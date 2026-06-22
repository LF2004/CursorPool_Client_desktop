---
name: cursor-reverse-notes-agent-protocol
description: Use when working on Cursor Agent protocol replication, RunSSE/BidiAppend streaming, structured tool roundtrip, tool-call frame parsing, conversationState persistence, session isolation, or debugging why Relay tool calls do not render in Cursor's native Agent UI. This skill distills rce.moe Cursor reverse notes 1 into this project's local Relay design so the long article does not need to be reread every time.
---

# Cursor Agent Protocol Notes

Use this skill before changing the Relay tool flow. The goal is to keep us anchored to Cursor's observed protocol shape instead of guessing from prompts or natural-language summaries.

Source article:

- `https://rce.moe/2026/01/31/cursor-reverse-notes-1/`

Local project anchors:

- `js/utils/cursor-relay-runner.js`
- `js/utils/cursor-relay-protocol.js`
- `js/utils/cursor-relay-proxy.js`
- `skills/cursor_relay_reverse/SKILL.md`
- `skills/cursor_modes/agent`

## Core Mental Model

Cursor Agent is not a plain request-response chat API. It is a streaming protocol with separate read/write channels:

- `RunSSE` is the server-to-Cursor read channel. It opens a long-lived stream and receives frame-by-frame agent updates.
- `BidiAppend` is the Cursor-to-server write/control channel. It sends user messages, tool results, KV acknowledgements, abort/control events, and other append messages.
- `requestId` links the `RunSSE` stream with later `BidiAppend` writes, but it is not enough for local session isolation.
- Local session isolation should be keyed by stable Cursor context, normally `workspaceId + composerId`, with `requestId` treated as a per-turn/request correlation id.

Important consequence: do not wait for the full upstream response before updating Cursor or local UI. Cursor expects each parsed frame to be forwarded as soon as it is available.

## Transport Notes

Cursor may label the stream with `text/event-stream`, but the body is not ordinary text SSE. Treat it as a low-buffering streaming transport carrying Connect/gRPC-style framed protobuf messages.

The useful abstraction for this project:

- Keep network forwarding non-blocking.
- Parse frame boundaries incrementally.
- Mirror parsed frames into logs/debug UI without delaying the real stream.
- Do not use tools like Burp/Yakit in a way that buffers the stream and changes timing.
- If a proxy captures traffic, it must preserve streaming behavior; otherwise Cursor Agent can hang even when the upstream is healthy.

## RunSSE Frame Classes

When debugging Relay output, classify every parsed server frame into one of these buckets.

### KV Frames

Early `RunSSE` frames can contain server-side KV instructions, such as `kvServerMessage.setBlobArgs`.

Expected behavior:

- Cursor stores the blob locally.
- Cursor acknowledges through `BidiAppend` with a matching KV client result.
- These frames often carry system/user context assembled by the server.

Relay implication:

- Do not assume the full prompt is present in the user append payload.
- Missing KV acknowledgement can cause the upstream turn to stall or replay.

### Thinking Frames

Thinking usually arrives as streaming deltas:

```json
{"interactionUpdate":{"thinkingDelta":{"text":"..."}}}
```

Expected behavior:

- Forward immediately.
- Preserve order relative to tool and text frames.
- A `thinkingCompleted` style frame may appear before tool execution or final text.

Relay implication:

- Thinking is part of the agent timeline, not disposable decoration.
- Dropping or delaying it can make the local UI look stuck even if the model is active.

### Text Frames

Assistant visible text normally arrives as `textDelta`:

```json
{"interactionUpdate":{"textDelta":{"text":"..."}}}
```

Expected behavior:

- Stream text as deltas.
- Do not synthesize a final assistant summary unless the upstream actually produced one.

Relay implication:

- If a file edit already happened but upstream continues emitting text/tool frames, the turn is not finished.
- If Relay injects "已完成" text without a matching protocol end, Cursor can continue/replay the same turn.

### Tool Frames

Cursor's tool lifecycle is structured. Do not infer tool execution from Chinese/English verbs in the prompt as the primary path.

Common frame sequence:

```text
partial_tool_call
tool_call_delta
tool_call_started
tool_call_progress / tool_call_delta
tool_call_completed
```

Article-style JSON shape:

```json
{"interactionUpdate":{"toolCallDelta":{"toolCallId":"call_xxx","name":"read_file","arguments":"{\"path\":\"/src/main.go\"}"}}}
```

Observed/expected meaning:

- `partial_tool_call` can identify the tool before full arguments are ready.
- `toolCallDelta` can stream tool name and argument chunks.
- `tool_call_started` means arguments are complete enough for Cursor's UI to show execution.
- Tool execution result must be sent back on the write/control side when required.
- `tool_call_completed` closes the visible tool lifecycle.

Relay implication:

- Accumulate arguments by `toolCallId`.
- Treat upstream tool delta frames as the source of truth.
- Execute or bridge local tools only after the tool call has a complete id/name/argument set.
- Never rely on `requestExpectsFileMutation` word guessing as the main trigger.
- If `streamedToolCalls > 0` but Cursor shows no tool card, the bug is probably frame encoding/lifecycle mapping.
- If `streamedToolCalls = 0`, the upstream did not emit structured tools; fix prompt/protocol negotiation, not local execution.

### Finish Frames

A turn ends only when the protocol says it ends. The important finish shape is:

```json
{"interactionUpdate":{"finished":{"conversationState":{}}}}
```

Other implementations may expose this as `turnEnded`, `finished`, or a final update containing `conversationState`.

Expected behavior:

- Persist `conversationState`.
- Emit turn completion exactly once per conversation key.
- Stop reading/executing/replaying that turn after completion.

Relay implication:

- A natural-language sentence like "已完成" is not a protocol finish.
- Missing or duplicated finish handling is a prime suspect for infinite loops, old conversation replay, and cross-window message bleed.
- If the user presses stop/pause, convert local pending state into a clean terminal state instead of leaving the session pending forever.

## Local Relay Mapping

Map article concepts to this project like this:

```text
Cursor user action
  -> BidiAppend append/control/user message
  -> RunSSE stream starts with requestId
  -> Relay parses upstream frames incrementally
  -> Relay forwards Cursor-compatible interactionUpdate frames
  -> Tool deltas accumulate by toolCallId
  -> Local tool executes or native Cursor bridge handles edit/review
  -> Tool result goes back through structured roundtrip
  -> finished/turnEnded persists conversationState
```

For our current system, the target flow is:

```text
RunSSE + BidiAppend + structured tool roundtrip
```

Do not collapse this into:

```text
prompt text -> guess desired edit -> write file -> fake completion text
```

That shortcut causes the exact class of failures we have been seeing: no native tool UI, edits landing too early, official Review/Keep/Undo missing, turns never closing, and different Agent windows sharing state.

## Current Verified Mutation Handoff Path

As of 2026-06-09, the verified default path for mutation tools is native Cursor edit lifecycle plus Relay-managed Agent protocol frames, not Relay filesystem commit and not hardcoded local edit synthesis:

```text
RunSSE opens for requestId
  -> BidiAppend user_message supplies user text and Cursor context
  -> upstream structured tool decision emits Read / Edit / Write / Delete intent
  -> Relay emits partial_tool_call, tool_call_delta, and tool_call_started
  -> mutating tools emit exec_server_message, normally write_args
  -> Cursor performs native write/review plumbing and returns BidiAppend exec_client write_result
  -> Relay emits tool_call_completed containing EditSuccess with diff_string
  -> Relay emits kvServerMessage.setBlobArgs and conversationCheckpointUpdate for file state
  -> Relay emits final text, turnEnded, ConnectEnd, and closes the stream
```

Important details:

- Mutation tools are `Write`, `Edit`, `PatchEdit`, `StrReplace`, and `Delete`.
- Local `fs.writeFileSync` fallback is intentionally disabled for general mutations. Only explicit user text replacement fallback may be used as a debug/emergency path.
- `PatchEdit/StrReplace` must be expanded into complete after-file content before building `write_args`.
- Do not feed a mutation `exec_client` timeout back to the model as a failed tool result. That caused infinite edit retry loops.
- `tool_call_completed` should be emitted only when Relay has a successful Cursor client result or local explicit fallback result.
- For non-mutation tools such as `Read`, `Grep`, and `Shell`, Relay can still wait briefly for native `exec_client` and fall back to local execution if no client acknowledgement arrives.

Verified good request:

- `c295d3db-423e-4c50-9322-dbe677b09082`
- Prompt: `@register-page/hello.html 帮我稍微丰富一下标签`
- Workspace: `E:\cursor_auto_test\register-page`
- Result: editor inline diff appeared, top `Undo / Keep` appeared, and composer bottom `Undo / Keep / Review` appeared.
- Decoded response: `readArgs -> partialToolCall -> toolCallDelta -> toolCallStarted -> writeArgs -> toolCallCompleted -> setBlobArgs -> conversationCheckpointUpdate -> turnEnded`.
- Decode errors: none.

## Session Isolation Rules

Use these checks whenever conversations cross, disappear, replay, or continue after Relay restart.

- Prefer `workspaceId + composerId` as the conversation key.
- Keep `requestId` as a request/turn id, not the sole session id.

## 2026-06-09 Regression Workflow

Use this workflow when validating local Agent parity. Do not rely on fixture files or prompts that tell the model which tool to call.

1. Restart the real Relay on `17789`, then verify `/__cursorpool__/health` reports `mode=local_relay`.
2. Use `E:\cursor_auto_test` as the test workspace.
3. Send real Cursor UI prompts when validating UI parity. Script tests are good for frame checks but cannot prove the native toolbar is visible.
4. Use natural prompts. A valid mutation test is: `@register-page/hello.html 帮我稍微丰富一下标签`.
5. Confirm the request entered local Relay: logs must contain `agent local relay RunSSE open ... mode=local_relay` and `agent local relay request ... upstreamModel=<BYOK model>`.
6. Confirm no official Cursor Agent quota was used for the Agent response. Control-plane calls such as analytics, auth, docs, repository sync, and telemetry may still pass through to Cursor; that is not the Agent backend.
7. Decode the saved response under `C:\Users\Administrator\.cursorpool\relay\samples` with `scripts/decode-cursor-agent-protobuf.cjs`.
8. Confirm the decoded response contains `writeArgs`, `toolCallCompleted`, `setBlobArgs`, `conversationCheckpointUpdate`, and `turnEnded`.
9. Confirm UI from the user's perspective: editor diff, top `Undo / Keep`, and composer bottom `Undo / Keep / Review`.
10. Record the request id and the exact UI result. Do not mark success from logs alone.

Known bad patterns from earlier runs:

- Direct write: `exec_server skipped ... tool=Write reason=disabled`, then `tool=Write ok=1`, with `execTools={}`.
- Retry loop: `exec_server sent ... nativeMutation=1`, then `exec_client wait fallback ... timedOut=1`, then `tool result ... ok=0`, followed by another mutation request for the same task.
- Hardcoded fallback: `provider=relay_general_fallback`, usually generating full HTML unrelated to the model's real edit.
- Parse crash: Cursor reports `[internal] parse binary: illegal tag`, usually caused by malformed protobuf field/wire encoding or sending text SSE when Cursor expects Connect-framed protobuf.
- Empty UI despite frames: often means only `exec_server_message` was emitted without `partial_tool_call/tool_call_delta/tool_call_started/tool_call_completed` and checkpoint frames.

- Store per-session tool accumulators, pending tool results, abort state, and `conversationState` separately.
- Clear only the active turn on finish/abort; do not wipe the whole workspace conversation unless Cursor did.
- Never route a BidiAppend from one composer into another composer just because the latest request id changed.

Debug labels should include:

```text
conversationKey=workspace:<workspaceId>:composer:<composerId>
requestId=<uuid>
toolCallId=<id>
streamedToolCalls=<n>
finished=<true|false>
```

## Edit / Review / Rollback Guidance

Cursor's native review UI is not just a diff snippet. It depends on the official tool lifecycle and editor/workbench state.

For edit tasks:

- Prefer upstream structured edit/tool frames over prompt keyword detection.
- Let Cursor own mutation timing through native exec frames.
- Do not write the real file before Cursor has entered its visible edit/review lifecycle unless this is an explicitly enabled emergency/debug fallback.
- A diff appearing in a side panel is not proof that native `Undo / Keep / Review` is wired.
- If the real file changes before the right-side edit UI appears, mutation timing is wrong.

If trying to use our Relay as an edit-review adapter later:

- Bridge tool frames into Cursor-like lifecycle events first.
- Prefer passing the mutation to the native edit path.
- Ensure `tool_call_completed` and turn finish are emitted after the edit lifecycle has reached a terminal state.

For the older review bridge implementation:

- A successful run should show both the editor-side inline `Undo / Keep` and the composer input-area `1 File / Undo / Keep / Review`.
- If only the editor diff appears, inspect whether the inline diff descriptor has `metadata.composerId`.
- If neither appears, inspect `/__cursorpool__/review-bridge-debug` for `poll_boot`, `review_event_queued`, `diff_created_active`, `promptbar_created`, and `attach_review_error`.
- If final text is missing but tools completed, inspect `agent_local_native_tool_*.json` for `finalAssistantTextPreview` and the log line `agent mutation final text emitted`.

## Tool Test Matrix

Use progressively harder prompts and record the `requestId` for each run.

### Level 1: Basic Read

- Prompt: `@index.html 读一下这个文件并总结结构`
- Expected: Read tool card appears and completes; no edit review toolbar appears; final text is streamed; no replay.
- Logs to check: `streamedToolCalls=1`, `tool=Read`, `RunSSE finished`.

### Level 2: Single-Line Edit

- Prompt: `@index.html:9 把标题改成 Hello, World`
- Expected: Read or StrReplace tool card appears; editor diff appears; inline `Undo / Keep` appears; composer `1 File / Undo / Keep / Review` appears; final summary appears.
- Logs to check: `tool=StrReplace`, `review_event_queued`, `diff_created_active`, `agent mutation final text emitted`.

### Level 3: Multi-Line Range Edit

- Prompt: `@index.html:130-168 帮我改成中文`
- Expected: range is replaced as one reviewable edit; composer toolbar appears; final summary explains the modification.
- If upstream followup times out: `local_native_tool_line_range_recovery` may appear, but the UI should still be correct.

### Level 4: Multi-File Edit

- Prompt: `把 @src/foo.ts 和 @src/bar.ts 里同一个配置字段一起改名`
- Expected: either multiple edit tool calls or multiple review events; input-area file list shows multiple files; each file has native review controls.
- Failure signal: only one file appears or conversation key changes between files.

### Level 5: Create / Write

- Prompt: `新建 @src/example.ts，导出一个 hello 函数`
- Expected: Write tool lifecycle and `exec_server_message` with `write_args`; Relay finishes quickly and does not create the file locally before Cursor accepts it.
- Check rollback: rejecting the native diff should remove the newly created file or restore prior state once Cursor consumes the frame.

### Level 6: Delete

- Prompt: `删除 @src/unused.ts`
- Expected: Delete tool lifecycle and `exec_server_message` with `delete_args`; Relay does not delete locally before Cursor accepts it.
- Check rollback: Undo/Reject should restore the original file content.

### Level 7: Complex Agent Task

- Prompt: `修复这个页面的布局问题，必要时修改 HTML 和 CSS，然后总结原因和改动`
- Expected: Read/Grep/possibly multiple edits; no premature finish while there are pending tool intents; final response has reason, fix, and summary.
- Logs to check: no `structured_followup_error` unless recovery is expected; no duplicate replay; `conversationKey` remains stable.

### Level 8: Abort / Duplicate Replay

- Start a slow edit, stop it, then submit the same request again.
- Expected: no infinite replay; duplicate turn is closed with clean `turnEnded + ConnectEnd`; a legitimate new request still works.

## Debug Checklist

Use this order before editing code.

1. Find the request in Relay logs by `requestId`.
2. Find the conversation key and confirm `workspaceId + composerId` are correct.
3. Count parsed upstream frames and confirm streaming did not buffer until the end.
4. Check `streamedToolCalls`.
5. If `streamedToolCalls = 0`, inspect upstream negotiation/system prompt/tool availability.
6. If `streamedToolCalls > 0`, inspect frame conversion into Cursor-visible tool lifecycle.
7. For each `toolCallId`, verify name and arguments were accumulated without mixing sessions.
8. For mutation tools, verify Relay emitted `exec_server_message` and then ended the turn without local filesystem writes or model retry.
9. Verify `finished.conversationState` or equivalent turn-end frame was received and persisted once.
10. Verify no post-finish replay guard is blocking a legitimate next turn or allowing an old one to loop.

## 2026-06-10 Local Relay Stability Fixes

Use request `6cd115ac-15eb-46c0-bdcf-05c600b6a42e` as the current good baseline for a multi-round local Relay mutation task. The user prompt was `@register-page/test.html 帮我去掉本次优化包含这整个模块`, and the successful shape was:

```text
Read / Glob / LS / Grep context tools
  -> multiple StrReplace native mutation handoffs
  -> ReadLints
  -> upstream final summary
  -> turnEnded
```

Healthy generated summary from that run included:

```text
interaction includes partial_tool_call, tool_call_started, tool_call_completed, text_delta, turn_ended
execTools includes read_args, ls_args, grep_args, write_args, diagnostics_args
serverMessages includes kv_server_message and conversation_checkpoint_update
connectErrors=[]
```

Important fixes and rules from this regression:

- Read/Grep/LS/Glob can still emit Cursor-native UI frames, but the tool result sent back to upstream must contain real local context. Do not feed the model vague native summaries such as `Cursor native tool execution completed.`
- Read results should include stable line numbers and honor `offset` / `limit`.
- Grep results should look like `path:line:content`, support `-A` / `-B` / `-C`, multiline, ignore-case, glob, and head limits, and should return an explicit no-match message instead of an empty failure.
- Repeated read-only tool calls should return the previous real result to upstream while marking the execution duplicate. Returning only "duplicate skipped" makes the model lose context and search again.
- A natural-language summary or any visible text delta is not completion. Completion requires no upstream error, no pending tools, no self-continuation request, no tool-round guard, and a protocol `turnEnded` / equivalent finish.
- Recoverable upstream timeout or idle interruption is not completion. Save unfinished context and mark the turn failed/unfinished so a later continuation can resume with tool history.
- Tool-round limits are only a dead-loop guard. Keep them high enough for complex tasks and never use them to force `Give the final answer now`.
- Avoid fixed total stream durations for complex Agent tasks. Prefer idle detection plus explicit abort/control handling.

When a task spends too long "finding code":

1. Inspect the tool result text in history, not only the visible Cursor UI card.
2. If Read/Grep output lacks file content, line numbers, or no-match clarity, fix the tool result bridge before changing prompts.
3. If the model repeats the same search, confirm duplicate calls re-send the previous real result to upstream.
4. If a timeout ends the turn, confirm the turn is marked failed/unfinished and not cached as completed.
5. Only after tool-result fidelity is correct should you consider prompt/tool-description tuning.

## Failure Signatures

### Tool Never Appears

Likely causes:

- Upstream never emitted structured tool frames.
- Relay parsed text but dropped `toolCallDelta`.
- Tool deltas were accumulated but never converted to Cursor's expected lifecycle frames.
- The frame was emitted under the wrong conversation key.
- Arguments never became valid JSON because chunks were not accumulated by `toolCallId`.

### File Changes Before UI

Likely causes:

- Relay executed local filesystem mutation directly.
- Edit detection is still driven by text/keyword guessing.
- Native Cursor edit/review lifecycle was bypassed.

### Mutation Keeps Retrying

Likely causes:

- Relay waited for mutation `exec_client` until timeout.
- Relay returned the timeout as `ok=false` tool output to the model.
- The next upstream round interpreted the failed tool result as permission to try the same Write/Edit again.
- The fix is to end the turn after native mutation handoff and avoid local writes.

### Turn Says Completed But Keeps Running

Likely causes:

- Relay emitted completion text but not protocol finish.
- `finished.conversationState` was not persisted.
- Pending tool result was not acknowledged through BidiAppend.
- Abort/pause state left the turn pending.

### Different Agent Windows Cross

Likely causes:

- State keyed only by latest `requestId`.
- Global pending tool accumulator.
- Global active conversation pointer.
- BidiAppend routed to the wrong composer.

### Relay Restart Replays Old Conversation

Likely causes:

- Local pending turn was not terminal.
- Finish frame was missed.
- Conversation state was not written back.
- Duplicate/replay guard blocks execution but still allows the UI loop to continue.

## Implementation Bias

When fixing Relay, prefer protocol evidence over heuristics:

- Parse first, then decide.
- Stream first, then summarize.
- Preserve Cursor's lifecycle, then add local convenience.
- Session-isolate everything that can outlive one request.
- Log enough structured metadata to prove where the failure is.

Avoid these patterns:

- More mutation guess words in `requestExpectsFileMutation`.
- Writing the file and pretending Cursor's native edit tool ran.
- Waiting for the whole stream before surfacing tool calls.
- Treating "assistant final text" as equivalent to `finished`.
- Sharing tool state across Agent windows.

## Read With

Open this together with:

- `skills/cursor_relay_reverse/SKILL.md` for installed Cursor/workbench reverse-engineering.
- `skills/cursor_modes/agent` for local agent-mode expectations.
- Relay logs for the exact `requestId` being debugged.

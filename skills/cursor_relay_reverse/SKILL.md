---
name: cursor-relay-reverse
description: Use when working on Cursor reverse-engineering, native tool/UI tracing, agent tool-call rendering, official undo/confirm review UI recovery, WebSearch/WebFetch/Fetched Page parity, image attachment transport, or local-first debugging of how Cursor routes RunSSE, Bidi, edit cards, and workbench diff state. Open this when you need to inspect Cursor installed source files, decode recorded protocol frames, find UI anchors, trace why tool cards appear without official review controls, or extend the local relay to match Cursor agent behavior.
---

# Cursor Relay Reverse

## Non-Negotiable Implementation Guardrail

Do not hardcode user prompt wording, task-specific keywords, page names, file counts, language-specific phrases, or sample-request details into relay behavior.

Forbidden patterns:

- Do not infer task completion from natural-language keyword matching such as "continue", "finish", page names, asset names, Chinese prompt phrases, or one sample request's wording.
- Do not add local rules like "if the user mentioned X, require Y file" unless X and Y are explicit structured protocol fields or verified product configuration.
- Do not branch protocol behavior based on a captured prompt's language, wording, or examples from one request.
- Do not use a bug reproduction prompt as a general completion contract.

Allowed patterns:

- Use official decoded frames, protobuf fields, tool-call/result structure, request IDs, response event order, and local execution state as the source of truth.
- For incomplete multi-step work, use a generic completion-verification loop that gives the upstream model the original request, actual tool results, and a workspace/status snapshot, then lets it either call more tools or finalize.
- If local code needs deterministic validation, validate protocol invariants and concrete tool outcomes, not human-language intent.
- Keep request-specific observations in this skill as evidence, not as logic to copy into runtime code.

## 2026-06-10 Web Search, Fetched Page, and Image Attachment Parity

Verified request:

- `requestId=cd8aeaca-7c16-4e47-a888-5a510704b3ff`
- Official Agent pure-recording mode was enabled.
- Sample directory: `C:\Users\xiaofan\.cursorpool\relay\samples`
- Primary RunSSE sample: `runsse-response-2026-06-10T12-37-23-996Z-cd8aeaca-7c16-4e47-a888-5a510704b3ff.response.bin`
- Primary Bidi sample: `bidi-2026-06-10T12-37-24-223Z-cd8aeaca-7c16-4e47-a888-5a510704b3ff.bin`

Discovery method:

1. Record the official Cursor Agent request in pure-recording mode.
2. Decode the RunSSE response with `scripts/decode-cursor-agent-protobuf.cjs`.
3. Grep `proto/agent_v1.proto` for the visible tool names and likely message names:
   - `WebSearchToolCall`
   - `WebFetchToolCall`
   - `InteractionQuery`
   - `ImageProto`
   - `SelectedImage`
4. Dump exact frames around `interactionQuery`, `toolCallStarted`, and `toolCallCompleted`.
5. Implement only the fields proven by decoded official frames.
6. Rebuild local frames and decode them with `decodeAgentServerMessage` to confirm they roundtrip to official oneof names.

Official `Searched web` mapping:

```text
ToolCall.web_search_tool_call = field 18

WebSearchArgs:
  search_term = 1
  tool_call_id = 2

WebSearchResult:
  success = 1
    references[] = WebSearchReference
  error = 2
  rejected = 3

WebSearchReference:
  title = 1
  url = 2
  chunk = 3
```

Observed frame sequence:

```text
interactionQuery.webSearchRequestQuery
interactionUpdate.toolCallStarted.toolCall.webSearchToolCall
interactionUpdate.toolCallCompleted.toolCall.webSearchToolCall.result.success.references[]
```

Important result detail:

- The first reference is normally synthetic: `title="Web search results"`.
- Its `chunk` contains a markdown/search bundle with `Links:`, `Synthesis:`, `Highlights:`, and repeated `<result id="...">` blocks.
- Images discovered by search are not structured image objects. They appear as markdown or HTML URLs inside `chunk`, such as `![...](https://...)`.
- Individual page dumps can appear as later references with a normal `title`, `url`, and a `chunk` like `Full page text written to file: ...`.

Official `Fetched Page` / `WebFetch` mapping:

```text
ToolCall.web_fetch_tool_call = field 37

WebFetchArgs:
  url = 1
  tool_call_id = 2

WebFetchResult:
  success = 1
    url = 1
    markdown = 2
  error = 2
    url = 1
    error = 2
  rejected = 3
```

Observed frame sequence:

```text
interactionQuery.webFetchRequestQuery
interactionUpdate.toolCallStarted.toolCall.webFetchToolCall
interactionUpdate.toolCallCompleted.toolCall.webFetchToolCall.result.success.markdown
```

Implementation status:

- `WebFetch` / Fetched Page has been frame-level replicated successfully.
- Local frames decode back to official `webFetchToolCall`.
- `WebFetch` result uses `success.url` and `success.markdown`.
- Binary URLs, images, PDFs, localhost, and private IPs should return a visible tool error instead of pretending to fetch content. This matches the official tool's read-only public webpage behavior.

Image attachment transport:

```text
UserMessage.selected_context.selected_images[] = SelectedImage

SelectedImage:
  blob_id = 1
  uuid = 2
  path = 3
  dimension = 4
  mime_type = 7
  data = 8
  blob_id_with_data = 9
```

For the verified request, the official Bidi user message carried one selected image:

```text
uuid=3fb9ba37-5917-4834-9a99-8b35a56a445e
path=c:\Users\xiaofan\AppData\Roaming\Cursor\User\workspaceStorage\...\images\image-db3c92bc-351f-4e39-817f-8e215ad9b315.png
mime_type=image/jpeg
dimension=1024x564
data bytes present
```

Do not trust the file extension for MIME. This sample used a `.png` path but JPEG bytes and `mime_type=image/jpeg`.

Local relay replication rules for these tools:

- Advertise `WebSearch` and `WebFetch` in the upstream tool schema.
- Accept `search_term`, `searchTerm`, or `query` for WebSearch; encode official args as `search_term`.
- Accept only `url` for WebFetch; encode official args as `url`.
- Emit `partialToolCall`, `toolCallStarted`, and `toolCallCompleted` through `buildAgentToolCall*Frame` with native fields 18 and 37.
- For WebSearch completion, return `result.success.references[]`; put any image URLs inside `chunk`.
- For WebFetch completion, return either `result.success.markdown` or `result.error.error`.
- For selected images, parse Bidi `SelectedImage` and forward bytes to upstream as multimodal input; keep debug/sample JSON lightweight by omitting raw base64 and storing only `hasData`, dimensions, path, UUID, and MIME.
- Do not add invented thumbnail fields to WebSearch. Official search does not carry them.

Regression checks:

```powershell
node --check js\utils\cursor-relay-protocol.js
node --check js\utils\cursor-relay-runner.js
```

Frame-level check:

```text
buildAgentToolCallStartedFrame("WebSearch", ...)
  -> decodeAgentServerMessage(...)
  -> interactionUpdate.toolCallStarted.toolCall.tool == "webSearchToolCall"

buildAgentToolCallCompletedFrame("WebFetch", ...)
  -> decodeAgentServerMessage(...)
  -> interactionUpdate.toolCallCompleted.toolCall.tool == "webFetchToolCall"
```

When discovering the next native tool, repeat the same pattern: record official traffic, decode exact started/completed frames, locate the proto message, implement only verified fields, then decode locally generated frames back to official oneof names before calling it done.

## 2026-06-09 Verified Native Edit Flow

Current verified success is a network-only local Relay flow, not Cursor client patching and not local hardcoded edit injection.

Validated request:

- `requestId=c295d3db-423e-4c50-9322-dbe677b09082`
- Workspace: `E:\cursor_auto_test\register-page`
- Prompt: `@register-page/hello.html 帮我稍微丰富一下标签`
- Relay mode: `local_relay`
- Upstream: configured BYOK `gpt-5.4` through `endpointMode=responses`
- UI result: editor-side native diff appeared, top `Undo / Keep` bar appeared, and right-side composer bottom `Undo / Keep / Review` controls appeared.

Decoded RunSSE evidence:

```text
execServerMessage: readArgs
interactionUpdate: partialToolCall
interactionUpdate: toolCallDelta
interactionUpdate: toolCallStarted
execServerMessage: writeArgs
interactionUpdate: toolCallCompleted
kvServerMessage: setBlobArgs
conversationCheckpointUpdate
interactionUpdate: turnEnded
```

Healthy decoded counts from this run:

```text
serverMessages={"execServerMessage":3,"interactionUpdate":312,"kvServerMessage":2,"conversationCheckpointUpdate":2}
interactionUpdates={"partialToolCall":1,"toolCallDelta":1,"toolCallStarted":1,"toolCallCompleted":1,"turnEnded":1}
decodeErrors=[]
```

Remaining known gap:

- The editor area diff and native review toolbar are working.
- The right-side chat/tool card does not yet render the full inline diff content inside the conversation panel; keep this as a follow-up, not as proof that native edit failed.
- Response speed is still slow because the current BYOK/model loop does `Read -> upstream follow-up -> Edit -> diagnostics`. Optimize by reducing unnecessary follow-up rounds only after preserving the verified native lifecycle.

## 2026-06-10 Stable Multi-Round Relay Baseline

Current good request:

- `requestId=6cd115ac-15eb-46c0-bdcf-05c600b6a42e`
- Workspace: `E:\cursor_auto_test\register-page`
- Prompt: `@register-page/test.html 帮我去掉本次优化包含这整个模块`
- Result: multiple native tool rounds completed, file diff/review stayed stable, ReadLints ran, and upstream produced a real final summary.

Healthy log shape:

```text
tool plan ... Read / Glob / LS / Grep
tool plan ... StrReplace
exec_client ... write_result
checkpoint emitted file=...
tool plan ... ReadLints
final text frame ... errorLen=0
RunSSE generated ... write_args, diagnostics_args, conversation_checkpoint_update, turn_ended
```

This fixed a class of failures where the Cursor UI showed tools but upstream did not receive useful context. The Relay now keeps native UI frames while feeding upstream real local context for read-only tools:

- Read returns line-numbered content and honors `offset` / `limit`.
- Grep returns `path:line:content`, supports context flags, and distinguishes no-match from tool failure.
- Duplicate read-only calls return the previous real result instead of only saying "duplicate skipped".
- Recoverable timeout/idle interruption is saved as unfinished, not marked complete.
- Tool-round limits are a high dead-loop guard, not a normal task boundary.

If a future run looks stuck in exploration, inspect the upstream tool result text first. A pretty native tool card is not enough; the model must see useful result content.

Next validation should move beyond single-file edits:

- empty-folder demo creation with multiple new files
- HTML + CSS + JS coordinated changes
- front-end plus back-end route/API updates
- multi-file rename/refactor
- long-running task with an upstream interruption followed by continuation
- reject/undo native review and then submit a new request in the same composer

Use this skill when the task is about how Cursor itself behaves, not just this repo's business UI.

The current default architecture is local-first interception with native mutation handoff:

- Relay still intercepts Cursor traffic first.
- Non-edit requests can continue through our Relay prompt and upstream path.
- File mutation requests must emit Cursor native interaction frames and exec frames so the official `Undo / Keep / Review` flow owns the change.
- Relay must not write mutation files locally as a fallback unless an explicit emergency/debug mode says so.

Start from the installed Cursor app, then map findings back into this repo.

## Workflow

1. Confirm the current project patch points in:
   - `js/utils/cursor-relay-proxy.js`
   - `js/utils/cursor-relay-review-bridge.js`
   - `js/utils/cursor-relay-runner.js`
   - `js/utils/cursor-relay-protocol.js`
2. Open `references/workflow.md` for the reverse-engineering procedure and anchor list.
3. If the issue is about official undo/confirm UI not appearing after a mutation request, inspect `js/utils/cursor-relay-review-bridge.js` and the workbench anchors listed in `references/review-bridge.md`.
4. If the issue is about tool calls or agent lifecycle, inspect relay stats and logs before changing prompts.
5. Prefer proving from source or traffic whether a request stayed in Relay or intentionally fell back to Cursor native execution before modifying behavior.
6. For no-request-id debugging, inspect the newest `runner.log` segment by content and frame labels, not by prompt memory.

## Rules

- Treat Cursor UI rendering, inline diff state, prompt-bar state, and relay network interception as separate layers.
- Do not assume edit cards imply official review UI exists.
- Do not use prompt hacks to compensate for missing local tool or workbench state.
- Treat reverse-engineering Cursor's internal edit tool execution as the primary mutation path for `Write/Edit/PatchEdit/StrReplace/Delete`.
- Keep the local-first constraint at the interception layer: traffic should reach our Relay first, but mutation execution can still be handed back to Cursor native flow on purpose.
- Never hide a native mutation failure by doing `fs.writeFileSync` and claiming the edit completed.
- If native mutation handoff lacks a Cursor client acknowledgement, end the turn once and do not ask the model to retry the same mutation.
- Never reintroduce broad `relay_general_fallback` or generated HTML templates. That produced hardcoded edits, polluted official-frame comparison, and did not prove Agent parity.
- For `PatchEdit/StrReplace`, expand `old_string/new_string` into complete after-file content before sending `write_args`; otherwise Cursor may treat a small replacement snippet as the whole file.

## Current Stop-Loop Rule

For mutation tools, the safe behavior is:

```text
upstream structured Write/Edit/PatchEdit
  -> Relay emits partial_tool_call / tool_call_delta / tool_call_started
  -> Relay emits exec_server_message with write_args
  -> Cursor returns BidiAppend exec_client write_result
  -> Relay emits tool_call_completed with EditSuccess diff_string
  -> Relay emits KV blob frames and conversation_checkpoint_update
  -> Relay emits final text, turnEnded, ConnectEnd
```

Do not feed a mutation timeout back to the model as `ok=false`. That makes the model retry the same edit and creates the looping behavior seen earlier on 2026-06-09.

Healthy generated RunSSE summary for a mutation handoff should include:

```text
serverMessages includes interaction_update, exec_server_message, kv_server_message, conversation_checkpoint_update
interaction includes partial_tool_call, tool_call_delta, tool_call_started, tool_call_completed, turn_ended
execTools includes write_args
```

Unhealthy older behavior looked like:

```text
exec_server skipped ... reason=disabled
tool result ... tool=Write ok=1 ... path=<file>
execTools={}
```

That means Relay wrote the file directly and Cursor had no chance to show native Keep/Undo.

## Local Test Method

Use the real Cursor UI for final acceptance. The user-visible pass condition is:

```text
editor inline diff visible
top editor Undo / Keep visible
composer bottom 1 File / Undo / Keep / Review visible
turn finishes without replay
runner.log has no relay_general_fallback
```

Use protocol tools for regression evidence:

```powershell
node scripts/decode-cursor-agent-protobuf.cjs "C:\Users\Administrator\.cursorpool\relay\samples\runsse-local-response-<timestamp>-<requestId>.response.bin"
```

For mutation handoff tests:

- Test in `E:\cursor_auto_test`.
- Use natural Cursor prompts such as `@register-page/hello.html 帮我稍微丰富一下标签`.
- Search `C:\Users\Administrator\.cursorpool\relay\runner.log` by request id or prompt content.
- Healthy logs include `RunSSE open ... mode=local_relay`, `upstreamModel=gpt-5.4 endpointMode=responses`, `tool plan ... Read`, `tool plan ... Edit`, `exec_client ... write_result`, and `checkpoint emitted`.
- Healthy decoded response includes `toolCallDelta`, `toolCallStarted`, `writeArgs`, `toolCallCompleted`, `setBlobArgs`, `conversationCheckpointUpdate`, and `turnEnded`.
- Unhealthy logs include `relay_general_fallback`, repeated post-finish user messages, parse-binary illegal tag errors, or missing `turnEnded`.

## Read Next

- `references/workflow.md` for the step-by-step investigation flow.
- `references/review-bridge.md` for the official undo/confirm UI recovery path.

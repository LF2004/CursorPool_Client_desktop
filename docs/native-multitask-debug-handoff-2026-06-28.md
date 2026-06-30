# Native Multitask / Debug Handoff

## Goal

This document captures the current verified state of the local native `Multitask` / `Debug` mode work in `CursorPool_Client_desktop`, including what is fixed, what is still broken, and where the next agent should continue.

The user explicitly does **not** want:

- fake UI-only parity
- workbench injection as the primary solution
- local fake cache-hit logic
- "runner ok" used as proof when the real Cursor UI is still wrong

The user **does** want:

- official-native behavior parity
- real subagent execution and recovery
- real Debug tools / logs / reproduction flow
- runner-based end-to-end verification, but only if it matches real UI behavior

## Current Verified State

### What is actually improved

1. `Debug` no longer hard-stalls at the first post-tool phase.
2. Background `Task` execution for `Debug` and `Multitask` does real local work rather than only semantic-search simulation.
3. Parent-vs-child task lookup was fixed so mode logic can find the parent task instead of mistakenly reading the last child record.
4. Local mode finalization was improved so `Debug` can close a turn with local evidence rather than always re-entering incomplete continuation.

### What is still broken in real UI

1. `Multitask` still behaves like "Task shell + normal agent fallback", not true official subagent orchestration.
2. The Cursor UI still often shows placeholder child cards like:
   - `New subagent`
   - `Planning next moves`
3. `Debug` still does not look or feel like official native debug mode in the UI.
4. `runner ok: true` is **not** enough evidence of parity.

This is the user's current complaint and it is valid.

## Key Diagnosis

### Important distinction

There are two layers:

1. Local relay / runner control flow
2. Native task UI consumption path in Cursor

The control flow layer has improved.
The native task UI consumption layer is still incomplete.

### Why the UI still looks wrong

The local response already includes `taskToolCallDelta` frames with parent/child task IDs, but Cursor still falls back to generic placeholders.

That strongly suggests the UI depends more on the native task RPC chain than on the task delta frames alone:

- `TaskInitResponse.human_readable_title`
- `TaskStreamLogResponse`
- `TaskLogItem`
- possibly `TaskInfoResponse` / `TaskGetInterfaceAgentStatus`

Relevant proto definitions:

- [proto/regen/agent_v1.proto](F:/xiaofan_project/CursorPool_Client_desktop/proto/regen/agent_v1.proto)
- [proto/regen/aiserver_v1.proto](F:/xiaofan_project/CursorPool_Client_desktop/proto/regen/aiserver_v1.proto)

### Critical proto facts already confirmed

1. `TaskArgs` / `TaskToolCallArgsProto` do **not** contain a `title` or `name` field.
2. Therefore UI title is probably not sourced from task args alone.
3. `TaskInitResponse` and `TaskStreamLogResponse` do contain title/log structures that likely drive the native task cards.

Relevant proto locations:

- `agent_v1.proto`
  - `TaskToolCall`
  - `TaskToolCallDelta`
- `aiserver_v1.proto`
  - `TaskInitResponse`
  - `TaskInfoResponse`
  - `TaskStreamLogRequest`
  - `TaskStreamLogResponse`
  - `TaskLogItem`

## Files Most Relevant

### Core runtime

- [js/utils/cursor-relay-runner.js](F:/xiaofan_project/CursorPool_Client_desktop/js/utils/cursor-relay-runner.js)
- [js/utils/cursor-relay-protocol.js](F:/xiaofan_project/CursorPool_Client_desktop/js/utils/cursor-relay-protocol.js)
- [js/utils/cursor-relay-protobuf.js](F:/xiaofan_project/CursorPool_Client_desktop/js/utils/cursor-relay-protobuf.js)

### Mode logic

- [js/mode/debug-mode.js](F:/xiaofan_project/CursorPool_Client_desktop/js/mode/debug-mode.js)
- [js/mode/multitask-mode.js](F:/xiaofan_project/CursorPool_Client_desktop/js/mode/multitask-mode.js)

### Reference reverse-engineering targets

- `D:\cursor\resources\app\out\vs\workbench\workbench.desktop.main.js`
- `D:\cursor\resources\app\out\vs\workbench\workbench.glass.main.js`

## Important Changes Already Made

### `js/mode/debug-mode.js`

- Added stronger local debug conclusion logic.
- Added mode-aware finalize behavior when debug artifacts are already complete.
- Reduced the old "evidence is complete but still loops forever" behavior.

### `js/mode/multitask-mode.js`

- Added better parent summary stop condition.
- Still not enough for official parity.

### `js/utils/cursor-relay-runner.js`

- Fixed `getLatestSessionTaskRecord()` so mode logic resolves the parent task instead of the last child task.
- Added `modeLocalFinalized` path so local finalize can short-circuit later incomplete continuation.
- Native task log payload now supports:
  - `thought`
  - `instruction`
  - `userMessage`
- Task/child-task initial logs were changed away from generic placeholder content.

## What Was Verified

### Verified runner passes

These runner tests passed at various points:

```powershell
$env:RELAY_TEST_AGENT_MODES='AGENT_MODE_DEBUG'; node scripts/test-relay-native-modes.cjs
$env:RELAY_TEST_AGENT_MODES='AGENT_MODE_MULTITASK'; node scripts/test-relay-native-modes.cjs
```

But again: this only proves the local relay can complete a turn, not that real Cursor UI parity is achieved.

### Verified sample decode

Decoded local response sample proved that `taskToolCallDelta` frames are present:

- `C:\Users\xiaofan\.cursorpool\relay-native-modes-17790\samples\runsse-local-response-2026-06-28T09-27-59-997Z-81a445d6-4290-49a0-bcdc-07a31fe8e59c.response.bin`

Decode command:

```powershell
node scripts/decode-cursor-agent-protobuf.cjs "<sample>.response.bin"
```

Observed:

- parent task delta exists
- child task deltas exist
- yet UI still falls back to placeholder cards

Conclusion:

- the task deltas alone are insufficient
- native task RPC title/log semantics still need to be aligned

## Current Blocking Problems

### 1. Native task cards still render placeholders

Symptom:

- `New subagent`
- `Planning next moves`

Likely cause:

- `TaskInitResponse.human_readable_title`
- `TaskStreamLogResponse.initialTaskInfo`
- `TaskLogItem` ordering/types/content

are still not close enough to official behavior.

### 2. `Multitask` is not true orchestration yet

Current behavior:

- local task execution exists
- child IDs exist
- parent summary exists

But still missing:

- true parent/child coordination feel
- official-like subagent life cycle in UI
- proper tool ownership semantics

### 3. `Debug` still feels text-summary based

Even when stable now, it still looks like:

- local summary text
- lots of `textDelta`

rather than official debug-native evidence card flow.

## Recommended Next Steps

### Priority 1: Fix native task UI consumption path

Focus only on the native task RPC layer:

- inspect `TaskInitResponse`
- inspect `TaskStreamLogResponse`
- inspect exact `TaskLogItem` type ordering
- compare with official logs / samples if available

The next agent should verify:

1. whether first visible task card title comes from `TaskInitResponse.human_readable_title`
2. whether first placeholder subtitle comes from missing / wrong `TaskLogItem`
3. whether `instruction` should be the first item, not `thought` or `output`
4. whether `TaskInfoResponse` or `TaskGetInterfaceAgentStatus` is also needed to update the card title/subtitle

### Priority 2: Stop treating multitask as a simple single-Task wrapper

Current forced mode injection:

- `buildForcedModeTaskToolCall()`

still pushes the system into a single Task wrapper too early.

Next agent should inspect whether official `Multitask`:

- spawns multiple subagents from parent decisions incrementally
- uses a different parent control surface than the current synthetic single `Task`
- requires additional exec/subagent messages rather than only task delta messages

### Priority 3: Compare against official UI consumer code

Search targets in workbench:

- `Planning next moves`
- `New subagent`
- `TaskStreamLog`
- `backgroundSubagentAction`
- `backgroundTaskCompletionAction`
- `taskToolCallDelta`

The likely goal is to determine exactly which fields switch the card from placeholder mode into real mode.

## Test / Debugging Tips

### Sequential testing only

Do not launch Debug and Multitask tests in parallel.
The current runner manager can race on port `17790`.

Run only one at a time:

```powershell
$env:RELAY_TEST_AGENT_MODES='AGENT_MODE_DEBUG'; node scripts/test-relay-native-modes.cjs
```

or

```powershell
$env:RELAY_TEST_AGENT_MODES='AGENT_MODE_MULTITASK'; node scripts/test-relay-native-modes.cjs
```

### Port conflict note

If tests fail with `EADDRINUSE` or `ECONNREFUSED`, inspect and clear `127.0.0.1:17790` first.

### Useful logs / locations

- Runner log:
  - `C:\Users\xiaofan\.cursorpool\relay-native-modes-17790\runner.log`
- History:
  - `C:\Users\xiaofan\.cursorpool\relay-native-modes-17790\history`
- Samples:
  - `C:\Users\xiaofan\.cursorpool\relay-native-modes-17790\samples`

## Honest Summary

This branch has improved stability and local execution significantly, especially for `Debug` closure.

However, the user's core complaint remains correct:

- `Multitask` is still not official-native enough
- `Debug` is still not official-native enough
- the native task UI layer is the real remaining blocker

Any next AI should continue from native task RPC/UI-consumer parity, not from runner completion heuristics.

---

# Round 2 更新（2026-06-28 下午）

## Round 2 已完成的修复

### proto schema 对齐（`proto/regen/aiserver_v1.proto`）
- `TaskInfoResponse` 增加 `TaskStatus task_status = 2`
- `TaskStreamLogResponse` 增加 `info_update = 2` oneof 分支 + 嵌套 `InfoUpdate { human_readable_title, task_status }`
- 新增 `InterfaceAgentStepStatus` enum
- `InterfaceAgentStatus` 增加 8 个 enum 字段

### runner 核心（`js/utils/cursor-relay-runner.js`）
- `handleTaskStreamLogLive`：TaskStreamLog 改为真正的 server-streaming
- 修复 `streamedLogItem` 编码丢失 bug（拆分 `buildTaskLogItemObject`）
- `findTaskRecordAcrossSessions` 增加 `parentToolCallId` 别名查找
- `emitTaskProgressFrame` 重写：删除空壳 backgroundSubagentAction/backgroundTaskCompletionAction 帧，partial/started 阶段不发 result
- `ensureDebugArtifactsForTask` 不再向 task.log 追加合成证据
- debug `waitForBackgroundExecutions` 超时 2500→8000ms

### 协议（`js/utils/cursor-relay-protocol.js`）
- `buildStructuredToolCallSnapshot` task 分支：`execution.includeResult === false` 时不输出 result
- `buildAgentTaskToolCallDeltaFrame` 填充 ToolCall metadata（toolCallId/startedAtMs/completedAtMs）
- `buildTaskSubagentTypeProto`：generalPurpose 从 `{unspecified:{}}` 改为 `{custom:{}}`

### debug 模式（`js/mode/debug-mode.js`）
- `getPostToolTurnAction` 不再返回大段结论文本，改为简短标记 + markCompleted

### 测试
- `scripts/test-task-streamlog-unit.cjs` — PASS
- `scripts/test-round2-native-task-ui.cjs` — 26/26 PASS
- `scripts/test-relay-native-modes.cjs` — DEBUG + MULTITASK ok=true

---

# Round 3 未修复问题清单（2026-06-28 晚，用户反馈后）

> **重要**：runner 测试通过 ≠ UI 对齐。以下问题在真实 Cursor UI 中仍然存在，用户已提供截图确认。

## 问题 1：子 agent 卡片显示 "New Agent / Cancelled"（Multitask）

### 症状
- Multitask 模式下，3 个子代理卡片全部显示 "New Agent"，状态为 "Cancelled"
- 子卡片内部无任何真实工具执行内容
- 官方对比：官方 Multitask 子卡片有标题、有工具执行流、状态为完成

### 根因诊断（已定位，修复中）
`executeBackgroundTask` 中，**每个子任务都调用了 `emitTaskProgressFrame(session, childRecord)`**，导致：
1. 客户端收到 3 个独立的 `taskToolCallDelta` 帧（partial→started→completed）
2. 客户端为每个子任务创建独立的 subagent 卡片
3. 但这些子任务的 `toolCallId`（如 `tool_xxx.child.1`）在客户端没有对应的 Task tool call 上下文
4. 当父 turn 的 `turnEnded` 帧到达时，客户端把所有未正式注册的子卡片标记为 "Cancelled"

### 修复方向（已开始实施）
- **子任务不应该 emit 自己的 taskToolCallDelta 帧**
- 子任务的生命周期只通过父任务的 TaskStreamLog 日志条目（`tool_action` / `tool_result`）体现
- 只有父任务 emit `partial → started → completed` 三个 delta 帧
- 已修改 `executeBackgroundTask` 删除子任务的 `emitTaskProgressFrame` 调用（3 处）
- **待验证**：需要用户在真实 UI 中确认子卡片不再出现 "Cancelled"

### 相关代码位置
- `js/utils/cursor-relay-runner.js` → `executeBackgroundTask`（约 line 7910）
- `js/utils/cursor-relay-runner.js` → `emitTaskProgressFrame`（约 line 7596）

---

## 问题 2：Debug 模式仍输出大段纯文本，无原生证据卡片

### 症状
- Debug 模式跑完后，主对话区是大段 textDelta 纯文本
- 子代理卡片内 "Debug Logs" 区域为空或只有合成文本
- 官方对比：官方 Debug 模式有结构化的证据卡片（Read 结果、Diagnostics、Reproduction Steps）

### 根因（部分已诊断）
1. **debug 子代理未真正执行工具**：`buildLocalChildTaskToolPlan` 返回的计划工具（Read/Grep）可能执行失败或返回空结果，导致 `tool_action` / `tool_result` 日志条目为空
2. **TaskStreamLog 日志条目类型不对**：客户端可能期望特定的 `TaskLogItem` 类型顺序（instruction → thought → tool_action → tool_result → output），但当前顺序可能不对
3. **getPostToolTurnAction 的 finalText 仍被当作主输出**：即使改为简短标记，上游 LLM 自己生成的 textDelta 仍会输出到主对话区

### 修复方向（待实施）
- 检查 `buildLocalChildTaskToolPlan` 返回的工具计划是否真正执行成功
- 检查 `executeRelayTool` 在子任务上下文中是否能正确执行 Read/Grep
- 可能需要让 debug 子代理的 TaskStreamLog 推送更多结构化日志条目
- 对比官方 Debug 模式的 TaskStreamLog 帧序列（需要抓包官方流量）

### 相关代码位置
- `js/utils/cursor-relay-runner.js` → `buildLocalChildTaskToolPlan`（约 line 7761）
- `js/utils/cursor-relay-runner.js` → `executeBackgroundTask`（debug 分支）
- `js/mode/debug-mode.js` → `getPostToolTurnAction`

---

## 问题 3：Plan 模式 Ask 确认后罢工（新发现）

### 症状
- Plan 模式中，agent 调用 AskQuestion 工具向用户确认
- 用户点击确认后，agent 不再继续工作，turn 停滞
- requestId: `5bc93042-7b0e-4303-a57c-890c79d9260e`

### 根因（待诊断）
- `plan-mode.js` 的 `shouldFinalizeInteractionResponseTurn` 仅在 `create_plan_request_response` 且 `createPlan.kind === 'success'` 时返回 true
- Ask 确认后的 interaction response 可能不是 `create_plan_request_response` 类型，导致 finalize 逻辑不触发
- `buildCompletedInteractionStatePatch` 在非成功 create_plan 时返回 `current_loop_status: 'completed'`，可能错误地标记 turn 为完成
- 需要检查 Ask 确认后的 interaction response 实际 kind 和结构

### 修复方向（待实施）
1. 在 `plan-mode.js` 中检查 Ask 确认后的 interaction response 结构
2. `shouldFinalizeInteractionResponseTurn` 可能需要额外处理 Ask 确认的情况
3. `buildCompletedInteractionStatePatch` 不应在 Ask 确认后返回 `completed`
4. 需要抓取 Ask 确认后的请求日志确认实际流转

### 相关代码位置
- `js/mode/plan-mode.js` → `shouldFinalizeInteractionResponseTurn`（line 417）
- `js/mode/plan-mode.js` → `buildCompletedInteractionStatePatch`（line 422）
- `js/mode/plan-mode.js` → `isSuccessfulCreatePlanInteractionResponse`（line 379）

---

## 问题 4：整体"还是 agent 那套"的感觉

### 症状
- 用户反馈："感觉还是agent那套了"
- 官方 Multitask/Debug 的 UI 是：主对话区简短，子代理卡片承载所有详细工作
- 当前本地实现：主对话区仍有大量文本输出，子代理卡片是附属品

### 根因
- 上游 LLM（通过 relay）仍然在主对话区生成大量 textDelta
- 本地 mode handler 没有抑制主对话区的文本输出
- 子代理卡片的内容（TaskStreamLog）不够丰富，无法替代主对话区

### 修复方向（长期）
- 研究 Cursor 官方如何在 Multitask/Debug 模式下抑制主对话区文本
- 可能需要在 `cursor-relay-runner.js` 的流处理逻辑中，对 Multitask/Debug 模式减少 textDelta 转发
- 或者让主对话区只显示简短的协调者文本，所有细节走 TaskStreamLog

---

## 下一步优先级

| 优先级 | 问题 | 状态 | 预计难度 |
|--------|------|------|----------|
| P0 | 子 agent "Cancelled"（问题1） | 修复中，待 UI 验证 | 中 |
| P1 | Plan 模式 Ask 后罢工（问题3） | 待诊断 | 中 |
| P2 | Debug 大段纯文本（问题2） | 部分诊断，待抓包对比 | 高 |
| P3 | 整体"还是 agent 那套"（问题4） | 长期优化 | 高 |

---

## 测试命令参考

```powershell
# 单元测试
node scripts/test-task-streamlog-unit.cjs
node scripts/test-round2-native-task-ui.cjs

# 端到端 runner 测试（需要配置好 relay profile）
$env:RELAY_TEST_AGENT_MODES='AGENT_MODE_DEBUG'; node scripts/test-relay-native-modes.cjs
$env:RELAY_TEST_AGENT_MODES='AGENT_MODE_MULTITASK'; node scripts/test-relay-native-modes.cjs

# 解码响应样本
node scripts/decode-cursor-agent-protobuf.cjs "<sample>.response.bin"
```


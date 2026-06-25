# Plan Mode Handoff - 2026-06-23

## 目标

继续把本地 relay 的 `plan mode` 完整复刻到接近官方 Cursor 的链路：

`Ask -> Answers -> Explore project structure -> Plan 卡片 -> Build -> execute_plan_action -> 执行 -> 总结`

本次文档重点记录今晚已经定位清楚的根因、已经落地的修复、还没有完全闭环的问题，以及下一步该怎么继续验证。

## 今晚已经确认并修过的点

### 1. `CreatePlan` 成功后不再一直卡死在 `Planning`

现象：

- `CreatePlan` 已经成功
- `plan.md` 已经落地
- 但可见 `RunSSE` 没有正常 finalize
- UI 会一直停在 `Planning`

本次处理：

- 在 `cursor-relay-runner.js` 中补了 `CreatePlan` 成功后的 finalize 与 checkpoint 呈现逻辑
- 成功的 `create_plan_request_response` 会更新 `plan_workflow`
- 呈现计划后会结束当前交互轮次，而不是无限等待

### 2. history 不再把 `waiting_for_interaction` 覆盖成 `completed`

现象：

- 明明应该等待 `Build`
- 但 history/state 被写成完成态
- 后续 UI 恢复和交互续接都会错

本次处理：

- `cursor-relay-agent-history.js` 的 `completeTurn()` 支持保留 `waiting_for_interaction`
- `cursor-relay-runner.js` 的 `completeSessionHistory()` 也会按等待态保留，而不是强制 completed

### 3. `Ask` 完成后强制补一次新的只读探查再 `CreatePlan`

现象：

- `Ask -> Answers` 后模型容易直接 `CreatePlan`
- 中间缺少你要的 `Explore project structure`

本次处理：

- 在 `plan/system_reminder.txt` 和 `plan-mode.js` 中明确加入约束：
- `AskQuestion` 成功后，下一步不能直接 `CreatePlan`
- 必须先做一次新的只读探查，再综合 Answers 生成计划

### 4. 旧 plan 状态污染新请求的问题已经开始拦截

现象：

- 新 plan 请求复用了旧的 `current_plan_text/current_plans/current_todos`
- 甚至直接读到工作区里旧的 `.cursor/plans/*.plan.md`
- 导致直接跳过 `Ask`，或者新请求把旧 UI 顶掉

已落地修复：

- fresh plan request 进入时会清掉旧的：
  - `current_plan_text`
  - `current_plans`
  - `current_todos`
  - `plan_workflow`
  - `waiting_for_interaction`
- plan 模式的扫描链路里，默认不再把 `.cursor` 当成正常项目结构去探查
- 这样能避免 `.cursor/plans/*.plan.md` 被当作项目文件读到

### 5. 等待中的 plan 会话不再随便吞掉新的普通请求

现象：

- 第二次新请求经常把第一次的 UI 冲掉
- 本质是 relay 只按 `stableConversationId` 把新请求错误接回旧的 waiting session

已落地修复：

- 只有真正的 `start_plan_action / execute_plan_action` 才允许在 `run_request` 阶段复用 waiting session
- 普通新的 `user_message` 只有在文本确实是同一条等待续接消息时才复用
- 否则按 fresh 请求处理，不再强行接回旧等待会话

## 今晚还没有彻底解决的问题

### 1. 还没有确认已经稳定复刻出独立的 `Plan 卡片`

当前状态：

- `plan.md` / checkpoint / waiting state 已经比之前更完整
- 文档内的 `Build` 有时能点
- 但你要的独立 `Plan 卡片` 还没有通过完整实测证明稳定出现

还缺什么：

- 需要继续对比官方 `CreatePlan` 后的帧序列
- 特别看是否还有额外的 `conversation_action` / checkpoint / structured state 更新
- 以及是否存在官方自己的 `Clear Plan` 链路

### 2. 还没有完全验证“第二次新请求 UI 不丢失”

虽然已经修了两个主要污染源：

- 旧 structured plan state 注入
- waiting session 错误复用

但还没有用你最新的完整复现场景重新跑一轮确认：

- 第一次 Ask/Answers UI 还在
- 第二次新请求不会顶掉前一次 UI
- 也不会直接跳过 Ask

### 3. 还没有最终确认 `Build` 只走 `execute_plan_action`

当前目标应该是：

- `Plan 卡片` 出现
- 点击 `Build`
- 走 `execute_plan_action`
- 进入 agent 执行
- 最后总结闭环

现在虽然已经把 `run_request.action.kind` 的分流收紧了，但还需要继续看日志确认：

- `Build` 不会误回到 `create_plan_request_response`
- 不会又掉回 `waiting_for_interaction`
- 不会在 plan 与 agent 之间切错状态

## 下一步建议怎么继续

### 第一优先级：先跑一轮完整新日志

建议明天先直接复现一轮，然后记录新的：

- request id
- 对应 `runner.log` 时间段
- 对应 `history/<stableConversationId>/context.json`
- 对应 `history/<stableConversationId>/state.json`

重点验证三件事：

1. 是否还会直接跳过 `Ask`
2. `Ask -> Answers -> Explore -> Plan 卡片` 是否完整
3. 第二次新请求时，前面的 UI 是否还保留

### 第二优先级：对比官方 `CreatePlan` 后到 `Build` 前的完整帧

重点查：

- 是否有额外 checkpoint
- 是否有 `start_plan_action`
- 是否有 `Clear Plan`
- `current_plan/current_todos/current_plans` 的写入时机

### 第三优先级：验证 `Build` 的 action 分流

重点查日志里这几个字段：

- `run_request.action.kind`
- `conversation_action.kind`
- `interaction_response.kind`
- `plan_workflow.phase`
- `waiting_for_interaction`

目标是确认点击 `Build` 后只能进入：

- `execute_plan_action`
- `AGENT_MODE_AGENT`
- 继续执行，而不是重新 `CreatePlan`

## 今晚关键日志结论

### 已经确认的事实

- 某些“跳过 Ask”的请求，不是模型随机行为
- 是新请求直接读到了旧的 `.cursor/plans/*.plan.md`
- 再叠加旧的 `current_plan_*` 结构化状态，导致直接走 `CreatePlan`

### 已经确认的另一条事实

- 第二次新请求 UI 消失，不只是前端问题
- 还有 relay 会话层的错误复用：
- 新请求被错误接回旧的 waiting session
- 结果旧 UI 被覆盖，新 UI 也不完整

## 本次主要改动文件

- `js/utils/cursor-relay-runner.js`
- `js/utils/cursor-relay-agent-history.js`
- `js/mode/plan-mode.js`
- `js/mode/common/message-builder.js`
- `js/utils/cursor-relay-protocol.js`
- `skills/cursor_modes/plan/system_reminder.txt`

## 明天继续时建议先看

1. `docs/plan-mode-handoff-2026-06-23.md`
2. `js/utils/cursor-relay-runner.js`
3. `C:\\Users\\xiaofan\\.cursorpool\\relay\\runner.log`
4. `C:\\Users\\xiaofan\\.cursorpool\\relay\\history\\`

## 当前结论

今晚不是“已经彻底修好”，而是把最关键的三类根因从日志上钉住了，并且已经把其中最明显的两个入口修掉：

- fresh 请求继承旧 plan structured state
- waiting session 错误吞掉新的普通请求

剩下最核心的未闭环点，是继续对齐官方 `Plan 卡片 -> Build -> execute_plan_action` 的完整帧序列，并用新的 request id 再做一轮实测证明。

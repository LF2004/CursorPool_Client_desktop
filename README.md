# Cursor Relay Local — 本地 Agent 能力还原说明

纯本地版 Cursor Agent 中继工具。不依赖任何远程后端，仅在本机完成：

1. **MITM 代理** — 拦截 Cursor 与官方后端的 gRPC/Connect 流量
2. **协议帧还原** — 解码/编码 Cursor Agent 二进制协议
3. **上游 LLM 转发** — 对接 OpenAI 兼容 `/v1/responses` 或 `/v1/chat/completions`
4. **本地工具执行** — 在本机复刻 Agent 的 read/grep/shell/edit 等工具链
5. **调用记录** — SQLite 本地持久化每次请求的 Token 与费用估算

> 当前版本**已还原 Agent 模式**的核心对话与工具循环。Plan、Ask 等模式尚未完整还原（逆向成本过高）。  
> 实现思路参考 [leookun/cursor-byok](https://github.com/leookun/cursor-byok) leookun大佬的实现思路，协议抓包与 proto 提取参考 [burpheart/cursor-tap](https://github.com/burpheart/cursor-tap)。

---

## 整体架构

```
┌─────────────┐     argv.json + settings.http.proxy      ┌──────────────────┐
│   Cursor    │ ──CONNECT MITM (127.0.0.1:17789)────────▶│ cursor-relay-    │
│   IDE       │     agent.api5.cursor.sh / api2...        │ runner.js        │
└─────────────┘                                          │  (子进程)         │
       ▲                                                 └────────┬─────────┘
       │  Connect Protocol 帧 (protobuf)                           │
       │  RunSSE / BidiAppend                                     │ OpenAI SSE
       └──────────────────────────────────────────────────────────┤
                                                                 ▼
                                                    ┌────────────────────┐
                                                    │ 用户配置的第三方 API │
                                                    │ responses / chat     │
                                                    └────────────────────┘
```

桌面壳层由 Electron 提供 UI；**编排**在 `cursor-relay-proxy.js`，**MITM + Agent 逻辑**在 `cursor-relay-runner.js`，**协议编解码**在 `cursor-relay-protocol.js`。

---

## 核心技术链路

### 1. MITM 代理 + Cursor 环境注入


| 步骤            | 实现位置                             | 说明                                                             |
| ------------- | -------------------------------- | -------------------------------------------------------------- |
| 生成并信任根证书      | `cursor-relay-cert.js`           | 动态 CA，写入 Windows 当前用户 Root 存储                                  |
| 启动 Runner     | `cursor-relay-runner-manager.js` | fork 子进程，默认 `127.0.0.1:17789`                                  |
| 配置 Cursor 走代理 | `cursor-relay-proxy.js`          | 写 `argv.json` 的 `proxy-server`、`proxy-bypass-list`             |
| 扩展 argv 白名单   | patch `main.js`                  | 允许 Electron 识别 proxy 相关启动参数                                    |
| 禁用 HTTP/2 直连  | `cursor-relay-system-proxy.js`   | 写 `settings.json`：`http.proxy` + `cursor.general.disableHttp2` |
| 可选透明 MITM     | `cursor-relay-transparent.js`    | hosts → `127.0.0.1:443`（需管理员，默认关闭）                             |


Runner 对 `*.cursor.sh` 等域名做 **CONNECT 隧道 MITM**：TLS 终止于本地，用动态 leaf 证书与 Cursor 握手，再解析 Connect Protocol 帧。

关键 RPC 路径（Agent 聊天）：

- `/agent.v1.AgentService/RunSSE` — 建立 SSE 会话，服务端持续推送 `AgentServerMessage`
- `/aiserver.v1.BidiService/BidiAppend` — 客户端推送用户消息、工具结果、心跳等

### 2. 协议帧还原（Connect + Protobuf）

Cursor 使用 **Connect Protocol**（gRPC-Web 变体）：

```
[1 byte type][4 byte BE length][payload...]
```

- `type=0/1`：数据帧（可 gzip）
- `type=2`：结束/metadata（JSON）
- `type=3`：错误帧

`cursor-relay-protocol.js` 手写 wire 解析，不依赖完整 protoc 编译链，便于快速迭代：

- `readConnectFrames` / `connectFrame` — 帧读写
- `parseFields` / `decodeVarint` — protobuf 字段遍历
- `decodeBidiAppendRequest` — 从 Bidi 请求中提取 `requestId`、用户文本、图片附件、工作区根路径
- `decodeRunSseRequestId` — 解析 RunSSE 会话 ID
- `summarizeAgentServerStream` — 调试官方响应帧分布

**Proto 定义**来自逆向，见 `proto/agent_v1.proto`（包名 `agent.v1`）。该文件从 Cursor 客户端 JS 中的 `protobuf-es` 产物提取，定义了：

- `AgentClientMessage` / `AgentServerMessage` — 客户端/服务端顶层 oneof
- `InteractionUpdate` — 文本 delta、thinking、tool call started/completed、turn ended
- `ExecServerMessage` — 官方下发给 IDE 执行 read/write/grep/shell 等
- `ExecClientMessage` — IDE 回传工具执行结果

`cursor-relay-protobuf.js` 用 `protobufjs` 加载 proto 做部分 Bidi 编解码；热路径以 `cursor-relay-protocol.js` 手写 builder 为主。

### 3. 上游 LLM 与 SSE 映射

`cursor-relay-runner.js` 在 `local_relay` 模式下：

1. **BidiAppend** 收到 `user_message` → 组装 OpenAI 消息列表（含 system prompt、skills、历史）
2. 按 profile 选择 `**/v1/responses`** 或 `**/v1/chat/completions**`
3. `parseSseStream` + `extractOpenAiDelta`（protocol 层）解析 SSE delta
4. 将文本/thinking 映射为 `buildAgentTextDeltaFrame` / `buildAgentThinkingDeltaFrame`
5. 将 tool call 映射为 `buildAgentPartialToolCallFrame` → `buildAgentToolCallStartedFrame` → 本地执行 → `buildAgentToolCallCompletedFrame`
6. 回合结束发送 `buildAgentTurnEndedFrame`，RunSSE 流保持长连接

兼容策略：若 responses 端点失败，Runner 会尝试 fallback 到 chat completions（见 `buildUpstreamAttempts`）。

### 4. Agent 工具链本地复刻

官方 Agent 有两种工具形态：


| 形态                              | 方向                         | 本项目的处理                                                                  |
| ------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| **InteractionUpdate tool_call** | 模型 → UI 展示                 | 从 OpenAI `tool_calls` 合成 Cursor 原生 tool call 帧                          |
| **ExecServerMessage**           | 服务端 → IDE 执行 read/grep/... | `localNativeAgentTools` 时在 Runner **本地执行**，结果编码为 `ExecClientMessage` 回写 |


本地工具实现（runner 内）包括但不限于：

- `read` / `grep` / `glob` / `ls` — 文件系统与 ripgrep
- `shell` / `shell_stream` — 子进程执行
- `write` / `strreplace` / `delete` — 文件变更
- `todowrite` — Todo 列表 proto 编码
- `diagnostics` — 预留 lint 接口

工具参数与结果通过 `encodeAgentToolArgsPayload` / `encodeAgentToolResultPayload` 对齐 `agent_v1.proto` 中的 **Native Tool Call** 结构（Shell/Read/Grep/Edit 等 oneof 字段号与 cursor-tap 抓包一致）。

Skills 提示词与工具 schema 从 `skills/cursor_modes/agent/` 加载，使本地模型行为接近 Cursor Agent。

### 5. 调用记录

`cursor-relay-usage-store.js`（better-sqlite3）在每次上游请求完成后写入：

- 模型、Token 用量、估算费用、Request ID、Cursor 账户邮箱（从本地 state.vscdb 读取）
- UI 见「调用记录」页，数据不出本机

---

## 三核心文件详解

### `js/utils/cursor-relay-proxy.js` — 编排与集成层

**职责**：桌面端与 Cursor 运行环境之间的「总开关」，不处理 HTTP 细节。

主要能力：


| 函数                              | 作用                                                      |
| ------------------------------- | ------------------------------------------------------- |
| `readCursorRelayProxyConfig`    | 汇总 argv、证书、Runner 状态、诊断统计                               |
| `applyCursorRelayProxyConfig`   | 启停 Relay：装证书 → 启 Runner → 写 argv/settings → 可选重启 Cursor |
| `disableCursorRelayProxyConfig` | 反向清理代理配置                                                |
| `ensureCursorRelayRunner`       | Runner 未运行时按上次配置自启                                      |
| `quickSwitchRelayModel`         | 热切换 profile，无需重启 Cursor                                 |
| `buildRelayDiagnostics`         | 生成 `diagnose.txt`，判断 Agent 是否真正走代理                      |
| `runRelayAgentDialogTest`       | 端到端探活：直连 RunSSE + 可选向 Cursor 发测试消息                      |


与 Electron 的 IPC 面（`main.js` / `preload.js`）：`cursorRelayApply`、`cursorRelayGetConfig`、`cursorRelayDiagnose` 等。

### `js/utils/cursor-relay-runner.js` — MITM 代理 + Agent 中继引擎

**职责**：独立 Node 子进程，监听 `127.0.0.1:17789`（默认）。

结构概览：

```
createServer (HTTP 代理)
  ├─ CONNECT → MITM TLS → onMitmRequest
  │     ├─ RunSSE  → 创建/绑定 AgentSession，pipe 响应帧
  │     └─ BidiAppend → decodeBidiAppendRequest → 触发上游 LLM 或处理 exec 回包
  ├─ /__cursorpool__/health
  └─ 可选 directMitmServer (:443 透明拦截)

AgentSession
  ├─ upstream 配置与消息历史
  ├─ writeAgentFrame → Connect 帧写入 RunSSE 响应流
  └─ runLocalToolLoop → 执行工具 → 编码 ExecClient / InteractionCompleted
```

两种运行模式：

- `**local_relay**`（默认）：解码 → 调上游 → 本地工具 → 编码回 Cursor  
- `**official_passthrough**`：薄代理直通官方，仅记录样本（配合 cursor-tap 式分析）

### `js/utils/cursor-relay-protocol.js` — Agent 二进制协议库

**职责**：Connect + protobuf 的手写工具链（约 2300 行），Runner 与诊断脚本共用。

解码侧：

- `decodeBidiAppendRequest` — 多候选 payload（raw / grpc frame / gzip / hex / lexical JSON）
- `summarizeAgentClientMessagePayload` — 识别 exec_client、run_request、kv 等
- `extractOpenAiDelta` — 统一 OpenAI Responses API 与 Chat Completions 的 SSE 事件

编码侧（还原 Cursor UI 所需帧序列）：

- 文本/thinking：`buildAgentTextDeltaFrame`、`buildAgentThinkingDeltaFrame`
- 工具生命周期：`buildAgentPartialToolCallFrame`、`buildAgentToolCallStartedFrame`、`buildAgentToolCallCompletedFrame`
- 官方 exec 通道：`buildAgentExecReadFrame`、`buildAgentExecGrepFrame`、`buildAgentExecShellStreamFrame` 等
- 会话状态：`buildAgentConversationCheckpointFrame`、`buildAgentTurnEndedFrame`

字段号映射（如 `ExecServerMessage` field 7 = read_args）与 `proto/agent_v1.proto` 保持一致，来源于 cursor-tap 抓包与客户端逆向。

---

## 与 cursor-tap / cursor-byok 的关系


| 项目                                                    | 贡献                                                        |
| ----------------------------------------------------- | --------------------------------------------------------- |
| [cursor-tap](https://github.com/burpheart/cursor-tap) | MITM 抓包、Connect 帧可视化、proto 提取方法论；本项目复用其 `agent.v1` 消息结构认知 |
| [cursor-byok](https://github.com/leookun/cursor-byok) | BYOK 产品思路：在 IDE 内替换模型上游而非改客户端二进制；本项目开源了 Agent 协议层与本地工具执行  |
| `proto/agent_v1.proto`                                | 从 Cursor 客户端提取的 Agent 协议「字典」，是编解码与 tool 复刻的 schema 来源     |


典型逆向工作流：

1. 用 cursor-tap（或本项目的「记录官方 Agent 流量」模式）抓取 RunSSE/BidiAppend 样本
2. 对照 `summarizeAgentServerStream` 输出理解帧类型分布
3. 在 `cursor-relay-protocol.js` 增加/修正 builder
4. 在 Runner 中接线本地工具与上游 SSE 映射

---

## 快速开始

```bash
npm install
npm run dev
```

1. 打开「本地代理」→ 新增模型配置（Base URL、API Key、模型名、端点类型）
2. 点击「启用 Relay」→ 按提示信任 MITM 证书并**完全重启 Cursor**
3. 在 Cursor **Agent** 模式发消息；「调用记录」页可查看本地日志

环境要求：

- Windows（主要开发与测试平台）  
- 已安装 Cursor IDE  
- 第三方 API 需支持 OpenAI 兼容接口；推荐支持 `responses` 流式

---

## 已知限制

- **Plan / Ask 模式**未完整还原（协议分支与 UI 状态机更复杂）  
- Agent 子进程可能直连 `agent.api5.cursor.sh` 绕过系统代理；若诊断显示 RunSSE=0，需完全重启 Cursor 或启用透明 MITM / 外部 Proxifier  
- 部分 MCP / Computer Use 等高级工具尚未实现  
- 需自行承担 API 费用与 Cursor 服务条款合规风险

---

## 目录索引

```
js/utils/cursor-relay-proxy.js    # 编排：argv、证书、Runner 启停
js/utils/cursor-relay-runner.js   # MITM + Agent 会话 + 上游 + 本地工具
js/utils/cursor-relay-protocol.js # Connect/protobuf 编解码
js/utils/cursor-relay-runner-manager.js
js/utils/cursor-relay-cert.js
js/utils/cursor-relay-usage-store.js
js/modules/proxy.js               # Relay UI
js/modules/usage.js               # 调用记录 UI
proto/agent_v1.proto              # Agent 协议定义（逆向）
proto/aiserver_v1.proto           # Bidi 层消息
skills/cursor_modes/agent/        # Agent system prompt & tools schema
```

---

## 许可证与致谢

- 协议逆向与抓包思路致谢 [burpheart/cursor-tap](https://github.com/burpheart/cursor-tap)  
- BYOK / 本地中继思路致谢 [leookun/cursor-byok](https://github.com/leookun/cursor-byok)

本项目仅供学习与研究 Cursor Agent 协议使用，请勿用于违反 Cursor 或模型提供商服务条款的场景。



如需学习讨论交流可加Q群一起讨论

1095670525
点击链接加入群聊【Mirai帆米CursorPool使用群】：https://qm.qq.com/q/SGuNwetVM6
<img  width="820"  alt="image" src="./assets/images/qrcode_1781793808669.jpg" />
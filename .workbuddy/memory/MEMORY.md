# CursorPool Client Desktop - 项目长期记忆

## 项目概述
Electron 32 桌面客户端，用于 Cursor 池子代理管理。核心是 Relay MITM 代理（子进程）
+ Cursor 私有协议解析 + 本地历史记录。技术栈：CommonJS、better-sqlite3、protobufjs、纯原生JS渲染层。

## 关键目录与文件
- `js/utils/cursor-relay-runner.js`：relay runner 子进程本体（~8800行），含上游请求、流式解析、agent主循环
- `js/utils/cursor-relay-runner-manager.js`：runner 子进程启停管理
- `js/utils/cursor-relay-proxy.js`：relay 总入口，编排 runner/证书/模型/进程
- `js/utils/cursor-relay-cert.js`：CA 证书签发（openssl execFileSync）
- `js/utils/cursor-relay-agent-history.js`：历史记录读写（每会话 context.json + state.json）
- `js/utils/relay-response-cache.js`：响应缓存模块（2026-06-25 新增）
- 历史目录：`C:\Users\Administrator\.cursorpool\relay\history\<UUID>\{context.json,state.json}`

## 重要架构知识
- `fetchUpstreamCompletion`（runner.js）是唯一上游出口，所有 agent 请求经此发出
- `streamAgentUpstreamResponse`（runner.js）解析 SSE 流，累积 textParts/reasoningParts
- `parseSseStream`：当 response.body 为 null 时走 response.text() 分支，JSON.parse 失败走 catch → onDelta({text:raw, done:true})。响应缓存利用此机制回放
- 历史记录 items 结构：role(user/assistant/system) + kind(user_message/assistant_text/request_context/prompt_context/metadata) + payload + turn_seq
- `flushAgentTextToHistory` 把累积文本写入 assistant_text 历史项
- runner 是 fork 的子进程（ELECTRON_RUN_AS_NODE=1），内存独立于主进程

## 性能优化记录（2026-06-25）
- 代理启停：waitForRunnerHealth 前快后慢探测、关闭超时缩短、6处 sleep 缩短
- 响应缓存：exact(model+messages) + fuzzy(单轮lastUserText) 两层，历史预热，伪Response回放
- 缓存安全：不缓存 toolCalls/error/多轮fuzzy，LRU 2000条，TTL 7天

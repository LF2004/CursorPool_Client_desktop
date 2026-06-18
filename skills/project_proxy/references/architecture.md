# Project Proxy Architecture

## Intent

This Electron project manages Cursor accounts and also acts as a hybrid Cursor relay controller.

The relay path is designed so Cursor talks to a local proxy first. After interception, the relay either keeps the request in our Relay/upstream path or hands mutation execution back to Cursor native edit flow.

## Main Files

- UI control surface: `js/modules/proxy.js`
- Relay config orchestration: `js/utils/cursor-relay-proxy.js`
- Runner lifecycle: `js/utils/cursor-relay-runner-manager.js`
- Traffic interceptor: `js/utils/cursor-relay-runner.js`
- Protocol encoding and decoding: `js/utils/cursor-relay-protocol.js`
- Cursor proxy settings patcher: `js/utils/cursor-relay-system-proxy.js`
- Transparent MITM helper: `js/utils/cursor-relay-transparent.js`
- Review UI bridge: `js/utils/cursor-relay-review-bridge.js`
- Connectivity test: `js/utils/cursor-relay-agent-test.js`
- Installed Cursor path resolver: `paths.js`

## Runtime Flow

1. The Electron UI collects upstream config.
2. `cursor-relay-proxy.js` applies Cursor-side patching:
   - `main.js` argv allowlist patch
   - `argv.json` proxy settings
   - `settings.json` proxy settings
   - optional CA install
   - optional transparent MITM
   - workbench review bridge patch
3. `cursor-relay-runner-manager.js` writes runner config and starts `cursor-relay-runner.js`.
4. `cursor-relay-runner.js` intercepts Cursor traffic such as:
   - `/agent.v1.AgentService/RunSSE`
   - `/aiserver.v1.BidiService/BidiAppend`
   - `/aiserver.v1.ChatService/StreamUnifiedChatWithTools`
5. The runner classifies the request:
   - read/search/question flows can stay in Relay
   - file mutation flows can be marked for Cursor native passthrough
6. For Relay-handled requests, the runner decodes Cursor frames and adapts them into upstream calls.
7. The runner converts upstream deltas back into Cursor-compatible frames.
8. When local native tool mode is enabled, it is primarily for read/search acceleration and diagnostics, not as the default mutation execution path.

## Important Current Modes

- Plain chat forwarding still exists.
- Hybrid Relay mode is the preferred direction for long-term usability.
- Synthetic edit cards alone are not enough for official Cursor review UI; native mutation fallback plus the workbench review bridge are what preserve the real review experience.

## Diagnostic Signals

- `seenAgentRunSse`
- `seenBidiAppend`
- `seenBidiUserMessage`
- `chatTotal`
- `connectHosts`
- `reviewBridgePatch.reviewBridgePatched`

If `RunSSE/Bidi` are zero, fix transport first. If edits happen but no official undo UI appears, fix workbench diff state.

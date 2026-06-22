# Cursor Reverse Workflow

## Goals

- Prove whether Cursor agent traffic is reaching the local relay.
- Prove whether a request stayed in Relay or intentionally fell back to Cursor native mutation execution.
- Prove whether tool cards are rendered from relay frames or native Cursor tool state.
- Prove whether official review controls come from workbench inline diff state.

## Source Map

- Project relay entry: `js/utils/cursor-relay-proxy.js`
- Relay process launcher: `js/utils/cursor-relay-runner-manager.js`
- Traffic interceptor and upstream adapter: `js/utils/cursor-relay-runner.js`
- gRPC/protobuf frame helpers: `js/utils/cursor-relay-protocol.js`
- Cursor UI review patch: `js/utils/cursor-relay-review-bridge.js`
- Cursor install main entry: `D:/cursor/resources/app/out/main.js`
- Cursor install workbench UI bundle: `D:/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js`

## Investigation Order

1. Check relay status first.
   - `readCursorRelayProxyConfig()` reports argv, settings, runner, cert, transparent MITM, and `reviewBridgePatch`.
   - `buildRelayDiagnostics()` is the fastest proof source for whether traffic is being intercepted.
2. Separate network and UI problems.
   - If `RunSSE` and `BidiAppend` are zero, fix proxy/intercept path first.
   - If a mutation request was intentionally marked for native passthrough, expect Cursor native execution and review controls instead of synthetic local edit playback.
   - If tool cards appear but no official undo bar appears, the relay is producing edit-like frames but Cursor has not attached a real inline diff to the prompt bar.
3. Inspect Cursor installed source, not just this repo.
   - Search `workbench.desktop.main.js` for `Undo File`, `Keep File`, `Review Next File`.
   - Search for `inlineDiffService`, `addDiff`, `addDecorationsOnlyDiff`, `streamDiff`, `updatePromptBar`.
4. Patch the smallest viable layer.
   - Use `main.js` patching only for proxy argv allowlist.
   - Use `workbench.desktop.main.js` patching only for official review UI restoration.
   - Use relay runner changes for transport, request classification, payload adaptation, and non-mutation tool behavior.

## Key Anchors

- Edit card renderer anchor:
  - `const S=lHg(e),E=aym(v),I=di(()=>y==="edit"&&a$g(t),[t,y]),R=`
- Effect insertion anchor:
  - `},[a,V,t,i]);const Be=di(()=>{`
- Workbench diff APIs:
  - `inlineDiffService.addDecorationsOnlyDiff`
  - `inlineDiffService.addDiff`
  - `inlineDiffService.streamDiff`
  - `cmdKStateService.updatePromptBar`

## What To Prove Before Changing Code

- Whether Cursor is reading `argv.json` proxy settings.
- Whether Cursor `settings.json` contains `http.proxy` and `cursor.general.disableHttp2`.
- Whether the runner is intercepting `/agent.v1.AgentService/RunSSE` and `/aiserver.v1.BidiService/BidiAppend`.
- Whether the runner logged a native mutation passthrough decision for the request.
- Whether the workbench patch marker `__cursorPoolRelayReviewBridge` exists in the installed workbench bundle.

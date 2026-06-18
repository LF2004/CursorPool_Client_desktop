# Review Bridge

## Problem

Relay-generated edit cards can show file diffs, but Cursor's official top review controls still depend on local workbench diff state. Without that state, the user sees edits but not the official undo/confirm bar.

## Current Project Fix

The project adds `js/utils/cursor-relay-review-bridge.js`.

It patches installed `workbench.desktop.main.js` and injects logic into the edit tool-call renderer to:

1. Detect relay-rendered edit cards.
2. Resolve the target path to a Cursor URI.
3. Call `inlineDiffService.addDecorationsOnlyDiff(...)`.
4. Mark the diff as attached to the prompt bar.
5. Bind the diff id back into `cmdKStateService.updatePromptBar(...)`.

## Expected Result

- Cursor traffic can still be intercepted by Relay first.
- If a mutation is rendered from relay-generated edit cards, the bridge can attach real workbench diff state to that UI.
- The official workbench review flow regains `Undo File` / `Keep File` style controls because a real inline diff now exists.

## Verification

- `readCursorRelayProxyConfig()` should show `reviewBridgePatch.reviewBridgePatched === true`.
- Installed file should contain `__cursorPoolRelayReviewBridge`.
- After reload/restart, an edit action should show official review controls above the diffable file flow.

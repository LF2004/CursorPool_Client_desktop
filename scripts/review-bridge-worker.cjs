const path = require('path');
const { resolveMainJsPath } = require('../paths');
const {
  patchRelayReviewBridgeInWorkbench,
  restoreRelayReviewBridgeInWorkbench,
  readRelayReviewBridgePatchStatus,
} = require('../js/utils/cursor-relay-review-bridge');

function resolveExplicitMainJsPath(rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return '';
  return resolveMainJsPath(text) || text;
}

function run(action, rawPath) {
  const explicitMainJsPath = resolveExplicitMainJsPath(rawPath);
  switch (String(action || '').trim()) {
    case 'status':
      return readRelayReviewBridgePatchStatus(explicitMainJsPath || undefined);
    case 'apply':
      return patchRelayReviewBridgeInWorkbench(explicitMainJsPath || undefined);
    case 'restore':
      return restoreRelayReviewBridgeInWorkbench(explicitMainJsPath || undefined);
    default:
      throw new Error(`Unsupported action: ${action || 'unknown'}`);
  }
}

try {
  const action = process.argv[2] || '';
  const targetPath = process.argv[3] || '';
  const result = run(action, targetPath);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stderr.write(String(error?.stack || error?.message || error || 'unknown error'));
  process.exitCode = 1;
}

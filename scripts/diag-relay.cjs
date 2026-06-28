const fs = require('fs');
const { resolveMainJsPath } = require('../paths');
const review = require('../js/utils/cursor-relay-review-bridge');
const { probeRunnerHealth, DEFAULT_PORT } = require('../js/utils/cursor-relay-runner-manager');
const { readCursorRelayProxyConfig } = require('../js/utils/cursor-relay-proxy');

async function main() {
  const mainJs = resolveMainJsPath();
  console.log('mainJs:', mainJs || '(not found)');
  if (mainJs) {
    const text = fs.readFileSync(mainJs, 'utf8');
    const hasProxy = ['"proxy-server"', '"proxy-pac-url"', '"no-proxy-server"'].every((n) => text.includes(n));
    console.log('hasProxyWhitelist:', hasProxy);
    console.log('whitelist regex match:', /const e=\[(.*?)\];process\.platform===/s.test(text));
  }
  const wb = review.resolveWorkbenchDesktopMainJsPath(mainJs);
  console.log('workbench:', wb || '(not found)');
  if (wb) {
    const wt = fs.readFileSync(wb, 'utf8');
    console.log('review signature found:', wt.includes('const S=lHg(e),E=aym(v),I=di(()=>y==="edit"&&a$g(t),[t,y]),R='));
    console.log('review effect anchor found:', wt.includes(review.REVIEW_BRIDGE_EFFECT_ANCHOR));
    console.log('inline diff anchor found (legacy):', wt.includes(review.INLINE_DIFF_SERVICE_ANCHOR));
    console.log('inline diff anchor found (current):', wt.includes(review.INLINE_DIFF_SERVICE_ANCHOR_VARIANT));
    console.log('review patched:', review.hasRelayReviewBridgePatch(wt));
  }

  const health = await probeRunnerHealth(DEFAULT_PORT);
  console.log('runner health:', JSON.stringify(health, null, 2));

  const cfg = await readCursorRelayProxyConfig();
  console.log('enabled:', cfg.enabled);
  console.log('proxyServer:', cfg.proxyServer);
  console.log('runner.running:', cfg.runner?.running);
  console.log('runner.healthOk:', cfg.runner?.healthOk);
  console.log('mainJsAllowsProxy:', cfg.mainJsAllowsProxy);
  console.log('reviewBridgePatched:', cfg.reviewBridgePatch?.reviewBridgePatched);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

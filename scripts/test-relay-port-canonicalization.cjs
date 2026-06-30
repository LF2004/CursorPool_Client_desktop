const assert = require('assert');
const proxy = require('../js/utils/cursor-relay-proxy');

async function main() {
  const status = await proxy.readCursorRelayProxyConfig({ lightweight: true });
  const actualRunnerPort = Number(status?.runner?.port || 0);
  const configuredProxyPort = Number(status?.configuredProxyPort || 0);

  assert(actualRunnerPort > 0, 'expected a running or reusable relay port');
  assert.strictEqual(
    Number(status?.frontProxyPort || 0),
    actualRunnerPort,
    `frontProxyPort should prefer actual relay port, got front=${status?.frontProxyPort} runner=${actualRunnerPort}`,
  );

  if (configuredProxyPort && configuredProxyPort !== actualRunnerPort) {
    console.log(`configured proxy port differs: configured=${configuredProxyPort} runner=${actualRunnerPort}`);
  }

  console.log(`relay canonical port ok: ${actualRunnerPort}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

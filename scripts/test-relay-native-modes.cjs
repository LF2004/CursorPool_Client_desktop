const path = require('path');
const {
  loadRelayProfileStore,
} = require('../js/utils/cursor-relay-profile-store');
const {
  startLocalRelayRunner,
  stopLocalRelayRunner,
} = require('../js/utils/cursor-relay-runner-manager');
const {
  runRelayAgentConnectionTest,
} = require('../js/utils/cursor-relay-agent-test');

function relayProfileToUpstream(profile = null) {
  if (!profile || typeof profile !== 'object') return null;
  const modelName = String(profile.modelName || '').trim();
  const baseUrl = String(profile.baseUrl || '').trim();
  const apiKey = String(profile.apiKey || '').trim();
  if (!modelName || !baseUrl || !apiKey) return null;
  return {
    providerId: String(profile.providerId || 'custom').trim() || 'custom',
    displayName: String(profile.name || profile.modelName || '').trim() || modelName,
    baseUrl,
    apiKey,
    modelName,
    endpointMode: String(profile.endpointMode || 'responses').trim() || 'responses',
    reasoningEffort: String(profile.reasoningEffort || 'medium').trim() || 'medium',
    thinkingMode: String(profile.thinkingMode || '').trim(),
    contextWindow: Number(profile.contextWindow) > 0 ? Number(profile.contextWindow) : 200000,
  };
}

function pickActiveUpstream() {
  const store = loadRelayProfileStore('');
  const configs = Array.isArray(store?.configs) ? store.configs : [];
  const activeId = String(store?.activeId || '').trim();
  const activeProfile = configs.find((item) => String(item?.id || '').trim() === activeId)
    || configs.find((item) => String(item?.baseUrl || '').trim() && String(item?.apiKey || '').trim() && String(item?.modelName || '').trim())
    || null;
  const upstream = relayProfileToUpstream(activeProfile);
  if (!upstream) {
    throw new Error('No usable local relay profile found. Configure baseUrl/apiKey/modelName first.');
  }
  return { store, activeProfile, upstream };
}

async function runModeCase({ port, mode, prompt, timeoutMs, dataDir }) {
  const result = await runRelayAgentConnectionTest({
    port,
    mode,
    prompt,
    timeoutMs,
    simulateExecClient: true,
  });
  return {
    mode,
    ok: Boolean(result?.ok),
    requestId: result?.requestId || '',
    targetHost: result?.targetHost || '',
    textPreview: String(result?.text || '').slice(0, 160),
    frameKinds: Array.isArray(result?.frameKinds) ? result.frameKinds : [],
    execServerFrames: Array.isArray(result?.execServerFrames) ? result.execServerFrames : [],
    execReplyCount: Number(result?.execReplyCount || 0),
    latencyMs: Number(result?.latencyMs || 0),
    message: result?.message || '',
    attempts: Array.isArray(result?.attempts) ? result.attempts : [],
    dataDir,
  };
}

async function main() {
  const port = Number(process.env.RELAY_TEST_PORT || 17790);
  const timeoutMs = Number(process.env.RELAY_TEST_TIMEOUT_MS || 45000);
  const dataDir = String(
    process.env.RELAY_TEST_DATA_DIR
    || path.join(process.env.USERPROFILE || process.cwd(), '.cursorpool', `relay-native-modes-${port}`),
  ).trim();
  const prompt = String(
    process.env.RELAY_TEST_PROMPT
    || 'Read the request, think briefly, and reply with exactly NATIVE_OK.'
  ).trim();
  const modes = String(process.env.RELAY_TEST_AGENT_MODES || 'AGENT_MODE_DEBUG,AGENT_MODE_MULTITASK')
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  const { activeProfile, upstream } = pickActiveUpstream();
  let started = null;
  try {
    started = await startLocalRelayRunner({
      mode: 'local_relay',
      upstream,
      port,
      dataDir,
      forceRestartRunner: true,
      localNativeAgentTools: true,
      structuredAgentToolCalls: true,
      nativeMutationTools: true,
      emitLocalToolInteractionFrames: true,
      emitLocalStepFrames: true,
      enableReviewBridge: false,
      historyRoot: path.join(dataDir, 'history'),
    });

    const cases = [];
    for (const mode of modes) {
      // eslint-disable-next-line no-await-in-loop
      cases.push(await runModeCase({ port, mode, prompt, timeoutMs, dataDir }));
    }

    const summary = {
      ok: cases.every((item) => item.ok),
      runner: {
        port,
        proxyServer: started?.proxyServer || '',
        dataDir,
        profileId: String(activeProfile?.id || ''),
        modelName: String(activeProfile?.modelName || upstream.modelName || ''),
        baseUrl: String(upstream.baseUrl || ''),
      },
      cases,
    };

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await stopLocalRelayRunner({ port }).catch(() => null);
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});

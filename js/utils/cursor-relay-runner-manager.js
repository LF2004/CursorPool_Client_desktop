const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { fork } = require('child_process');
const { ensureRelayCertificates, getRelayDataDir } = require('./cursor-relay-cert');
const { initRunnerLogs, getRunnerLogPaths, readRunnerLogTail } = require('./cursor-relay-log');
const { DEFAULT_DIRECT_MITM_PORT } = require('./cursor-relay-transparent');
const { normalizeBaseUrl } = require('./cursor-model-proxy');
const { resolveRelayOutboundProxy } = require('./cursor-relay-system-proxy');

const DEFAULT_PORT = Number(process.env.CURSOR_RELAY_PORT || 17789);
const HEALTH_PATH = '/__cursorpool__/health';
const CONTROL_SHUTDOWN_PATH = '/__cursorpool__/control/shutdown';
const RUNNER_SCRIPT = path.join(__dirname, 'cursor-relay-runner.js');
const CHAT_PATH = '/agent.v1.AgentService/RunSSE + /aiserver.v1.BidiService/BidiAppend';
const RUNNER_MODE_LOCAL_RELAY = 'local_relay';
const RUNNER_MODE_OFFICIAL_PASSTHROUGH = 'official_passthrough';

const runnerOperationState = {
  startPromise: null,
  startKey: '',
  stopPromise: null,
  stopKey: '',
};

let runnerChild = null;
let runnerConfig = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildStartOperationKey(options = {}) {
  const port = Number(options.port || DEFAULT_PORT) || DEFAULT_PORT;
  const mode = normalizeRunnerMode(options.mode || process.env.CURSOR_RELAY_RUNNER_MODE);
  const modelRoutes = normalizeModelRoutes(options.modelRoutes);
  const upstreamPayload = options.upstream && typeof options.upstream === 'object'
    ? { ...options.upstream }
    : {};
  if (upstreamPayload.advancedModelBilling) delete upstreamPayload.advancedModelBilling;
  const upstream = mode === RUNNER_MODE_OFFICIAL_PASSTHROUGH && !options.upstream
    ? buildOfficialPassthroughUpstream()
    : normalizeUpstream(upstreamPayload || {});
  const outboundProxy = options.outboundProxy && typeof options.outboundProxy === 'object'
    ? options.outboundProxy
    : resolveRelayOutboundProxy({ localProxyPorts: [port] });
  const keyPayload = {
    port,
    mode,
    forceRestartRunner: options.forceRestartRunner === true,
    localNativeAgentTools: options.localNativeAgentTools !== false,
    structuredAgentToolCalls: options.structuredAgentToolCalls !== false,
    nativeMutationTools: options.nativeMutationTools !== false,
    nativeMutationApplyMode: String(options.nativeMutationApplyMode || 'cursor'),
    emitAgentKvBootstrap: options.emitAgentKvBootstrap === true,
    emitLocalMutationCheckpoints: options.emitLocalMutationCheckpoints === true,
    emitLocalToolInteractionFrames: options.emitLocalToolInteractionFrames !== false,
    emitAgentExecServerFrames: options.emitAgentExecServerFrames !== false,
    maxLocalToolCallsPerRound: Math.max(1, Math.min(32, Math.floor(Number(options.maxLocalToolCallsPerRound) || 12))),
    enableReviewBridge: options.enableReviewBridge === true,
    directMitmPort: Number(options.directMitmPort) || 0,
    outboundProxy: normalizeOutboundProxyForCompare(outboundProxy),
    upstream: {
      providerId: upstream.providerId,
      baseUrl: upstream.baseUrl,
      modelName: upstream.modelName,
      availableModels: upstream.availableModels,
      endpointMode: upstream.endpointMode,
      reasoningEffort: upstream.reasoningEffort,
      thinkingMode: upstream.thinkingMode,
      contextWindow: upstream.contextWindow,
      apiKey: upstream.apiKey,
    },
    modelRoutes,
  };
  return JSON.stringify(keyPayload);
}


function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function normalizeOutboundProxyForCompare(proxy = null) {
  const enabled = Boolean(proxy?.enabled && proxy?.url);
  return {
    enabled,
    url: enabled ? String(proxy.url || '').trim().replace(/\/$/, '') : '',
  };
}

function outboundProxyMatches(current = null, wanted = null) {
  const currentProxy = normalizeOutboundProxyForCompare(current);
  const wantedProxy = normalizeOutboundProxyForCompare(wanted);
  return currentProxy.enabled === wantedProxy.enabled
    && currentProxy.url === wantedProxy.url;
}

function getRunnerPaths(customRoot) {
  const dataDir = getRelayDataDir(customRoot);
  return {
    dataDir,
    configPath: path.join(dataDir, 'runner-config.json'),
    logPath: path.join(dataDir, 'runner.log'),
  };
}

function normalizeUpstream(upstream = {}) {
  const rawBaseUrl = String(upstream.baseUrl || '').trim();
  const baseUrl = rawBaseUrl ? normalizeBaseUrl(rawBaseUrl) : '';
  const apiKey = String(upstream.apiKey || '').trim();
  const modelName = String(upstream.modelName || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const endpointMode = String(upstream.endpointMode || 'responses').trim().toLowerCase();
  const reasoningEffort = String(upstream.reasoningEffort || 'medium').trim().toLowerCase();
  const thinkingMode = String(upstream.thinkingMode || '').trim().toLowerCase();
  const contextWindow = Number(upstream.contextWindow) > 0 ? Number(upstream.contextWindow) : 250000;
  if (!baseUrl) throw new Error('Upstream baseUrl is required for the local relay runner');
  if (!apiKey) throw new Error('Upstream apiKey is required for the local relay runner');
  const availableModels = Array.isArray(upstream.availableModels)
    ? upstream.availableModels
      .map((item) => String(item || '').trim())
      .filter((item, index, list) => item && list.indexOf(item) === index)
    : [];
  if (!availableModels.includes(modelName)) availableModels.unshift(modelName);
  return {
    providerId: String(upstream.providerId || 'custom').trim() || 'custom',
    baseUrl,
    apiKey,
    modelName,
    availableModels,
    endpointMode: ['responses', 'chat'].includes(endpointMode) ? endpointMode : 'responses',
    reasoningEffort: ['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort) ? reasoningEffort : 'medium',
    thinkingMode: ['enabled', 'disabled'].includes(thinkingMode) ? thinkingMode : '',
    contextWindow,
  };
}

function normalizeModelRoutes(modelRoutes = []) {
  if (!Array.isArray(modelRoutes)) return [];
  const seen = new Set();
  const routes = [];
  for (const item of modelRoutes) {
    if (!item || typeof item !== 'object') continue;
    const modelName = String(item.modelName || '').trim();
    if (!modelName || seen.has(modelName)) continue;
    const routeUpstream = normalizeUpstream(item.upstream || {});
    seen.add(modelName);
    routes.push({
      modelName,
      upstream: routeUpstream,
    });
  }
  return routes;
}

function normalizeRunnerMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === RUNNER_MODE_LOCAL_RELAY || mode === 'relay') return RUNNER_MODE_LOCAL_RELAY;
  return RUNNER_MODE_OFFICIAL_PASSTHROUGH;
}

function buildOfficialPassthroughUpstream() {
  return {
    providerId: 'cursor_official',
    baseUrl: 'https://api2.cursor.sh',
    apiKey: 'official-passthrough',
    modelName: 'cursor-official',
    endpointMode: 'responses',
    reasoningEffort: 'medium',
    thinkingMode: '',
    contextWindow: 250000,
  };
}

function writeRunnerConfig({
  upstream,
  modelRoutes = [],
  port,
  customRoot,
  mode = RUNNER_MODE_OFFICIAL_PASSTHROUGH,
  directMitmPort = 0,
  localNativeAgentTools = true,
  structuredAgentToolCalls = true,
  nativeMutationTools = true,
  nativeMutationApplyMode = 'cursor',
  emitAgentKvBootstrap = false,
  emitLocalMutationCheckpoints = false,
  emitLocalToolInteractionFrames = true,
  emitAgentExecServerFrames = true,
  maxLocalToolCallsPerRound = 12,
  enableReviewBridge = false,
  historyRoot = '',
  advancedModelBilling = null,
  outboundProxy = null,
}) {
  const paths = getRunnerPaths(customRoot);
  const cert = ensureRelayCertificates(customRoot);
  const config = {
    port,
    mode,
    directMitmPort: Number(directMitmPort) || 0,
    mockAgentTools: false,
    mockAgentProtoTools: false,
    localNativeAgentTools: Boolean(localNativeAgentTools),
    structuredAgentToolCalls: Boolean(structuredAgentToolCalls),
    nativeMutationTools: Boolean(nativeMutationTools),
    nativeMutationApplyMode: String(nativeMutationApplyMode || 'cursor'),
    emitAgentKvBootstrap: Boolean(emitAgentKvBootstrap),
    emitLocalMutationCheckpoints: Boolean(emitLocalMutationCheckpoints),
    emitLocalToolInteractionFrames: Boolean(emitLocalToolInteractionFrames),
    emitSyntheticLocalNativeToolFrames: false,
    emitAgentExecServerFrames: Boolean(emitAgentExecServerFrames),
    maxLocalToolCallsPerRound: Math.max(1, Math.min(32, Math.floor(Number(maxLocalToolCallsPerRound) || 12))),
    enableReviewBridge: Boolean(enableReviewBridge),
    historyRoot: String(historyRoot || path.join(paths.dataDir, 'history')),
    logPath: paths.logPath,
    advancedModelBilling: advancedModelBilling && typeof advancedModelBilling === 'object'
      ? advancedModelBilling
      : null,
    outboundProxy: outboundProxy && typeof outboundProxy === 'object'
      ? outboundProxy
      : null,
    cert: {
      leafCertPath: cert.leafCertPath,
      leafKeyPath: cert.leafKeyPath,
      caCertPath: cert.caCertPath,
      fullChainCertPath: cert.fullChainCertPath,
    },
    upstream: normalizeUpstream(upstream),
    modelRoutes: normalizeModelRoutes(modelRoutes),
  };
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { ...paths, config };
}

function probeRunnerHealth(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: HEALTH_PATH,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({
            ok: res.statusCode === 200 && payload?.ok === true,
            statusCode: res.statusCode,
            payload,
          });
        } catch {
          resolve({ ok: false, statusCode: res.statusCode, payload: null });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, payload: null, timedOut: true });
    });
    req.on('error', () => resolve({ ok: false, statusCode: 0, payload: null }));
  });
}

function isPortOpen(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = require('net').connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

function requestRunnerShutdown(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: CONTROL_SHUTDOWN_PATH,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '2',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({
            ok: res.statusCode === 200,
            statusCode: res.statusCode || 0,
            payload: raw ? JSON.parse(raw) : null,
          });
        } catch {
          resolve({ ok: res.statusCode === 200, statusCode: res.statusCode || 0, payload: null });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, payload: null, timedOut: true });
    });
    req.on('error', () => resolve({ ok: false, statusCode: 0, payload: null }));
    req.end('{}');
  });
}

async function waitForRunnerHealth(port, options = {}) {
  const attempts = Number(options.attempts || 10);
  const delayMs = Number(options.delayMs || 100);
  const isExpected = typeof options.isExpected === 'function' ? options.isExpected : null;
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const health = await probeRunnerHealth(port);
    if (health.ok && (!isExpected || isExpected(health))) return health;
    // eslint-disable-next-line no-await-in-loop
    await sleep(delayMs);
  }
  const finalHealth = await probeRunnerHealth(port);
  if (finalHealth.ok && isExpected && !isExpected(finalHealth)) {
    return { ...finalHealth, ok: false, unexpectedRunner: true };
  }
  return finalHealth;
}

function terminateRunnerPid(pid, { force = false } = {}) {
  const targetPid = Number(pid) || 0;
  if (!targetPid) return false;
  try {
    process.kill(targetPid, force ? 'SIGKILL' : 'SIGTERM');
    return true;
  } catch {
    /* ignore */
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(targetPid), '/T', ...(force ? ['/F'] : [])], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function getRunnerScriptFingerprint() {
  try {
    const stat = fs.statSync(RUNNER_SCRIPT);
    return {
      path: RUNNER_SCRIPT,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
    };
  } catch {
    return {
      path: RUNNER_SCRIPT,
      mtime: '',
      size: 0,
    };
  }
}

function runnerUpstreamMatches(healthPayload, upstream, options = {}) {
  if (!healthPayload || !upstream) return false;
  const fingerprint = getRunnerScriptFingerprint();
  if (String(healthPayload.runnerScriptPath || '').toLowerCase() !== String(fingerprint.path || '').toLowerCase()) {
    return false;
  }
  if (String(healthPayload.runnerScriptMtime || '') !== fingerprint.mtime) return false;
  if (Number(healthPayload.runnerScriptSize) !== Number(fingerprint.size)) return false;
  if (String(healthPayload.mode || '') !== String(options.mode || RUNNER_MODE_OFFICIAL_PASSTHROUGH)) return false;
  if (!outboundProxyMatches(healthPayload.outboundProxy || null, options.outboundProxy || null)) return false;
  const baseUrl = String(upstream.baseUrl || '').trim().replace(/\/+$/, '');
  const modelName = String(upstream.modelName || '').trim();
  if (String(healthPayload.upstreamBaseUrl || '').trim().replace(/\/+$/, '') !== baseUrl) return false;
  if (String(healthPayload.upstreamModelName || '').trim() !== modelName) return false;
  const currentAvailableModels = Array.isArray(healthPayload.upstreamAvailableModels)
    ? healthPayload.upstreamAvailableModels.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const wantedAvailableModels = Array.isArray(upstream.availableModels)
    ? upstream.availableModels.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (currentAvailableModels.join('\n') !== wantedAvailableModels.join('\n')) return false;
  const currentModelRoutes = Array.isArray(healthPayload.modelRoutes)
    ? healthPayload.modelRoutes.map((item) => JSON.stringify(item)).filter(Boolean)
    : [];
  const wantedModelRoutes = Array.isArray(options.modelRoutes)
    ? options.modelRoutes.map((item) => JSON.stringify(item)).filter(Boolean)
    : [];
  if (currentModelRoutes.join('\n') !== wantedModelRoutes.join('\n')) return false;
  if (String(healthPayload.upstreamEndpointMode || 'responses') !== String(upstream.endpointMode || 'responses')) {
    return false;
  }
  const wantLocalNative = options.localNativeAgentTools !== false;
  const wantStructured = options.structuredAgentToolCalls !== false;
  const wantNativeMutation = options.nativeMutationTools !== false;
  const wantNativeMutationApplyMode = String(options.nativeMutationApplyMode || 'cursor');
  const wantKvBootstrap = options.emitAgentKvBootstrap === true;
  const wantLocalMutationCheckpoints = options.emitLocalMutationCheckpoints === true;
  const wantLocalToolInteractionFrames = options.emitLocalToolInteractionFrames === true;
  const wantSyntheticFrames = false;
  const wantExecServerFrames = options.emitAgentExecServerFrames === true;
  const wantMaxLocalToolCallsPerRound = Math.max(1, Math.min(32, Math.floor(Number(options.maxLocalToolCallsPerRound) || 12)));
  const wantReviewBridge = options.enableReviewBridge === true;
  if (Boolean(healthPayload.localNativeAgentTools) !== wantLocalNative) return false;
  if (Boolean(healthPayload.structuredAgentToolCalls) !== wantStructured) return false;
  if (Boolean(healthPayload.nativeMutationTools ?? true) !== wantNativeMutation) return false;
  if (String(healthPayload.nativeMutationApplyMode || 'cursor') !== wantNativeMutationApplyMode) return false;
  if (Boolean(healthPayload.emitAgentKvBootstrap) !== wantKvBootstrap) return false;
  if (Boolean(healthPayload.emitLocalMutationCheckpoints) !== wantLocalMutationCheckpoints) return false;
  if (Boolean(healthPayload.emitLocalToolInteractionFrames) !== wantLocalToolInteractionFrames) return false;
  if (Boolean(healthPayload.emitSyntheticLocalNativeToolFrames) !== wantSyntheticFrames) return false;
  if (Boolean(healthPayload.emitAgentExecServerFrames) !== wantExecServerFrames) return false;
  if (Math.max(1, Math.floor(Number(healthPayload.maxLocalToolCallsPerRound) || 0)) !== wantMaxLocalToolCallsPerRound) return false;
  if (Boolean(healthPayload.enableReviewBridge) !== wantReviewBridge) return false;
  return true;
}

function buildRunnerStartResult({
  port,
  written,
  upstream,
  health,
  childPid,
  reused = false,
}) {
  return {
    ok: true,
    running: true,
    pid: childPid || null,
    port,
    directMitmPort: written.config.directMitmPort || 0,
    mode: written.config.mode || health?.payload?.mode || RUNNER_MODE_OFFICIAL_PASSTHROUGH,
    mockAgentTools: false,
    mockAgentProtoTools: false,
    localNativeAgentTools: Boolean(written.config.localNativeAgentTools),
    structuredAgentToolCalls: Boolean(written.config.structuredAgentToolCalls),
    nativeMutationTools: Boolean(written.config.nativeMutationTools),
    nativeMutationApplyMode: String(written.config.nativeMutationApplyMode || 'cursor'),
    emitAgentKvBootstrap: Boolean(written.config.emitAgentKvBootstrap),
    emitLocalMutationCheckpoints: Boolean(written.config.emitLocalMutationCheckpoints),
    emitLocalToolInteractionFrames: Boolean(written.config.emitLocalToolInteractionFrames),
    emitSyntheticLocalNativeToolFrames: false,
    emitAgentExecServerFrames: Boolean(written.config.emitAgentExecServerFrames),
    maxLocalToolCallsPerRound: Number(written.config.maxLocalToolCallsPerRound) || 12,
    enableReviewBridge: Boolean(written.config.enableReviewBridge),
    proxyServer: `http://127.0.0.1:${port}`,
    outboundProxy: written.config.outboundProxy || null,
    health,
    configPath: written.configPath,
    logPath: written.logPath,
    interceptPath: CHAT_PATH,
    upstream: {
      providerId: upstream.providerId,
      baseUrl: upstream.baseUrl,
      modelName: upstream.modelName,
      availableModels: upstream.availableModels || [upstream.modelName],
      endpointMode: upstream.endpointMode,
      reasoningEffort: upstream.reasoningEffort,
      thinkingMode: upstream.thinkingMode,
      contextWindow: upstream.contextWindow,
      apiKeyMasked: maskSecret(upstream.apiKey),
    },
    modelRoutes: Array.isArray(written.config.modelRoutes)
      ? written.config.modelRoutes.map((item) => ({
        modelName: item.modelName,
        upstream: {
          providerId: item.upstream?.providerId,
          baseUrl: item.upstream?.baseUrl,
          modelName: item.upstream?.modelName,
          availableModels: item.upstream?.availableModels || [item.upstream?.modelName].filter(Boolean),
          endpointMode: item.upstream?.endpointMode,
          reasoningEffort: item.upstream?.reasoningEffort,
          thinkingMode: item.upstream?.thinkingMode,
          contextWindow: item.upstream?.contextWindow,
          apiKeyMasked: maskSecret(item.upstream?.apiKey),
        },
      }))
      : [],
    reused,
  };
}

async function waitForRunnerDown(port, attempts = 10, delayMs = 100) {
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const health = await probeRunnerHealth(port, 250);
    if (!health.ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(delayMs);
  }
  const finalHealth = await probeRunnerHealth(port, 250);
  return !finalHealth.ok;
}

async function stopLocalRelayRunner(payload = {}) {
  const port = Number(payload.port || runnerConfig?.port || DEFAULT_PORT);
  const knownChild = runnerChild;
  const knownPid = Number(knownChild?.pid) || 0;
  const fast = payload.fast === true;

  if (runnerOperationState.stopPromise && runnerOperationState.stopKey === String(port)) {
    return runnerOperationState.stopPromise;
  }

  const stopPromise = (async () => {
    let health = null;
  try {
    health = await probeRunnerHealth(port, knownPid ? 300 : 200);
  } catch {
    health = null;
  }
  const healthPid = Number(health?.payload?.pid) || 0;
  const pidSet = new Set([knownPid, healthPid].filter(Boolean));

  runnerChild = null;
  runnerConfig = null;

  if (!pidSet.size) {
    return { ok: true, stopped: false, running: false, port };
  }

  if (fast) {
    requestRunnerShutdown(port, 250).catch(() => null);
    pidSet.forEach((pid) => {
      setTimeout(() => terminateRunnerPid(pid, { force: false }), 50).unref?.();
      setTimeout(() => terminateRunnerPid(pid, { force: true }), 900).unref?.();
    });
    return {
      ok: true,
      stopped: true,
      running: false,
      port,
      terminating: true,
      terminatedPids: Array.from(pidSet),
    };
  }

  await requestRunnerShutdown(port, 700).catch(() => null);

  pidSet.forEach((pid) => {
    terminateRunnerPid(pid, { force: false });
  });

  let down = await waitForRunnerDown(port, 8, 100);
  if (!down) {
    pidSet.forEach((pid) => {
      terminateRunnerPid(pid, { force: true });
    });
    down = await waitForRunnerDown(port, 6, 120);
  }

  return {
    ok: down,
    stopped: true,
    running: false,
    port,
    terminatedPids: Array.from(pidSet),
  };
  })();

  runnerOperationState.stopPromise = stopPromise;
  runnerOperationState.stopKey = String(port);

  try {
    return await stopPromise;
  } finally {
    if (runnerOperationState.stopPromise === stopPromise) {
      runnerOperationState.stopPromise = null;
      runnerOperationState.stopKey = '';
    }
  }
}

async function startLocalRelayRunner(payload = {}) {
  const operationKey = buildStartOperationKey(payload);
  if (runnerOperationState.startPromise && runnerOperationState.startKey === operationKey) {
    return runnerOperationState.startPromise;
  }

  const startPromise = (async () => {
    const port = Number(payload.port || DEFAULT_PORT);
  const customRoot = payload.dataDir || '';
  const forceRestartRunner = payload.forceRestartRunner === true;
  const mode = normalizeRunnerMode(payload.mode || process.env.CURSOR_RELAY_RUNNER_MODE);
  const advancedModelBilling = payload.advancedModelBilling
    || payload.upstream?.advancedModelBilling
    || null;
  const upstreamPayload = payload.upstream && typeof payload.upstream === 'object'
    ? { ...payload.upstream }
    : {};
  if (upstreamPayload.advancedModelBilling) delete upstreamPayload.advancedModelBilling;
  const upstream = mode === RUNNER_MODE_OFFICIAL_PASSTHROUGH && !payload.upstream
    ? buildOfficialPassthroughUpstream()
    : normalizeUpstream(upstreamPayload || {});
  const modelRoutes = normalizeModelRoutes(payload.modelRoutes);
  const localNativeAgentTools = payload.localNativeAgentTools !== false
    && String(process.env.CURSOR_RELAY_LOCAL_NATIVE_TOOLS || '').trim() !== '0';
  const structuredAgentToolCalls = payload.structuredAgentToolCalls !== false
    && (
      payload.structuredAgentToolCalls === true
      || localNativeAgentTools
      || String(process.env.CURSOR_RELAY_STRUCTURED_AGENT_TOOLS || '').trim() === '1'
    );
  const emitSyntheticLocalNativeToolFrames = false;
  const emitAgentExecServerFrames = payload.emitAgentExecServerFrames !== false
    && String(process.env.CURSOR_RELAY_AGENT_EXEC_SERVER_FRAMES || '').trim() !== '0';
  const nativeMutationTools = payload.nativeMutationTools !== false
    && String(process.env.CURSOR_RELAY_NATIVE_MUTATION_TOOLS || '').trim() !== '0';
  const nativeMutationApplyMode = String(
    payload.nativeMutationApplyMode
      || process.env.CURSOR_RELAY_NATIVE_MUTATION_APPLY_MODE
      || 'cursor',
  ).trim() || 'cursor';
  const emitAgentKvBootstrap = payload.emitAgentKvBootstrap === true
    || String(process.env.CURSOR_RELAY_AGENT_KV_BOOTSTRAP || '').trim() === '1';
  const emitLocalMutationCheckpoints = payload.emitLocalMutationCheckpoints === true
    || String(process.env.CURSOR_RELAY_LOCAL_MUTATION_CHECKPOINTS || '').trim() === '1';
  const emitLocalToolInteractionFrames = payload.emitLocalToolInteractionFrames !== false
    && String(process.env.CURSOR_RELAY_LOCAL_TOOL_INTERACTION_FRAMES || '').trim() !== '0';
  const maxLocalToolCallsPerRound = Math.max(1, Math.min(32, Math.floor(Number(
    payload.maxLocalToolCallsPerRound
      || process.env.CURSOR_RELAY_MAX_LOCAL_TOOL_CALLS_PER_ROUND
      || 12,
  ) || 12)));
  const reviewBridgeEnv = String(process.env.CURSOR_RELAY_ENABLE_REVIEW_BRIDGE || '').trim();
  const enableReviewBridge = (payload.enableReviewBridge === true || reviewBridgeEnv === '1') && reviewBridgeEnv !== '0';
  const outboundProxy = payload.outboundProxy && typeof payload.outboundProxy === 'object'
    ? payload.outboundProxy
    : resolveRelayOutboundProxy({ localProxyPorts: [port] });
  const reuseOptions = {
    mode,
    localNativeAgentTools,
    structuredAgentToolCalls,
    nativeMutationTools,
    nativeMutationApplyMode,
    emitAgentKvBootstrap,
    emitLocalMutationCheckpoints,
    emitLocalToolInteractionFrames,
    emitSyntheticLocalNativeToolFrames,
    emitAgentExecServerFrames,
    maxLocalToolCallsPerRound,
    enableReviewBridge,
    outboundProxy,
    modelRoutes,
  };

  const existingHealth = await probeRunnerHealth(port, 250);
  if (
    !forceRestartRunner
    && existingHealth.ok
    && runnerUpstreamMatches(existingHealth.payload, upstream, reuseOptions)
  ) {
    const paths = getRunnerPaths(customRoot);
    runnerConfig = {
      port,
      upstream,
      mode: existingHealth.payload?.mode || mode,
      directMitmPort: Number(existingHealth.payload?.directMitmPort) || 0,
      localNativeAgentTools,
      structuredAgentToolCalls,
      nativeMutationTools,
      nativeMutationApplyMode,
      emitAgentKvBootstrap,
      emitLocalMutationCheckpoints,
      emitLocalToolInteractionFrames,
      emitSyntheticLocalNativeToolFrames,
      emitAgentExecServerFrames,
      maxLocalToolCallsPerRound,
      enableReviewBridge,
      outboundProxy: existingHealth.payload?.outboundProxy || outboundProxy || null,
      modelRoutes,
    };
    if (runnerChild && !runnerChild.killed) {
      /* keep tracked child */
    } else if (existingHealth.payload?.pid) {
      runnerChild = { pid: Number(existingHealth.payload.pid), killed: false };
    }
    return buildRunnerStartResult({
      port,
      written: {
        config: runnerConfig,
        configPath: paths.configPath,
        logPath: paths.logPath,
      },
      upstream,
      health: existingHealth,
      childPid: runnerChild?.pid || existingHealth.payload?.pid || null,
      reused: true,
    });
  }

  await stopLocalRelayRunner({ port });

  const logPaths = initRunnerLogs(customRoot);
  const directMitmPort = Number(payload.directMitmPort) || 0;
  const written = writeRunnerConfig({
    upstream,
    port,
    customRoot,
    mode,
    directMitmPort,
    mockAgentTools: false,
    mockAgentProtoTools: false,
    localNativeAgentTools,
    structuredAgentToolCalls,
    nativeMutationTools,
    nativeMutationApplyMode,
    emitAgentKvBootstrap,
    emitLocalMutationCheckpoints,
    emitLocalToolInteractionFrames,
    emitSyntheticLocalNativeToolFrames,
    emitAgentExecServerFrames,
    maxLocalToolCallsPerRound,
    enableReviewBridge,
    advancedModelBilling,
    outboundProxy,
    modelRoutes,
  });
  runnerConfig = written.config;

  const spawnEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (written.config.outboundProxy?.enabled && written.config.outboundProxy.url) {
    const proxyUrl = String(written.config.outboundProxy.url).trim();
    spawnEnv.HTTP_PROXY = proxyUrl;
    spawnEnv.HTTPS_PROXY = proxyUrl;
    spawnEnv.ALL_PROXY = proxyUrl;
    spawnEnv.http_proxy = proxyUrl;
    spawnEnv.https_proxy = proxyUrl;
    spawnEnv.all_proxy = proxyUrl;
    spawnEnv.NO_PROXY = 'localhost,127.0.0.1,::1';
    spawnEnv.no_proxy = 'localhost,127.0.0.1,::1';
  }

  runnerChild = fork(RUNNER_SCRIPT, ['--config', written.configPath], {
    stdio: 'ignore',
    detached: true,
    env: spawnEnv,
  });

  const childPid = runnerChild.pid;
  runnerChild.on('exit', () => {
    if (runnerChild && runnerChild.pid === childPid) {
      runnerChild = null;
      runnerConfig = null;
    }
  });
  try {
    runnerChild.unref?.();
    runnerChild.channel?.unref?.();
  } catch {
    /* ignore */
  }

  const health = await waitForRunnerHealth(port, {
    attempts: 40,
    delayMs: 150,
    isExpected: (result) => (
      Number(result?.payload?.pid) === Number(childPid)
      && String(result?.payload?.mode || '') === mode
      && String(result?.payload?.upstreamBaseUrl || '').trim() === written.config.upstream.baseUrl
      && String(result?.payload?.upstreamModelName || '').trim() === written.config.upstream.modelName
      && JSON.stringify(result?.payload?.modelRoutes || []) === JSON.stringify(
        Array.isArray(written.config.modelRoutes)
          ? written.config.modelRoutes.map((item) => ({
            modelName: item.modelName,
            upstreamBaseUrl: String(item.upstream?.baseUrl || ''),
            upstreamModelName: String(item.upstream?.modelName || ''),
            upstreamEndpointMode: String(item.upstream?.endpointMode || 'responses'),
          }))
          : [],
      )
    ),
  });
  if (!health.ok) {
    const latestLog = await readRunnerLogTail(customRoot, 120).catch(() => null);
    const portOpen = await isPortOpen(port).catch(() => false);
    const logHint = String(latestLog?.text || '')
      .split(/\r?\n/)
      .filter((line) => /error|EADDRINUSE|listen|throw|failed|certificate|openssl|uncaught/i.test(line))
      .slice(-12)
      .join('\n');
    const detail = [
      `Local relay runner failed health check on 127.0.0.1:${port}`,
      health.unexpectedRunner ? 'An unexpected runner answered on the relay port.' : '',
      portOpen ? 'The relay port is still occupied after restart.' : '',
      logHint ? `Recent runner log:\n${logHint}` : '',
    ].filter(Boolean).join('\n');
    await stopLocalRelayRunner({ port });
    throw new Error(detail);
  }

  return buildRunnerStartResult({
    port,
    written,
    upstream,
    health,
    childPid,
    reused: false,
  });
  })();

  runnerOperationState.startPromise = startPromise;
  runnerOperationState.startKey = operationKey;

  try {
    return await startPromise;
  } finally {
    if (runnerOperationState.startPromise === startPromise) {
      runnerOperationState.startPromise = null;
      runnerOperationState.startKey = '';
    }
  }
}

async function getLocalRelayRunnerStatus(payload = {}) {
  const port = Number(payload.port || runnerConfig?.port || DEFAULT_PORT);
  const paths = getRunnerPaths(payload.dataDir || '');
  const health = await probeRunnerHealth(port);
  const running = Boolean(runnerChild && !runnerChild.killed) || health.ok;
  return {
    running,
    pid: runnerChild?.pid || health.payload?.pid || null,
    port: health.payload?.port || port,
    directMitmPort: health.payload?.directMitmPort || runnerConfig?.directMitmPort || 0,
    mode: health.payload?.mode || runnerConfig?.mode || '',
    mockAgentTools: false,
    mockAgentProtoTools: false,
    localNativeAgentTools: Boolean(health.payload?.localNativeAgentTools || runnerConfig?.localNativeAgentTools),
    structuredAgentToolCalls: Boolean(
      health.payload?.structuredAgentToolCalls || runnerConfig?.structuredAgentToolCalls,
    ),
    nativeMutationTools: Object.prototype.hasOwnProperty.call(health.payload || {}, 'nativeMutationTools')
      ? Boolean(health.payload?.nativeMutationTools)
      : Boolean(runnerConfig?.nativeMutationTools),
    nativeMutationApplyMode: String(health.payload?.nativeMutationApplyMode || runnerConfig?.nativeMutationApplyMode || 'cursor'),
    emitAgentKvBootstrap: Object.prototype.hasOwnProperty.call(health.payload || {}, 'emitAgentKvBootstrap')
      ? Boolean(health.payload?.emitAgentKvBootstrap)
      : Boolean(runnerConfig?.emitAgentKvBootstrap),
    emitLocalMutationCheckpoints: Object.prototype.hasOwnProperty.call(health.payload || {}, 'emitLocalMutationCheckpoints')
      ? Boolean(health.payload?.emitLocalMutationCheckpoints)
      : Boolean(runnerConfig?.emitLocalMutationCheckpoints),
    emitLocalToolInteractionFrames: Object.prototype.hasOwnProperty.call(health.payload || {}, 'emitLocalToolInteractionFrames')
      ? Boolean(health.payload?.emitLocalToolInteractionFrames)
      : Boolean(runnerConfig?.emitLocalToolInteractionFrames),
    emitSyntheticLocalNativeToolFrames: false,
    emitAgentExecServerFrames: Boolean(
      health.payload?.emitAgentExecServerFrames || runnerConfig?.emitAgentExecServerFrames,
    ),
    maxLocalToolCallsPerRound: Number(
      health.payload?.maxLocalToolCallsPerRound || runnerConfig?.maxLocalToolCallsPerRound || 12,
    ),
    enableReviewBridge: Object.prototype.hasOwnProperty.call(health.payload || {}, 'enableReviewBridge')
      ? Boolean(health.payload?.enableReviewBridge)
      : Boolean(runnerConfig?.enableReviewBridge),
    healthOk: health.ok,
    proxyServer: running ? `http://127.0.0.1:${health.payload?.port || port}` : '',
    outboundProxy: runnerConfig?.outboundProxy || health.payload?.outboundProxy || null,
    configPath: paths.configPath,
    logPath: paths.logPath,
    interceptPath: CHAT_PATH,
    upstream: runnerConfig?.upstream
        ? {
            providerId: runnerConfig.upstream.providerId || 'custom',
            baseUrl: runnerConfig.upstream.baseUrl,
            modelName: runnerConfig.upstream.modelName,
            availableModels: Array.isArray(runnerConfig.upstream.availableModels)
              ? runnerConfig.upstream.availableModels
              : [runnerConfig.upstream.modelName],
            endpointMode: runnerConfig.upstream.endpointMode || 'responses',
            reasoningEffort: runnerConfig.upstream.reasoningEffort || 'medium',
            thinkingMode: runnerConfig.upstream.thinkingMode || '',
            contextWindow: runnerConfig.upstream.contextWindow || 250000,
            apiKeyMasked: maskSecret(runnerConfig.upstream.apiKey),
          }
        : health.payload
        ? {
            baseUrl: health.payload.upstreamBaseUrl,
            modelName: health.payload.upstreamModelName,
            availableModels: Array.isArray(health.payload.upstreamAvailableModels)
              ? health.payload.upstreamAvailableModels
              : [health.payload.upstreamModelName],
            endpointMode: health.payload.upstreamEndpointMode || 'responses',
            reasoningEffort: health.payload.upstreamReasoningEffort || 'medium',
            thinkingMode: health.payload.upstreamThinkingMode || '',
            contextWindow: health.payload.upstreamContextWindow || 250000,
            stats: health.payload.stats || null,
          }
        : null,
    stats: health.payload?.stats || null,
  };
}

module.exports = {
  DEFAULT_PORT,
  CHAT_PATH,
  getRunnerPaths,
  getRunnerLogPaths,
  readRunnerLogTail,
  startLocalRelayRunner,
  stopLocalRelayRunner,
  getLocalRelayRunnerStatus,
  probeRunnerHealth,
};

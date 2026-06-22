const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { getCursorAppDataDir } = require('./cursor-local-state');
const { resolveMainJsPath } = require('../../paths');
const {
  isCursorRunningHeuristic,
  getCursorProcessSnapshot,
  forceQuitCursorForRestart,
  quitCursorAndWait,
  launchCursorApp,
  startNewCursorAgentConversation,
  waitForCursorWindowReady,
  reloadRunningCursorWindow,
  focusCursorAndSendChatMessage,
} = require('./cursor-process');
const {
  readModelProxyConfig,
  clearModelProxyConfigOnly,
  syncCursorRelayModelCatalog,
} = require('./cursor-model-proxy');
const {
  loadRelayProfileStore,
  saveRelayProfileStore,
} = require('./cursor-relay-profile-store');
const { getRelayCertStatusReadonly, installRelayCaCertificate, checkRelayCertificates, repairRelayCertificates } = require('./cursor-relay-cert');
const {
  DEFAULT_PORT,
  startLocalRelayRunner,
  stopLocalRelayRunner,
  getLocalRelayRunnerStatus,
  getRunnerLogPaths,
  readRunnerLogTail,
} = require('./cursor-relay-runner-manager');
const { writeUtf8FileWithBom } = require('./cursor-relay-log');
const { ensureCursorAuthIfNeeded } = require('../../update_cursor_auth');
const {
  applyRelaySystemProxy,
  clearRelaySystemProxy,
  readRelayProxyState,
  applyCursorHttpProxySettings,
  clearCursorHttpProxySettings,
} = require('./cursor-relay-system-proxy');
const {
  DEFAULT_DIRECT_MITM_PORT,
  applyTransparentHosts,
  clearTransparentHosts,
  readTransparentHostsStatus,
  snapshotCursorTcpConnections,
} = require('./cursor-relay-transparent');
const {
  patchRelayReviewBridgeInWorkbench,
  restoreRelayReviewBridgeInWorkbench,
  readRelayReviewBridgePatchStatus,
} = require('./cursor-relay-review-bridge');
const { runRelayAgentConnectionTest } = require('./cursor-relay-agent-test');

const DEFAULT_PROXY_BYPASS_LIST = [
  '<-loopback>',
  'localhost',
  '127.0.0.1',
  '::1',
  '*.microsoft.com',
  '*.google.com',
  '*.googleapis.com',
  '*.gstatic.com',
  '*.openai.com',
  'chatgpt.com',
  'chat.openai.com',
  '*.bing.com',
  '*.bytedance.com',
  '*.byteimg.com',
  '*.byteintl.com',
  '*.volccdn.com',
  '*.volcengine.com',
  '*.volceapplog.com',
  '*.snssdk.com',
  '*.zijieapi.com',
  '*.ibytedapm.com',
  '*.bytetos.com',
  '*.bytednsdoc.com',
  '*.bytetcc.com',
  '*.gcloudcache.com',
].join(';');
const PROXY_ARG_KEYS = ['proxy-server', 'proxy-pac-url', 'no-proxy-server', 'proxy-bypass-list'];
const PROXY_ALLOWLIST_KEYS = [
  'disable-hardware-acceleration',
  'force-color-profile',
  'disable-lcd-text',
  'proxy-bypass-list',
  'proxy-server',
  'proxy-pac-url',
  'no-proxy-server',
];
const DEFAULT_ENABLE_REVIEW_BRIDGE = false;
const REVIEW_BRIDGE_LAUNCH_TIMEOUT_MS = 30000;
const RELAY_RUNTIME_STATE_PATH = path.join(getCursorAppDataDir(), 'relay-runtime-state.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function restartCursorAfterRelayCertChange(payload = {}) {
  const shouldRestart = payload.restartCursor === true || payload.autoRestartCursor === true;
  if (!shouldRestart || !isCursorRunningHeuristic()) {
    return {
      ok: true,
      restarted: false,
      skipped: true,
      cursorWasRunning: isCursorRunningHeuristic(),
      message: '',
    };
  }

  const status = await readCursorRelayProxyConfig({ lightweight: true }).catch(() => null);
  const proxyServer = String(
    payload.proxyServer
    || status?.proxyServer
    || status?.runner?.proxyServer
    || '',
  ).trim();
  const proxyBypassList = String(
    payload.proxyBypassList
    || status?.proxyBypassList
    || DEFAULT_PROXY_BYPASS_LIST,
  ).trim();
  const relayCert = getRelayCertStatusReadonly(payload.customRoot);

  const quitResult = await forceQuitCursorForRestart({
    maxWaitMs: Number(payload.quitMaxWaitMs || 5000),
    postKillMs: Number(payload.quitPostKillMs || 250),
  });
  if (!quitResult.ok) {
    return {
      ok: false,
      restarted: false,
      skipped: false,
      cursorWasRunning: true,
      launch: null,
      cursorWindowReady: null,
      message: '无法关闭 Cursor。请先手动完全退出 Cursor 后重试。',
    };
  }

  const launch = launchCursorApp({
    proxyServer,
    proxyBypassList,
    extraCaCertPath: relayCert.caCertPath,
  });
  const restarted = Boolean(launch?.ok);
  const windowReadyTimeoutMs = Number(payload.windowReadyTimeoutMs ?? 0);
  const cursorWindowReady = restarted && windowReadyTimeoutMs > 0
    ? await waitForCursorWindowReady(windowReadyTimeoutMs)
    : null;
  return {
    ok: restarted,
    restarted,
    skipped: false,
    cursorWasRunning: true,
    launch,
    cursorWindowReady,
    message: restarted
      ? 'Cursor 已重启并加载新的 MITM 根证书。'
      : (launch?.message || 'Cursor 重启失败，请手动完全退出 Cursor 后重新打开。'),
  };
}

function readRelayRuntimeState() {
  try {
    if (!fs.existsSync(RELAY_RUNTIME_STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(RELAY_RUNTIME_STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRelayRuntimeState(nextState = {}) {
  const current = readRelayRuntimeState();
  const merged = {
    ...current,
    ...(nextState && typeof nextState === 'object' ? nextState : {}),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(RELAY_RUNTIME_STATE_PATH), { recursive: true });
  fs.writeFileSync(RELAY_RUNTIME_STATE_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

function clearRelayRuntimeState() {
  try {
    if (fs.existsSync(RELAY_RUNTIME_STATE_PATH)) {
      fs.unlinkSync(RELAY_RUNTIME_STATE_PATH);
    }
  } catch {
    /* ignore */
  }
}

function readLastRelayRunnerConfig() {
  try {
    const paths = getRunnerLogPaths();
    const configPath = path.join(path.dirname(paths.primary), 'runner-config.json');
    if (!fs.existsSync(configPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function sanitizeRelayUpstream(upstream = null) {
  if (!upstream || typeof upstream !== 'object') return null;
  const baseUrl = String(upstream.baseUrl || '').trim();
  const apiKey = String(upstream.apiKey || '').trim();
  const modelName = String(upstream.modelName || '').trim();
  if (!baseUrl || !apiKey || !modelName) return null;
  return {
    providerId: String(upstream.providerId || 'custom').trim() || 'custom',
    baseUrl,
    apiKey,
    modelName,
    availableModels: Array.isArray(upstream.availableModels)
      ? upstream.availableModels.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    endpointMode: String(upstream.endpointMode || 'responses').trim() || 'responses',
    reasoningEffort: String(upstream.reasoningEffort || 'medium').trim() || 'medium',
    thinkingMode: ['enabled', 'disabled'].includes(String(upstream.thinkingMode || '').trim())
      ? String(upstream.thinkingMode || '').trim()
      : '',
    contextWindow: Number(upstream.contextWindow) > 0 ? Number(upstream.contextWindow) : 250000,
  };
}

function sanitizeRelayModelRoutes(modelRoutes = []) {
  if (!Array.isArray(modelRoutes)) return [];
  const seen = new Set();
  return modelRoutes
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const modelName = String(item.modelName || '').trim();
      const upstream = sanitizeRelayUpstream(item.upstream);
      if (!modelName || !upstream || seen.has(modelName)) return null;
      seen.add(modelName);
      return { modelName, upstream };
    })
    .filter(Boolean);
}

function relayProfileToUpstream(profile = null) {
  if (!profile || typeof profile !== 'object') return null;
  const modelName = String(profile.modelName || '').trim();
  const baseUrl = String(profile.baseUrl || '').trim();
  const apiKey = String(profile.apiKey || '').trim();
  if (!modelName || !baseUrl || !apiKey) return null;
  return {
    providerId: String(profile.providerId || 'custom').trim() || 'custom',
    baseUrl,
    apiKey,
    modelName,
    endpointMode: String(profile.endpointMode || 'responses').trim() || 'responses',
    reasoningEffort: String(profile.reasoningEffort || 'medium').trim() || 'medium',
    thinkingMode: String(profile.thinkingMode || '').trim(),
    contextWindow: Number(profile.contextWindow) > 0 ? Number(profile.contextWindow) : 250000,
  };
}

function buildRelayModelRoutesFromStore(store = {}) {
  if (!Array.isArray(store?.configs)) return [];
  const seen = new Set();
  return store.configs
    .map((profile) => {
      const upstream = relayProfileToUpstream(profile);
      const modelName = String(profile?.modelName || '').trim();
      if (!upstream || !modelName || seen.has(modelName)) return null;
      seen.add(modelName);
      return { modelName, upstream };
    })
    .filter(Boolean);
}

function buildRelayStartOptionsFromConfig(config = null, overrides = {}) {
  const existing = config && typeof config === 'object' ? config : {};
  const hasReviewBridgeOverride = Object.prototype.hasOwnProperty.call(overrides, 'enableReviewBridge');
  const maxLocalToolCallsPerRound = Math.max(1, Math.min(32, Math.floor(Number(
    overrides.maxLocalToolCallsPerRound
      || existing.maxLocalToolCallsPerRound
      || 12,
  ) || 12)));
  return {
    mode: String(overrides.mode || existing.mode || 'local_relay'),
    directMitmPort: Number(overrides.directMitmPort ?? existing.directMitmPort) || 0,
    localNativeAgentTools: overrides.localNativeAgentTools !== false && existing.localNativeAgentTools !== false,
    structuredAgentToolCalls: overrides.structuredAgentToolCalls !== false && existing.structuredAgentToolCalls !== false,
    emitLocalToolInteractionFrames: overrides.emitLocalToolInteractionFrames !== false,
    emitSyntheticLocalNativeToolFrames: false,
    maxLocalToolCallsPerRound,
    enableReviewBridge: hasReviewBridgeOverride
      ? overrides.enableReviewBridge === true
      : Object.prototype.hasOwnProperty.call(existing, 'enableReviewBridge')
        ? existing.enableReviewBridge === true
        : DEFAULT_ENABLE_REVIEW_BRIDGE,
  };
}

function getCursorUserDir() {
  return path.join(getCursorAppDataDir(), 'User');
}

function getCursorArgvJsonPath() {
  return path.join(getCursorUserDir(), 'argv.json');
}

function stripJsonComments(input) {
  const text = String(input || '');
  let out = '';
  let inString = false;
  let quoteChar = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        out += ch;
      }
      continue;
    }

    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quoteChar) {
        inString = false;
        quoteChar = '';
      }
      continue;
    }

    if ((ch === '"' || ch === "'") && !inString) {
      inString = true;
      quoteChar = ch;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

function readArgvJson() {
  const argvPath = getCursorArgvJsonPath();
  if (!fs.existsSync(argvPath)) {
    return { argvPath, exists: false, data: {} };
  }

  const raw = fs.readFileSync(argvPath, 'utf8');
  const clean = stripJsonComments(raw).trim();
  if (!clean) return { argvPath, exists: true, data: {} };

  try {
    const data = JSON.parse(clean);
    return { argvPath, exists: true, data: data && typeof data === 'object' ? data : {} };
  } catch (error) {
    throw new Error(`Unable to parse argv.json: ${error.message || error}`);
  }
}

function writeArgvJson(data) {
  const argvPath = getCursorArgvJsonPath();
  fs.mkdirSync(path.dirname(argvPath), { recursive: true });
  fs.writeFileSync(argvPath, `${JSON.stringify(data || {}, null, 2)}\n`, 'utf8');
  return argvPath;
}

function parseLocalProxyPort(proxyValue) {
  const text = String(proxyValue || '').trim();
  if (!text) return 0;
  const match = text.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/i);
  return match ? Number(match[1]) || 0 : 0;
}

function hasProxyWhitelist(mainText) {
  return ['"proxy-server"', '"proxy-pac-url"', '"no-proxy-server"'].every((needle) => mainText.includes(needle));
}

function buildWorkbenchRuntimeStatus(reviewBridgePatch, options = {}) {
  const patch = reviewBridgePatch && typeof reviewBridgePatch === 'object'
    ? reviewBridgePatch
    : { exists: false, workbenchPath: '', reviewBridgePatched: false };
  const processSnapshot = options.lightweight === true
    ? { running: isCursorRunningHeuristic(), newestStartTimeMs: 0, windowStartTimeMs: 0, count: 0 }
    : getCursorProcessSnapshot();
  const runtimeState = readRelayRuntimeState();

  const status = {
    exists: Boolean(patch.exists),
    workbenchPath: String(patch.workbenchPath || ''),
    reviewBridgePatched: Boolean(patch.reviewBridgePatched),
    workbenchMtimeMs: 0,
    cursorRunning: Boolean(processSnapshot.running),
    cursorNewestStartTimeMs: Number(processSnapshot.newestStartTimeMs) || 0,
    cursorWindowStartTimeMs: Number(processSnapshot.windowStartTimeMs) || 0,
    cursorProcessCount: Number(processSnapshot.count) || 0,
    requiresCursorRestart: false,
    loadedInRunningCursor: null,
  };

  if (status.workbenchPath && fs.existsSync(status.workbenchPath)) {
    try {
      status.workbenchMtimeMs = Number(fs.statSync(status.workbenchPath).mtimeMs) || 0;
    } catch {
      status.workbenchMtimeMs = 0;
    }
  }

  if (!status.reviewBridgePatched) {
    status.loadedInRunningCursor = false;
    return status;
  }

  if (!status.cursorRunning) {
    status.loadedInRunningCursor = null;
    return status;
  }

  if (!status.workbenchMtimeMs) {
    status.loadedInRunningCursor = null;
    return status;
  }

  const referenceStartTime = status.cursorWindowStartTimeMs || status.cursorNewestStartTimeMs || 0;
  if (!referenceStartTime) {
    status.loadedInRunningCursor = null;
    status.requiresCursorRestart = true;
    return status;
  }

  const lastReloadAt = Number(runtimeState.reviewBridgeReloadedAt || 0);
  const lastReloadWorkbenchMtimeMs = Number(runtimeState.reviewBridgeWorkbenchMtimeMs || 0);
  if (
    lastReloadAt > 0
    && lastReloadWorkbenchMtimeMs > 0
    && lastReloadWorkbenchMtimeMs === status.workbenchMtimeMs
    && referenceStartTime <= lastReloadAt + 15000
  ) {
    status.loadedInRunningCursor = true;
    status.requiresCursorRestart = false;
    return status;
  }

  const loaded = referenceStartTime >= status.workbenchMtimeMs - 1000;
  status.loadedInRunningCursor = loaded;
  status.requiresCursorRestart = !loaded;
  return status;
}

function patchProxySupportInMainJs() {
  const mainJsPath = resolveMainJsPath();
  if (!mainJsPath) {
    throw new Error('Cursor main.js was not found');
  }

  const original = fs.readFileSync(mainJsPath, 'utf8');
  if (hasProxyWhitelist(original)) {
    return { ok: true, mainJsPath, changed: false, alreadyPatched: true };
  }

  const whitelistRegex = /const e=\[(.*?)\];process\.platform===/s;
  const match = original.match(whitelistRegex);
  if (!match) {
    throw new Error('Unable to find Cursor argv allowlist in main.js');
  }

  const currentKeys = [];
  const itemRegex = /"([^"]+)"/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(match[1])) !== null) {
    currentKeys.push(itemMatch[1]);
  }

  const mergedKeys = Array.from(new Set([...currentKeys, ...PROXY_ALLOWLIST_KEYS]));
  const replacement = `const e=[${mergedKeys.map((item) => JSON.stringify(item)).join(',')}];process.platform===`;
  const updated = original.replace(whitelistRegex, replacement);

  if (updated === original) {
    throw new Error('Cursor main.js proxy patch did not change the file');
  }

  fs.writeFileSync(mainJsPath, updated, 'utf8');
  return { ok: true, mainJsPath, changed: true, alreadyPatched: false };
}

function restoreProxySupportInMainJs() {
  const mainJsPath = resolveMainJsPath();
  if (!mainJsPath) {
    return { ok: false, mainJsPath: '', changed: false, alreadyRestored: true };
  }

  const original = fs.readFileSync(mainJsPath, 'utf8');
  const whitelistRegex = /const e=\[(.*?)\];process\.platform===/s;
  const match = original.match(whitelistRegex);
  if (!match) {
    throw new Error('Unable to find Cursor argv allowlist in main.js');
  }

  const currentKeys = [];
  const itemRegex = /"([^"]+)"/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(match[1])) !== null) {
    currentKeys.push(itemMatch[1]);
  }

  const restoredKeys = currentKeys.filter((item) => !PROXY_ALLOWLIST_KEYS.includes(item));
  if (restoredKeys.length === currentKeys.length) {
    return { ok: true, mainJsPath, changed: false, alreadyRestored: true };
  }

  const replacement = `const e=[${restoredKeys.map((item) => JSON.stringify(item)).join(',')}];process.platform===`;
  const updated = original.replace(whitelistRegex, replacement);
  if (updated === original) {
    throw new Error('Cursor main.js proxy restore did not change the file');
  }

  fs.writeFileSync(mainJsPath, updated, 'utf8');
  return { ok: true, mainJsPath, changed: true, alreadyRestored: false };
}

async function readCursorRelayProxyConfig(options = {}) {
  const lightweight = options.lightweight === true;
  const argv = readArgvJson();
  const systemProxy = readRelayProxyState({ skipWindows: lightweight });
  const mainJsPath = resolveMainJsPath();
  const mainJsAllowsProxy = Boolean(
    mainJsPath &&
    fs.existsSync(mainJsPath) &&
    hasProxyWhitelist(fs.readFileSync(mainJsPath, 'utf8')),
  );
  const cert = getRelayCertStatusReadonly();
  const inferredPort = parseLocalProxyPort(argv.data['proxy-server'])
    || parseLocalProxyPort(systemProxy?.cursorSettings?.httpProxy)
    || DEFAULT_PORT;
  const runner = await getLocalRelayRunnerStatus({ port: inferredPort });
  const logPaths = getRunnerLogPaths();
  const log = lightweight
    ? {
      ok: runner.healthOk,
      exists: Boolean(runner.logPath),
      logPath: runner.logPath || logPaths.displayPath,
      displayPath: logPaths.displayPath,
      lines: [],
      text: '',
      hasChatIntercept: runner.running && Number(runner.stats?.chatTotal) > 0,
      stats: runner.stats || null,
      message: runner.running ? 'Runner 正在运行。' : 'Runner 未运行。',
    }
    : await readRunnerLogTail('', lightweight ? 20 : 40, { lightweight });
  const modelProxy = lightweight
    ? null
    : await readModelProxyConfig({ quick: true }).catch(() => null);
  const transparent = readTransparentHostsStatus({ skipElevation: lightweight });
  const reviewBridgePatch = readRelayReviewBridgePatchStatus(mainJsPath);
  const reviewBridgeRuntime = lightweight
    ? {
      exists: Boolean(reviewBridgePatch.exists),
      workbenchPath: String(reviewBridgePatch.workbenchPath || ''),
      reviewBridgePatched: Boolean(reviewBridgePatch.reviewBridgePatched),
      requiresCursorRestart: false,
      loadedInRunningCursor: null,
      lightweight: true,
    }
    : buildWorkbenchRuntimeStatus(reviewBridgePatch);
  return {
    ok: true,
    argvPath: argv.argvPath,
    argvExists: argv.exists,
    mainJsPath: mainJsPath || '',
    mainJsAllowsProxy,
    enabled: Boolean(argv.data['proxy-server'] || argv.data['proxy-pac-url']),
    proxyServer: String(argv.data['proxy-server'] || '').trim(),
    proxyPacUrl: String(argv.data['proxy-pac-url'] || '').trim(),
    proxyBypassList: String(argv.data['proxy-bypass-list'] || '').trim(),
    noProxyServer: Boolean(argv.data['no-proxy-server']),
    frontProxyPort: inferredPort,
    cursorRunning: lightweight ? Boolean(runner.running) : isCursorRunningHeuristic(),
    argv: {
      path: argv.argvPath,
      exists: argv.exists,
      proxyServer: String(argv.data['proxy-server'] || '').trim(),
      proxyPacUrl: String(argv.data['proxy-pac-url'] || '').trim(),
      proxyBypassList: String(argv.data['proxy-bypass-list'] || '').trim(),
      noProxyServer: Boolean(argv.data['no-proxy-server']),
    },
    cert,
    runner: {
      ...runner,
      logPath: runner.logPath || logPaths.primary,
      logDisplayPath: logPaths.displayPath,
      logMirrorPath: logPaths.mirror,
      hasChatIntercept: runner.running && log.hasChatIntercept,
      logHint: runner.running ? log.message : 'Runner 未运行：Cursor 已配置代理，但本地 Relay 进程不可用。',
    },
    log,
    systemProxy,
    transparent,
    reviewBridgePatch,
    reviewBridgeRuntime,
    cursorSettings: modelProxy ? {
      dbExists: Boolean(modelProxy?.dbExists),
      dbPath: modelProxy?.dbPath || '',
      useOpenAIKey: Boolean(modelProxy?.config?.useOpenAIKey),
      openAIBaseUrl: String(modelProxy?.config?.baseUrl || '').trim(),
      providerId: String(modelProxy?.config?.providerId || '').trim(),
      enabled: Boolean(modelProxy?.config?.enabled),
    } : {
      dbExists: false,
      dbPath: '',
      useOpenAIKey: false,
      openAIBaseUrl: '',
      providerId: '',
      enabled: false,
    },
  };
}

async function applyCursorRelayProxyConfig(payload = {}) {
  const requestedRestartCursor = payload.restartCursor === true;
  const reloadCursor = payload.reloadCursor === true && payload.allowWindowFocusSwitch === true;
  const bypassList = String(payload.proxyBypassList || DEFAULT_PROXY_BYPASS_LIST).trim() || DEFAULT_PROXY_BYPASS_LIST;
  const noProxyServer = Boolean(payload.noProxyServer);
  const installCert = payload.installCert !== false;
  const upstream = payload.upstream && typeof payload.upstream === 'object' ? payload.upstream : null;
  const runnerMode = String(payload.mode || 'local_relay');
  const frontProxyPort = Number(payload.frontProxyPort || payload.proxyPort || payload.runnerPort || DEFAULT_PORT);
  const disableHttp2 = payload.disableHttp2 !== false;
  const proxyStrictSSL = payload.proxyStrictSSL === true;
  const enableReviewBridge = Object.prototype.hasOwnProperty.call(payload, 'enableReviewBridge')
    ? payload.enableReviewBridge === true
    : DEFAULT_ENABLE_REVIEW_BRIDGE;
  const restartCursor = requestedRestartCursor;
  let proxyServer = '';
  let proxyPacUrl = '';
  let argvPath = '';
  let patchResult = null;
  let reviewBridgePatchResult = null;
  let systemProxyResult = null;
  let byokCleared = false;
  let certInstallResult = null;
  let modelCatalogSyncResult = null;
  const rollbackPartialApply = async () => {
    try {
      const argv = readArgvJson();
      const next = { ...argv.data };
      PROXY_ARG_KEYS.forEach((key) => delete next[key]);
      writeArgvJson(next);
    } catch {
      /* ignore */
    }
    try {
      clearCursorHttpProxySettings();
    } catch {
      /* ignore */
    }
    try {
      await stopLocalRelayRunner({ port: frontProxyPort, fast: true });
    } catch {
      /* ignore */
    }
  };

  try {

  // 与常见 Cursor 代理插件一致：默认仅 HTTP 代理 + 证书 + argv/settings，不碰 hosts/:443（需管理员）
  const useTransparent = payload.transparentMitm === true && process.platform === 'win32';
  let transparentHosts = { ok: false, skipped: !useTransparent };
  let directMitmPort = 0;
  if (useTransparent) {
    transparentHosts = applyTransparentHosts();
    const hostsStatus = readTransparentHostsStatus();
    if (transparentHosts.ok || hostsStatus.hasBlock) {
      directMitmPort = DEFAULT_DIRECT_MITM_PORT;
    }
  }

  let runner = null;
  let cursorAuthEnsure = null;
  if (upstream && runnerMode !== 'official_passthrough' && payload.ensureCursorAuth !== false && payload.skipCursorAuthEnsure !== true) {
    cursorAuthEnsure = await ensureCursorAuthIfNeeded(
      payload.cursorAuth && typeof payload.cursorAuth === 'object' ? payload.cursorAuth : undefined,
    );
    if (cursorAuthEnsure?.reason === 'missing_local_guest') {
      throw new Error('Cursor 未登录且未找到本地免登账号，请配置 desktop/js/utils/users.json（email + token）');
    }
    if (cursorAuthEnsure?.reason === 'state_vscdb_missing') {
      throw new Error('state.vscdb 不存在，请先启动一次 Cursor');
    }
  }
  if (upstream || runnerMode === 'official_passthrough') {
    const officialPassthrough = runnerMode === 'official_passthrough';
    const localNativeAgentTools = officialPassthrough ? false : true;
    const structuredAgentToolCalls = officialPassthrough ? false : payload.structuredAgentToolCalls !== false;
    if (installCert) {
      certInstallResult = installRelayCaCertificate();
      if (!certInstallResult?.installed) {
        throw new Error(certInstallResult?.message || 'Relay CA certificate install failed.');
      }
    }
    runner = await startLocalRelayRunner({
      mode: runnerMode,
      ...(upstream ? { upstream } : {}),
      modelRoutes: sanitizeRelayModelRoutes(payload.modelRoutes),
      port: frontProxyPort,
      forceRestartRunner: payload.forceRestartRunner === true,
      directMitmPort,
      localNativeAgentTools,
      structuredAgentToolCalls,
      nativeMutationTools: officialPassthrough ? false : payload.nativeMutationTools,
      emitLocalToolInteractionFrames: payload.emitLocalToolInteractionFrames !== false,
      emitSyntheticLocalNativeToolFrames: false,
      maxLocalToolCallsPerRound: payload.maxLocalToolCallsPerRound,
      enableReviewBridge,
    });
    if (upstream && runnerMode !== 'official_passthrough') {
      modelCatalogSyncResult = await syncCursorRelayModelCatalog({
        modelName: upstream.modelName,
        availableModels: upstream.availableModels,
      }).catch((error) => ({
        ok: false,
        skipped: false,
        error: error?.message || String(error || 'sync model catalog failed'),
      }));
    }
  } else {
    runner = await getLocalRelayRunnerStatus({ port: frontProxyPort });
    if (!runner.running) {
      if (payload.forceRestartRunner === true) {
        const lastConfig = readLastRelayRunnerConfig();
        const lastUpstream = sanitizeRelayUpstream(lastConfig?.upstream);
        const lastMode = String(lastConfig?.mode || runnerMode).trim() || runnerMode;
        if (lastUpstream || lastMode === 'official_passthrough') {
          const startOptions = buildRelayStartOptionsFromConfig(lastConfig, {
            mode: lastMode,
            enableReviewBridge,
          });
          runner = await startLocalRelayRunner({
            mode: lastMode,
            ...(lastUpstream ? { upstream: lastUpstream } : {}),
            modelRoutes: sanitizeRelayModelRoutes(lastConfig?.modelRoutes),
            port: frontProxyPort,
            forceRestartRunner: true,
            directMitmPort,
            ...startOptions,
          });
        }
      }
      if (!runner?.running) {
        throw new Error('Local relay runner is not running. Pass upstream config when enabling Relay.');
      }
    }
  }

  proxyServer = String(payload.proxyServer || runner.proxyServer || '').trim();
  proxyPacUrl = String(payload.proxyPacUrl || '').trim();
  if (!proxyServer && !proxyPacUrl) {
    await stopLocalRelayRunner({ port: frontProxyPort });
    throw new Error('proxyServer or proxyPacUrl is required');
  }

  if (restartCursor && isCursorRunningHeuristic()) {
    await quitCursorAndWait({ throwOnTimeout: false });
    await sleep(800);
    if (isCursorRunningHeuristic()) {
      const { killCursorForce } = require('./cursor-process');
      killCursorForce();
      await sleep(1500);
    }
  }

  if (upstream && payload.disableByok === true) {
    const modelProxy = await readModelProxyConfig().catch(() => null);
    const needsByokClear = Boolean(
      modelProxy?.config?.useOpenAIKey ||
      modelProxy?.config?.enabled ||
      modelProxy?.config?.baseUrl,
    );
    if (needsByokClear) {
      const cleared = await clearModelProxyConfigOnly();
      byokCleared = Boolean(cleared?.cleared);
    }
  }

  patchResult = patchProxySupportInMainJs();
  try {
    reviewBridgePatchResult = enableReviewBridge
      ? patchRelayReviewBridgeInWorkbench(patchResult.mainJsPath)
      : restoreRelayReviewBridgeInWorkbench(patchResult.mainJsPath);
  } catch (error) {
    reviewBridgePatchResult = {
      ok: false,
      changed: false,
      alreadyPatched: false,
      workbenchPath: '',
      error: error?.message || String(error || 'review bridge patch failed'),
    };
  }
  const argv = readArgvJson();
  const next = { ...argv.data };

  if (proxyServer) next['proxy-server'] = proxyServer;
  else delete next['proxy-server'];

  if (proxyPacUrl) next['proxy-pac-url'] = proxyPacUrl;
  else delete next['proxy-pac-url'];

  next['proxy-bypass-list'] = bypassList;
  if (noProxyServer) next['no-proxy-server'] = true;
  else delete next['no-proxy-server'];

  argvPath = writeArgvJson(next);
  const useSystemProxy = payload.useSystemProxy === true;
  const cursorSettingsResult = applyCursorHttpProxySettings(proxyServer, {
    disableHttp2,
    proxyStrictSSL,
  });
  systemProxyResult = useSystemProxy
    ? applyRelaySystemProxy(proxyServer, bypassList, {
      disableHttp2,
      proxyStrictSSL,
    })
    : {
      settings: cursorSettingsResult,
      windows: { ok: true, skipped: true },
      message: '已写入 Cursor settings.http.proxy；未修改 Windows 系统代理',
    };

  let restarted = false;
  let cursorWindowReady = null;
  let reloaded = false;
  const runtimePatchChanged = Boolean(patchResult?.changed || reviewBridgePatchResult?.changed);
  const certNeedsCursorRestart = Boolean(
    !restartCursor
    && certInstallResult?.installed
    && (!certInstallResult?.alreadyInstalled || certInstallResult?.removedStale?.removed)
    && isCursorRunningHeuristic()
  );
  const autoRestartForNewCert = Boolean(
    certNeedsCursorRestart
    && payload.autoRestartCursorOnCertInstall !== false
  );
  if (restartCursor) {
    const relayCert = getRelayCertStatusReadonly();
    const launch = launchCursorApp({
      proxyServer,
      proxyBypassList: bypassList,
      extraCaCertPath: relayCert.caCertPath,
    });
    restarted = Boolean(launch?.ok);
    cursorWindowReady = restarted ? await waitForCursorWindowReady(45000) : null;
  } else if (autoRestartForNewCert) {
    await forceQuitCursorForRestart({ maxWaitMs: 5000, postKillMs: 250 });
    const relayCert = getRelayCertStatusReadonly();
    const launch = launchCursorApp({
      proxyServer,
      proxyBypassList: bypassList,
      extraCaCertPath: relayCert.caCertPath,
    });
    restarted = Boolean(launch?.ok);
    cursorWindowReady = null;
  } else if (runtimePatchChanged && enableReviewBridge && isCursorRunningHeuristic()) {
    reloaded = reloadRunningCursorWindow();
    if (reloaded) {
      const patchedWorkbenchPath = String(reviewBridgePatchResult?.workbenchPath || '').trim();
      let workbenchMtimeMs = 0;
      if (patchedWorkbenchPath && fs.existsSync(patchedWorkbenchPath)) {
        try {
          workbenchMtimeMs = Number(fs.statSync(patchedWorkbenchPath).mtimeMs) || 0;
        } catch {
          workbenchMtimeMs = 0;
        }
      }
      writeRelayRuntimeState({
        reviewBridgeReloadedAt: Date.now(),
        reviewBridgeWorkbenchPath: patchedWorkbenchPath,
        reviewBridgeWorkbenchMtimeMs: workbenchMtimeMs,
      });
      await sleep(1500);
    }
  } else if (!runtimePatchChanged && reloadCursor && isCursorRunningHeuristic()) {
    reloaded = reloadRunningCursorWindow();
  }

  const status = await readCursorRelayProxyConfig({ lightweight: true });
  const requiresCursorRestart = (runtimePatchChanged || certNeedsCursorRestart) && !restarted;
  return {
    ok: true,
    argvPath,
    proxyServer,
    frontProxyPort,
    launchArgs: restartCursor ? [`--proxy-server=${proxyServer}`, `--proxy-bypass-list=${bypassList}`, '--disable-quic'] : [],
    proxyPacUrl,
    proxyBypassList: bypassList,
    restarted,
    autoRestartForNewCert,
    cursorWindowReady,
    reloaded,
    hotSwitched: !restartCursor && !requiresCursorRestart,
    requiresCursorRestart,
    certNeedsCursorRestart,
    patchResult,
    reviewBridgePatchResult,
    certInstallResult,
    enableReviewBridge,
    byokCleared,
    systemProxy: systemProxyResult,
    transparent: status.transparent,
    transparentMitm: useTransparent,
    useSystemProxy,
    disableHttp2,
    proxyStrictSSL,
    transparentHosts,
    directMitmPort,
    cursorRunning: isCursorRunningHeuristic(),
    runner: status.runner,
    cert: status.cert,
    cursorSettings: status.cursorSettings,
    argv: status.argv,
    cursorAuthEnsure,
    modelCatalogSyncResult,
  };
  } catch (error) {
    await rollbackPartialApply();
    throw error;
  }
}

async function restartRelayRunnerAfterCertRepair(payload = {}) {
  const status = await readCursorRelayProxyConfig({ lightweight: true });
  const port = Number(payload.frontProxyPort || payload.proxyPort || status.frontProxyPort || DEFAULT_PORT);
  const lastConfig = readLastRelayRunnerConfig();
  const upstream = sanitizeRelayUpstream(payload.upstream) || sanitizeRelayUpstream(lastConfig?.upstream);
  const mode = String(payload.mode || lastConfig?.mode || status.runner?.mode || 'local_relay').trim() || 'local_relay';
  const shouldRestart = status.enabled || status.runner?.running || Boolean(upstream) || mode === 'official_passthrough';

  if (!shouldRestart) {
    return {
      ok: true,
      restarted: false,
      skipped: true,
      message: '',
    };
  }

  if (!upstream && mode !== 'official_passthrough') {
    return {
      ok: false,
      restarted: false,
      skipped: false,
      message: '证书已恢复，但 Runner 未能自动重启（缺少上游配置）。请重新点击「启用 Relay」。',
    };
  }

  try {
    const startOptions = buildRelayStartOptionsFromConfig(lastConfig, {
      mode,
      enableReviewBridge: Object.prototype.hasOwnProperty.call(payload, 'enableReviewBridge')
        ? payload.enableReviewBridge === true
        : status.runner?.enableReviewBridge ?? lastConfig?.enableReviewBridge,
    });
    const runner = await startLocalRelayRunner({
      mode,
      ...(upstream ? { upstream } : {}),
      port,
      forceRestartRunner: true,
      ...startOptions,
    });
    return {
      ok: true,
      restarted: true,
      skipped: false,
      runner,
      message: 'Runner 已重启并加载新证书。',
    };
  } catch (error) {
    return {
      ok: false,
      restarted: false,
      skipped: false,
      message: error?.message || String(error || 'Runner restart failed'),
    };
  }
}

async function repairRelayCertificatesFull(payload = {}) {
  const repair = repairRelayCertificates(payload.customRoot);
  const restart = await restartRelayRunnerAfterCertRepair(payload);
  const cursorRestart = repair.ok
    ? await restartCursorAfterRelayCertChange(payload)
    : {
      ok: true,
      restarted: false,
      skipped: true,
      message: '',
    };
  let message = repair.message || 'Relay 证书恢复已完成。';
  if (restart.restarted) {
    message = 'Relay 证书已重新生成并安装到本地受信任存储。Runner 已重启并加载新证书。';
  } else if (restart.message) {
    message = `${message}\n\n${restart.message}`;
  }
  if (cursorRestart.message) {
    message = `${message}\n\n${cursorRestart.message}`;
  }
  return {
    ...repair,
    runnerRestart: restart,
    cursorRestart,
    message,
  };
}

async function installRelayCaCertificateFull(payload = {}) {
  const install = installRelayCaCertificate(payload.customRoot);
  const changedTrust = Boolean(
    install.installed
    && (!install.alreadyInstalled || install.removedStale?.removed || payload.forceRestartCursor === true)
  );
  const cursorRestart = changedTrust
    ? await restartCursorAfterRelayCertChange(payload)
    : {
      ok: true,
      restarted: false,
      skipped: true,
      cursorWasRunning: isCursorRunningHeuristic(),
      message: '',
    };
  return {
    ...install,
    cursorRestart,
    message: cursorRestart.message
      ? `${install.message || 'Relay CA installed into the current-user Root store.'}\n\n${cursorRestart.message}`
      : install.message,
  };
}

async function ensureCursorRelayRunner(payload = {}) {
  const status = await readCursorRelayProxyConfig({ lightweight: true });
  const port = Number(payload.frontProxyPort || payload.proxyPort || payload.runnerPort || status.frontProxyPort || DEFAULT_PORT);
  const hasReviewBridgePreference = Object.prototype.hasOwnProperty.call(payload, 'enableReviewBridge');
  const lastConfig = readLastRelayRunnerConfig();
  const desiredReviewBridge = hasReviewBridgePreference
    ? payload.enableReviewBridge === true
    : status.runner?.running
      ? Boolean(status.runner?.enableReviewBridge)
      : lastConfig?.enableReviewBridge === true;
  if (
    status.runner?.running
    && Number(status.runner?.port || port) === port
    && Boolean(status.runner?.enableReviewBridge) === desiredReviewBridge
  ) {
    return {
      ok: true,
      started: false,
      reused: true,
      runner: status.runner,
      status,
    };
  }

  const upstream = sanitizeRelayUpstream(payload.upstream)
    || sanitizeRelayUpstream(lastConfig?.upstream);
  if (!upstream) {
    throw new Error('Relay runner 未运行，且没有可用于自启动的上游配置。请先选择模型配置并启用 Relay。');
  }

  const startOptions = buildRelayStartOptionsFromConfig(lastConfig, {
    mode: payload.mode || 'local_relay',
    directMitmPort: payload.directMitmPort,
    localNativeAgentTools: payload.localNativeAgentTools,
    structuredAgentToolCalls: payload.structuredAgentToolCalls,
    emitLocalToolInteractionFrames: payload.emitLocalToolInteractionFrames,
    emitSyntheticLocalNativeToolFrames: payload.emitSyntheticLocalNativeToolFrames,
    maxLocalToolCallsPerRound: payload.maxLocalToolCallsPerRound,
    enableReviewBridge: payload.enableReviewBridge,
  });
  const runner = await startLocalRelayRunner({
    upstream,
    port,
    forceRestartRunner: payload.forceRestartRunner === true,
    ...startOptions,
  });
  const refreshed = await readCursorRelayProxyConfig({ lightweight: true });
  return {
    ok: true,
    started: true,
    reused: Boolean(runner?.reused),
    runner: refreshed.runner || runner,
    status: refreshed,
  };
}

async function quickSwitchRelayModel(payload = {}) {
  const profileId = String(payload.profileId || '').trim();
  if (!profileId) throw new Error('缺少 profileId');

  const store = loadRelayProfileStore('');
  const profile = Array.isArray(store.configs)
    ? store.configs.find((item) => String(item?.id || '') === profileId)
    : null;
  if (!profile) throw new Error('未找到要切换的本地模型配置');

  const upstream = relayProfileToUpstream(profile);
  if (!upstream) throw new Error('目标模型配置不完整，请检查 Base URL、API Key 和模型名');

  store.activeId = profileId;
  saveRelayProfileStore(store, '');

  const modelRoutes = buildRelayModelRoutesFromStore(store);
  const status = await readCursorRelayProxyConfig({ lightweight: true });
  const relayEnabled = Boolean(status?.enabled);
  if (!relayEnabled) {
    const applied = await applyCursorRelayProxyConfig({
      upstream,
      modelRoutes,
      forceRestartRunner: false,
      restartCursor: false,
      reloadCursor: false,
      installCert: false,
      useSystemProxy: false,
      disableByok: true,
      mode: 'local_relay',
      localNativeAgentTools: true,
      structuredAgentToolCalls: true,
      emitLocalToolInteractionFrames: true,
      enableReviewBridge: status?.runner?.enableReviewBridge === true,
      skipCursorAuthEnsure: true,
    });
    return {
      ok: true,
      hotSwitched: Boolean(applied?.hotSwitched),
      enabledFromOff: true,
      profile,
      relay: applied,
    };
  }

  const applied = await applyCursorRelayProxyConfig({
    upstream,
    modelRoutes,
    forceRestartRunner: relayEnabled,
    restartCursor: false,
    reloadCursor: false,
    installCert: false,
    useSystemProxy: false,
    disableByok: true,
    mode: status?.runner?.mode || 'local_relay',
    localNativeAgentTools: status?.runner?.localNativeAgentTools !== false,
    structuredAgentToolCalls: status?.runner?.structuredAgentToolCalls !== false,
    emitLocalToolInteractionFrames: status?.runner?.emitLocalToolInteractionFrames !== false,
    maxLocalToolCallsPerRound: status?.runner?.maxLocalToolCallsPerRound || 12,
    enableReviewBridge: status?.runner?.enableReviewBridge === true,
    skipCursorAuthEnsure: true,
  });
  return {
    ok: true,
    hotSwitched: Boolean(applied?.hotSwitched),
    enabledFromOff: false,
    profile,
    relay: applied,
  };
}

async function disableCursorRelayProxyConfig(payload = {}) {
  const restartCursor = payload.restartCursor === true;
  const reloadCursor = payload.reloadCursor === true && payload.allowWindowFocusSwitch === true;
  const transparentHosts = clearTransparentHosts();
  const clearSystemProxy = payload.clearSystemProxy === true;
  clearRelayRuntimeState();
  const cursorWasRunning = isCursorRunningHeuristic();
  const resetActiveAgentConversation = payload.resetActiveAgentConversation !== false && cursorWasRunning && !restartCursor;
  const stopRunnerFast = payload.fast === true && !resetActiveAgentConversation;

  if (restartCursor && cursorWasRunning) {
    await quitCursorAndWait({ throwOnTimeout: false });
    await sleep(800);
  }

  const argv = readArgvJson();
  const next = { ...argv.data };
  PROXY_ARG_KEYS.forEach((key) => delete next[key]);
  const argvPath = writeArgvJson(next);
  const cursorSettingsResult = clearCursorHttpProxySettings();
  const systemProxyResult = clearSystemProxy
    ? clearRelaySystemProxy()
    : {
      settings: cursorSettingsResult,
      windows: { ok: true, skipped: true },
      ok: true,
      skipped: true,
    };
  const mainJsRestoreResult = restoreProxySupportInMainJs();
  const reviewBridgeRestoreResult = restoreRelayReviewBridgeInWorkbench();

  let restarted = false;
  let reloaded = false;
  let runnerStopped = false;
  let agentConversationReset = { ok: false, skipped: true, message: '未请求切换 Agent 对话' };
  const runtimePatchChanged = Boolean(mainJsRestoreResult?.changed || reviewBridgeRestoreResult?.changed);
  if (restartCursor) {
    const launch = launchCursorApp({
      extraCaCertPath: getRelayCertStatusReadonly().caCertPath,
    });
    restarted = Boolean(launch?.ok);
    await stopLocalRelayRunner();
    runnerStopped = true;
  } else if (payload.fast === true || payload.stopRunner === true || payload.stopRunner !== false) {
    await stopLocalRelayRunner({ fast: stopRunnerFast });
    runnerStopped = true;
  } else if (!runtimePatchChanged && reloadCursor && isCursorRunningHeuristic()) {
    reloaded = reloadRunningCursorWindow();
  }

  if (!restartCursor && !isCursorRunningHeuristic()) {
    await stopLocalRelayRunner();
    runnerStopped = true;
  }

  if (resetActiveAgentConversation) {
    await sleep(250);
    agentConversationReset = startNewCursorAgentConversation();
  }

  const status = await readCursorRelayProxyConfig({ lightweight: true });
  return {
    ok: true,
    argvPath,
    restarted,
    reloaded,
    runnerStopped,
    hotSwitched: !restartCursor && !runtimePatchChanged,
    requiresCursorRestart: runtimePatchChanged,
    agentConversationReset,
    mainJsRestoreResult,
    reviewBridgeRestoreResult,
    systemProxy: systemProxyResult,
    transparent: status.transparent,
    transparentHosts,
    cursorRunning: isCursorRunningHeuristic(),
    runner: status.runner,
    cert: status.cert,
    cursorSettings: status.cursorSettings,
    argv: status.argv,
  };
}

async function buildRelayDiagnostics() {
  const status = await readCursorRelayProxyConfig();
  const log = await readRunnerLogTail('', 60);
  const stats = status.runner?.stats || log.stats || {};
  const connectMitm = Number(stats.connectMitm || 0);
  const directTls = Number(stats.directTlsRequests || 0);
  const directTlsConnects = Number(stats.directTlsConnects || 0);
  const seenRunSse = Number(stats.seenAgentRunSse || 0);
  const seenBidi = Number(stats.seenBidiAppend || 0);
  const seenUser = Number(stats.seenBidiUserMessage || 0);
  const chatTotal = Number(stats.chatTotal || 0);
  const transparent = status.transparent || readTransparentHostsStatus();
  const tcpSnapshot = snapshotCursorTcpConnections();

  const recentPaths = Array.isArray(stats.recentPaths) ? stats.recentPaths : [];
  const connectHosts = stats.connectHosts && typeof stats.connectHosts === 'object'
    ? stats.connectHosts
    : {};

  const issues = [];
  const hints = [];
  const proven = [];
  const inferred = [];

  if (!status.runner?.running) issues.push('本地 runner 未运行');
  if (!status.enabled) issues.push('argv.json 未配置 proxy-server');
  if (!status.mainJsAllowsProxy) issues.push('Cursor main.js 未打代理白名单补丁');
  if (!status.cert?.caInstalled) issues.push('MITM 根证书未安装到系统信任库');
  if (status.cursorRunning && !status.argv?.proxyServer) {
    issues.push('Cursor 正在运行但 argv 里没有 proxy-server（需完全重启 Cursor）');
  }
  if (!status.systemProxy?.cursorSettings?.httpProxy) {
    issues.push('Cursor settings.json 未设置 http.proxy（扩展/Node 可能不走 argv 代理）');
  } else if (
    status.runner?.proxyServer
    && status.systemProxy.cursorSettings.httpProxy
    && status.systemProxy.cursorSettings.httpProxy !== status.runner.proxyServer
  ) {
    issues.push(`Cursor settings.json 的 http.proxy 指向 ${status.systemProxy.cursorSettings.httpProxy}，不是本地 Relay ${status.runner.proxyServer}（可能被第三方插件接管）`);
    proven.push(`检测到扩展/Node 代理入口: ${status.systemProxy.cursorSettings.httpProxy}`);
  }
  if (status.systemProxy?.cursorSettings?.disableHttp2 !== true) {
    issues.push('Cursor settings.json 未开启 cursor.general.disableHttp2，Auto/Agent 可能继续走 h2 直连链路');
    hints.push('已知第三方代理会同时写入 cursor.general.disableHttp2=true；建议保持开启');
  } else {
    proven.push('Cursor settings.json 已开启 cursor.general.disableHttp2=true');
  }
  if (status.systemProxy?.cursorSettings?.proxyStrictSSL !== false) {
    hints.push('当前 http.proxyStrictSSL 不是 false；若本地 MITM 证书链仍异常，可继续比对这一项');
  }
  const transparentActive = Boolean(status.runner?.directMitmPort || transparent.hasBlock);
  if (transparentActive && transparent.hasBlock && !status.runner?.directMitmPort) {
    issues.push('hosts 已指向 127.0.0.1 但 runner 未监听 :443（透明 MITM 未生效）');
  }
  if (transparentActive && !transparent.hasBlock) {
    issues.push('已请求透明 MITM 但 hosts 未写入（需管理员或手动改 hosts）');
  }
  const hostKeys = Object.keys(connectHosts);
  const seenApi5 = hostKeys.some((h) => /api5\.cursor\.sh/i.test(h));
  const seenAgentApi = hostKeys.some((h) => /agent(api|n)?\.api/i.test(h));
  if (connectMitm > 5 && !seenApi5 && !seenAgentApi) {
    proven.push('MITM 流量仅有 api2/api3 等，未见 api5/agent.api5（Auto Agent 常用端点）');
    inferred.push('Agent 聊天很可能直连官方 IP，未经过 127.0.0.1:17789');
  }
  if (seenApi5 || seenAgentApi) {
    proven.push(`已 MITM Agent 相关域名: ${hostKeys.filter((h) => /api5|agent\.api/i.test(h)).join(', ') || 'yes'}`);
  }
  if (directTlsConnects > 0) {
    proven.push(`透明 TLS 入站连接: ${directTlsConnects}（hosts→127.0.0.1:443 已命中）`);
  }
  if (directTls > 0 && seenRunSse === 0) {
    inferred.push(`透明 MITM 已处理 ${directTls} 个 HTTP 请求，但尚无 RunSSE`);
  }
  if (connectMitm > 5 && seenRunSse === 0 && seenBidi === 0 && directTls === 0) {
    issues.push('已有 MITM（多为 api2 仪表盘/命名）但无 RunSSE/Bidi：Auto Agent 未走本代理');
    hints.push('Relay 已尽量对齐常见插件：argv + settings.http.proxy（默认不改系统全局代理）');
    hints.push('请完全退出 Cursor 后重开，在 Auto 发新消息再诊断');
    hints.push('若仍为零：Agent 子进程直连 api5/agent.api5，需 Proxifier 指到 127.0.0.1:17789，或自愿开启 transparentMitm（改 hosts，需管理员）');
  }
  if (connectMitm > 5 && seenRunSse === 0 && seenBidi === 0 && directTls > 0) {
    issues.push('透明 MITM 有流量但无 RunSSE：路径可能仍不是 Agent 聊天 RPC');
  }
  if (seenRunSse > 0 && seenUser === 0) {
    hints.push('已看到 RunSSE，等待 BidiAppend 用户消息（可再发一条聊天）');
  }
  if (seenUser > 0 && chatTotal === 0) {
    hints.push('已看到用户消息但未 chat intercept，可能是 protobuf 解码或上游失败');
  }
  if (chatTotal > 0) {
    hints.push('聊天拦截已成功，Relay 正在工作');
  }
  if (status.systemProxy?.windows?.enabled && connectMitm > 5 && seenRunSse === 0) {
    hints.push('若曾开启系统全局代理：可停用 Relay 一次以恢复，再启用（现已默认不再写系统代理）');
  }

  const verdict = chatTotal > 0
    ? 'chat_intercept_ok'
    : connectMitm > 5 && seenRunSse === 0 && seenBidi === 0
      ? 'agent_chat_likely_bypasses_proxy'
      : !status.runner?.running
        ? 'runner_down'
        : 'waiting_for_chat';

  const summaryLines = [
    '[SUMMARY - ASCII]',
    `encoding=UTF-8-BOM (open with Notepad Win10+ or VS Code, not GBK)`,
    `verdict=${verdict}`,
    `runner=${status.runner?.running ? 'up' : 'down'} http_proxy=${status.runner?.port || '-'}`,
    `connect=${stats.connectTotal ?? 0} mitm=${connectMitm} h2=${stats.connectH2 ?? 0}`,
    `run_sse=${seenRunSse} bidi=${seenBidi} user_msg=${seenUser} chat_intercept=${chatTotal}`,
    `transparent_443=${status.runner?.directMitmPort || 0}`,
    `mitm_api5=${Object.keys(connectHosts).some((h) => /api5|agent\.api/i.test(h)) ? 'yes' : 'no'}`,
    '',
  ];

  const lines = [
    ...summaryLines,
    '=== CursorPool Relay 诊断 ===',
    '# 本文件为 UTF-8（带 BOM）。若中文乱码，请勿用 GBK 打开。',
    `时间: ${new Date().toISOString()}`,
    '',
    '[Runner]',
    `运行: ${status.runner?.running ? '是' : '否'} | HTTP 代理: ${status.runner?.port || '-'}`,
    `透明 MITM: ${status.runner?.directMitmPort ? `0.0.0.0:${status.runner.directMitmPort}` : '未启用'}`,
    `CONNECT: ${stats.connectTotal ?? 0} | MITM: ${connectMitm} | H2: ${stats.connectH2 ?? 0}`,
    `透明请求: ${directTls} | 透明 TLS 连接: ${directTlsConnects}`,
    `RunSSE: ${seenRunSse} | BidiAppend: ${seenBidi} | 用户消息: ${seenUser} | 聊天拦截: ${chatTotal}`,
    '',
    '[透明拦截 hosts（可选，默认关）]',
    `已写入: ${transparent.hasBlock ? '是' : '否'} | runner :443: ${status.runner?.directMitmPort ? '是' : '否'}`,
    `hosts 文件: ${transparent.hostsPath || '-'}`,
    '',
    '[已证实]',
    ...(proven.length ? proven.map((item) => `  - ${item}`) : ['  （暂无额外观测）']),
    '',
    '[推断]',
    ...(inferred.length ? inferred.map((item) => `  - ${item}`) : ['  （暂无）']),
    '',
    '[Cursor 代理配置]',
    `argv proxy-server: ${status.argv?.proxyServer || '-'}`,
    `settings http.proxy: ${status.systemProxy?.cursorSettings?.httpProxy || '-'}`,
    `settings cursor.general.disableHttp2: ${String(status.systemProxy?.cursorSettings?.disableHttp2)}`,
    `settings http.proxyStrictSSL: ${String(status.systemProxy?.cursorSettings?.proxyStrictSSL)}`,
    `Windows 系统代理: ${status.systemProxy?.windows?.enabled ? status.systemProxy.windows.server : '未启用'}`,
    `main.js 补丁: ${status.mainJsAllowsProxy ? '已打' : '未打'}`,
    `workbench review bridge: ${status.reviewBridgePatch?.reviewBridgePatched ? '已打' : '未打'}`,
    `workbench 已加载到当前 Cursor: ${status.reviewBridgeRuntime?.loadedInRunningCursor === true ? '是' : status.reviewBridgeRuntime?.requiresCursorRestart ? '否（需重启）' : '-'}`,
    `MITM 证书: ${status.cert?.caInstalled ? '已信任' : '未信任'}`,
    `Cursor 进程: ${status.cursorRunning ? '运行中' : '未运行'}`,
    '',
    '[MITM 域名统计]',
    ...Object.entries(connectHosts).sort((a, b) => b[1] - a[1]).map(([host, count]) => `  ${host}: ${count}`),
    '',
    '[最近请求路径]',
    ...(recentPaths.length ? recentPaths.map((item) => `  ${item}`) : ['  （暂无）']),
    '',
    '[Cursor :443 TCP 归属快照]',
    ...(tcpSnapshot.text ? tcpSnapshot.text.split('\n').map((line) => `  ${line}`) : ['  （无）']),
    '',
    '[问题]',
    ...(issues.length ? issues.map((item) => `  - ${item}`) : ['  （无）']),
    '',
    '[建议]',
    ...(hints.length ? hints.map((item) => `  - ${item}`) : ['  发 Auto 消息后刷新诊断']),
    '',
    '[最近日志]',
    log.text || '（无）',
    '',
    `日志文件: ${log.logPath || log.displayPath || '-'}`,
  ];

  const text = lines.join('\n');
  const summary = [
    verdict === 'chat_intercept_ok' ? '聊天拦截已成功' : '',
    verdict === 'agent_chat_likely_bypasses_proxy'
      ? `MITM ${connectMitm} 次但 RunSSE/Bidi=0：Agent 未走 17789（常见只打到 api2 NameTab）`
      : '',
    verdict === 'runner_down' ? 'Runner 未运行' : '',
    verdict === 'waiting_for_chat' ? '等待 Auto 聊天请求' : '',
    `CONNECT ${stats.connectTotal ?? 0} | MITM ${connectMitm} | RunSSE ${seenRunSse} | 拦截 ${chatTotal}`,
  ].filter(Boolean).join('\n');

  const paths = getRunnerLogPaths();
  let diagnosePath = '';
  try {
    diagnosePath = path.join(path.dirname(paths.displayPath || paths.primary), 'diagnose.txt');
    writeUtf8FileWithBom(diagnosePath, `${text}\n`);
  } catch {
    diagnosePath = '';
  }

  return {
    ok: true,
    text,
    summary,
    verdict,
    diagnosePath,
    issues,
    hints,
    stats,
    recentPaths,
    connectHosts,
    chatLikelyBypassing: connectMitm > 5 && seenRunSse === 0 && seenBidi === 0,
    hasChatIntercept: chatTotal > 0 || log.hasChatIntercept,
  };
}

async function disableByokForRelay(payload = {}) {
  const restartCursor = payload.restartCursor !== false;
  if (restartCursor && isCursorRunningHeuristic()) {
    await quitCursorAndWait({ throwOnTimeout: false });
    await sleep(800);
  }
  const cleared = await clearModelProxyConfigOnly();
  let restarted = false;
  if (restartCursor) {
    const argv = readArgvJson();
    const proxyServer = String(argv.data['proxy-server'] || '').trim();
    const relayCert = getRelayCertStatusReadonly();
    const launch = launchCursorApp({
      proxyServer,
      proxyBypassList: String(argv.data['proxy-bypass-list'] || DEFAULT_PROXY_BYPASS_LIST).trim(),
      extraCaCertPath: relayCert.caCertPath,
    });
    restarted = Boolean(launch?.ok);
  }
  const status = await readCursorRelayProxyConfig({ lightweight: true });
  return {
    ok: true,
    cleared: Boolean(cleared?.cleared),
    restarted,
    cursorSettings: status.cursorSettings,
  };
}

function buildRelayAgentTestPrompt(token) {
  return `请只回复这一行，不要其它内容：【${token}】`;
}

function createRelayAgentTestToken() {
  return `CursorPool-${crypto.randomBytes(3).toString('hex')}`;
}

async function waitForRunnerChatEcho(token, { baselineText = '', timeoutMs = 45000, pollMs = 1000 } = {}) {
  const safeToken = String(token || '').trim();
  const baselineLines = String(baselineText || '').split(/\r?\n/).filter(Boolean);
  const baselineAnchor = baselineLines.slice(-8).join('\n');
  if (!safeToken) return { ok: false, timedOut: true, message: '缺少测试标记' };

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const log = await readRunnerLogTail('', 160);
    const text = String(log.text || '');
    let slice = text;
    if (baselineAnchor) {
      const anchorIndex = text.lastIndexOf(baselineAnchor);
      if (anchorIndex >= 0) {
        slice = text.slice(anchorIndex + baselineAnchor.length);
      } else {
        const lastBaselineLine = baselineLines[baselineLines.length - 1] || '';
        const lastLineIndex = lastBaselineLine ? text.lastIndexOf(lastBaselineLine) : -1;
        if (lastLineIndex >= 0) {
          slice = text.slice(lastLineIndex + lastBaselineLine.length);
        }
      }
    }

    const hasIntercept = /chat intercept agent requestId=|protocol RunSSE requestId=/i.test(slice);
    const hasResponse = /agent upstream response|protocol BidiAppend kind=user_message|protocol RunSSE response requestId=/i.test(slice);
    const hasToken = slice.includes(safeToken);

    if (hasIntercept && hasResponse && hasToken) {
      const previewMatch = slice.match(/(?:textPreview|userTextPreview)=(.+)$/m);
      return {
        ok: true,
        logSnippet: slice.slice(-1800),
        responsePreview: previewMatch?.[1] || '',
        waitedMs: Date.now() - started,
      };
    }
  }

  return {
    ok: false,
    timedOut: true,
    waitedMs: Date.now() - started,
    message: '等待 Cursor 侧代理回显超时',
  };
}

async function runRelayAgentDialogTest(payload = {}) {
  let ensureResult = null;
  try {
    ensureResult = await ensureCursorRelayRunner(payload);
  } catch (error) {
    throw new Error(`Relay runner 未运行且自启动失败：${error.message || String(error)}`);
  }
  const status = await readCursorRelayProxyConfig();
  const runner = status?.runner;
  if (!runner?.running) {
    throw new Error('Relay 未启用或 runner 未运行，请先启用 Relay');
  }

  const customPrompt = String(payload?.prompt || payload?.userPrompt || payload?.message || '').trim();
  const requestedMode = String(payload?.mode || payload?.agentMode || 'AGENT_MODE_AGENT').trim() || 'AGENT_MODE_AGENT';
  const token = customPrompt ? '' : createRelayAgentTestToken();
  const prompt = customPrompt || buildRelayAgentTestPrompt(token);
  const port = Number(runner.port || DEFAULT_PORT);
  const sendToCursor = payload?.sendToCursor !== false;
  const directTimeoutMs = Math.max(
    customPrompt ? 15000 : 8000,
    Number(payload.timeoutMs) || (customPrompt ? 90000 : 20000),
  );
  const targetHosts = customPrompt
    ? [String(payload.targetHost || 'agent.api5.cursor.sh').trim() || 'agent.api5.cursor.sh']
    : undefined;

  const probe = await runRelayAgentConnectionTest({
    port,
    prompt,
    mode: requestedMode,
    targetHosts,
    timeoutMs: customPrompt ? directTimeoutMs : Math.min(30000, directTimeoutMs),
  });

  const afterProbeLog = await readRunnerLogTail('', 80);
  const afterProbeText = String(afterProbeLog.text || '');

  let cursorSend = { ok: false, skipped: true, message: '未尝试发送到 Cursor' };
  let cursorEcho = { ok: false, skipped: true, message: '未等待 Cursor 回显' };

  if (sendToCursor && isCursorRunningHeuristic()) {
    cursorSend = focusCursorAndSendChatMessage(prompt);
    if (cursorSend.ok) {
      cursorEcho = await waitForRunnerChatEcho(token, {
        baselineText: afterProbeText,
        timeoutMs: Math.min(60000, Math.max(15000, Number(payload.cursorWaitMs) || 45000)),
      });
    }
  } else if (sendToCursor) {
    cursorSend = { ok: false, message: 'Cursor 未运行，请打开 Cursor Agent 聊天窗口后重试' };
  }

  const probeHasToken = token ? probe.ok && String(probe.text || '').includes(token) : false;
  const cursorPathOk = Boolean(cursorEcho.ok);
  const cursorActive = sendToCursor && isCursorRunningHeuristic();
  const overallOk = probe.ok && (!cursorActive || !token || cursorPathOk);
  const finalLog = await readRunnerLogTail('', 220);
  const finalLogText = String(finalLog.text || '');
  const requestId = String(probe?.requestId || '').trim();
  const requestLogEvidence = requestId
    ? finalLogText
      .split(/\r?\n/)
      .filter((line) => line.includes(requestId) || /review_event_queued|review_events_polled|diff_created_active|promptbar_attached|promptbar_created/i.test(line))
      .slice(-80)
      .join('\n')
    : finalLogText.slice(-4000);

  let summary = ensureResult?.started
    ? 'Relay runner 已自动拉起并通过健康检查。\n\n'
    : '';
  if (probe.ok) {
    summary += `Relay 通路正常（${probe.targetHost}，${probe.latencyMs || '?'} ms）。\n上游回显：${String(probe.text || '').slice(0, 280)}`;
  } else {
    summary += `Relay 通路失败：${probe.message || (probe.errors || []).join('；') || '未知错误'}`;
  }

  if (cursorActive) {
    summary += '\n\n';
    if (cursorSend.ok) {
      summary += cursorPathOk
        ? `Cursor 侧已检测到代理回显（${cursorEcho.waitedMs || '?'} ms）。请在 Cursor Agent 对话中查看是否出现【${token}】。`
        : `已向 Cursor 发送测试消息，但未检测到代理回显。\n若 Cursor 出现「额度限制」而对话无 AI 回复，说明 Agent 流量未走本地 Relay（常见于 agent.api5 直连）。`;
    } else {
      summary += `未能自动发送到 Cursor：${cursorSend.message || '未知错误'}。\n请手动在 Agent 中粘贴发送：\n${prompt}`;
    }
  }

  return {
    ok: overallOk,
    probeOk: probe.ok,
    probeHasToken,
    cursorPathOk,
    token,
    prompt,
    probe,
    cursorSend,
    cursorEcho,
    ensure: ensureResult,
    requestId,
    logEvidence: requestLogEvidence,
    summary,
  };
}

module.exports = {
  DEFAULT_PROXY_BYPASS_LIST,
  getCursorArgvJsonPath,
  readCursorRelayProxyConfig,
  applyCursorRelayProxyConfig,
  ensureCursorRelayRunner,
  quickSwitchRelayModel,
  disableCursorRelayProxyConfig,
  disableByokForRelay,
  patchProxySupportInMainJs,
  restoreProxySupportInMainJs,
  patchRelayReviewBridgeInWorkbench,
  restoreRelayReviewBridgeInWorkbench,
  installRelayCaCertificate,
  installRelayCaCertificateFull,
  checkRelayCertificates,
  repairRelayCertificates,
  repairRelayCertificatesFull,
  restartRelayRunnerAfterCertRepair,
  stopLocalRelayRunner,
  getRunnerLogPaths,
  readRunnerLogTail,
  buildRelayDiagnostics,
  clearModelProxyConfigOnly,
  runRelayAgentDialogTest,
};

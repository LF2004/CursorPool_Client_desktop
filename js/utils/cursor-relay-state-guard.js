/**
 * cursor-relay-state-guard.js
 *
 * 状态守护模块：防止 Cursor 官方覆盖我们的账号信息和模型列表。
 *
 * 问题根因（逆向文档已确认）：
 *   Cursor 客户端启动后会从官方 API 获取：
 *     1. 账号信息 → 写入 state.vscdb ItemTable (cursor.email, cursor.accessToken 等)
 *     2. 模型列表 → 通过 AvailableModels RPC 或 KV SetBlobArgs 推送到客户端内存
 *   我们的 relay 启动后写入的值会被 Cursor 官方后续请求覆盖回原始值。
 *
 * 解决方案（三层防御）：
 *   第一层：DB 写入 — 启动时和定期把账号/模型写入 state.vscdb
 *   第二层：KV 注入 — 在 RunSSE 响应流中通过 SetBlobArgs 推送模型列表到客户端
 *   第三层：请求拦截 — 拦截 AvailableModels/GetUsableModels 响应注入本地模型
 */

const fs = require('fs');
const path = require('path');
const {
  loadCursorProtoRoot,
  getRootSync,
  encodeMessageSync,
  readConnectFrames,
  buildConnectFrame,
} = require('./cursor-relay-protobuf');
const {
  ensureCursorAccount,
  checkCursorLogin,
  syncCursorLoginToTemplate,
  readDefaultUserTemplate,
  DEFAULT_USER_JSON_PATH,
} = require('./cursor-relay-account-store');
const { collectLocalModels } = require('./cursor-relay-model-injection');
const { loadRelayProfileStore } = require('./cursor-relay-profile-store');
const { syncCursorRelayModelCatalog } = require('./cursor-model-proxy');
const {
  getStateVscdbPath,
  readItemSafe,
} = require('./cursor-local-state');

// ── [FIX #4] 辅助函数：读取当前 DB 中的 stripeMembershipType ──
// cursor-local-state.js 的 readCursorLoginState 不读此字段，需单独查询
function readCurrentDbMembershipType() {
  try {
    const Database = require('better-sqlite3');
    const dbPath = getStateVscdbPath();
    if (!dbPath || !require('fs').existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    // 先试 ItemTable（新版 Cursor）
    let val = readItemSafe(db, 'ItemTable', 'cursorAuth/stripeMembershipType');
    if (!val) val = readItemSafe(db, 'ItemTable', 'stripeMembershipType'); // 兼容旧版
    db.close();
    return val == null ? null : String(val).trim().toLowerCase();
  } catch (e) {
    // better-sqlite3 未安装或 DB 锁定 — 静默返回
    return null;
  }
}

// 期望的 membership type（必须是小写，匹配 Cursor cs 枚举）
const EXPECTED_MEMBERSHIP_TYPE = 'ultra';

// ── 守护配置 ───────────────────────────────────────────────

const DEFAULT_GUARD_CONFIG = {
  // DB 轮询间隔(ms)
  dbPollInterval: 5000,
  // 最大轮询次数（0=无限）
  maxDbPolls: 0,
  // KV 推送间隔(ms) — 在活跃 session 中定期推送
  kvPushInterval: 10000,
  // 首次写入延迟(ms) — 等 Cursor 启动完成
  initialWriteDelay: 3000,
  // 要守护的 state.vscdb 键
  guardedKeys: [
    'cursor.email',
    'cursor.accessToken',
    'cursorAuth/accessToken',
    'cursorAuth/cachedEmail',
    'cursorAuth/refreshToken',
    'cursorAuth/stripeMembershipType',
    'cursorAuth/cachedSignUpType',
    // Cursor 可能用来存模型缓存的键（需要从实际抓包确认）
    'cursorai/modelConfig',
    'cursorai/selectedModel',
    'cursorai/recentModels',
    // Cursor 的 serverConfig — 我们要清空它以阻止官方配置
    'cursorai/serverConfig',
  ],
};

// ── 全局状态 ─────────────────────────────────────────────

let guardTimers = {
  dbPoll: null,      // DB 轮询定时器
  kvPush: null,       // KV 推送定时器
  initial: null,      // 首次写入定时器
};
let isGuardRunning = false;
let activeSessions = new Map(); // requestId → { lastKvPush, modelListPushed }

function getLocalModelCatalogSnapshot() {
  const localModels = collectLocalModels();
  const availableModels = localModels
    .map((item) => String(item?.modelName || '').trim())
    .filter(Boolean);
  if (!availableModels.length) return null;

  let activeProfile = null;
  let primaryModel = '';
  try {
    const store = loadRelayProfileStore('');
    activeProfile = Array.isArray(store?.configs)
      ? store.configs.find((item) => String(item?.id || '') === String(store?.activeId || ''))
      : null;
    primaryModel = String(activeProfile?.modelName || '').trim();
  } catch {
    // ignore active profile lookup failure and fall back to first model
  }

  if (!primaryModel) primaryModel = availableModels[0];
  if (!primaryModel) return null;

  return {
    modelName: primaryModel,
    availableModels,
    contextWindow: Number(activeProfile?.contextWindow) > 0 ? Number(activeProfile.contextWindow) : undefined,
    reasoningEffort: String(activeProfile?.reasoningEffort || '').trim() || undefined,
  };
}

// ── 第一层：DB 写入守护 ───────────────────────────────────

/**
 * 执行一次 DB 写入检查：
 *   1. 读取当前 state.vscdb 中的值
 *   2. 与我们的期望值对比
 *   3. 如果被覆盖了，重新写入
 *
 * @param {{force?: boolean}} options
 */
async function performDbGuardCheck(options = {}) {
  try {
    const loginState = checkCursorLogin();
    const template = readDefaultUserTemplate();

    if (!loginState?.loggedIn && !template) {
      return { checked: false, reason: 'no_account_to_guard' };
    }

    // 检查是否需要重新写入
    // [FIX #4] 新增 stripeMembershipType 检查 — Cursor 启动后调 /auth/full_stripe_profile
    // 可能会把我们的 'ultra' 覆盖回 'free'，导致 Settings 显示 Free Plan
    const currentMembershipType = readCurrentDbMembershipType();
    const membershipOverwritten = (
      currentMembershipType &&
      currentMembershipType !== EXPECTED_MEMBERSHIP_TYPE &&
      currentMembershipType !== ''
    );
    const needsWrite =
      options.force ||
      (!loginState.loggedIn && template) ||
      (template && loginState.email !== template['cursorAuth/cachedEmail']) ||
      membershipOverwritten;  // ← 新增：membership 被覆盖则重写

    if (membershipOverwritten) {
      // 记录覆盖事件（仅日志，不暴露到返回值）
      try {
        const logger = require('./cursor-relay-log').createLogger?.() || console;
        logger.warn?.(`state-guard: membership type overwritten! DB="${currentMembershipType}" expected="${EXPECTED_MEMBERSHIP_TYPE}", will rewrite`);
      } catch { /* ignore */ }
    }

    if (!needsWrite) {
      const modelCatalog = getLocalModelCatalogSnapshot();
      const modelSync = modelCatalog ? await syncCursorRelayModelCatalog(modelCatalog) : null;
      return {
        checked: true,
        reason: 'values_intact',
        email: loginState.email || null,
        modelSync,
      };
    }

    // 执行写入
    const result = await ensureCursorAccount({ allowRunningCursor: true });
    const modelCatalog = getLocalModelCatalogSnapshot();
    const modelSync = modelCatalog ? await syncCursorRelayModelCatalog(modelCatalog) : null;
    return {
      checked: true,
      written: result?.applied || false,
      email: result?.email || null,
      source: result?.source || null,
      modelSync,
    };
  } catch (e) {
    return { checked: false, error: e.message };
  }
}

/**
 * 启动 DB 轮询守护
 */
function startDbPolling(config = {}) {
  stopDbPolling();
  const interval = Number(config.dbPollInterval) || DEFAULT_GUARD_CONFIG.dbPollInterval;
  const maxPolls = Number(config.maxDbPolls) || DEFAULT_GUARD_CONFIG.maxDbPolls;
  let pollCount = 0;

  guardTimers.dbPoll = setInterval(async () => {
    if (maxPolls > 0 && pollCount >= maxPolls) {
      stopDbPolling();
      return;
    }
    pollCount++;
    const result = await performDbGuardCheck();
    if (result.written) {
      // 写入成功，可以降低轮询频率
    }
  }, interval);
}

function stopDbPolling() {
  if (guardTimers.dbPoll) {
    clearInterval(guardTimers.dbPoll);
    guardTimers.dbPoll = null;
  }
}

// ── 第二层：KV SetBlobArgs 注入 ─────────────────────────────

/**
 * 构造模型列表的 SetBlobArgs KV 消息
 * 通过 protobufjs 编码 ExecServerMessage with set_blob_args
 *
 * @returns {Buffer|null} 编码后的 Connect 帧
 */
function buildModelListKvMessage() {
  try {
    getRootSync(); // 确保proto已加载
  } catch {
    return null;
  }

  const localModels = collectLocalModels();
  if (!localModels.length) return null;

  // 构造模型列表 JSON（这是 Cursor 客户端能理解的格式）
  const modelListPayload = {
    models: localModels.map((m) => ({
      id: m.modelId,
      name: m.displayName || m.modelName,
      clientDisplayName: m.displayNameShort || m.modelName,
      serverModelName: m.modelName,
      supportsAgent: true,
      supportsPlanMode: true,
      supportsThinking: true,
      selected: m.profileId ? undefined : true, // active profile 标记
    })),
    source: 'cursorpool-local',
    timestamp: Date.now(),
  };

  // 用 protobufjs 编码 SetBlobArgs
  // SetBlobArgs: { id: bytes, data: bytes }
  const blobId = Buffer.from('cursorpool:model-list');
  const blobData = Buffer.from(JSON.stringify(modelListPayload));

  // ExecServerMessage oneof field 11 = set_blob_args
  // 但我们直接用已有的手写 build 函数来构建帧
  // 这里用 protobufjs 构造一个更精确的版本
  try {
    const setBlobMsg = encodeMessageSync('agent.v1.SetBlobArgs', {
      id: blobId,
      data: blobData,
    });
    const kvServerMsg = encodeMessageSync('agent.v1.KvServerMessage', {
      setBlobArgs: setBlobMsg,
    });
    const serverMsg = encodeMessageSync('agent.v1.AgentServerMessage', {
      kvServerMessage: kvServerMsg,
    });
    return serverMsg; // 返回原始 buffer，调用方负责包装成 Connect 帧
  } catch (e) {
    // protobufjs 未加载或类型不存在，用手写兜底
    return buildModelListKvFallback(blobId, blobData);
  }
}

/**
 * 手写兜底：构建模型列表 KV 帧（不依赖 protobufjs）
 */
function buildModelListKvFallback(blobId, blobData) {
  // 复用 protocol.js 的 buildAgentKvSetBlobFrame
  try {
    const { buildAgentKvSetBlobFrame, buildAgentServerMessageField } = require('./cursor-relay-protocol');
    const inner = buildAgentKvSetBlobFrame(
      blobId.toString('base64'),
      blobData.toString('base64'),
      { id: 1 },
    );
    // 包装成 AgentServerMessage field 4 (kv_server_message)
    return inner; // 已经是完整帧了
  } catch {
    return null;
  }
}

/**
 * 向指定 session 推送模型列表 KV 消息
 */
function pushModelListToSession(session) {
  if (!session || !session.writeAgentFrame) return false;

  try {
    const kvBuffer = buildModelListKvMessage();
    if (!kvBuffer) return false;

    // 写入 session 的响应流
    if (typeof session.writeAgentFrame === 'function') {
      session.writeAgentFrame(kvBuffer);
    }
    session.lastModelPush = Date.now();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 向所有活跃 session 定期推送模型列表
 */
function pushModelListToAllActive() {
  let pushed = 0;
  for (const [reqId, session] of activeSessions) {
    if (session.active && !session.aborted && !session.turnEnded) {
      if (pushModelListToSession(session)) pushed++;
    }
  }
  return pushed;
}

/**
 * 注册一个 session 到守护（由 runner.js 调用）
 */
function registerSession(requestId, session) {
  activeSessions.set(String(requestId || ''), session);
  // 立即推送一次模型列表
  setTimeout(() => {
    pushModelListToSession(session);
  }, 1000); // 延迟1秒让客户端准备好接收
}

/**
 * 取消注册 session（session结束时调用）
 */
function unregisterSession(requestId) {
  activeSessions.delete(String(requestId || ''));
}

/**
 * 启动 KV 推送守护
 */
function startKvPushing(config = {}) {
  stopKvPushing();
  const interval = Number(config.kvPushInterval) || DEFAULT_GUARD_CONFIG.kvPushInterval;

  guardTimers.kvPush = setInterval(() => {
    pushModelListToAllActive();
  }, interval);
}

function stopKvPushing() {
  if (guardTimers.kvPush) {
    clearInterval(guardTimers.kvPush);
    guardTimers.kvPush = null;
  }
}

// ── 第三层：首次写入（等 Cursor 启动完成） ──────────────

/**
 * 启动完整的状态守护
 *
 * @param {{config?, onReady?}} options
 */
async function startStateGuard(options = {}) {
  if (isGuardRunning) return { alreadyRunning: true };
  isGuardRunning = true;

  const config = { ...DEFAULT_GUARD_CONFIG, ...options.config };

  // 1. 首次延迟写入（等 Cursor 完成初始化）
  const delay = Number(options.initialDelay) || config.initialWriteDelay;
  guardTimers.initial = setTimeout(async () => {
    // 首次强制写入
    const result = await performDbGuardCheck({ force: true });
    if (result.written) {
      // 写入成功，启动持续守护
      startDbPolling(config);
      startKvPushing(config);
      if (typeof options.onReady === 'function') {
        options.onReady(result);
      }
    } else {
      // 写入失败但继续尝试
      startDbPolling(config);
      startKvPushing(config);
    }
  }, delay);

  return { started: true, initialDelay: delay };
}

/**
 * 停止所有守护
 */
function stopStateGuard() {
  isGuardRunning = false;
  stopDbPolling();
  stopKvPushing();
  if (guardTimers.initial) {
    clearTimeout(guardTimers.initial);
    guardTimers.initial = null;
  }
  activeSessions.clear();
}

/**
 * 查询守护状态
 */
function getStateGuardStatus() {
  return {
    running: isGuardRunning,
    sessionsCount: activeSessions.size,
    hasTimer: {
      dbPoll: !!guardTimers.dbPoll,
      kvPush: !!guardTimers.kvPush,
      initial: !!guardTimers.initial,
    },
  };
}

module.exports = {
  DEFAULT_GUARD_CONFIG,
  startStateGuard,
  stopStateGuard,
  getStateGuardStatus,
  performDbGuardCheck,
  startDbPolling,
  stopDbPolling,
  startKvPushing,
  stopKvPushing,
  pushModelListToSession,
  pushModelListToAllActive,
  registerSession,
  unregisterSession,
  buildModelListKvMessage,
};

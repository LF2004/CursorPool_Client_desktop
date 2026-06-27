/**
 * cursor-relay-account-store.js
 *
 * 账号信息缓存统一入口：
 *   defult_user.json (项目内模板) ←→ state.vscdb (Cursor 客户端真实状态)
 *
 * 之前的问题：
 *   - js/hook/defult_user.json 是死文件，全仓零读写
 *   - 账号写入散落在 switch-account.js / update_cursor_auth.js / cursor-local-state.js，逻辑重复
 *   - 字段不一致：defult_user.json 5个键，实际写入也是5个键但来源分散
 *
 * 统一职责：
 *   1. 读取 defult_user.json 模板（作为账号信息缓存的单一来源）
 *   2. 把模板写入 state.vscdb ItemTable（带备份/重试/校验）
 *   3. 从 state.vscdb 读回当前 Cursor 实际登录态
 *   4. 提供 ensureCursorAccount() 一键保证 Cursor 处于登录态
 *
 * 与 update_cursor_auth.js 的关系：
 *   update_cursor_auth.js 的 applyCursorAuth() 仍是最底层的 DB 写入实现，
 *   本模块负责"模板来源"和"统一调度"，复用其 applyCursorAuth。
 */

const fs = require('fs');
const path = require('path');
const {
  applyCursorAuth,
  processToken,
  loadLocalGuestCursorAuth,
} = require('../../update_cursor_auth');
const {
  readCursorLoginState,
  getCursorPaths,
  getStateVscdbPath,
} = require('./cursor-local-state');

const DEFAULT_USER_JSON_PATH = path.join(__dirname, '..', 'hook', 'defult_user.json');

/**
 * defult_user.json 与 state.vscdb 共同的 5 个键。
 * 这是写入 ItemTable 的标准字段集。
 */
const ACCOUNT_KEYS = {
  EMAIL: 'cursor.email',
  ACCESS_TOKEN: 'cursor.accessToken',
  AUTH_REFRESH_TOKEN: 'cursorAuth/refreshToken',
  AUTH_ACCESS_TOKEN: 'cursorAuth/accessToken',
  AUTH_CACHED_EMAIL: 'cursorAuth/cachedEmail',
};

// defult_user.json 模板内的键名（注意是 cursorAuth/ 前缀的3个 + 我们扩展的2个）
const TEMPLATE_KEYS = {
  AUTH_ACCESS_TOKEN: 'cursorAuth/accessToken',
  AUTH_CACHED_EMAIL: 'cursorAuth/cachedEmail',
  AUTH_CACHED_SIGNUP_TYPE: 'cursorAuth/cachedSignUpType',
  AUTH_REFRESH_TOKEN: 'cursorAuth/refreshToken',
  STRIPE_MEMBERSHIP_TYPE: 'cursorAuth/stripeMembershipType',
};

/**
 * 读取 defult_user.json 模板
 * @returns {object|null} 模板对象，含 cursorAuth/accessToken 等键
 */
function readDefaultUserTemplate() {
  if (!fs.existsSync(DEFAULT_USER_JSON_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(DEFAULT_USER_JSON_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * 把模板对象解析成标准账号信息
 * @param {object} template defult_user.json 内容
 * @returns {{email, accessToken, refreshToken, stripeMembershipType, cachedSignUpType}|null}
 */
function parseTemplateToAccount(template) {
  if (!template) return null;
  const accessToken = processToken(template[TEMPLATE_KEYS.AUTH_ACCESS_TOKEN] || '');
  const email = String(template[TEMPLATE_KEYS.AUTH_CACHED_EMAIL] || '').trim();
  const refreshToken = processToken(
    template[TEMPLATE_KEYS.AUTH_REFRESH_TOKEN] || accessToken,
  );
  const stripeMembershipType = String(
    template[TEMPLATE_KEYS.STRIPE_MEMBERSHIP_TYPE] || 'ultra',
  ).toLowerCase(); // Cursor cs 枚举用小写: "ultra"/"pro"/"free"
  const cachedSignUpType = String(
    template[TEMPLATE_KEYS.AUTH_CACHED_SIGNUP_TYPE] || 'Google',
  );
  if (!email || !accessToken) return null;
  return { email, accessToken, refreshToken, stripeMembershipType, cachedSignUpType };
}

/**
 * 把账号信息写回 defult_user.json 模板（更新缓存）
 * @param {{email, accessToken, refreshToken?, stripeMembershipType?, cachedSignUpType?}} account
 */
function writeDefaultUserTemplate(account) {
  if (!account?.email || !account?.accessToken) return false;
  const parent = path.dirname(DEFAULT_USER_JSON_PATH);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const template = {
    [TEMPLATE_KEYS.AUTH_ACCESS_TOKEN]: account.accessToken,
    [TEMPLATE_KEYS.AUTH_CACHED_EMAIL]: account.email,
    [TEMPLATE_KEYS.AUTH_CACHED_SIGNUP_TYPE]: account.cachedSignUpType || 'Google',
    [TEMPLATE_KEYS.AUTH_REFRESH_TOKEN]:
      account.refreshToken || account.accessToken,
    [TEMPLATE_KEYS.STRIPE_MEMBERSHIP_TYPE]: account.stripeMembershipType || 'ultra',
  };
  fs.writeFileSync(DEFAULT_USER_JSON_PATH, JSON.stringify(template, null, 2), 'utf8');
  return true;
}

/**
 * 检查 Cursor 当前是否已登录（读 state.vscdb）
 * @returns {{loggedIn, email, accessToken, refreshToken, hasEmail, hasValidAccessToken}}
 */
function checkCursorLogin() {
  return readCursorLoginState();
}

/**
 * 一键保证 Cursor 处于登录态：
 *   1. 先读 state.vscdb，已登录则跳过
 *   2. 未登录则尝试 defult_user.json 模板
 *   3. 模板也没有则尝试 js/utils/users.json 本地 guest
 *   4. 把账号写入 state.vscdb
 *
 * @param {{allowRunningCursor?: boolean, credentials?: object}} options
 * @returns {Promise<{ok, skipped, reason, email, source}>}
 */
async function ensureCursorAccount(options = {}) {
  const loginState = checkCursorLogin();
  if (loginState.loggedIn) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_logged_in',
      email: loginState.email || '',
      loginState,
    };
  }

  // 优先用调用方传入的 credentials
  let account = null;
  let source = '';
  if (options.credentials?.email && options.credentials?.accessToken) {
    account = {
      email: String(options.credentials.email).trim(),
      accessToken: processToken(options.credentials.accessToken),
      refreshToken: processToken(
        options.credentials.refreshToken || options.credentials.accessToken,
      ),
      stripeMembershipType: (options.credentials.stripeMembershipType || 'ultra').toLowerCase(),
      cachedSignUpType: options.credentials.cachedSignUpType || 'Google',
    };
    source = 'payload';
  }

  // 其次用 defult_user.json 模板
  if (!account) {
    const template = readDefaultUserTemplate();
    account = parseTemplateToAccount(template);
    if (account) source = 'defult_user.json';
  }

  // 最后用 js/utils/users.json 本地 guest
  if (!account) {
    account = loadLocalGuestCursorAuth();
    if (account) source = 'users.json';
  }

  if (!account?.email || !account?.accessToken) {
    return {
      ok: false,
      skipped: true,
      reason: 'no_account_available',
      loginState,
      searchedPaths: [DEFAULT_USER_JSON_PATH],
    };
  }

  const dbPath = getStateVscdbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      skipped: true,
      reason: 'state_vscdb_missing',
      email: account.email,
      source,
      loginState,
    };
  }

  try {
    const result = await applyCursorAuth({
      email: account.email,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken || account.accessToken,
      clearServerConfig: false,
      allowRunningCursor: options.allowRunningCursor === true,
    });
    return {
      ok: true,
      applied: true,
      email: account.email,
      source,
      loginState,
      ...result,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: 'apply_failed',
      error: error.message || String(error),
      email: account.email,
      source,
      loginState,
    };
  }
}

/**
 * 把当前 Cursor 登录态同步回 defult_user.json 模板（反向缓存）。
 * 适用场景：用户在 Cursor 里登录了新账号，把新账号缓存到模板以便下次复用。
 * @returns {{synced, email, reason}|null}
 */
function syncCursorLoginToTemplate() {
  const loginState = checkCursorLogin();
  if (!loginState.loggedIn || !loginState.email || !loginState.accessToken) {
    return { synced: false, reason: 'not_logged_in', loginState };
  }
  const ok = writeDefaultUserTemplate({
    email: loginState.email,
    accessToken: loginState.accessToken,
    refreshToken: loginState.refreshToken || loginState.accessToken,
    stripeMembershipType: 'ultra', // 默认 ultra（小写，匹配 Cursor cs 枚举）
    cachedSignUpType: 'Google',
  });
  return {
    synced: ok,
    email: loginState.email,
    reason: ok ? 'synced' : 'write_failed',
    templatePath: DEFAULT_USER_JSON_PATH,
  };
}

module.exports = {
  DEFAULT_USER_JSON_PATH,
  ACCOUNT_KEYS,
  TEMPLATE_KEYS,
  readDefaultUserTemplate,
  parseTemplateToAccount,
  writeDefaultUserTemplate,
  checkCursorLogin,
  ensureCursorAccount,
  syncCursorLoginToTemplate,
};

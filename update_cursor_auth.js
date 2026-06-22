const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const {
  getStateVscdbPath,
  getCursorAuthJsonPath,
  readCursorLoginState,
  isCursorRunningHeuristic,
} = require('./js/utils/cursor-local-state');

const LOCAL_GUEST_AUTH_PATH = path.join(__dirname, 'js/utils/users.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectItemTableName(db) {
  try {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('itemtable','item_table')",
      )
      .all();
    return rows[0]?.name || null;
  } catch {
    return null;
  }
}

/** 对齐 switch-account.js / authentication.rs */
function processToken(token) {
  if (typeof token !== 'string') return token;
  if (token.includes('%3A%3A')) {
    const parts = token.split('%3A%3A');
    return parts.length > 1 ? parts[1] : token;
  }
  return token;
}

function writeCursorAuthJson(email, accessToken) {
  const authPath = getCursorAuthJsonPath();
  const parent = path.dirname(authPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const payload = { email, access_token: accessToken };
  fs.writeFileSync(authPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return authPath;
}

function upsertAuth(db, tableName, key, value) {
  const info = db.prepare(`UPDATE "${tableName}" SET value = ? WHERE key = ?`).run(value, key);
  if (info.changes === 0) {
    db.prepare(`INSERT INTO "${tableName}" (key, value) VALUES (?, ?)`).run(key, value);
  }
}

function cleanupServerConfig(db, tableName) {
  try {
    db.prepare(`DELETE FROM "${tableName}" WHERE key = ?`).run('cursorai/serverConfig');
  } catch {
    /* ignore */
  }
}

async function openDbWithRetry(dbPath, tries = 25, delayMs = 400) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const db = new Database(dbPath);
      try {
        db.pragma('busy_timeout = 5000');
      } catch {
        /* ignore */
      }
      return db;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? String(e.message) : '';
      if (msg.includes('locked') || msg.includes('busy')) {
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('无法打开 state.vscdb');
}

function runDbQuickCheck(db, label) {
  try {
    const rows = db.pragma('quick_check');
    const values = Array.isArray(rows)
      ? rows.map((row) => String(row.quick_check || row.integrity_check || Object.values(row)[0] || '').trim())
      : [];
    const ok = values.length > 0 && values.every((value) => value.toLowerCase() === 'ok');
    if (!ok) {
      throw new Error(values.filter(Boolean).join('; ') || 'unknown quick_check failure');
    }
  } catch (error) {
    throw new Error(`${label} quick_check 失败：${error.message || error}`);
  }
}

function ensureItemTable(db) {
  const existing = detectItemTableName(db);
  if (existing) return existing;
  db.prepare('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)').run();
  return 'ItemTable';
}

function createStateDbBackupSet(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupBase = `${dbPath}.cursorpool-${stamp}.bak`;
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const target = `${backupBase}${suffix}`;
    fs.copyFileSync(source, target);
    copied.push({ source, target });
  }
  return { backupBase, copied };
}

function restoreStateDbBackupSet(backup) {
  if (!backup?.copied?.length) return;
  for (const item of backup.copied) {
    if (!fs.existsSync(item.target)) continue;
    fs.copyFileSync(item.target, item.source);
  }
}

function createAuthJsonBackup(authPath) {
  if (!fs.existsSync(authPath)) return { authPath, existed: false, backupPath: null };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${authPath}.cursorpool-${stamp}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return { authPath, existed: true, backupPath };
}

function restoreAuthJsonBackup(backup) {
  if (!backup?.authPath) return;
  if (backup.existed && backup.backupPath && fs.existsSync(backup.backupPath)) {
    fs.copyFileSync(backup.backupPath, backup.authPath);
    return;
  }
  if (!backup.existed && fs.existsSync(backup.authPath)) {
    fs.unlinkSync(backup.authPath);
  }
}

function loadLocalGuestCursorAuth() {
  if (!fs.existsSync(LOCAL_GUEST_AUTH_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_GUEST_AUTH_PATH, 'utf8'));
    const email = String(raw?.email || '').trim();
    const accessToken = processToken(raw?.token || raw?.accessToken || '');
    const refreshToken = processToken(raw?.refreshToken || raw?.token || accessToken);
    if (!email || !accessToken) return null;
    return {
      email,
      accessToken,
      refreshToken,
      stripeMembershipType: 'pro',
    };
  } catch {
    return null;
  }
}

/**
 * 写入 Cursor 登录态。默认对齐 CursorPool_Client switch_account：
 * 只在 state.vscdb 的 ItemTable 中替换 Cursor 认证相关 5 个键。
 * @param {{
 *   email: string,
 *   accessToken: string,
 *   refreshToken?: string,
 *   clearServerConfig?: boolean,
 *   writeAuthJson?: boolean,
 *   dbRetries?: number,
 *   onboardingDate?: string,
 *   stripeMembershipType?: string,
 * }} payload
 */
async function applyCursorAuth(payload) {
  const email = payload?.email;
  const accessToken = processToken(payload?.accessToken || '');
  const refreshToken = processToken(payload?.refreshToken || accessToken);
  if (!email || !accessToken) {
    throw new Error('缺少 email 或 accessToken');
  }

  const dbPath = getStateVscdbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('state.vscdb 不存在，请先启动一次 Cursor。');
  }
  if (payload?.allowRunningCursor !== true && isCursorRunningHeuristic()) {
    throw new Error('Cursor 仍在运行，已停止写入 state.vscdb。请完全退出 Cursor 后重试。');
  }

  const backup = createStateDbBackupSet(dbPath);
  const authPath = getCursorAuthJsonPath();
  const shouldWriteAuthJson = payload?.writeAuthJson === true;
  const authBackup = shouldWriteAuthJson
    ? createAuthJsonBackup(authPath)
    : { authPath, existed: fs.existsSync(authPath), backupPath: null };
  const db = await openDbWithRetry(
    dbPath,
    payload?.dbRetries || 25,
    payload?.dbRetryDelayMs || 400,
  );
  let dbClosed = false;
  const closeDb = () => {
    if (dbClosed) return;
    db.close();
    dbClosed = true;
  };
  try {
    runDbQuickCheck(db, '写入前');
    const tableName = ensureItemTable(db);
    if (payload?.clearServerConfig === true) {
      cleanupServerConfig(db, tableName);
    }
    const updates = [
      ['cursor.email', email],
      ['cursor.accessToken', accessToken],
      ['cursorAuth/refreshToken', refreshToken],
      ['cursorAuth/accessToken', accessToken],
      ['cursorAuth/cachedEmail', email],
    ];
    const tx = db.transaction(() => {
      for (const [key, value] of updates) {
        if (value == null) continue;
        upsertAuth(db, tableName, key, value);
      }
    });
    tx();
    if (shouldWriteAuthJson) {
      writeCursorAuthJson(email, accessToken);
    }
    runDbQuickCheck(db, '写入后');
  } catch (error) {
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    restoreStateDbBackupSet(backup);
    restoreAuthJsonBackup(authBackup);
    throw error;
  } finally {
    try {
      closeDb();
    } catch {
      /* ignore */
    }
  }

  return {
    dbPath,
    authPath: shouldWriteAuthJson ? authPath : null,
    backupPath: backup.backupBase,
    mode: shouldWriteAuthJson ? 'state_vscdb_and_auth_json' : 'state_vscdb_itemtable',
  };
}

/**
 * 仅在 Cursor 未登录时写入本地免登账号（desktop/js/utils/users.json）。
 * @param {{ email?: string, accessToken?: string, refreshToken?: string, stripeMembershipType?: string }} [credentials]
 */
async function ensureCursorAuthIfNeeded(credentials) {
  const loginState = readCursorLoginState();
  if (loginState.loggedIn) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_logged_in',
      email: loginState.email || '',
    };
  }

  const creds = credentials?.email && credentials?.accessToken
    ? {
      email: String(credentials.email).trim(),
      accessToken: processToken(credentials.accessToken),
      refreshToken: processToken(credentials.refreshToken || credentials.accessToken),
      stripeMembershipType: credentials.stripeMembershipType || 'pro',
    }
    : loadLocalGuestCursorAuth();

  if (!creds?.email || !creds.accessToken) {
    return {
      ok: false,
      skipped: true,
      reason: 'missing_local_guest',
      loginState,
      authPath: LOCAL_GUEST_AUTH_PATH,
    };
  }

  const dbPath = getStateVscdbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, skipped: true, reason: 'state_vscdb_missing', loginState };
  }

  const result = await applyCursorAuth({
    email: creds.email,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken || creds.accessToken,
    clearServerConfig: false,
    stripeMembershipType: creds.stripeMembershipType || 'pro',
  });
  return {
    ok: true,
    applied: true,
    email: creds.email,
    source: credentials?.email ? 'payload' : 'users.json',
    loginState,
    ...result,
  };
}

async function main() {
  const EMAIL = process.env.CURSOR_EMAIL || 'you@example.com';
  const ACCESS_TOKEN = process.env.CURSOR_ACCESS_TOKEN || '';
  const REFRESH_TOKEN = process.env.CURSOR_REFRESH_TOKEN || ACCESS_TOKEN;
  if (!ACCESS_TOKEN || EMAIL === 'you@example.com') {
    console.error('请通过环境变量 CURSOR_EMAIL/CURSOR_ACCESS_TOKEN/CURSOR_REFRESH_TOKEN 传入值');
    process.exit(1);
  }
  const result = await applyCursorAuth({
    email: EMAIL,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
  });
  console.log('写入成功:', result.dbPath, result.authPath);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  applyCursorAuth,
  processToken,
  writeCursorAuthJson,
  loadLocalGuestCursorAuth,
  ensureCursorAuthIfNeeded,
  readCursorLoginState,
  LOCAL_GUEST_AUTH_PATH,
};

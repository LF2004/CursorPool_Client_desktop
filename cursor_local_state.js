/**
 * 读取本地 Cursor 状态（只读），供 Electron 主页与 CLI 共用。
 * 逻辑对齐 print-full-state.js：globalStorage、cursor.auth.json、state.vscdb ItemTable、客户端注入启发式。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { hookStatus } = require('./hook');

function getGlobalStorageDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const candidates = [];
    if (appData) candidates.push(path.join(appData, 'Cursor', 'User', 'globalStorage'));
    const cursorPath = process.env.CURSOR_PATH;
    if (cursorPath) candidates.push(path.join(cursorPath, 'User', 'globalStorage'));
    for (const dir of candidates) {
      if (dir && fs.existsSync(dir)) return dir;
    }
    return candidates[0] || '';
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage');
}

function getStateVscdbPath() {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  return path.join(getGlobalStorageDir(), 'state.vscdb');
}

function getCursorAuthJsonPath() {
  return path.join(getGlobalStorageDir(), 'cursor.auth.json');
}

function detectItemTableName(db) {
  try {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('itemtable','item_table')",
      )
      .all();
    if (!rows.length) return null;
    return rows[0].name;
  } catch {
    return null;
  }
}

function readItemTableValue(db, tableName, key) {
  if (!tableName) return null;
  try {
    const stmt = db.prepare(`SELECT value FROM "${tableName}" WHERE key = ?`).pluck();
    const v = stmt.get(key);
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

/** @returns {object} 本地 Cursor 快照（globalStorage、邮箱、机器码、注入状态） */
function getLocalCursorState() {
  const globalStorageDir = getGlobalStorageDir();
  const stateVscdbPath = getStateVscdbPath();
  const authJsonPath = getCursorAuthJsonPath();

  const out = {
    globalStorageDir,
    stateVscdbPath,
    stateVscdbExists: fs.existsSync(stateVscdbPath),
    authJsonEmail: null,
    localEmail: null,
    machineId: null,
    dbError: null,
    injection: {
      found: false,
      hooked: null,
      path: null,
      message: null,
    },
  };

  if (fs.existsSync(authJsonPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
      out.authJsonEmail = j.email != null ? String(j.email) : null;
    } catch {
      // ignore
    }
  }

  if (out.stateVscdbExists) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(stateVscdbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 8000,
      });
      try {
        const tableName = detectItemTableName(db);
        if (!tableName) {
          out.dbError = 'state.vscdb 中未找到 ItemTable/itemTable';
          out.localEmail = out.authJsonEmail;
        } else {
          const cached = readItemTableValue(db, tableName, 'cursorAuth/cachedEmail');
          const cursorEmail = readItemTableValue(db, tableName, 'cursor.email');
          out.localEmail = cached || cursorEmail || out.authJsonEmail || null;
          out.machineId = readItemTableValue(db, tableName, 'telemetry.devDeviceId');
        }
      } finally {
        db.close();
      }
    } catch (e) {
      const msg = e.message || String(e);
      out.dbError = msg;
      out.localEmail = out.authJsonEmail;
      if (/locked|busy|SQLITE_BUSY/i.test(msg)) {
        out.dbError = `${msg}（请先关闭 Cursor 再刷新，或稍后重试）`;
      }
    }
  } else {
    out.localEmail = out.authJsonEmail;
  }

  try {
    const hs = hookStatus({});
    out.injection = {
      found: hs.found,
      hooked: hs.hooked,
      path: hs.path,
      message: hs.message || null,
      machineMatches: hs.machineMatches,
      macMatches: hs.macMatches,
      backupExists: hs.backupExists,
    };
  } catch (e) {
    out.injection.message = e.message || String(e);
  }

  return out;
}

module.exports = {
  getGlobalStorageDir,
  getStateVscdbPath,
  getCursorAuthJsonPath,
  getLocalCursorState,
};

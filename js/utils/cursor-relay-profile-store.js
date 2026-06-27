const fs = require('fs');
const path = require('path');
const { getRelayDataDir } = require('./cursor-relay-cert');

const DB_FILE_NAME = 'model.db';

let Database = null;
let dbCache = new Map();

function loadDatabaseCtor() {
  if (Database) return Database;
  Database = require('better-sqlite3');
  return Database;
}

function getRelayProfileDbPath(customRoot = '') {
  const dataDir = getRelayDataDir(customRoot);
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, DB_FILE_NAME);
}

function openProfileDb(customRoot = '') {
  const dbPath = getRelayProfileDbPath(customRoot);
  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  const DatabaseCtor = loadDatabaseCtor();
  const db = new DatabaseCtor(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      endpoint_mode TEXT NOT NULL DEFAULT 'responses',
      reasoning_effort TEXT NOT NULL DEFAULT 'medium',
      thinking_mode TEXT NOT NULL DEFAULT '',
      context_window INTEGER NOT NULL DEFAULT 200000,
      notes TEXT NOT NULL DEFAULT '',
      test_status_json TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_profile_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relay_profiles_provider_updated
      ON relay_profiles(provider_id, updated_at DESC);
  `);
  dbCache.set(dbPath, db);
  return db;
}

function closeProfileDbs() {
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  dbCache = new Map();
}

function readMeta(db, key, fallback = '') {
  try {
    const value = db.prepare('SELECT value FROM relay_profile_meta WHERE key = ?').pluck().get(String(key || ''));
    return value == null ? fallback : String(value);
  } catch {
    return fallback;
  }
}

function upsertMeta(db, key, value) {
  db.prepare(`
    INSERT INTO relay_profile_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(key || ''), String(value == null ? '' : value));
}

function normalizeStore(store = {}) {
  const raw = store && typeof store === 'object' ? store : {};
  const configs = Array.isArray(raw.configs) ? raw.configs : [];
  const version = Number(raw.version) > 0 ? Number(raw.version) : 2;
  const activeId = String(raw.activeId || '').trim();
  const filterProvider = String(raw.filterProvider || 'openai').trim() || 'openai';
  return {
    version,
    activeId,
    filterProvider,
    configs: configs.map((item) => ({
      id: String(item?.id || '').trim(),
      name: String(item?.name || '').trim(),
      providerId: String(item?.providerId || 'custom').trim() || 'custom',
      baseUrl: String(item?.baseUrl || '').trim(),
      apiKey: String(item?.apiKey || '').trim(),
      modelName: String(item?.modelName || '').trim(),
      endpointMode: String(item?.endpointMode || 'responses').trim() || 'responses',
      reasoningEffort: String(item?.reasoningEffort || 'medium').trim() || 'medium',
      thinkingMode: String(item?.thinkingMode || '').trim(),
      contextWindow: Math.max(1, Math.min(200000, Number(item?.contextWindow) > 0 ? Number(item.contextWindow) : 200000)),
      notes: String(item?.notes || '').trim(),
      testStatus: normalizeTestStatus(item?.testStatus),
      createdAt: Number(item?.createdAt) || 0,
      updatedAt: Number(item?.updatedAt) || 0,
    })).filter((item) => item.id),
  };
}

function emptyTestStatus() {
  return {
    status: 'idle',
    message: '',
    latencyMs: 0,
    durationMs: 0,
    ttftMs: 0,
    generationMs: 0,
    tokensPerSecond: 0,
    outputTokens: 0,
    outputTokensEstimated: false,
  };
}

function normalizeTestStatus(raw = {}) {
  if (!raw || typeof raw !== 'object') return emptyTestStatus();
  const status = String(raw.status || 'idle');
  return {
    status: ['idle', 'ok', 'warn', 'fail', 'testing'].includes(status) ? status : 'idle',
    message: String(raw.message || ''),
    latencyMs: Number(raw.latencyMs) || 0,
    durationMs: Number(raw.durationMs) || Number(raw.latencyMs) || 0,
    ttftMs: Number(raw.ttftMs) || 0,
    generationMs: Number(raw.generationMs) || 0,
    tokensPerSecond: Number(raw.tokensPerSecond) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
    outputTokensEstimated: Boolean(raw.outputTokensEstimated),
  };
}

function loadRelayProfileStore(customRoot = '') {
  const db = openProfileDb(customRoot);
  const rows = db.prepare(`
    SELECT
      id,
      name,
      provider_id,
      base_url,
      api_key,
      model_name,
      endpoint_mode,
      reasoning_effort,
      thinking_mode,
      context_window,
      notes,
      test_status_json,
      created_at,
      updated_at
    FROM relay_profiles
    ORDER BY updated_at DESC, created_at DESC, id ASC
  `).all();

  return {
    version: Number(readMeta(db, 'version', '2')) || 2,
    activeId: readMeta(db, 'activeId', ''),
    filterProvider: readMeta(db, 'filterProvider', 'openai') || 'openai',
    configs: rows.map((row) => {
      let testStatus = emptyTestStatus();
      try {
        const parsed = JSON.parse(String(row.test_status_json || ''));
        if (parsed && typeof parsed === 'object') {
          testStatus = normalizeTestStatus(parsed);
        }
      } catch {
        /* ignore */
      }
      return {
        id: String(row.id || ''),
        name: String(row.name || ''),
        providerId: String(row.provider_id || 'custom'),
        baseUrl: String(row.base_url || ''),
        apiKey: String(row.api_key || ''),
        modelName: String(row.model_name || ''),
        endpointMode: String(row.endpoint_mode || 'responses'),
        reasoningEffort: String(row.reasoning_effort || 'medium'),
        thinkingMode: String(row.thinking_mode || ''),
        contextWindow: Math.max(1, Math.min(200000, Number(row.context_window) || 200000)),
        notes: String(row.notes || ''),
        testStatus,
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
      };
    }),
  };
}

function saveRelayProfileStore(store = {}, customRoot = '') {
  const db = openProfileDb(customRoot);
  const normalized = normalizeStore(store);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM relay_profiles').run();
    const insert = db.prepare(`
      INSERT INTO relay_profiles (
        id,
        name,
        provider_id,
        base_url,
        api_key,
        model_name,
        endpoint_mode,
        reasoning_effort,
        thinking_mode,
        context_window,
        notes,
        test_status_json,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @name,
        @provider_id,
        @base_url,
        @api_key,
        @model_name,
        @endpoint_mode,
        @reasoning_effort,
        @thinking_mode,
        @context_window,
        @notes,
        @test_status_json,
        @created_at,
        @updated_at
      )
    `);
    for (const item of normalized.configs) {
      insert.run({
        id: item.id,
        name: item.name || item.modelName || '未命名配置',
        provider_id: item.providerId,
        base_url: item.baseUrl,
        api_key: item.apiKey,
        model_name: item.modelName,
        endpoint_mode: item.endpointMode,
        reasoning_effort: item.reasoningEffort,
        thinking_mode: item.thinkingMode,
        context_window: item.contextWindow,
        notes: item.notes,
        test_status_json: JSON.stringify(item.testStatus || { status: 'idle', message: '', latencyMs: 0 }),
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      });
    }
    upsertMeta(db, 'version', String(normalized.version || 2));
    upsertMeta(db, 'activeId', normalized.activeId || '');
    upsertMeta(db, 'filterProvider', normalized.filterProvider || 'openai');
  });
  tx();
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    dbPath: getRelayProfileDbPath(customRoot),
    count: normalized.configs.length,
    store: normalized,
  };
}

module.exports = {
  getRelayProfileDbPath,
  loadRelayProfileStore,
  saveRelayProfileStore,
  closeProfileDbs,
};

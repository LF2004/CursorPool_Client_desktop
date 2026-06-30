const fs = require('fs');
const path = require('path');
const { getRelayDataDir } = require('./cursor-relay-cert');
const { matchModelPrice } = require('./model-pricing');

const DB_FILE_NAME = 'usage.db';
const USD_PER_POINT = 0.02;

let dbCache = new Map();
let historySyncCache = new Map();
const HISTORY_SYNC_MIN_INTERVAL_MS = 30000;
let Database = null;
let databaseDisabledReason = '';

function disableDatabase(reason) {
  if (!databaseDisabledReason) {
    databaseDisabledReason = String(reason || 'usage_database_unavailable');
    try {
      console.warn(`[cursor-relay-usage-store] disabled: ${databaseDisabledReason}`);
    } catch {
      /* ignore console failures */
    }
  }
}

function isDatabaseDisabled() {
  return Boolean(databaseDisabledReason);
}

function loadDatabaseCtor() {
  if (databaseDisabledReason) {
    throw new Error(databaseDisabledReason);
  }
  if (Database) return Database;
  try {
    Database = require('better-sqlite3');
  } catch (error) {
    disableDatabase(error?.message || error);
    throw error;
  }
  return Database;
}

function getUsageDbPath(customRoot) {
  const dataDir = getRelayDataDir(customRoot);
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, DB_FILE_NAME);
}

function ensureRelayUsageSchema(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(relay_usage)').all().map((column) => column.name),
  );
  const migrations = [
    ['mode', 'ALTER TABLE relay_usage ADD COLUMN mode TEXT'],
    ['billed_points', 'ALTER TABLE relay_usage ADD COLUMN billed_points REAL DEFAULT 0'],
    ['cursor_agent_account', 'ALTER TABLE relay_usage ADD COLUMN cursor_agent_account TEXT'],
    ['reasoning_effort', 'ALTER TABLE relay_usage ADD COLUMN reasoning_effort TEXT'],
    ['platform_billing', 'ALTER TABLE relay_usage ADD COLUMN platform_billing INTEGER NOT NULL DEFAULT 0'],
    ['display_name', 'ALTER TABLE relay_usage ADD COLUMN display_name TEXT'],
  ];
  for (const [column, sql] of migrations) {
    if (!columns.has(column)) db.prepare(sql).run();
  }
}

function openUsageDb(customRoot) {
  if (databaseDisabledReason) {
    throw new Error(databaseDisabledReason);
  }
  const dbPath = getUsageDbPath(customRoot);
  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  let DatabaseCtor = null;
  try {
    DatabaseCtor = loadDatabaseCtor();
  } catch (error) {
    disableDatabase(error?.message || error);
    throw error;
  }
  let db = null;
  try {
    db = new DatabaseCtor(dbPath);
  } catch (error) {
    disableDatabase(error?.message || error);
    throw error;
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      conversation_id TEXT,
      mode TEXT,
      phase TEXT,
      endpoint_mode TEXT,
      display_name TEXT,
      model TEXT,
      model_label TEXT,
      status TEXT NOT NULL,
      http_status INTEGER DEFAULT 0,
      error TEXT,
      input_tokens INTEGER DEFAULT 0,
      cached_input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_price_per_million REAL DEFAULT 0,
      cached_input_price_per_million REAL DEFAULT 0,
      output_price_per_million REAL DEFAULT 0,
      input_cost_usd REAL DEFAULT 0,
      cached_input_cost_usd REAL DEFAULT 0,
      output_cost_usd REAL DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      points REAL DEFAULT 0,
      billed_points REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      prompt_chars INTEGER DEFAULT 0,
      response_text_chars INTEGER DEFAULT 0,
      reasoning_chars INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      upstream_base_url TEXT,
      price_source TEXT,
      price_source_url TEXT,
      raw_usage_json TEXT,
      meta_json TEXT,
      cursor_agent_account TEXT,
      reasoning_effort TEXT
    );
  `);
  ensureRelayUsageSchema(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relay_usage_created_at ON relay_usage(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_relay_usage_request_id ON relay_usage(request_id);
    CREATE INDEX IF NOT EXISTS idx_relay_usage_model ON relay_usage(model);
    CREATE INDEX IF NOT EXISTS idx_relay_usage_status ON relay_usage(status);
    CREATE INDEX IF NOT EXISTS idx_relay_usage_cursor_agent_account ON relay_usage(cursor_agent_account);
    CREATE INDEX IF NOT EXISTS idx_relay_usage_platform_billing ON relay_usage(platform_billing, created_at DESC);
  `);
  dbCache.set(dbPath, db);
  return db;
}

function closeUsageDbs() {
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  dbCache = new Map();
}

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function normalizeUsage(rawUsage = {}) {
  const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
  const usageMeta = usage.usageMetadata && typeof usage.usageMetadata === 'object'
    ? usage.usageMetadata
    : {};
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const outputDetails = usage.output_tokens_details || usage.completion_tokens_details || {};
  const cacheReadCandidates = [
    inputDetails.cached_tokens,
    inputDetails.cached_input_tokens,
    inputDetails.cache_read_input_tokens,
    inputDetails.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_input_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cached_input_tokens,
    usage.cachedContentTokenCount,
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.input_cached_tokens,
    usageMeta.cachedContentTokenCount,
    usageMeta.cacheReadInputTokens,
    usageMeta.cacheReadTokens,
  ];
  const deepSeekCacheHitTokens = toInt(usage.prompt_cache_hit_tokens);
  const deepSeekCacheMissTokens = toInt(usage.prompt_cache_miss_tokens);
  const inputTokens = toInt(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount)
    || toInt(usageMeta.promptTokenCount)
    || deepSeekCacheHitTokens + deepSeekCacheMissTokens;
  const outputTokens = toInt(usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount)
    || toInt(usageMeta.candidatesTokenCount);
  const cachedInputTokens = cacheReadCandidates.reduce((value, candidate) => (
    value > 0 ? value : toInt(candidate)
  ), 0);
  const totalTokens = toInt(usage.total_tokens) || inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    rawUsageJson: Object.keys(usage).length ? JSON.stringify(usage) : '',
    reasoningTokens: toInt(outputDetails.reasoning_tokens),
  };
}

function estimateCost(modelName, rawUsage = {}) {
  const price = matchModelPrice(modelName);
  const usage = normalizeUsage(rawUsage);
  const billableInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const inputCostUsd = (billableInputTokens / 1_000_000) * price.inputPerMillion;
  const cachedInputCostUsd = (usage.cachedInputTokens / 1_000_000) * price.cachedInputPerMillion;
  const outputCostUsd = (usage.outputTokens / 1_000_000) * price.outputPerMillion;
  const totalCostUsd = inputCostUsd + cachedInputCostUsd + outputCostUsd;
  return {
    ...usage,
    ...price,
    inputCostUsd,
    cachedInputCostUsd,
    outputCostUsd,
    totalCostUsd,
    points: USD_PER_POINT > 0 ? totalCostUsd / USD_PER_POINT : 0,
  };
}

function hasRecordedTokenUsage(cost = {}) {
  return toInt(cost.inputTokens) > 0
    || toInt(cost.cachedInputTokens) > 0
    || toInt(cost.outputTokens) > 0
    || toInt(cost.totalTokens) > 0;
}

function estimateUsageFromTextChars(promptChars = 0, responseTextChars = 0) {
  const input = Math.max(0, Math.ceil(Number(promptChars) / 4));
  const output = Math.max(0, Math.ceil(Number(responseTextChars) / 4));
  if (!input && !output) return null;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
}

function recordRelayUsage(customRoot, payload = {}) {
  const isLocalProxy = !(payload.platformBilling === true || Number(payload.platformBilling) === 1);
  let usageInput = payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  let usageEstimated = false;
  if (isLocalProxy && !hasRecordedTokenUsage(estimateCost(payload.model, usageInput))) {
    const estimated = estimateUsageFromTextChars(payload.promptChars, payload.responseTextChars);
    if (estimated) {
      usageInput = estimated;
      usageEstimated = true;
    }
  }
  const cost = estimateCost(payload.model, usageInput);
  const billedPoints = !isLocalProxy && Number(payload.billedPoints) > 0 ? Number(payload.billedPoints) : null;
  const forceRecord = payload.forceRecord === true || isLocalProxy;
  if (!hasRecordedTokenUsage(cost) && billedPoints == null && !forceRecord) {
    return { ok: true, skipped: true, reason: 'zero_token_usage', dbPath: getUsageDbPath(customRoot) };
  }
  let db = null;
  try {
    db = openUsageDb(customRoot);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      reason: 'usage_db_unavailable',
      dbPath: getUsageDbPath(customRoot),
      error: error?.message || String(error),
    };
  }
  const createdAt = payload.createdAt || new Date().toISOString();
  const status = String(payload.status || 'unknown');
  const row = {
    created_at: createdAt,
    request_id: String(payload.requestId || ''),
    conversation_id: String(payload.conversationId || ''),
    mode: String(payload.mode || ''),
    phase: String(payload.phase || ''),
    endpoint_mode: String(payload.endpointMode || ''),
    display_name: String(payload.displayName || payload.model || '').trim(),
    model: String(payload.model || ''),
    model_label: cost.modelLabel,
    status,
    http_status: toInt(payload.httpStatus),
    error: String(payload.error || ''),
    input_tokens: cost.inputTokens,
    cached_input_tokens: cost.cachedInputTokens,
    output_tokens: cost.outputTokens,
    total_tokens: cost.totalTokens,
    input_price_per_million: cost.inputPerMillion,
    cached_input_price_per_million: cost.cachedInputPerMillion,
    output_price_per_million: cost.outputPerMillion,
    input_cost_usd: cost.inputCostUsd,
    cached_input_cost_usd: cost.cachedInputCostUsd,
    output_cost_usd: cost.outputCostUsd,
    total_cost_usd: cost.totalCostUsd,
    points: isLocalProxy ? null : cost.points,
    billed_points: billedPoints,
    duration_ms: toInt(payload.durationMs),
    prompt_chars: toInt(payload.promptChars),
    response_text_chars: toInt(payload.responseTextChars),
    reasoning_chars: toInt(payload.reasoningChars),
    tool_calls: toInt(payload.toolCalls),
    upstream_base_url: String(payload.upstreamBaseUrl || ''),
    price_source: cost.priceSource,
    price_source_url: cost.priceSourceUrl,
    raw_usage_json: cost.rawUsageJson,
    meta_json: payload.meta
      ? JSON.stringify({ ...payload.meta, ...(usageEstimated ? { usageEstimated: true } : {}) })
      : (usageEstimated ? JSON.stringify({ usageEstimated: true }) : ''),
    cursor_agent_account: String(payload.cursorAgentAccount || ''),
    reasoning_effort: String(payload.reasoningEffort || ''),
    platform_billing: payload.platformBilling === true || Number(payload.platformBilling) === 1 ? 1 : 0,
  };
  const stmt = db.prepare(`
    INSERT INTO relay_usage (
      created_at, request_id, conversation_id, mode, phase, endpoint_mode, display_name, model, model_label,
      status, http_status, error, input_tokens, cached_input_tokens, output_tokens, total_tokens,
      input_price_per_million, cached_input_price_per_million, output_price_per_million,
      input_cost_usd, cached_input_cost_usd, output_cost_usd, total_cost_usd, points, billed_points,
      duration_ms, prompt_chars, response_text_chars, reasoning_chars, tool_calls,
      upstream_base_url, price_source, price_source_url, raw_usage_json, meta_json, cursor_agent_account,
      reasoning_effort, platform_billing
    ) VALUES (
      @created_at, @request_id, @conversation_id, @mode, @phase, @endpoint_mode, @display_name, @model, @model_label,
      @status, @http_status, @error, @input_tokens, @cached_input_tokens, @output_tokens, @total_tokens,
      @input_price_per_million, @cached_input_price_per_million, @output_price_per_million,
      @input_cost_usd, @cached_input_cost_usd, @output_cost_usd, @total_cost_usd, @points, @billed_points,
      @duration_ms, @prompt_chars, @response_text_chars, @reasoning_chars, @tool_calls,
      @upstream_base_url, @price_source, @price_source_url, @raw_usage_json, @meta_json, @cursor_agent_account,
      @reasoning_effort, @platform_billing
    )
  `);
  const info = stmt.run(row);
  return { ok: true, id: info.lastInsertRowid, dbPath: getUsageDbPath(customRoot), row };
}

function appendRelayUsageMeta(customRoot, usageId, extraMeta = {}) {
  if (!usageId || !extraMeta || typeof extraMeta !== 'object') return { ok: false };
  if (isDatabaseDisabled()) return { ok: false, skipped: true, reason: databaseDisabledReason };
  const db = openUsageDb(customRoot);
  const row = db.prepare('SELECT meta_json FROM relay_usage WHERE id = ?').get(usageId);
  if (!row) return { ok: false };
  let existing = {};
  try { existing = JSON.parse(row.meta_json || '{}'); } catch { /* empty */ }
  const merged = JSON.stringify({ ...existing, ...extraMeta });
  db.prepare('UPDATE relay_usage SET meta_json = ? WHERE id = ?').run(merged, usageId);
  return { ok: true };
}

function deleteZeroTokenRelayUsage(customRoot) {
  if (isDatabaseDisabled()) {
    return { ok: false, skipped: true, reason: databaseDisabledReason, deleted: 0, dbPath: getUsageDbPath(customRoot) };
  }
  const db = openUsageDb(customRoot);
  const info = db.prepare(`
    DELETE FROM relay_usage
    WHERE COALESCE(input_tokens, 0) = 0
      AND COALESCE(cached_input_tokens, 0) = 0
      AND COALESCE(output_tokens, 0) = 0
      AND COALESCE(total_tokens, 0) = 0
      AND COALESCE(billed_points, 0) = 0
  `).run();
  try {
    db.prepare('VACUUM').run();
  } catch {
    /* WAL mode may delay vacuum; deleting rows is enough for UI. */
  }
  return { ok: true, deleted: info.changes || 0, dbPath: getUsageDbPath(customRoot) };
}

function syncUsageFromHistory(customRoot) {
  const dataDir = getRelayDataDir(customRoot);
  const historyRoot = path.join(dataDir, 'history');
  if (!fs.existsSync(historyRoot)) return { ok: true, inserted: 0, skipped: true };
  if (isDatabaseDisabled()) {
    return { ok: false, inserted: 0, skipped: true, reason: databaseDisabledReason };
  }
  const db = openUsageDb(customRoot);
  let lastRunnerConfig = null;
  try {
    lastRunnerConfig = JSON.parse(fs.readFileSync(path.join(dataDir, 'runner-config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    lastRunnerConfig = null;
  }
  const upstream = lastRunnerConfig?.upstream && typeof lastRunnerConfig.upstream === 'object'
    ? lastRunnerConfig.upstream
    : {};
  let inserted = 0;
  const dirs = fs.readdirSync(historyRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(historyRoot, entry.name));
  for (const dir of dirs) {
    const contextPath = path.join(dir, 'context.json');
    if (!fs.existsSync(contextPath)) continue;
    let context = null;
    try {
      context = JSON.parse(fs.readFileSync(contextPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    const items = Array.isArray(context?.items) ? context.items : [];
    const completed = items.filter((item) => (
      item?.kind === 'metadata'
      && item?.payload?.type === 'turn_completed'
      && item?.payload?.value?.request_id
    ));
    for (const item of completed) {
      const requestId = String(item.payload.value.request_id || item.request_id || '').trim();
      if (!requestId) continue;
      const request = items.find((candidate) => (
        candidate?.request_id === requestId
        && candidate?.kind === 'user_message'
      ));
      const exists = db.prepare('SELECT id, model, display_name FROM relay_usage WHERE request_id = ? LIMIT 1').get(requestId);
      if (exists) {
        if (upstream.modelName || request?.payload?.mode) {
          const shouldBackfillDisplayName = !String(exists.display_name || '').trim()
            && (!String(exists.model || '').trim() || String(exists.model || '').trim() === String(upstream.modelName || '').trim());
          db.prepare(`
            UPDATE relay_usage
            SET
              mode = CASE WHEN COALESCE(mode, '') = '' THEN @mode ELSE mode END,
              display_name = CASE WHEN COALESCE(display_name, '') = '' AND @shouldBackfillDisplayName = 1 THEN @displayName ELSE display_name END,
              model = CASE WHEN COALESCE(model, '') = '' THEN @model ELSE model END,
              endpoint_mode = CASE WHEN COALESCE(endpoint_mode, '') = '' THEN @endpointMode ELSE endpoint_mode END,
              upstream_base_url = CASE WHEN COALESCE(upstream_base_url, '') = '' THEN @baseUrl ELSE upstream_base_url END,
              reasoning_effort = CASE WHEN COALESCE(reasoning_effort, '') = '' THEN @reasoningEffort ELSE reasoning_effort END
            WHERE id = @id
          `).run({
            id: exists.id,
            mode: String(request?.payload?.mode || ''),
            displayName: String(upstream.displayName || upstream.modelName || ''),
            shouldBackfillDisplayName: shouldBackfillDisplayName ? 1 : 0,
            model: String(upstream.modelName || ''),
            endpointMode: String(upstream.endpointMode || ''),
            baseUrl: String(upstream.baseUrl || ''),
            reasoningEffort: String(upstream.reasoningEffort || ''),
          });
        }
        continue;
      }
      const assistant = [...items].reverse().find((candidate) => (
        candidate?.request_id === requestId
        && candidate?.kind === 'assistant_text'
      ));
      const createdAt = String(item.created_at || assistant?.created_at || request?.created_at || context.updated_at || new Date().toISOString());
      const responseText = String(assistant?.payload?.text || '');
      const result = recordRelayUsage(customRoot, {
        createdAt,
        requestId,
        conversationId: String(context.conversation_id || ''),
        mode: String(request?.payload?.mode || ''),
        phase: 'history',
        endpointMode: String(upstream.endpointMode || ''),
        displayName: String(upstream.displayName || upstream.modelName || ''),
        model: String(upstream.modelName || ''),
        status: item.payload.value.status === 'failed' ? 'failed' : 'success',
        usage: {},
        responseTextChars: responseText.length,
        upstreamBaseUrl: String(upstream.baseUrl || ''),
        reasoningEffort: String(upstream.reasoningEffort || ''),
        meta: { source: 'history_backfill' },
        platformBilling: true,
      });
      if (!result?.skipped) inserted += 1;
    }
  }
  return { ok: true, inserted };
}

function buildWhere(filters = {}) {
  const where = [];
  const params = {};
  if (filters.platformBillingOnly === true) {
    where.push('platform_billing = 1');
  } else if (filters.platformBillingOnly === false) {
    where.push('platform_billing = 0');
  }
  if (filters.from) {
    where.push('created_at >= @from');
    params.from = `${filters.from}T00:00:00.000Z`;
  }
  if (filters.to) {
    where.push('created_at <= @to');
    params.to = `${filters.to}T23:59:59.999Z`;
  }
  if (filters.status) {
    where.push('status = @status');
    params.status = String(filters.status);
  }
  if (filters.model) {
    where.push('(model LIKE @model OR display_name LIKE @model)');
    params.model = `%${String(filters.model)}%`;
  }
  if (filters.requestId) {
    where.push('request_id LIKE @requestId');
    params.requestId = `%${String(filters.requestId)}%`;
  }
  if (filters.cursorAgentAccount) {
    where.push('cursor_agent_account LIKE @cursorAgentAccount');
    params.cursorAgentAccount = `%${String(filters.cursorAgentAccount)}%`;
  }
  return {
    clause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

function listRelayUsage(customRoot, options = {}) {
  if (isDatabaseDisabled()) {
    return {
      ok: false,
      skipped: true,
      reason: databaseDisabledReason,
      page: Math.max(1, toInt(options.page) || 1),
      pageSize: Math.min(100, Math.max(1, toInt(options.pageSize) || 20)),
      total: 0,
      list: [],
      summary: {
        count: 0,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        total_cost_usd: 0,
        points: 0,
        billed_points: 0,
        effective_points: 0,
        success_count: 0,
        pending_count: 0,
        error_count: 0,
      },
    };
  }
  const dbPath = getUsageDbPath(customRoot);
  const forceHistorySync = options.syncHistory === true;
  const lastHistorySyncAt = historySyncCache.get(dbPath) || 0;
  if (forceHistorySync || Date.now() - lastHistorySyncAt >= HISTORY_SYNC_MIN_INTERVAL_MS) {
    syncUsageFromHistory(customRoot);
    historySyncCache.set(dbPath, Date.now());
  }
  const db = openUsageDb(customRoot);
  const pageSize = Math.min(100, Math.max(1, toInt(options.pageSize) || 20));
  const page = Math.max(1, toInt(options.page) || 1);
  const { clause, params } = buildWhere(options);
  const total = db.prepare(`SELECT COUNT(*) AS total FROM relay_usage ${clause}`).get(params)?.total || 0;
  const rows = db.prepare(`
    SELECT * FROM relay_usage
    ${clause}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
      COALESCE(SUM(points), 0) AS points,
      COALESCE(SUM(billed_points), 0) AS billed_points,
      COALESCE(SUM(billed_points), 0) AS effective_points,
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
      COALESCE(SUM(CASE WHEN status IN ('paid', 'pending') THEN 1 ELSE 0 END), 0) AS pending_count,
      COALESCE(SUM(CASE WHEN status NOT IN ('success', 'paid', 'pending') THEN 1 ELSE 0 END), 0) AS error_count
    FROM relay_usage
    ${clause}
  `).get(params);
  return {
    ok: true,
    page,
    pageSize,
    total,
    list: rows,
    summary,
  };
}

function updateRelayUsageBilledPoints(customRoot, usageId, billedPoints, serverEstimatedPoints = null) {
  const amount = Number(billedPoints);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, skipped: true };
  if (isDatabaseDisabled()) return { ok: false, skipped: true, reason: databaseDisabledReason };
  const db = openUsageDb(customRoot);
  const serverPoints = Number(serverEstimatedPoints);
  const info = Number.isFinite(serverPoints) && serverPoints > 0
    ? db.prepare('UPDATE relay_usage SET billed_points = ?, points = ? WHERE id = ?').run(amount, serverPoints, usageId)
    : db.prepare('UPDATE relay_usage SET billed_points = ? WHERE id = ?').run(amount, usageId);
  return { ok: true, updated: info.changes || 0, dbPath: getUsageDbPath(customRoot) };
}

function updateRelayUsageStatusForRequest(customRoot, requestId, fromStatus, toStatus, error = '') {
  const rid = String(requestId || '').trim();
  const nextStatus = String(toStatus || '').trim();
  if (!rid || !nextStatus) return { ok: false, skipped: true };
  if (isDatabaseDisabled()) return { ok: false, skipped: true, reason: databaseDisabledReason };
  const db = openUsageDb(customRoot);
  const params = {
    request_id: rid,
    status: nextStatus,
    error: String(error || ''),
    from_status: String(fromStatus || '').trim(),
  };
  const statusClause = params.from_status ? 'AND status = @from_status' : '';
  const errorSql = params.error ? ', error = @error' : '';
  const info = db.prepare(`
    UPDATE relay_usage
    SET status = @status${errorSql}
    WHERE request_id = @request_id
      ${statusClause}
  `).run(params);
  return { ok: true, updated: info.changes || 0, dbPath: getUsageDbPath(customRoot) };
}

function clearRelayUsage(customRoot) {
  if (isDatabaseDisabled()) {
    return { ok: false, skipped: true, reason: databaseDisabledReason, deleted: 0, dbPath: getUsageDbPath(customRoot) };
  }
  const db = openUsageDb(customRoot);
  const info = db.prepare('DELETE FROM relay_usage').run();
  try {
    db.prepare('VACUUM').run();
  } catch {
    /* WAL mode may delay vacuum; deleting rows is enough for UI. */
  }
  return { ok: true, deleted: info.changes || 0, dbPath: getUsageDbPath(customRoot) };
}

module.exports = {
  getUsageDbPath,
  estimateCost,
  recordRelayUsage,
  appendRelayUsageMeta,
  deleteZeroTokenRelayUsage,
  updateRelayUsageBilledPoints,
  updateRelayUsageStatusForRequest,
  listRelayUsage,
  clearRelayUsage,
  closeUsageDbs,
  isDatabaseDisabled,
};

/**
 * Cursor 第三方模型代理（BYOK / OpenAI 兼容端点）
 * 写入 state.vscdb：applicationUser.useOpenAIKey / openAIBaseUrl + cursorAuth/openAIKey
 */

const fs = require('fs');
const { getStateVscdbPath } = require('./cursor-local-state');
const { reloadRunningCursorWindow, isCursorRunningHeuristic, quitCursorAndWait, launchCursorApp } = require('./cursor-process');
const { createProxyAwareFetch } = require('./proxy-aware-fetch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let CachedDatabaseCtor = null;
let cachedDbMode = '';

function createStatementAdapter(statement, mode) {
  if (mode === 'better-sqlite3') return statement;
  return {
    all(...params) {
      return statement.all(...params);
    },
    get(...params) {
      return statement.get(...params);
    },
    run(...params) {
      const result = statement.run(...params);
      return {
        changes: Number(result?.changes || 0),
        lastInsertRowid: result?.lastInsertRowid,
      };
    },
    pluck() {
      return {
        get: (...params) => {
          const row = statement.get(...params);
          if (row == null) return undefined;
          if (Array.isArray(row)) return row[0];
          if (typeof row === 'object') {
            const firstKey = Object.keys(row)[0];
            return firstKey ? row[firstKey] : undefined;
          }
          return row;
        },
      };
    },
  };
}

function createDbAdapter(rawDb, mode) {
  return {
    prepare(sql) {
      return createStatementAdapter(rawDb.prepare(sql), mode);
    },
    pragma(sql) {
      if (mode === 'better-sqlite3') return rawDb.pragma(sql);
      return rawDb.exec(`PRAGMA ${sql}`);
    },
    exec(sql) {
      return rawDb.exec(sql);
    },
    transaction(fn) {
      if (mode === 'better-sqlite3') return rawDb.transaction(fn);
      return (...args) => {
        rawDb.exec('BEGIN IMMEDIATE');
        try {
          const result = fn(...args);
          rawDb.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            rawDb.exec('ROLLBACK');
          } catch {
            /* ignore */
          }
          throw error;
        }
      };
    },
    close() {
      return rawDb.close();
    },
  };
}

function loadDatabaseCtor() {
  if (CachedDatabaseCtor) {
    return { DatabaseCtor: CachedDatabaseCtor, mode: cachedDbMode };
  }
  try {
    // Prefer the existing native module when its ABI matches.
    CachedDatabaseCtor = require('better-sqlite3');
    cachedDbMode = 'better-sqlite3';
    return { DatabaseCtor: CachedDatabaseCtor, mode: cachedDbMode };
  } catch {
    const sqlite = require('node:sqlite');
    CachedDatabaseCtor = sqlite.DatabaseSync;
    cachedDbMode = 'node:sqlite';
    return { DatabaseCtor: CachedDatabaseCtor, mode: cachedDbMode };
  }
}

function forceNodeSqliteCtor() {
  const sqlite = require('node:sqlite');
  CachedDatabaseCtor = sqlite.DatabaseSync;
  cachedDbMode = 'node:sqlite';
  return { DatabaseCtor: CachedDatabaseCtor, mode: cachedDbMode };
}

/** Cursor 实际读取的 applicationUser（与短键 applicationUser 并存，必须同步写入） */
const REACTIVE_APP_USER_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
const LEGACY_APP_USER_KEY = 'applicationUser';

const PROVIDER_PRESETS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    hint: '官方 OpenAI API，需海外网络或中转',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: '',
    hint: 'Anthropic 原生协议与 OpenAI 不同；这里请填写 Anthropic 兼容网关地址',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    hint: 'DeepSeek 官方 OpenAI 兼容端点',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hint: 'Google Gemini 官方 OpenAI 兼容端点，通常使用 chat/completions',
  },
  mimo: {
    id: 'mimo',
    name: 'MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    hint: '小米 MiMo 官方 OpenAI 兼容端点，推荐模型 mimo-v2.5-pro / mimo-v2.5',
  },
  rightcodes: {
    id: 'rightcodes',
    name: 'Right Code（通用）',
    baseUrl: 'https://api.right.codes/v1',
    hint: 'Right Code 通用 OpenAI 端点；Codex 模型请选「Right Code Codex」',
  },
  rightcodes_codex: {
    id: 'rightcodes_codex',
    name: 'Right Code Codex',
    baseUrl: 'https://www.right.codes/codex/v1',
    hint: 'Right Code Codex 专用端点，支持 gpt-5.x / Responses API（Agent 模式）',
  },
  custom: {
    id: 'custom',
    name: '自定义',
    baseUrl: '',
    hint: '任意 OpenAI 兼容 API 地址，如 OpenRouter、OneAPI 等',
  },
};

function detectItemTableName(db) {
  try {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('itemtable','item_table')",
      )
      .all();
    return rows[0]?.name || 'ItemTable';
  } catch {
    return 'ItemTable';
  }
}

async function openDbWithRetry(dbPath, tries = 25, delayMs = 400) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      let { DatabaseCtor, mode } = loadDatabaseCtor();
      let rawDb;
      try {
        rawDb = new DatabaseCtor(dbPath);
      } catch (openError) {
        const msg = String(openError?.message || '');
        const shouldFallbackToNodeSqlite = mode === 'better-sqlite3'
          && /NODE_MODULE_VERSION|better_sqlite3\.node|ERR_DLOPEN_FAILED/i.test(msg);
        if (!shouldFallbackToNodeSqlite) throw openError;
        ({ DatabaseCtor, mode } = forceNodeSqliteCtor());
        rawDb = new DatabaseCtor(dbPath);
      }
      const db = createDbAdapter(rawDb, mode);
      try {
        db.pragma('journal_mode = WAL');
      } catch {
        /* ignore */
      }
      return db;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? String(e.message) : '';
      if (msg.includes('locked') || msg.includes('busy')) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('无法打开 state.vscdb');
}

function readItem(db, tableName, key) {
  try {
    const v = db.prepare(`SELECT value FROM "${tableName}" WHERE key = ?`).pluck().get(key);
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

function upsertItem(db, tableName, key, value) {
  const info = db.prepare(`UPDATE "${tableName}" SET value = ? WHERE key = ?`).run(value, key);
  if (info.changes === 0) {
    db.prepare(`INSERT INTO "${tableName}" (key, value) VALUES (?, ?)`).run(key, value);
  }
}

function parseApplicationUser(raw) {
  if (raw == null || raw === '') return {};
  const text = typeof raw === 'string' ? raw : String(raw);
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function stripKnownOpenAiEndpointSuffix(urlText) {
  const parsed = new URL(urlText);
  const rawPath = (parsed.pathname || '').replace(/\/+$/, '') || '';
  const pathLower = rawPath.toLowerCase();
  const suffixes = ['/chat/completions', '/responses', '/models'];
  const suffix = suffixes.find((item) => pathLower.endsWith(item));
  if (!suffix) return urlText;
  const nextPath = rawPath.slice(0, rawPath.length - suffix.length) || '/';
  parsed.pathname = nextPath;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function resolveBaseUrl(url, opts = {}) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('Base URL 不能为空');
  if (!/^https?:\/\//i.test(u)) throw new Error('Base URL 需以 http:// 或 https:// 开头');

  try {
    u = stripKnownOpenAiEndpointSuffix(u).replace(/\/+$/, '');
  } catch {
    /* ignore */
  }

  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    const path = (parsed.pathname || '').replace(/\/+$/, '') || '';
    const isBareHost = !path || path === '/';

    // 仅裸域名才做 Right Code 默认映射；保留 /codex/v1、/claude 等子路径
    if (isBareHost && (host === 'www.right.codes' || host === 'right.codes')) {
      return 'https://api.right.codes/v1';
    }
    if (isBareHost && host === 'api.right.codes') {
      return 'https://api.right.codes/v1';
    }
  } catch {
    /* ignore */
  }

  if (opts.autoAppendV1 !== false) {
    try {
      const parsed = new URL(u);
      const path = (parsed.pathname || '').replace(/\/+$/, '') || '';
      const isBareHost = !path || path === '/';
      const hasVersion = /\/v\d+(\/|$)/i.test(path);
      const hasGatewayPrefix = /\/(openai|claude|gemini|codex|api)\b/i.test(path);
      if (isBareHost && !hasVersion && !hasGatewayPrefix) {
        u = `${u}/v1`;
      }
    } catch {
      /* ignore */
    }
  }

  return u.replace(/\/+$/, '');
}

function normalizeBaseUrl(url, opts) {
  return resolveBaseUrl(url, opts);
}

function hintForHttpStatus(status, baseUrl, bodySnippet = '') {
  const host = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (status === 406 && (host.includes('right.codes') || String(bodySnippet).includes('Not Acceptable'))) {
    return '当前地址可能是官网入口而非 API。Right Code 请改用 https://api.right.codes/v1';
  }
  if (status === 404 && host.includes('right.codes')) {
    return '路径不存在。OpenAI 兼容接口请使用 https://api.right.codes/v1';
  }
  if (status === 406) {
    return '服务端不接受当前探测请求，可改用 chat/completions 探测或检查 Base URL 是否含 /v1';
  }
  return '';
}

function looksLikeAnthropicNative(providerId, baseUrl) {
  const pid = String(providerId || '').trim().toLowerCase();
  const host = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return pid === 'anthropic' && host.endsWith('anthropic.com');
}

function prefersResponsesApi(providerId, baseUrl) {
  const pid = String(providerId || '').trim().toLowerCase();
  const url = String(baseUrl || '').toLowerCase();
  if (pid === 'gemini' || pid.includes('gemini') || isMimoProvider(providerId, baseUrl)) return false;
  return pid === 'rightcodes_codex' || url.includes('/codex/');
}

function buildRelayUserAgent(baseUrl) {
  try {
    const host = new URL(String(baseUrl || '')).hostname;
    const product = String(host || 'Sub2API').replace(/[^A-Za-z0-9.-]/g, '') || 'Sub2API';
    return `Mozilla/5.0 (compatible; ${product}-Relay/1.0)`;
  } catch {
    return 'Mozilla/5.0 (compatible; Sub2API-Relay/1.0)';
  }
}

function isMimoProvider(providerId, baseUrl = '') {
  const pid = String(providerId || '').trim().toLowerCase();
  const url = String(baseUrl || '').toLowerCase();
  return pid === 'mimo' || pid.includes('mimo') || url.includes('xiaomimimo.com');
}

function buildMimoThinkingOption(providerId, baseUrl, thinkingMode = '') {
  if (!isMimoProvider(providerId, baseUrl)) return null;
  const mode = String(thinkingMode || 'disabled').trim().toLowerCase();
  return { type: mode === 'enabled' ? 'enabled' : 'disabled' };
}

function estimateOutputTokens(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const asciiWords = (value.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length;
  const punctuation = (value.match(/[^\sA-Za-z0-9_\u3400-\u9fff]/g) || []).length;
  return Math.max(1, Math.round(cjk + asciiWords * 1.3 + punctuation * 0.3));
}

function formatSeconds(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '-';
  return `${Math.round((value / 1000) * 10) / 10} s`;
}

function formatPerformanceSummary(metrics = null, fallbackLatencyMs = 0) {
  const tps = Number(metrics?.tokensPerSecond) || 0;
  const ttftMs = Number(metrics?.ttftMs) || 0;
  if (tps > 0 || ttftMs > 0) {
    const speed = tps > 0 ? `${Math.round(tps * 10) / 10} t/s` : '- t/s';
    const first = ttftMs > 0 ? `首字 ${formatSeconds(ttftMs)}` : '首字 -';
    return `${speed} | ${first}`;
  }
  const latency = Number(fallbackLatencyMs) || 0;
  return latency > 0 ? `总耗时 ${latency} ms` : '';
}

function extractUsageOutputTokens(payload) {
  const usage = payload?.usage || payload?.response?.usage || payload?.data?.usage || null;
  if (!usage || typeof usage !== 'object') return 0;
  return Number(
    usage.output_tokens
    || usage.completion_tokens
    || usage.generated_tokens
    || usage.outputTokens
    || usage.completionTokens
    || 0,
  ) || 0;
}

function extractStreamText(payload, compatMode = '', eventName = '') {
  const mode = String(compatMode || '').toLowerCase();
  const event = String(eventName || payload?.type || '').toLowerCase();
  const parts = [];

  if (Array.isArray(payload?.choices)) {
    payload.choices.forEach((choice) => {
      const delta = choice?.delta || {};
      const message = choice?.message || {};
      [
        delta.content,
        delta.reasoning_content,
        delta.reasoning,
        delta.text,
        message.content,
        choice?.text,
      ].forEach((item) => {
        if (typeof item === 'string') parts.push(item);
      });
    });
  }

  if (mode === 'responses' || event.includes('response.')) {
    if (typeof payload?.delta === 'string' && /output_text|text|refusal/.test(event)) {
      parts.push(payload.delta);
    }
    if (typeof payload?.text === 'string') parts.push(payload.text);
    if (typeof payload?.output_text === 'string') parts.push(payload.output_text);
  }

  return parts.join('');
}

function extractJsonText(payload) {
  const parts = [];
  if (Array.isArray(payload?.choices)) {
    payload.choices.forEach((choice) => {
      const message = choice?.message || {};
      [message.content, choice?.text].forEach((item) => {
        if (typeof item === 'string') parts.push(item);
      });
    });
  }
  if (typeof payload?.output_text === 'string') parts.push(payload.output_text);
  if (Array.isArray(payload?.output)) {
    payload.output.forEach((item) => {
      if (Array.isArray(item?.content)) {
        item.content.forEach((content) => {
          if (typeof content?.text === 'string') parts.push(content.text);
        });
      }
    });
  }
  return parts.join('');
}

async function readSyncMetrics(resp, startedAt) {
  const text = await resp.text();
  const endedAt = Date.now();
  const durationMs = Math.max(1, endedAt - startedAt);
  const parsed = (() => {
    try { return JSON.parse(text); } catch { return null; }
  })();
  const outputText = parsed ? extractJsonText(parsed) : text;
  const outputTokens = extractUsageOutputTokens(parsed) || estimateOutputTokens(outputText);
  return {
    bodySnippet: text.slice(0, 300),
    outputText,
    outputTokens,
    outputTokensEstimated: !extractUsageOutputTokens(parsed),
    ttftMs: durationMs,
    durationMs,
    generationMs: durationMs,
    tokensPerSecond: outputTokens > 0
      ? Math.round((outputTokens / (durationMs / 1000)) * 10) / 10
      : 0,
  };
}

async function readStreamingMetrics(resp, startedAt, compatMode = '') {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const text = await resp.text();
    const parsed = (() => {
      try { return JSON.parse(text); } catch { return null; }
    })();
    const outputText = parsed ? extractJsonText(parsed) : text;
    const outputTokens = extractUsageOutputTokens(parsed) || estimateOutputTokens(outputText);
    return {
      bodySnippet: text.slice(0, 300),
      outputText,
      outputTokens,
      outputTokensEstimated: !extractUsageOutputTokens(parsed),
      ttftMs: 0,
      durationMs: Date.now() - startedAt,
      generationMs: 0,
      tokensPerSecond: 0,
    };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rawText = '';
  let outputText = '';
  let usageOutputTokens = 0;
  let firstTextAt = 0;

  const consumeSseBlock = (block) => {
    const lines = String(block || '').split(/\r?\n/);
    const dataLines = [];
    let eventName = '';
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') return;
    let payload = null;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const text = extractStreamText(payload, compatMode, eventName);
    if (text) {
      if (!firstTextAt) firstTextAt = Date.now();
      outputText += text;
    }
    usageOutputTokens = extractUsageOutputTokens(payload) || usageOutputTokens;
  };

  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawText += chunk;
    buffer += chunk;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    blocks.forEach(consumeSseBlock);
  }
  const tail = decoder.decode();
  if (tail) {
    rawText += tail;
    buffer += tail;
  }
  if (buffer.trim()) consumeSseBlock(buffer);

  if (!outputText && rawText.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawText.trim());
      outputText = extractJsonText(parsed);
      usageOutputTokens = extractUsageOutputTokens(parsed) || usageOutputTokens;
      if (outputText && !firstTextAt) firstTextAt = Date.now();
    } catch {
      /* ignore */
    }
  }

  const endedAt = Date.now();
  const outputTokens = usageOutputTokens || estimateOutputTokens(outputText);
  const generationMs = firstTextAt ? Math.max(1, endedAt - firstTextAt) : 0;
  return {
    bodySnippet: (outputText || rawText).slice(0, 300),
    outputText,
    outputTokens,
    outputTokensEstimated: !usageOutputTokens,
    ttftMs: firstTextAt ? firstTextAt - startedAt : 0,
    durationMs: endedAt - startedAt,
    generationMs,
    tokensPerSecond: outputTokens > 0 && generationMs > 0
      ? Math.round((outputTokens / (generationMs / 1000)) * 10) / 10
      : 0,
  };
}

function buildProbeAttempts({ baseUrl, apiKey, modelName, providerId, endpointMode, reasoningEffort, thinkingMode, attempt }) {
  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'User-Agent': buildRelayUserAgent(baseUrl),
  };
  if (isMimoProvider(providerId, baseUrl)) {
    authHeaders['api-key'] = apiKey;
  }
  const normalizedEndpointMode = String(endpointMode || '').trim().toLowerCase();
  const normalizedReasoningEffort = ['low', 'medium', 'high', 'xhigh'].includes(String(reasoningEffort || '').trim().toLowerCase())
    ? String(reasoningEffort || '').trim().toLowerCase()
    : '';
  const reasoning = !isMimoProvider(providerId, baseUrl) && normalizedReasoningEffort
    ? { effort: normalizedReasoningEffort }
    : null;
  const mimoThinking = buildMimoThinkingOption(providerId, baseUrl, thinkingMode);

  const probePrompt = '请输出一段约80个字的中文速度测试文本，不要解释。';
  const chatBody = (stream) => ({
    model: modelName,
    messages: [{ role: 'user', content: probePrompt }],
    ...(reasoning ? { reasoning: { effort: reasoning.effort } } : {}),
    ...(mimoThinking ? { thinking: mimoThinking } : {}),
    ...(mimoThinking ? { max_completion_tokens: 96 } : { max_tokens: 96 }),
    temperature: 0,
    stream,
  });
  const responsesBody = (stream) => ({
    model: modelName,
    input: probePrompt,
    ...(reasoning ? { reasoning } : {}),
    max_output_tokens: 96,
    temperature: 0,
    stream,
  });

  const chatSyncAttempt = {
    method: 'POST /chat/completions',
    compatMode: 'chat',
    run: () => attempt(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody(false)),
      metricMode: 'sync',
      compatMode: 'chat',
    }),
  };
  const chatStreamAttempt = {
    method: 'POST /chat/completions (stream)',
    compatMode: 'chat',
    run: () => attempt(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody(true)),
      metricMode: 'stream',
      compatMode: 'chat',
    }),
  };
  const responsesSyncAttempt = {
    method: 'POST /responses',
    compatMode: 'responses',
    run: () => attempt(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(responsesBody(false)),
      metricMode: 'sync',
      compatMode: 'responses',
    }),
  };
  const responsesStreamAttempt = {
    method: 'POST /responses (stream)',
    compatMode: 'responses',
    run: () => attempt(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(responsesBody(true)),
      metricMode: 'stream',
      compatMode: 'responses',
    }),
  };
  const modelsAttempt = {
    method: 'GET /models',
    compatMode: 'models',
    run: () => attempt(`${baseUrl}/models`, { method: 'GET', headers: authHeaders }),
  };

  const generationAttempts = normalizedEndpointMode === 'responses'
    ? [responsesSyncAttempt, chatSyncAttempt, responsesStreamAttempt, chatStreamAttempt]
    : normalizedEndpointMode === 'chat'
      ? [chatSyncAttempt, responsesSyncAttempt, chatStreamAttempt, responsesStreamAttempt]
      : prefersResponsesApi(providerId, baseUrl)
        ? [responsesSyncAttempt, chatSyncAttempt, responsesStreamAttempt, chatStreamAttempt]
        : [chatSyncAttempt, responsesSyncAttempt, chatStreamAttempt, responsesStreamAttempt];

  return [...generationAttempts, modelsAttempt];
}

function maskApiKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function guessProviderId(baseUrl) {
  const u = String(baseUrl || '').toLowerCase();
  if (!u) return 'custom';
  if (u.includes('right.codes/codex')) return 'rightcodes_codex';
  if (u.includes('right.codes')) return 'rightcodes';
  if (u.includes('openai.com')) return 'openai';
  if (u.includes('anthropic.com')) return 'anthropic';
  if (u.includes('deepseek.com')) return 'deepseek';
  if (u.includes('generativelanguage.googleapis.com') || u.includes('googleapis.com/gemini')) return 'gemini';
  if (u.includes('xiaomimimo.com')) return 'mimo';
  return 'custom';
}

function readApplicationUserFromDb(db, tableName) {
  const reactiveRaw = readItem(db, tableName, REACTIVE_APP_USER_KEY);
  const legacyRaw = readItem(db, tableName, LEGACY_APP_USER_KEY);
  const reactive = parseApplicationUser(reactiveRaw);
  const legacy = parseApplicationUser(legacyRaw);
  const useOpenAIKey = Boolean(reactive.useOpenAIKey || legacy.useOpenAIKey);
  const openAIBaseUrlRaw = reactive.openAIBaseUrl != null && String(reactive.openAIBaseUrl).trim() !== ''
    ? reactive.openAIBaseUrl
    : legacy.openAIBaseUrl;
  const baseUrl = openAIBaseUrlRaw != null ? String(openAIBaseUrlRaw).trim() : '';
  return {
    reactiveRaw,
    legacyRaw,
    reactive,
    legacy,
    useOpenAIKey,
    baseUrl,
    synced: Boolean(reactive.useOpenAIKey) === Boolean(legacy.useOpenAIKey)
      && String(reactive.openAIBaseUrl || '') === String(legacy.openAIBaseUrl || ''),
  };
}

function applyOpenAiFields(appUser, { enabled, baseUrl }) {
  appUser.useOpenAIKey = enabled;
  appUser.openAIBaseUrl = enabled ? baseUrl : null;
  if (!appUser.azureState || typeof appUser.azureState !== 'object') {
    appUser.azureState = { useAzure: false, baseUrl: '', deployment: '', apiKey: '' };
  }
  return appUser;
}

function writeApplicationUserBoth(db, tableName, { enabled, baseUrl }) {
  const current = readApplicationUserFromDb(db, tableName);

  const reactiveNext = applyOpenAiFields(
    current.reactive && Object.keys(current.reactive).length ? { ...current.reactive } : {},
    { enabled, baseUrl },
  );
  const legacyNext = applyOpenAiFields(
    current.legacy && Object.keys(current.legacy).length ? { ...current.legacy } : {},
    { enabled, baseUrl },
  );

  upsertItem(db, tableName, REACTIVE_APP_USER_KEY, JSON.stringify(reactiveNext));
  upsertItem(db, tableName, LEGACY_APP_USER_KEY, JSON.stringify(legacyNext));
}

function deleteItem(db, tableName, key) {
  try {
    db.prepare(`DELETE FROM "${tableName}" WHERE key = ?`).run(key);
  } catch {
    /* ignore */
  }
}

function uniqueModelNames(modelNames = [], primaryModel = '') {
  const seen = new Set();
  const items = [];
  const push = (value) => {
    const name = String(value || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    items.push(name);
  };
  push(primaryModel);
  if (Array.isArray(modelNames)) {
    modelNames.forEach(push);
  }
  return items;
}

function normalizeRelayReasoningEffort(rawReasoningEffort = 'extra-high') {
  const effort = String(rawReasoningEffort || 'extra-high').trim().toLowerCase();
  if (!effort) return 'extra-high';
  if (effort === 'xhigh') return 'extra-high';
  return effort;
}

function getRelayReasoningBadgeLabel(rawReasoningEffort = 'extra-high') {
  const effort = normalizeRelayReasoningEffort(rawReasoningEffort);
  return effort === 'extra-high'
    ? 'XHigh'
    : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

function buildRelayModelParameterDefinitions() {
  return [
    {
      id: 'thinking',
      name: 'thinking',
      markdownTooltip: 'Enable thinking mode for this local relay model.',
      parameterType: {
        booleanParameter: {},
      },
    },
    {
      id: 'reasoning',
      name: 'reasoning',
      markdownTooltip: 'Reasoning effort level.',
      parameterType: {
        enumParameter: {
          values: [
            { value: 'low', displayName: 'Low' },
            { value: 'medium', displayName: 'Medium' },
            { value: 'high', displayName: 'High' },
            { value: 'extra-high', displayName: 'XHigh' },
          ],
        },
      },
    },
  ];
}

function buildRelayModelVariants(modelName, shortName, rawReasoningEffort = 'extra-high') {
  const normalizedEffort = normalizeRelayReasoningEffort(rawReasoningEffort);
  const badgeLabel = getRelayReasoningBadgeLabel(normalizedEffort);
  return [
    {
      parameterValues: [
        { id: 'thinking', value: 'true' },
        { id: 'reasoning', value: normalizedEffort },
      ],
      displayName: `${modelName} ${badgeLabel}`.trim(),
      displayNameOutsidePicker: `${shortName} ${badgeLabel}`.trim(),
      variantStringRepresentation: `${String(modelName || '').toLowerCase().replace(/\s+/g, '-')}-thinking-${normalizedEffort}`,
      isMaxMode: false,
      isDefaultMaxConfig: false,
      isDefaultNonMaxConfig: true,
      tooltipData: {
        markdownContent: `Thinking enabled<br /><br />Reasoning: ${badgeLabel}`,
      },
      tagline: 'Reasoning enabled',
    },
  ];
}

function buildRelaySelectedModel(modelName, rawReasoningEffort = 'extra-high') {
  const normalizedEffort = normalizeRelayReasoningEffort(rawReasoningEffort);
  return {
    modelId: modelName,
    parameters: [
      { id: 'thinking', value: 'true' },
      { id: 'reasoning', value: normalizedEffort },
    ],
  };
}

function mergeUniqueStrings(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      merged.push(value);
    }
  }
  return merged;
}

function buildRelayModelEntry(name, primaryModel, rawReasoningEffort = 'medium') {
  const modelName = String(name || '').trim();
  const shortName = modelName;
  const normalizedEffort = normalizeRelayReasoningEffort(rawReasoningEffort);
  const reasoningLabel = getRelayReasoningBadgeLabel(normalizedEffort);
  const tooltipParts = [
    `**${modelName}**`,
    `Model: ${modelName}`,
    'Local provider model',
    '200000 context window',
    'Thinking: enabled',
    `Reasoning: ${reasoningLabel}`,
  ];
  return {
    name: modelName,
    defaultOn: true,
    visibleInRoutedModelView: true,
    namedModelSectionIndex: 99,
    tagline: 'Local provider model',
    parameterDefinitions: [],
    variants: [],
    legacySlugs: [],
    idAliases: [],
    cloudAgentEffortModes: [],
    supportsAgent: true,
    supportsThinking: true,
    supportsImages: true,
    supportsAutoContext: true,
    autoContextMaxTokens: 200000,
    autoContextExtendedMaxTokens: 200000,
    supportsMaxMode: true,
    contextTokenLimit: 200000,
    clientDisplayName: modelName,
    serverModelName: modelName,
    supportsNonMaxMode: true,
    supportsPlanMode: true,
    inputboxShortModelName: shortName,
    supportsSandboxing: true,
    supportsCmdK: true,
    parameterDefinitions: buildRelayModelParameterDefinitions(),
    variants: buildRelayModelVariants(modelName, shortName, normalizedEffort),
    cloudAgentEffortModes: ['low', 'medium', 'high', 'extra-high'],
    tooltipData: {
      markdownContent: tooltipParts.join('<br /><br />'),
    },
    degradationStatus: 0,
    isUserAdded: true,
  };
}

function buildFeatureModelConfig(defaultModel, models, previousConfig = null) {
  const previous = previousConfig && typeof previousConfig === 'object' ? previousConfig : {};
  return {
    defaultModel,
    fallbackModels: mergeUniqueStrings(models, previous.fallbackModels),
    bestOfNDefaultModels: mergeUniqueStrings(models, previous.bestOfNDefaultModels),
  };
}

function isPreservedBuiltInModel(name = '') {
  const modelName = String(name || '').trim().toLowerCase();
  return modelName === 'default' || modelName === 'auto';
}

function buildRelayModelSelectionState(modelName, rawReasoningEffort = 'extra-high') {
  return {
    modelId: modelName,
    displayModelId: modelName,
    displayName: modelName,
    displayNameShort: String(modelName || '').trim().slice(0, 20),
    parameters: buildRelaySelectedModel(modelName, rawReasoningEffort).parameters,
  };
}

function updateModelConfigEntry(entry, defaultModel, rawReasoningEffort = 'extra-high') {
  const next = entry && typeof entry === 'object' ? { ...entry } : {};
  const currentModel = String(next.modelName || '').trim().toLowerCase();
  if (!currentModel || currentModel === 'default') {
    next.modelName = defaultModel;
  }
  const effectiveModel = String(next.modelName || defaultModel || '').trim() || defaultModel;
  if (Array.isArray(next.selectedModels)) {
    next.selectedModels = next.selectedModels.map((item, index) => {
      if (!item || typeof item !== 'object') return item;
      const nextItem = { ...item };
      const itemModel = String(nextItem.modelId || '').trim().toLowerCase();
      if (index === 0 && (!itemModel || itemModel === 'default')) {
        nextItem.modelId = effectiveModel;
        nextItem.parameters = buildRelaySelectedModel(effectiveModel, rawReasoningEffort).parameters;
      }
      if (String(nextItem.modelId || '').trim() === effectiveModel && !Array.isArray(nextItem.parameters)) {
        nextItem.parameters = buildRelaySelectedModel(effectiveModel, rawReasoningEffort).parameters;
      }
      return nextItem;
    });
  } else if (effectiveModel) {
    next.selectedModels = [buildRelaySelectedModel(effectiveModel, rawReasoningEffort)];
  }
  return next;
}

function applyRelayModelCatalog(appUser, {
  primaryModel,
  availableModels,
  contextWindow,
  reasoningEffort = 'medium',
}) {
  const models = uniqueModelNames(availableModels, primaryModel);
  if (!models.length) return appUser;
  const maxContextTokens = Math.max(1, Math.min(200000, Number(contextWindow) || 200000));
  const normalizedEffort = normalizeRelayReasoningEffort(reasoningEffort);

  const next = appUser && typeof appUser === 'object' ? { ...appUser } : {};
  const localModelSet = new Set(models);
  const existingCatalog = Array.isArray(next.availableDefaultModels2) ? next.availableDefaultModels2 : [];
  const mergedCatalog = [];
  const seenCatalogNames = new Set();
  for (const item of existingCatalog) {
    const modelName = String(item?.name || '').trim();
    if (!modelName || seenCatalogNames.has(modelName)) continue;
    if (!localModelSet.has(modelName) && !isPreservedBuiltInModel(modelName)) continue;
    seenCatalogNames.add(modelName);
    if (localModelSet.has(modelName)) {
      mergedCatalog.push({
        ...(item && typeof item === 'object' ? item : {}),
        ...buildRelayModelEntry(modelName, primaryModel, normalizedEffort),
      });
    } else {
      mergedCatalog.push(item);
    }
  }
  for (const modelName of models) {
    if (seenCatalogNames.has(modelName)) continue;
    seenCatalogNames.add(modelName);
    mergedCatalog.push(buildRelayModelEntry(modelName, primaryModel, normalizedEffort));
  }
  next.availableDefaultModels2 = mergedCatalog;
  next.localProviderModelIds = [...models];
  next.useModelParameters = true;
  next.selectedModel = primaryModel;
  next.recentModels = mergeUniqueStrings([primaryModel], next.recentModels, models);
  next.lastSelectedModel = primaryModel;
  next.currentModelId = primaryModel;

  const prevFeatureConfigs = next.featureModelConfigs && typeof next.featureModelConfigs === 'object'
    ? next.featureModelConfigs
    : {};
  next.featureModelConfigs = {
    ...prevFeatureConfigs,
    composer: buildFeatureModelConfig(primaryModel, models, prevFeatureConfigs.composer),
    cmdK: buildFeatureModelConfig(primaryModel, models, prevFeatureConfigs.cmdK),
    backgroundComposer: buildFeatureModelConfig(primaryModel, models, prevFeatureConfigs.backgroundComposer),
    planExecution: buildFeatureModelConfig(primaryModel, models, prevFeatureConfigs.planExecution),
    spec: buildFeatureModelConfig(primaryModel, models, prevFeatureConfigs.spec),
    deepSearch: buildFeatureModelConfig(primaryModel, models, prevFeatureConfigs.deepSearch),
    quickAgent: buildFeatureModelConfig(primaryModel, models, prevFeatureConfigs.quickAgent),
    subagentModels: prevFeatureConfigs.subagentModels && typeof prevFeatureConfigs.subagentModels === 'object'
      ? prevFeatureConfigs.subagentModels
      : { explore: { defaultModel: 'default', fallbackModels: [], bestOfNDefaultModels: [] } },
  };

  const prevAiSettings = next.aiSettings && typeof next.aiSettings === 'object' ? next.aiSettings : {};
  const prevModelConfig = prevAiSettings.modelConfig && typeof prevAiSettings.modelConfig === 'object'
    ? prevAiSettings.modelConfig
    : {};
  const modelOverrideEnabled = mergeUniqueStrings(prevAiSettings.modelOverrideEnabled);
  const modelOverrideDisabled = mergeUniqueStrings(prevAiSettings.modelOverrideDisabled)
    .filter((name) => !localModelSet.has(name));
  next.aiSettings = {
    ...prevAiSettings,
    modelsWithNoDefaultSwitch: mergeUniqueStrings(models, prevAiSettings.modelsWithNoDefaultSwitch),
    modelOverrideEnabled,
    modelOverrideDisabled,
    selectedModel: primaryModel,
    recentModels: mergeUniqueStrings([primaryModel], prevAiSettings.recentModels, models),
    maxTokens: maxContextTokens,
    contextTokenLimit: maxContextTokens,
    modelConfig: {
      ...prevModelConfig,
      composer: updateModelConfigEntry(prevModelConfig.composer, primaryModel, normalizedEffort),
      'cmd-k': updateModelConfigEntry(prevModelConfig['cmd-k'], primaryModel, normalizedEffort),
      'background-composer': updateModelConfigEntry(prevModelConfig['background-composer'], primaryModel, normalizedEffort),
      'composer-ensemble': updateModelConfigEntry(prevModelConfig['composer-ensemble'], primaryModel, normalizedEffort),
      'plan-execution': updateModelConfigEntry(prevModelConfig['plan-execution'], primaryModel, normalizedEffort),
      spec: updateModelConfigEntry(prevModelConfig.spec, primaryModel, normalizedEffort),
      'deep-search': updateModelConfigEntry(prevModelConfig['deep-search'], primaryModel, normalizedEffort),
      'quick-agent': updateModelConfigEntry(prevModelConfig['quick-agent'], primaryModel, normalizedEffort),
    },
  };

  next.aiSettings.selectedModels = [buildRelayModelSelectionState(primaryModel, normalizedEffort)];

  return next;
}

async function syncCursorRelayModelCatalog(payload = {}) {
  const primaryModel = String(payload.modelName || '').trim();
  const availableModels = uniqueModelNames(payload.availableModels, primaryModel);
  const contextWindow = Math.max(1, Math.min(200000, Number(payload.contextWindow) || 200000));
  const reasoningEffort = normalizeRelayReasoningEffort(payload.reasoningEffort || 'medium');
  if (!primaryModel || !availableModels.length) {
    return { ok: false, skipped: true, reason: 'missing_models' };
  }

  const dbPath = getStateVscdbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, skipped: true, reason: 'state_vscdb_missing' };
  }

  const db = await openDbWithRetry(dbPath, 6, 250);
  try {
    const tableName = detectItemTableName(db);
    const reactiveRaw = readItem(db, tableName, REACTIVE_APP_USER_KEY);
    if (!reactiveRaw) {
      return { ok: false, skipped: true, reason: 'application_user_missing' };
    }

    const reactive = parseApplicationUser(reactiveRaw);
    const nextReactive = applyRelayModelCatalog(reactive, {
      primaryModel,
      availableModels,
      contextWindow,
      reasoningEffort,
    });

    const tx = db.transaction(() => {
      upsertItem(db, tableName, REACTIVE_APP_USER_KEY, JSON.stringify(nextReactive));
      upsertItem(db, tableName, 'cursorai/selectedModel', primaryModel);
      upsertItem(db, tableName, 'cursorai/recentModels', JSON.stringify(mergeUniqueStrings([primaryModel], availableModels)));
      deleteItem(db, tableName, 'cursorai/serverConfig');
      deleteItem(db, tableName, 'cursorai/featureConfigCache');

      const legacyRaw = readItem(db, tableName, LEGACY_APP_USER_KEY);
      if (legacyRaw) {
        const legacy = parseApplicationUser(legacyRaw);
        const nextLegacy = applyRelayModelCatalog(legacy, {
          primaryModel,
          availableModels,
          contextWindow,
          reasoningEffort,
        });
        upsertItem(db, tableName, LEGACY_APP_USER_KEY, JSON.stringify(nextLegacy));
      }
    });
    tx();

    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }

    return {
      ok: true,
      dbPath,
      primaryModel,
      availableModels,
      contextWindow,
      reasoningEffort,
      reloaded: isCursorRunningHeuristic() ? reloadRunningCursorWindow() : false,
    };
  } finally {
    db.close();
  }
}

async function syncCursorRelayProviderConfig(payload = {}) {
  const rawBaseUrl = String(payload.baseUrl || '').trim();
  const baseUrl = resolveBaseUrl(rawBaseUrl);
  const apiKey = String(payload.apiKey || '').trim();
  const enabled = payload.enabled !== false;
  if (!enabled || !baseUrl || !apiKey) {
    return { ok: false, skipped: true, reason: 'missing_provider_config' };
  }

  const dbPath = getStateVscdbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, skipped: true, reason: 'state_vscdb_missing' };
  }

  const db = await openDbWithRetry(dbPath, 6, 250);
  try {
    const tableName = detectItemTableName(db);
    const tx = db.transaction(() => {
      writeApplicationUserBoth(db, tableName, { enabled: true, baseUrl });
      upsertItem(db, tableName, 'cursorAuth/openAIKey', apiKey);
    });
    tx();
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      dbPath,
      baseUrl,
      providerId: guessProviderId(baseUrl),
    };
  } finally {
    db.close();
  }
}

function readConfigFromDb(db, tableName) {
  const appUser = readApplicationUserFromDb(db, tableName);
  const apiKey = readItem(db, tableName, 'cursorAuth/openAIKey');
  const baseUrl = appUser.baseUrl;
  const enabled = Boolean(appUser.useOpenAIKey) && Boolean(baseUrl) && Boolean(apiKey);
  return {
    enabled,
    useOpenAIKey: Boolean(appUser.useOpenAIKey),
    baseUrl,
    apiKey: apiKey != null ? String(apiKey) : '',
    apiKeyMasked: maskApiKey(apiKey != null ? String(apiKey) : ''),
    providerId: guessProviderId(baseUrl),
    hasApplicationUser: Boolean(appUser.reactiveRaw || appUser.legacyRaw),
    configSynced: appUser.synced,
    reactiveEnabled: Boolean(appUser.reactive.useOpenAIKey),
  };
}

async function readModelProxyConfig(options = {}) {
  const quick = Boolean(options.quick);
  const dbPath = getStateVscdbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      dbExists: false,
      dbPath,
      config: {
        enabled: false,
        useOpenAIKey: false,
        baseUrl: '',
        apiKey: '',
        apiKeyMasked: '',
        providerId: 'openai',
        hasApplicationUser: false,
      },
      cursorRunning: isCursorRunningHeuristic(),
    };
  }

  const db = await openDbWithRetry(dbPath, quick ? 3 : 25, quick ? 200 : 400);
  try {
    const tableName = detectItemTableName(db);
    const config = readConfigFromDb(db, tableName);
    return {
      ok: true,
      dbExists: true,
      dbPath,
      config,
      cursorRunning: isCursorRunningHeuristic(),
    };
  } finally {
    db.close();
  }
}

async function writeModelProxyConfig(payload = {}) {
  const enabled = payload.enabled !== false;
  const baseUrl = normalizeBaseUrl(payload.baseUrl);
  const restartCursor = payload.restartCursor !== false;

  const dbPath = getStateVscdbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('state.vscdb 不存在，请先启动一次 Cursor');
  }

  if (restartCursor && isCursorRunningHeuristic()) {
    await quitCursorAndWait({ throwOnTimeout: false });
    await sleep(800);
  }

  const db = await openDbWithRetry(dbPath);
  let apiKey = String(payload.apiKey || '').trim();
  try {
    const tableName = detectItemTableName(db);
    if (enabled && !apiKey) {
      const existing = readItem(db, tableName, 'cursorAuth/openAIKey');
      apiKey = existing != null ? String(existing).trim() : '';
    }
    if (enabled && !apiKey) {
      throw new Error('启用代理时需填写 API Key');
    }

    const tx = db.transaction(() => {
      writeApplicationUserBoth(db, tableName, { enabled, baseUrl });
      if (enabled && apiKey) {
        upsertItem(db, tableName, 'cursorAuth/openAIKey', apiKey);
      }
    });
    tx();

    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
  } finally {
    db.close();
  }

  const verify = await readModelProxyConfig();
  if (enabled && !verify?.config?.reactiveEnabled) {
    throw new Error('写入后 Cursor 主配置未生效，请完全退出 Cursor 后重试');
  }

  let restarted = false;
  let reloaded = false;
  if (restartCursor) {
    const launch = launchCursorApp();
    restarted = Boolean(launch?.ok);
  } else if (isCursorRunningHeuristic()) {
    reloaded = reloadRunningCursorWindow();
  }

  return {
    ok: true,
    dbPath,
    enabled,
    baseUrl,
    restarted,
    reloaded,
    cursorRunning: isCursorRunningHeuristic(),
    configSynced: verify?.config?.configSynced,
  };
}

async function clearModelProxyConfigOnly() {
  const dbPath = getStateVscdbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, skipped: true, reason: 'state.vscdb 不存在' };
  }

  const db = await openDbWithRetry(dbPath);
  try {
    const tableName = detectItemTableName(db);
    const tx = db.transaction(() => {
      writeApplicationUserBoth(db, tableName, { enabled: false, baseUrl: null });
      try {
        db.prepare(`DELETE FROM "${tableName}" WHERE key = ?`).run('cursorAuth/openAIKey');
      } catch {
        /* ignore */
      }
    });
    tx();
    return { ok: true, cleared: true };
  } finally {
    db.close();
  }
}

async function disableModelProxy(payload = {}) {
  const restartCursor = payload.restartCursor !== false;
  const dbPath = getStateVscdbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('state.vscdb 不存在');
  }

  if (restartCursor && isCursorRunningHeuristic()) {
    await quitCursorAndWait({ throwOnTimeout: false });
    await sleep(800);
  }

  await clearModelProxyConfigOnly();

  let restarted = false;
  if (restartCursor) {
    const launch = launchCursorApp();
    restarted = Boolean(launch?.ok);
  }
  return { ok: true, reloaded: false, restarted };
}

async function testModelProxyConnection(payload = {}) {
  const rawBaseUrl = String(payload.baseUrl || '').trim();
  const baseUrl = resolveBaseUrl(rawBaseUrl);
  const normalizedFrom = rawBaseUrl !== baseUrl ? baseUrl : null;
  const providerId = String(payload.providerId || guessProviderId(baseUrl) || 'custom').trim();
  const probeFetch = createProxyAwareFetch(payload.outboundProxy || null);

  let apiKey = String(payload.apiKey || '').trim();
  if (!apiKey) {
    const snap = await readModelProxyConfig();
    apiKey = String(snap?.config?.apiKey || '').trim();
  }
  if (!apiKey) throw new Error('请先填写 API Key，或先应用并保存 Key');

  const modelName = String(payload.modelName || payload.model || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const endpointMode = String(payload.endpointMode || '').trim().toLowerCase();
  const reasoningEffort = String(payload.reasoningEffort || '').trim().toLowerCase();
  const thinkingMode = String(payload.thinkingMode || '').trim().toLowerCase();
  const timeoutMs = Math.min(30000, Math.max(3000, Number(payload.timeoutMs) || 15000));

  if (looksLikeAnthropicNative(providerId, baseUrl)) {
    return {
      ok: false,
      success: false,
      compatible: false,
      status: 0,
      latencyMs: 0,
      url: baseUrl,
      probe: 'unsupported',
      normalizedBaseUrl: normalizedFrom,
      message: '当前 Relay 只支持 OpenAI 兼容或 Responses 风格上游，不能直接填写 Anthropic 官方 API。请改用兼容网关地址，或切到“自定义”后填写兼容端点。',
    };
  }

  async function attempt(url, options) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const metricMode = String(options?.metricMode || '').trim();
      const compatMode = String(options?.compatMode || '').trim();
      const fetchOptions = { ...options };
      delete fetchOptions.metricMode;
      delete fetchOptions.compatMode;
      const resp = await probeFetch(url, { ...fetchOptions, signal: controller.signal });
      const latencyMs = Date.now() - start;
      let bodySnippet = '';
      let metrics = null;
      if (metricMode === 'sync' && resp.ok) {
        try {
          metrics = await readSyncMetrics(resp, start);
          bodySnippet = metrics.bodySnippet || '';
        } catch (error) {
          metrics = {
            syncError: error?.message || String(error),
            ttftMs: 0,
            tokensPerSecond: 0,
            outputTokens: 0,
            durationMs: Date.now() - start,
          };
        }
      } else if (metricMode === 'stream' && resp.ok) {
        try {
          metrics = await readStreamingMetrics(resp, start, compatMode);
          bodySnippet = metrics.bodySnippet || '';
        } catch (error) {
          metrics = {
            streamError: error?.message || String(error),
            ttftMs: 0,
            tokensPerSecond: 0,
            outputTokens: 0,
            durationMs: Date.now() - start,
          };
        }
      } else {
        try {
          bodySnippet = (await resp.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
      }
      const looksHtml = /^\s*<!doctype html|^\s*<html/i.test(bodySnippet);
      return { resp, latencyMs, bodySnippet, url, looksHtml, metrics };
    } catch (e) {
      return {
        error: e,
        latencyMs: Date.now() - start,
        url,
        bodySnippet: '',
        looksHtml: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const attempts = buildProbeAttempts({
    baseUrl,
    apiKey,
    modelName,
    providerId,
    endpointMode,
    reasoningEffort,
    thinkingMode,
    attempt,
  });

  function buildProbeSuccessResult(r, item) {
    const status = r.resp.status;
    const authReachable = status === 401 || status === 403;
    const ok = r.resp.ok && !r.looksHtml;
    const hint = normalizedFrom ? `（已自动修正 API 地址为 ${baseUrl}）` : '';
    const perf = formatPerformanceSummary(r.metrics, r.latencyMs);
    const message = ok
      ? `连接成功 · ${perf || `${r.latencyMs} ms`} · ${item.method}${hint}`
      : authReachable
        ? `端点可达 · ${item.method}，但 Key 无效或无权（HTTP ${status}，${r.latencyMs} ms）${hint}`
        : `请求失败（HTTP ${status}，${r.latencyMs} ms）`;
    return {
      ok: ok || authReachable,
      success: ok,
      compatible: true,
      status,
      latencyMs: r.latencyMs,
      durationMs: Number(r.metrics?.durationMs) || r.latencyMs,
      ttftMs: Number(r.metrics?.ttftMs) || 0,
      generationMs: Number(r.metrics?.generationMs) || 0,
      tokensPerSecond: Number(r.metrics?.tokensPerSecond) || 0,
      outputTokens: Number(r.metrics?.outputTokens) || 0,
      outputTokensEstimated: Boolean(r.metrics?.outputTokensEstimated),
      url: r.url,
      probe: item.method,
      compatMode: item.compatMode,
      normalizedBaseUrl: normalizedFrom,
      message,
      bodySnippet: r.bodySnippet,
    };
  }

  let lastResult = null;
  let modelsFallback = null;
  for (const item of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const r = await item.run();
    lastResult = { ...r, probe: item.method, compatMode: item.compatMode };
    if (r.error) continue;

    const status = r.resp.status;
    const authReachable = status === 401 || status === 403;
    const ok = r.resp.ok && !r.looksHtml;
    const reachable = ok || authReachable;

    if (reachable && !r.looksHtml) {
      const result = buildProbeSuccessResult(r, item);
      if (item.compatMode === 'models') {
        if (!modelsFallback) modelsFallback = result;
        continue;
      }
      return result;
    }
  }

  if (modelsFallback) return modelsFallback;

  const r = lastResult;
  if (!r) {
    return {
      ok: false,
      success: false,
      status: 0,
      latencyMs: 0,
      url: `${baseUrl}/models`,
      message: '连接测试失败',
    };
  }

  if (r.error) {
    const root = r.error?.cause || r.error;
    const code = String(root?.code || r.error?.code || '').trim().toUpperCase();
    const msg = r.error?.name === 'AbortError'
      ? '连接超时'
      : code === 'ECONNRESET'
        ? '连接被对端或中间代理重置'
        : code === 'ECONNREFUSED'
          ? '连接被拒绝'
          : code === 'ENOTFOUND'
            ? '域名解析失败'
            : code === 'ETIMEDOUT'
              ? '网络连接超时'
              : code === 'EAI_AGAIN'
                ? 'DNS 临时解析失败'
                : (code ? `${code}: ${root?.message || ''}`.trim() : (r.error?.message || String(r.error)));
    return {
      ok: false,
      success: false,
      compatible: true,
      status: 0,
      latencyMs: r.latencyMs,
      url: r.url,
      probe: r.probe,
      compatMode: r.compatMode,
      normalizedBaseUrl: normalizedFrom,
      message: `${msg}（${r.latencyMs} ms）`,
      error: msg,
    };
  }

  const status = r.resp.status;
  const extraHint = hintForHttpStatus(status, rawBaseUrl || baseUrl, r.bodySnippet);
  const normHint = normalizedFrom ? `建议 API 地址：${baseUrl}。` : '';
  return {
    ok: false,
    success: false,
    compatible: true,
    status,
    latencyMs: r.latencyMs,
    url: r.url,
    probe: r.probe,
    compatMode: r.compatMode,
    normalizedBaseUrl: normalizedFrom,
    message: [
      `请求失败（HTTP ${status}，${r.latencyMs} ms）`,
      normHint,
      extraHint,
    ].filter(Boolean).join('\n'),
    bodySnippet: r.bodySnippet,
  };
}

module.exports = {
  PROVIDER_PRESETS,
  REACTIVE_APP_USER_KEY,
  LEGACY_APP_USER_KEY,
  readModelProxyConfig,
  writeModelProxyConfig,
  clearModelProxyConfigOnly,
  disableModelProxy,
  testModelProxyConnection,
  syncCursorRelayModelCatalog,
  syncCursorRelayProviderConfig,
  normalizeBaseUrl,
  resolveBaseUrl,
  maskApiKey,
  guessProviderId,
};

'use strict';

// Relay 响应缓存模块（三层混合 + 上下文感知）
//
//   1) exact  —— hash(model + toolKey + phase + reasoning params + 完整 messages)
//      命中重试/重连的完全相同请求
//   2) fuzzy  —— hash(model + 上下文指纹)，同模型命中
//      - 单轮：指纹 = "U:最后用户消息"
//      - 多轮(仅含幂等工具)：指纹 = 完整对话流(用户+工具调用+工具结果)
//      - 多轮(含副作用工具)：禁用
//   3) ultra  —— hash(上下文指纹)，跨模型兜底（默认关闭，需显式开启）
//
// 查询顺序：exact → fuzzy → ultra(可选)
// 安全约束：
//   - 只缓存成功、有文本、无错误的响应
//   - 含副作用工具(Shell/Write/Delete/StrReplace/Task)的对话不缓存
//   - 工具调用结果作为响应一部分的(toolCalls 数组非空)不缓存
//   - LRU + 频次保护（hits ≥ 3 的热点豁免，最多保护 500 条）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_HISTORY_ROOT = path.join(
  process.env.USERPROFILE || process.cwd(),
  '.cursorpool', 'relay', 'history',
);
const DEFAULT_DATA_ROOT = path.join(
  process.env.USERPROFILE || process.cwd(),
  '.cursorpool', 'relay',
);

const MAX_MEMORY_ENTRIES = 3000;
const PROTECTED_HOT_ENTRIES = 500;
const HOT_HIT_THRESHOLD = 3;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_TEXT_LEN = 1;
const MAX_TEXT_LEN = 64 * 1024;
const MAX_TOOL_RESULT_LEN = 8192; // 工具结果参与指纹时的截断长度
const MAX_USER_MSG_LEN = 2048;
const ENABLE_ULTRA_CACHE = String(process.env.CURSOR_RELAY_ENABLE_ULTRA_CACHE || '').trim() === '1';

// 不参与响应缓存的上游阶段（其余 Agent 阶段均允许 fuzzy/ultra）
const PHASE_CACHE_BLOCKED = new Set(['history', 'billing', 'test']);

function normalizePhaseForCacheKey(phase) {
  const value = String(phase || 'upstream');
  if (/^post_tool_/.test(value)) return 'post_tool';
  if (/^completion_verify_/.test(value)) return 'completion_verify';
  if (/^incomplete_continuation_/.test(value)) return 'incomplete_continuation';
  return value;
}

function isPhaseCacheAllowed(phase) {
  return !PHASE_CACHE_BLOCKED.has(String(phase || 'upstream'));
}

// 幂等工具（GET 类）：可缓存其结果
const IDEMPOTENT_TOOLS = new Set([
  'read', 'ls', 'grep', 'glob', 'diagnostics', 'readlints',
  'semanticsearch', 'semsearch', 'semantic_search',
  'webfetch', 'web_fetch', 'fetch',
  'websearch', 'web_search',
  'list_mcp_resources', 'listmcpresources',
  'read_mcp_resource', 'readmcpresource',
]);

// 文件编辑类副作用工具：修改文件但结果确定。
// 不阻断 fuzzy/ultra 缓存，但指纹只取最后一个编辑工具之后的片段。
// 这样 "PatchEdit → Read 同一文件" 的后续请求能命中缓存。
const FILE_EDIT_TOOLS = new Set([
  'write', 'edit', 'patchedit', 'strreplace', 'str_replace',
  'todowrite', 'todo_write', 'updatetodo', 'updatetodos',
  'createplan', 'create_plan',
]);

// 高风险副作用工具：行为不可预测或影响外部状态，绝不缓存。
const HIGH_RISK_SIDE_EFFECT_TOOLS = new Set([
  'shell', 'shell_stream', 'shellstream',
  'delete',
  'task',
  'computer_use', 'computeruse',
  'record_screen', 'recordscreen',
  'write_shell_stdin', 'writeshellstdin',
  'execute_hook', 'executehook',
  'mcp', // MCP 工具行为不可预测，默认按副作用处理
]);

// 兼容：全部副作用工具（exact 层仍按此判断）
const SIDE_EFFECT_TOOLS = new Set([
  ...FILE_EDIT_TOOLS,
  ...HIGH_RISK_SIDE_EFFECT_TOOLS,
]);

const memoryCache = new Map();
let warmedUp = false;
let warmupPromise = null;

function getHistoryRoot() {
  return String(process.env.CURSOR_RELAY_HISTORY_ROOT || DEFAULT_HISTORY_ROOT);
}

function getDataRoot() {
  return String(process.env.CURSOR_RELAY_DATA_ROOT || DEFAULT_DATA_ROOT);
}

function normalizeMessageContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return String(part || '');
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    }).join('');
  }
  if (typeof content === 'object') return String(content.text || content.content || '');
  return String(content || '');
}

function normalizeToolName(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[-_\s]+/g, '_');
}

function isIdempotentTool(name) {
  return IDEMPOTENT_TOOLS.has(normalizeToolName(name));
}

function isSideEffectTool(name) {
  return SIDE_EFFECT_TOOLS.has(normalizeToolName(name));
}

function isHighRiskSideEffectTool(name) {
  return HIGH_RISK_SIDE_EFFECT_TOOLS.has(normalizeToolName(name));
}

function isFileEditTool(name) {
  return FILE_EDIT_TOOLS.has(normalizeToolName(name));
}

// 检查 messages 是否包含高风险副作用工具调用（阻断所有缓存）
function hasHighRiskSideEffectTools(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      for (const call of msg.tool_calls) {
        const name = normalizeToolName(call?.function?.name || call?.name || '');
        if (!name) continue;
        if (isHighRiskSideEffectTool(name)) return true;
        // 未知工具保守按高风险处理
        if (!isIdempotentTool(name) && !isFileEditTool(name)) return true;
      }
    }
  }
  return false;
}

// 检查 messages 是否包含副作用工具调用（兼容旧调用，含文件编辑类）
// 检查 messages 是否包含副作用工具调用
// 注意：文件编辑类不再阻断 fuzzy/ultra，但 exact 层仍按此判断
function hasSideEffectTools(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      for (const call of msg.tool_calls) {
        const name = normalizeToolName(call?.function?.name || call?.name || '');
        if (!name) continue;
        if (isSideEffectTool(name)) return true;
        // 未知工具保守按副作用处理
        if (!isIdempotentTool(name)) return true;
      }
    }
  }
  return false;
}

// 找到最后一个"文件编辑工具结果"在 messages 中的索引。
// 用于分段指纹：只取最后一个编辑工具之后的对话片段。
// 返回 -1 表示没有文件编辑工具。
function findLastFileEditToolResultIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  // 先收集所有文件编辑工具的 call_id
  const fileEditCallIds = new Set();
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const name = normalizeToolName(call?.function?.name || call?.name || '');
        if (isFileEditTool(name) && call?.id) {
          fileEditCallIds.add(String(call.id));
        }
      }
    }
  }
  if (!fileEditCallIds.size) return -1;
  // 找到最后一个 tool 消息，其 tool_call_id 属于文件编辑工具
  let lastIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    if (String(msg.role || '') === 'tool') {
      const callId = String(msg.tool_call_id || '');
      if (callId && fileEditCallIds.has(callId)) {
        lastIndex = i;
      }
    }
  }
  return lastIndex;
}

// 判断对话是否可缓存（fuzzy/ultra 层）
// 规则：最后一条必须是 user，且不含高风险副作用工具调用
// 文件编辑类工具不阻断，但指纹会分段处理
function isCacheableConversation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (!last || String(last.role || '') !== 'user') return false;
  if (hasHighRiskSideEffectTools(messages)) return false;
  return true;
}

function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && String(msg.role || '') === 'user') {
      return normalizeMessageContent(msg.content);
    }
  }
  return '';
}

// messages 规范化用于 exact key；含副作用工具则返回 null
function normalizeMessagesForKey(messages) {
  if (!Array.isArray(messages)) return null;
  if (hasSideEffectTools(messages)) return null;
  const parts = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || '');
    if (role === 'tool') {
      const content = String(msg.content || '').slice(0, MAX_TOOL_RESULT_LEN);
      parts.push(`tool:${content}`);
      continue;
    }
    const content = normalizeMessageContent(msg.content);
    let entry = `${role}:${content}`;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const calls = msg.tool_calls.map((call) => {
        const name = normalizeToolName(call?.function?.name || call?.name || '');
        const args = String(call?.function?.arguments || call?.arguments || '');
        return `${name}:${args}`;
      }).join('|');
      entry += `{calls:${calls}}`;
    }
    parts.push(entry);
  }
  return parts.join('\x00');
}

// 构建上下文指纹（用于 fuzzy/ultra）
// 单轮：U:最后用户消息
// 多轮(仅幂等工具)：U:user1 | T:tool_call | R:tool_result | U:user2 ...
// 跳过 assistant 文本（那是要被缓存的内容）
// 分段优化：如果对话含文件编辑工具，只取最后一个编辑工具结果之后的片段，
// 这样 "PatchEdit → Read" 的后续请求能命中 "Read → 分析" 的缓存。
function buildContextFingerprint(messages) {
  if (!Array.isArray(messages)) return '';
  // 分段：找到最后一个文件编辑工具结果的索引，从其后开始取指纹
  const cutIndex = findLastFileEditToolResultIndex(messages);
  const start = cutIndex >= 0 ? cutIndex + 1 : 0;
  const parts = [];
  for (let i = start; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || '');
    if (role === 'system') continue; // 系统消息通常是 env 信息，跨会话不稳定
    if (role === 'user') {
      const text = normalizeMessageContent(msg.content);
      parts.push(`U:${text.slice(0, MAX_USER_MSG_LEN)}`);
    } else if (role === 'assistant') {
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          const name = normalizeToolName(call?.function?.name || call?.name || '');
          // 文件编辑工具的调用不出现在分段后的指纹里（已被截断）
          // 高风险工具已被 isCacheableConversation 拦截
          if (!isIdempotentTool(name)) continue;
          const args = String(call?.function?.arguments || call?.arguments || '');
          parts.push(`T:${name}:${args.slice(0, 1024)}`);
        }
      }
      // 跳过 assistant 文本内容
    } else if (role === 'tool') {
      const content = String(msg.content || '').slice(0, MAX_TOOL_RESULT_LEN);
      parts.push(`R:${content}`);
    }
  }
  return parts.join('\x00');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

// 返回 { exact, fuzzy, ultra }，任一为 null 表示该层不缓存
function buildCacheKeys(model, messages, options = {}) {
  const enableTools = options.enableTools !== false;
  const toolKey = enableTools ? String(options.toolChoice || 'auto') : 'notools';
  const phase = String(options.phase || 'upstream');
  const phaseAllowed = isPhaseCacheAllowed(phase);
  const phaseKey = normalizePhaseForCacheKey(phase);

  // exact 层：完整 messages + 推理参数
  const norm = normalizeMessagesForKey(messages);
  let exact = null;
  if (norm && phaseAllowed) {
    // 修复 deepseek 缺陷 3：补全影响输出的生成参数
    const reasoningKey = options.disableReasoning === true
      ? 'no_reasoning'
      : String(options.reasoningEffort || config_upstream_reasoning(options) || 'default');
    exact = sha256(`exact|${model}|${toolKey}|${phaseKey}|${reasoningKey}|${norm}`);
  }

  // fuzzy/ultra 层：上下文指纹
  let fuzzy = null;
  let ultra = null;
  if (phaseAllowed && isCacheableConversation(messages)) {
    const fingerprint = buildContextFingerprint(messages);
    if (fingerprint && fingerprint.length >= MIN_TEXT_LEN && fingerprint.length <= 32768) {
      fuzzy = sha256(`fuzzy|${model || ''}|${fingerprint}`);
      if (ENABLE_ULTRA_CACHE) ultra = sha256(`ultra|${fingerprint}`);
    }
  }
  return { exact, fuzzy, ultra };
}

// 兼容旧调用：从 options 中取 reasoningEffort
function config_upstream_reasoning(options) {
  return options && typeof options === 'object' ? options.reasoningEffort : '';
}

// 查询顺序：exact → fuzzy → ultra
function get(keys) {
  if (!keys) return null;
  const { exact, fuzzy, ultra } = keys;
  if (exact) {
    const entry = _get(exact);
    if (entry) return { entry, key: exact, layer: 'exact' };
  }
  if (fuzzy) {
    const entry = _get(fuzzy);
    if (entry) return { entry, key: fuzzy, layer: 'fuzzy' };
  }
  if (ultra) {
    const entry = _get(ultra);
    if (entry) return { entry, key: ultra, layer: 'ultra' };
  }
  return null;
}

function _get(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    memoryCache.delete(key);
    return null;
  }
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  entry.hits = (entry.hits || 0) + 1;
  return entry;
}

// 写入：三层都写
function set(keys, value) {
  if (!keys || !value) return;
  const text = String(value.text || '');
  if (!text || text.length < MIN_TEXT_LEN || text.length > MAX_TEXT_LEN) return;
  if (value.upstreamError) return;
  if (Array.isArray(value.toolCalls) && value.toolCalls.length) return;
  const reasoning = String(value.reasoning || '');
  const ts = Date.now();
  const model = String(value.model || '');
  const { exact, fuzzy, ultra } = keys;
  if (exact) _set(exact, { text, reasoning, ts, hits: 0, layer: 'exact', model });
  if (fuzzy) _set(fuzzy, { text, reasoning, ts, hits: 0, layer: 'fuzzy', model });
  if (ultra) _set(ultra, { text, reasoning, ts, hits: 0, layer: 'ultra', model });
}

// 修复 deepseek 缺陷 2：_set merge 已有 hits
function _set(key, entry) {
  const existing = memoryCache.get(key);
  if (existing) {
    // 保留旧 hits（热点保护），更新 text/reasoning/ts
    entry.hits = Math.max(entry.hits || 0, existing.hits || 0);
    entry.ts = Date.now(); // 刷新 TTL
  }
  memoryCache.set(key, entry);
  if (memoryCache.size <= MAX_MEMORY_ENTRIES) return;
  // LRU + 频次保护
  let protectedCount = 0;
  const victims = [];
  for (const [k, v] of memoryCache) {
    if ((v.hits || 0) >= HOT_HIT_THRESHOLD && protectedCount < PROTECTED_HOT_ENTRIES) {
      protectedCount += 1;
      continue;
    }
    victims.push(k);
    if (victims.length >= Math.ceil(MAX_MEMORY_ENTRIES * 0.1)) break;
  }
  for (const k of victims) memoryCache.delete(k);
}

function buildCachedResponse(entry) {
  const text = String(entry.text || '');
  const reasoning = String(entry.reasoning || '');
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => (String(name || '').toLowerCase() === 'content-type'
        ? 'text/event-stream' : null),
    },
    body: createReplayStream(text, reasoning),
    text: async () => text,
    _fromCache: true,
    _cachedAt: entry.ts,
    _cacheLayer: entry.layer,
  };
}

function createReplayStream(text, reasoning = '') {
  if (typeof ReadableStream !== 'function') {
    return null;
  }
  const frames = [];
  for (const chunk of splitReplayText(reasoning)) {
    frames.push({ type: 'response.reasoning_summary_text.delta', delta: chunk });
  }
  for (const chunk of splitReplayText(text)) {
    frames.push({ type: 'response.output_text.delta', delta: chunk });
  }
  frames.push({ type: 'response.output_text.done' });
  frames.push({ type: 'response.completed', response: { output: [] } });

  return new ReadableStream({
    start(controller) {
      let closed = false;
      const burstSize = 8;
      let index = 0;
      const pump = () => {
        if (closed) return;
        if (index >= frames.length) {
          closed = true;
          controller.close();
          return;
        }
        const end = Math.min(index + burstSize, frames.length);
        for (; index < end; index += 1) {
          if (closed) return;
          controller.enqueue(Buffer.from(`data: ${JSON.stringify(frames[index])}\n\n`, 'utf8'));
        }
        if (!closed) setTimeout(pump, 0);
      };
      pump();
    },
    cancel() {
      // no-op
    },
  });
}

function splitReplayText(text) {
  const value = String(text || '');
  if (!value) return [];
  const chunks = [];
  const chunkSize = value.length > 1200 ? 512 : 256;
  for (let i = 0; i < value.length; i += chunkSize) {
    chunks.push(value.slice(i, i + chunkSize));
  }
  return chunks;
}

function warmupFromHistory(historyRoot) {
  if (warmedUp) return Promise.resolve();
  if (warmupPromise) return warmupPromise;
  warmupPromise = new Promise((resolve) => {
    setImmediate(() => {
      try {
        _doWarmup(historyRoot);
      } catch {
        /* ignore */
      }
      warmedUp = true;
      resolve();
    });
  });
  return warmupPromise;
}

function _loadModelMapFromUsageDb() {
  const map = new Map();
  try {
    const usageDbPath = path.join(getDataRoot(), 'usage.db');
    if (!fs.existsSync(usageDbPath)) return map;
    const Database = require('better-sqlite3');
    const db = new Database(usageDbPath, { readonly: true, fileMustExist: false });
    const rows = db.prepare('SELECT request_id, model FROM relay_usage WHERE request_id IS NOT NULL AND model IS NOT NULL AND model != ?').all('');
    for (const row of rows) {
      if (row.request_id && row.model) map.set(String(row.request_id), String(row.model));
    }
    db.close();
  } catch (err) {
    // usage.db 不存在或 better-sqlite3 不可用，降级到只写 ultra
    if (process.env.CURSOR_RELAY_CACHE_DEBUG === '1') {
      console.warn('[relay-cache] warmup model map failed:', err?.message || err);
    }
  }
  return map;
}

function _doWarmup(historyRoot) {
  const root = historyRoot || getHistoryRoot();
  if (!fs.existsSync(root)) return 0;
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, mtime: _safeMtime(path.join(root, d.name, 'context.json')) }))
      .sort((a, b) => b.mtime - a.mtime) // 按修改时间倒序，优先预热最近的
      .slice(0, 80)
      .map((d) => d.name);
  } catch {
    return 0;
  }

  const modelMap = _loadModelMapFromUsageDb();
  let loaded = 0;

  for (const dir of dirs) {
    try {
      const ctxPath = path.join(root, dir, 'context.json');
      const raw = fs.readFileSync(ctxPath, 'utf8');
      const ctx = JSON.parse(raw);
      const items = Array.isArray(ctx.items) ? ctx.items : [];

      // 按会话重建对话流，找出每个 user_message → assistant_text 的可缓存片段
      const turns = _extractCacheableTurns(items);
      const turnToRequestId = {};
      for (const item of items) {
        if (item.request_id) turnToRequestId[Number(item.turn_seq) || 0] = String(item.request_id);
      }

      for (const turn of turns) {
        const userText = turn.userText;
        const asstText = turn.assistantText;
        if (!userText || !asstText) continue;
        if (userText.length > MAX_USER_MSG_LEN || asstText.length > MAX_TEXT_LEN || asstText.length < MIN_TEXT_LEN) continue;
        // 历史预热只支持单轮（多轮需要 tool_calls 信息，context.json 里没有完整的 tool_calls.arguments）
        const fingerprint = `U:${userText}`;
        const ts = Date.now();
        const requestId = turnToRequestId[turn.turnSeq] || '';
        const model = modelMap.get(requestId) || '';

        const ultraKey = sha256(`ultra|${fingerprint}`);
        if (ENABLE_ULTRA_CACHE && !memoryCache.has(ultraKey)) {
          memoryCache.set(ultraKey, { text: asstText, reasoning: '', ts, hits: 0, layer: 'ultra', model });
          loaded += 1;
        }
        if (model) {
          const fuzzyKey = sha256(`fuzzy|${model}|${fingerprint}`);
          if (!memoryCache.has(fuzzyKey)) {
            memoryCache.set(fuzzyKey, { text: asstText, reasoning: '', ts, hits: 0, layer: 'fuzzy', model });
            loaded += 1;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  while (memoryCache.size > MAX_MEMORY_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    memoryCache.delete(oldest);
  }
  return loaded;
}

function _safeMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

// 从历史 items 提取可缓存的 user→assistant 对话对
function _extractCacheableTurns(items) {
  const result = [];
  const byTurn = {};
  for (const item of items) {
    const turn = Number(item.turn_seq) || 0;
    if (!byTurn[turn]) byTurn[turn] = { turnSeq: turn, userText: '', assistantText: '' };
    if (item.role === 'user' && item.kind === 'user_message') {
      byTurn[turn].userText = String(item.payload?.text || '');
    } else if (item.role === 'assistant' && item.kind === 'assistant_text' && !item.payload?.error) {
      // 多个 assistant_text 累加（流式分片）
      const text = String(item.payload?.text || '');
      byTurn[turn].assistantText = (byTurn[turn].assistantText || '') + text;
    }
  }
  for (const turn of Object.values(byTurn)) {
    if (turn.userText && turn.assistantText) result.push(turn);
  }
  return result;
}

function getStats() {
  let totalHits = 0;
  let exactCount = 0;
  let fuzzyCount = 0;
  let ultraCount = 0;
  let hotCount = 0;
  for (const entry of memoryCache.values()) {
    totalHits += (entry.hits || 0);
    if ((entry.hits || 0) >= HOT_HIT_THRESHOLD) hotCount += 1;
    if (entry.layer === 'exact') exactCount += 1;
    else if (entry.layer === 'fuzzy') fuzzyCount += 1;
    else ultraCount += 1;
  }
  return {
    entries: memoryCache.size,
    exactEntries: exactCount,
    fuzzyEntries: fuzzyCount,
    ultraEntries: ultraCount,
    hotEntries: hotCount,
    totalHits,
    warmedUp,
  };
}

function clear() {
  memoryCache.clear();
  warmedUp = false;
  warmupPromise = null;
}

// 测试辅助导出
module.exports = {
  buildCacheKeys,
  get,
  set,
  buildCachedResponse,
  createReplayStream,
  warmupFromHistory,
  getStats,
  clear,
  // 测试用导出
  _internal: {
    isCacheableConversation,
    hasSideEffectTools,
    hasHighRiskSideEffectTools,
    isIdempotentTool,
    isSideEffectTool,
    isHighRiskSideEffectTool,
    isFileEditTool,
    findLastFileEditToolResultIndex,
    buildContextFingerprint,
    normalizeToolName,
    IDEMPOTENT_TOOLS,
    SIDE_EFFECT_TOOLS,
    FILE_EDIT_TOOLS,
    HIGH_RISK_SIDE_EFFECT_TOOLS,
  },
};

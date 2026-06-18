const fs = require('fs');
const path = require('path');

const DEFAULT_HISTORY_ROOT = path.join(process.env.USERPROFILE || process.cwd(), '.cursorpool', 'relay', 'history');

function nowIso() {
  return new Date().toISOString();
}

function safeId(value, fallback = 'unknown') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || fallback;
}

function getHistoryRoot(config = {}) {
  return String(config.historyRoot || process.env.CURSOR_RELAY_HISTORY_ROOT || DEFAULT_HISTORY_ROOT);
}

function getConversationId(requestId, workspaceRoot = '') {
  const explicit = String(requestId || '').trim();
  if (explicit) return explicit;
  const workspace = String(workspaceRoot || '').trim();
  return workspace ? `workspace-${safeId(workspace)}` : 'unknown';
}

function getConversationDir(config = {}, conversationId = '') {
  return path.join(getHistoryRoot(config), safeId(conversationId));
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function loadConversation(config = {}, conversationId = '', options = {}) {
  const id = getConversationId(conversationId || options.requestId, options.workspaceRoot);
  const dir = getConversationDir(config, id);
  const contextPath = path.join(dir, 'context.json');
  const statePath = path.join(dir, 'state.json');
  const context = readJson(contextPath, {
    schema_version: 1,
    conversation_id: id,
    version: 0,
    updated_at: nowIso(),
    items: [],
  });
  const state = readJson(statePath, {
    schema_version: 1,
    conversation_id: id,
    root_conversation_id: id,
    parent_conversation_id: '',
    parent_tool_call_id: '',
    mode: 'agent',
    context_version: Number(context.version) || 0,
    current_loop_id: '',
    current_loop_status: 'idle',
    current_request_id: '',
    current_turn_seq: 0,
    token_details_used_tokens: 0,
    token_details_max_tokens: Number.MAX_SAFE_INTEGER,
    latest_request_prefix: null,
    last_provider_call: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    next_turn_seq: 1,
    next_entry_seq: Math.max(1, ...(Array.isArray(context.items) ? context.items.map((item) => Number(item.seq) || 0) : [0])) + 1,
  });
  return { id, dir, contextPath, statePath, context, state };
}

function saveConversation(conversation) {
  if (!conversation) return;
  const updatedAt = nowIso();
  conversation.context.updated_at = updatedAt;
  conversation.state.updated_at = updatedAt;
  conversation.state.context_version = Number(conversation.context.version) || 0;
  writeJson(conversation.contextPath, conversation.context);
  writeJson(conversation.statePath, conversation.state);
}

function beginTurn(config = {}, requestId = '', workspaceRoot = '', capture = null) {
  const stableConversationId = String(capture?.stableConversationId || capture?.conversationId || '').trim();
  const conversation = loadConversation(config, stableConversationId || requestId, { requestId, workspaceRoot });
  const turnSeq = Math.max(1, Number(conversation.state.next_turn_seq) || 1);
  conversation.state.current_loop_id = `${turnSeq}:${requestId || conversation.id}`;
  conversation.state.current_loop_status = 'running';
  conversation.state.current_request_id = requestId || conversation.id;
  conversation.state.current_turn_seq = turnSeq;
  conversation.state.next_turn_seq = turnSeq + 1;
  if (workspaceRoot) conversation.state.workspace_root = workspaceRoot;
  if (capture) conversation.state.last_capture = {
    captured_at: capture.capturedAt || nowIso(),
    raw_len: capture.rawLen || 0,
    workspace_root: workspaceRoot || capture.workspaceRoot || '',
    stable_conversation_id: stableConversationId,
  };
  saveConversation(conversation);
  return { conversation, turnSeq };
}

function appendHistoryItem(conversation, item = {}) {
  if (!conversation) return null;
  const seq = Math.max(1, Number(conversation.state.next_entry_seq) || 1);
  const entry = {
    seq,
    turn_seq: Number(item.turn_seq || conversation.state.current_turn_seq) || 1,
    request_id: String(item.request_id || conversation.state.current_request_id || ''),
    role: String(item.role || 'system'),
    kind: String(item.kind || 'metadata'),
    ...(item.tool_call_id ? { tool_call_id: String(item.tool_call_id) } : {}),
    payload: item.payload && typeof item.payload === 'object' ? item.payload : {},
    created_at: nowIso(),
  };
  conversation.context.items = Array.isArray(conversation.context.items) ? conversation.context.items : [];
  conversation.context.items.push(entry);
  conversation.context.version = seq;
  conversation.state.next_entry_seq = seq + 1;
  saveConversation(conversation);
  return entry;
}

function completeTurn(conversation, options = {}) {
  if (!conversation) return;
  conversation.state.current_loop_status = options.status || 'completed';
  conversation.state.last_provider_call = options.lastProviderCall || conversation.state.last_provider_call || null;
  appendHistoryItem(conversation, {
    role: 'system',
    kind: 'metadata',
    payload: {
      type: 'turn_completed',
      value: {
        request_id: conversation.state.current_request_id,
        status: conversation.state.current_loop_status,
        model_call_id: options.modelCallId || '',
      },
    },
  });
  saveConversation(conversation);
}

function updateUsage(config = {}, usage = {}) {
  const usagePath = path.join(getHistoryRoot(config), 'usage.json');
  const current = readJson(usagePath, {
    schema_version: 1,
    updated_at: nowIso(),
    requests: 0,
    tool_calls: 0,
    turns_completed: 0,
  });
  current.updated_at = nowIso();
  current.requests += Number(usage.requests) || 0;
  current.tool_calls += Number(usage.tool_calls) || 0;
  current.turns_completed += Number(usage.turns_completed) || 0;
  writeJson(usagePath, current);
}

module.exports = {
  beginTurn,
  appendHistoryItem,
  completeTurn,
  getConversationId,
  getHistoryRoot,
  updateUsage,
};

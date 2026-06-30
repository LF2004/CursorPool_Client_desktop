const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_RELAY_MEMORY_MAX_CHARS = 80000;
const DEFAULT_RELAY_MEMORY_ITEM_MAX_CHARS = 2400;
const DEFAULT_RELAY_CONTEXT_INPUT_RATIO = 0.82;
const DEFAULT_RELAY_CONTEXT_RESERVED_OUTPUT_TOKENS = 4096;

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function imagePartToText(part = {}) {
  const imageUrl = typeof part.image_url === 'string'
    ? part.image_url
    : typeof part.imageUrl === 'string'
      ? part.imageUrl
      : typeof part.image_url?.url === 'string'
        ? part.image_url.url
        : '';
  const detail = part.detail ? ` detail=${part.detail}` : '';
  return imageUrl ? `[image ${imageUrl}${detail}]` : '[image]';
}

function buildUsageMetaFromMessages(messages = []) {
  const normalized = Array.isArray(messages) ? messages : [];
  return {
    messageCount: normalized.length,
    messageChars: normalized.reduce((sum, message) => {
      if (Array.isArray(message?.content)) {
        return sum + message.content.reduce((inner, part) => inner + String(part?.text || part?.image_url || '').length, 0);
      }
      return sum + String(message?.content || '').length;
    }, 0),
  };
}

function getMessageContentText(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return String(part || '');
        if (part.type === 'input_text' || part.type === 'text') return String(part.text || '');
        if (part.type === 'input_image' || part.type === 'image_url') return imagePartToText(part);
        return String(part.text || part.image_url || '');
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

function setMessageContentText(message, text) {
  if (!message || !Array.isArray(message.content)) {
    return { ...(message || {}), content: text };
  }
  const content = [];
  let replaced = false;
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    if (!replaced && (part.type === 'input_text' || part.type === 'text')) {
      content.push({ ...part, text });
      replaced = true;
    } else {
      content.push(part);
    }
  }
  if (!replaced) content.unshift({ type: 'input_text', text });
  return { ...message, content };
}

function estimateMessageChars(message) {
  return getMessageContentText(message?.content).length;
}

function limitRelayText(value, maxChars = DEFAULT_RELAY_MEMORY_ITEM_MAX_CHARS) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  const limit = Math.max(200, Number(maxChars) || DEFAULT_RELAY_MEMORY_ITEM_MAX_CHARS);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function summarizeHistoryToolItem(item = {}, maxChars = DEFAULT_RELAY_MEMORY_ITEM_MAX_CHARS) {
  const payload = item.payload || {};
  const toolName = String(payload.tool_name || payload.toolName || item.tool_call_id || 'tool').trim();
  const ok = payload.ok === false ? 'failed' : 'ok';
  let args = payload.arguments || {};
  if (typeof args === 'string') args = parseJsonObject(args);
  const target = args.path || args.cwd || args.working_directory || args.target_file || args.targetFile || '';
  const result = limitRelayText(payload.result_text || payload.resultText || payload.output || '', Math.floor(maxChars * 0.7));
  return [
    `${toolName} ${ok}`,
    target ? `target=${target}` : '',
    result ? `result=${result}` : '',
  ].filter(Boolean).join(' | ');
}

function buildRelayConversationMemory(session = {}, options = {}) {
  const items = Array.isArray(session?.agentHistory?.context?.items)
    ? session.agentHistory.context.items
    : [];
  if (!items.length) return '';
  const currentTurn = Number(session.agentTurnSeq) || Number(session.agentHistory?.state?.current_turn_seq) || 0;
  const previousItems = currentTurn > 0
    ? items.filter((item) => Number(item.turn_seq) < currentTurn)
    : items;
  if (!previousItems.length) return '';

  const maxChars = Math.max(2000, Number(options.maxChars) || DEFAULT_RELAY_MEMORY_MAX_CHARS);
  const itemMaxChars = Math.max(600, Number(options.itemMaxChars) || DEFAULT_RELAY_MEMORY_ITEM_MAX_CHARS);
  const lines = [];
  const recentEditedFile = String(options.recentEditedFile || '').trim();
  if (recentEditedFile) lines.push(`Most recent edited file: ${recentEditedFile}`);

  const turns = new Map();
  for (const item of previousItems) {
    const turn = Number(item.turn_seq) || 0;
    if (!turns.has(turn)) turns.set(turn, []);
    turns.get(turn).push(item);
  }

  const sortedTurns = Array.from(turns.entries()).sort((a, b) => a[0] - b[0]);
  for (const [turn, turnItems] of sortedTurns.slice(-8)) {
    const user = turnItems.find((item) => item.kind === 'user_message')?.payload?.text;
    const assistantItems = turnItems.filter((item) => item.kind === 'assistant_text');
    const assistant = assistantItems[assistantItems.length - 1]?.payload?.text;
    const toolItems = turnItems.filter((item) => item.kind === 'tool_result').slice(-8);
    if (!user && !assistant && !toolItems.length) continue;
    lines.push(`Turn ${turn}:`);
    if (user) lines.push(`User: ${limitRelayText(user, itemMaxChars)}`);
    for (const toolItem of toolItems) {
      lines.push(`Tool: ${summarizeHistoryToolItem(toolItem, itemMaxChars)}`);
    }
    if (assistant) lines.push(`Assistant: ${limitRelayText(assistant, itemMaxChars)}`);
  }

  if (!lines.length) return '';
  return limitRelayText([
    'Conversation memory from previous turns in this same Cursor agent conversation.',
    'Use it as context, but prefer current tool results and current files over stale memory.',
    '',
    ...lines,
  ].join('\n'), maxChars);
}

function resolveRelayContextBudgetChars(config = {}) {
  const contextTokens = Number(config?.upstream?.contextWindow) || 200000;
  const reservedOutputTokens = Math.max(1024, Number(config.relayReservedOutputTokens) || DEFAULT_RELAY_CONTEXT_RESERVED_OUTPUT_TOKENS);
  const ratio = Number(config.relayContextInputRatio);
  const inputRatio = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : DEFAULT_RELAY_CONTEXT_INPUT_RATIO;
  const usableTokens = Math.max(4096, Math.floor((contextTokens - reservedOutputTokens) * inputRatio));
  return Math.max(16000, usableTokens * APPROX_CHARS_PER_TOKEN);
}

function compressSingleMessageContent(message, budgetChars) {
  const text = getMessageContentText(message?.content);
  if (!text || text.length <= budgetChars) return message;
  return setMessageContentText(message, `${text.slice(0, Math.max(0, budgetChars))}\n...[truncated to fit relay context budget]`);
}

function compactRelayMessagesForContext(messages = [], config = {}, logger = null, meta = {}) {
  const normalized = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const budgetChars = resolveRelayContextBudgetChars(config);
  let usage = buildUsageMetaFromMessages(normalized);
  if (usage.messageChars <= budgetChars) {
    return { messages: normalized, usage, compacted: false, dropped: 0, budgetChars };
  }

  const systemMessages = normalized.filter((message) => message?.role === 'system');
  const nonSystem = normalized.filter((message) => message?.role !== 'system');
  const kept = [...systemMessages];
  let used = systemMessages.reduce((sum, message) => sum + estimateMessageChars(message), 0);

  // 按时间顺序保留消息前缀，优先截断旧消息内容而非跳选中间段，利于上游 Prompt 前缀缓存命中
  for (let index = 0; index < nonSystem.length; index += 1) {
    const message = nonSystem[index];
    const isLatest = index === nonSystem.length - 1;
    const remaining = nonSystem.length - index - 1;
    const reservedForTail = isLatest ? 0 : Math.min(
      Math.floor(budgetChars * 0.45),
      Math.max(4000, (budgetChars - used) * 0.55),
    );
    const messageBudget = Math.max(
      isLatest ? 1000 : 400,
      budgetChars - used - reservedForTail,
    );
    let next = estimateMessageChars(message) <= messageBudget
      ? message
      : compressSingleMessageContent(message, messageBudget);
    let nextChars = estimateMessageChars(next);
    if (used + nextChars > budgetChars && !isLatest) {
      // 从最早非 system 消息起 FIFO 丢弃，保持剩余前缀顺序稳定
      while (kept.length > systemMessages.length && used + nextChars > budgetChars) {
        used -= estimateMessageChars(kept[systemMessages.length]);
        kept.splice(systemMessages.length, 1);
      }
      if (used + nextChars > budgetChars) {
        next = compressSingleMessageContent(next, Math.max(400, budgetChars - used));
        nextChars = estimateMessageChars(next);
      }
    }
    if (used + nextChars > budgetChars && remaining > 0) break;
    kept.push(next);
    used += nextChars;
  }

  usage = buildUsageMetaFromMessages(kept);
  if (usage.messageChars > budgetChars && kept.length > 1) {
    const last = kept[kept.length - 1];
    const withoutLast = kept.slice(0, -1);
    const headChars = withoutLast.reduce((sum, message) => sum + estimateMessageChars(message), 0);
    kept[kept.length - 1] = compressSingleMessageContent(last, Math.max(1000, budgetChars - headChars));
    usage = buildUsageMetaFromMessages(kept);
  }

  const dropped = normalized.length - kept.length;
  logger?.warn?.(
    `agent local relay context compacted requestId=${meta.requestId || '-'} phase=${meta.phase || '-'} beforeChars=${buildUsageMetaFromMessages(normalized).messageChars} afterChars=${usage.messageChars} budgetChars=${budgetChars} droppedMessages=${dropped}`,
  );
  return { messages: kept, usage, compacted: true, dropped, budgetChars };
}

module.exports = {
  DEFAULT_RELAY_MEMORY_MAX_CHARS,
  DEFAULT_RELAY_MEMORY_ITEM_MAX_CHARS,
  DEFAULT_RELAY_CONTEXT_INPUT_RATIO,
  DEFAULT_RELAY_CONTEXT_RESERVED_OUTPUT_TOKENS,
  buildRelayConversationMemory,
  buildUsageMetaFromMessages,
  compactRelayMessagesForContext,
  resolveRelayContextBudgetChars,
};

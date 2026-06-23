const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const http2 = require('http2');
const https = require('https');
const net = require('net');
const path = require('path');
const { execFile, spawn } = require('child_process');

const {
  decodeCursorChatRequest,
  decodeRunSseRequestId,
  decodeBidiAppendRequest,
  extractAgentModeFromPayload,
  summarizeConnectFrames,
  summarizeAgentServerStream,
  buildAgentKvSetBlobFrame,
  buildAgentTextDeltaFrame,
  buildAgentThinkingDeltaFrame,
  buildAgentTokenDeltaFrame,
  buildAgentThinkingCompletedFrame,
  buildAgentTurnEndedFrame,
  buildAgentHeartbeatFrame,
  buildAgentStepStartedFrame,
  buildAgentStepCompletedFrame,
  buildAgentPartialToolCallFrame,
  buildAgentToolCallStartedFrame,
  buildAgentToolCallCompletedFrame,
  buildAgentEditToolCallDeltaFrame,
  buildAgentConversationCheckpointFrame,
  buildAgentExecReadFrame,
  buildAgentExecWriteFrame,
  buildAgentExecDeleteFrame,
  buildAgentExecGrepFrame,
  buildAgentExecLsFrame,
  buildAgentExecShellStreamFrame,
  buildAgentExecDiagnosticsFrame,
  buildConnectEndFrame,
  buildConnectErrorFrame,
  buildStructuredToolCallSnapshot,
  extractOpenAiDelta,
} = require('./cursor-relay-protocol');
const { encodeMessage: encodeCursorProtoMessage } = require('./cursor-relay-protobuf');
const {
  beginTurn: beginAgentHistoryTurn,
  appendHistoryItem: appendAgentHistoryItem,
  completeTurn: completeAgentHistoryTurn,
  updateConversationState: updateAgentHistoryConversationState,
  updateUsage: updateAgentHistoryUsage,
} = require('./cursor-relay-agent-history');
const {
  DEFAULT_RELAY_MEMORY_MAX_CHARS,
  DEFAULT_RELAY_MEMORY_ITEM_MAX_CHARS,
  buildRelayConversationMemory,
  compactRelayMessagesForContext,
} = require('./cursor-relay-context-manager');
const {
  normalizeAgentModeName,
  getCursorModeDirectory,
  getSessionAgentMode,
} = require('../mode/registry');
const {
  getModeHandler,
  buildToolDefinitionsForChatByMode,
  buildToolDefinitionsForResponsesByMode,
  buildLocalRelayMessagesForMode,
  shouldUseNativeExecForModeTool,
  getUpstreamRequestOptionsForMode,
} = require('../mode');
const {
  isTodoToolName,
} = require('../mode/common/policy');
const {
  recordRelayUsage,
  updateRelayUsageBilledPoints,
  updateRelayUsageStatusForRequest,
} = require('./cursor-relay-usage-store');
const { getCursorPaths, readAccountFromItemTable, resolveCursorDbEmail } = require('./cursor-local-state');

const CHAT_PATH = '/aiserver.v1.ChatService/StreamUnifiedChatWithTools';
const AGENT_RUN_SSE_PATH = '/agent.v1.AgentService/RunSSE';
const BIDI_APPEND_PATH = '/aiserver.v1.BidiService/BidiAppend';
const HEALTH_PATH = '/__cursorpool__/health';
const CONTROL_SHUTDOWN_PATH = '/__cursorpool__/control/shutdown';
const RUNNER_MODE_LOCAL_RELAY = 'local_relay';
const RUNNER_MODE_OFFICIAL_PASSTHROUGH = 'official_passthrough';
const UPSTREAM_FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 90 * 1000;
const POST_TOOL_UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;
const POST_TOOL_STREAM_IDLE_TIMEOUT_MS = 90 * 1000;
const POST_TOOL_MUTATION_STREAM_IDLE_TIMEOUT_MS = 45 * 1000;
const POST_MUTATION_SUMMARY_TIMEOUT_MS = 12 * 1000;
const POST_MUTATION_SUMMARY_IDLE_TIMEOUT_MS = 4500;
const MUTATION_TOOL_STREAM_IDLE_TIMEOUT_MS = 45 * 1000;
const MUTATION_TOOL_STREAM_MAX_DURATION_MS = 80 * 1000;
const AGENT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_MAX_LOCAL_TOOL_CALLS_PER_ROUND = 12;
const DEFAULT_MAX_LOCAL_TOOL_ROUNDS = 0;
const MAX_POST_TOOL_STREAM_RECOVERIES = 2;
const MAX_COMPLETION_VERIFICATION_ROUNDS = 0;
const DEFAULT_MAX_INCOMPLETE_POST_MUTATION_CONTINUATIONS = 16;
const DEFAULT_MAX_INCOMPLETE_TODO_CONTINUATIONS = 0;
const DEFAULT_MAX_READONLY_EXPLORATION_CONTINUATIONS = 6;
const POST_MUTATION_STOP_AFTER_TEXT_MS = 2500;
const FORCE_MUTATION_AFTER_READ_ONLY_ROUNDS = 2;
const DEEPSEEK_REASONING_ONLY_STREAM_MAX_MS = 12000;
const INITIAL_VISIBLE_PROGRESS_MS = 12000;
const MAX_TOOL_OUTPUT_CHARS = 16000;
const MAX_INLINE_EDIT_RESULT_CONTENT_CHARS = 512 * 1024;
const MAX_UPSTREAM_IMAGE_BYTES = 20 * 1024 * 1024;
const EDIT_STREAM_FLUSH_CHARS = 2048;
const EDIT_STREAM_FLUSH_MS = 250;
const EDIT_STREAM_FRAME_CHARS = 2048;
const MAX_EDIT_STREAM_CONTENT_CHARS = 1400;
const EXEC_CLIENT_WAIT_TIMEOUT_MS = 8000;
const RECENT_EXECUTION_WORKSPACE_PATH = path.join(process.env.USERPROFILE || process.cwd(), '.cursorpool', 'relay', 'recent-execution-workspace.json');

const { appendRunnerLog, initRunnerLogs } = require('./cursor-relay-log');
const { createProxyAwareFetch } = require('./proxy-aware-fetch');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--config') out.configPath = argv[i + 1];
  }
  return out;
}

function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
}

function createLogger(customRoot = '') {
  initRunnerLogs(customRoot);
  try {
    appendRunnerLog(`[info] runner code mtime=${fs.statSync(__filename).mtime.toISOString()}`, customRoot);
  } catch {
    /* ignore */
  }
  return {
    info(message) {
      appendRunnerLog(`[info] ${message}`, customRoot);
    },
    warn(message) {
      appendRunnerLog(`[warn] ${message}`, customRoot);
    },
    error(message) {
      appendRunnerLog(`[error] ${message}`, customRoot);
    },
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getRunnerMode(config = {}) {
  const explicit = String(config.mode || process.env.CURSOR_RELAY_RUNNER_MODE || '').trim().toLowerCase();
  if (explicit === RUNNER_MODE_OFFICIAL_PASSTHROUGH || explicit === 'thin-proxy' || explicit === 'thin_proxy') {
    return RUNNER_MODE_OFFICIAL_PASSTHROUGH;
  }
  if (explicit === RUNNER_MODE_LOCAL_RELAY || explicit === 'relay') return RUNNER_MODE_LOCAL_RELAY;
  return RUNNER_MODE_OFFICIAL_PASSTHROUGH;
}

function isLocalRelayMode(config = {}) {
  return getRunnerMode(config) === RUNNER_MODE_LOCAL_RELAY;
}

function maskProxyUrlForLog(proxyUrl = '') {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = '****';
    if (parsed.password) parsed.password = '****';
    return parsed.href.replace(/\/$/, '');
  } catch {
    return raw.replace(/\/\/([^:@/]+):([^@/]+)@/i, '//****:****@');
  }
}

function describeOutboundProxyForLog(proxyConfig = null) {
  if (!proxyConfig?.enabled || !proxyConfig.url) return 'direct';
  const source = String(proxyConfig.source || 'proxy').trim() || 'proxy';
  return `${source}:${maskProxyUrlForLog(proxyConfig.url)}`;
}

function createConfigProxyFetch(config = {}) {
  return createProxyAwareFetch(config?.outboundProxy || null, {
    localProxyPorts: [Number(config?.port) || 0],
  });
}

function createAbortSignal(timeoutMs = UPSTREAM_FETCH_TIMEOUT_MS, parentSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Upstream timeout after ${timeoutMs}ms`)), timeoutMs);
  const abortFromParent = () => {
    try {
      controller.abort(parentSignal?.reason || new Error('Relay session aborted'));
    } catch {
      /* ignore */
    }
  };
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    },
  };
}

function trimRelayText(value, limit = 6000) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text;
}

function supportsImageContent(upstream = {}, modelName = '') {
  const provider = String(upstream.providerId || '').trim().toLowerCase();
  const model = String(modelName || upstream.modelName || '').trim().toLowerCase();
  if (provider.includes('deepseek') || model.startsWith('deepseek')) return false;
  return true;
}

function isDeepSeekModel(configOrUpstream = {}, modelName = '') {
  const upstream = configOrUpstream?.upstream || configOrUpstream || {};
  const provider = String(upstream.providerId || '').trim().toLowerCase();
  const model = String(modelName || upstream.modelName || '').trim().toLowerCase();
  return provider.includes('deepseek') || model.startsWith('deepseek');
}

function isMimoProvider(upstream = {}, modelName = '') {
  const provider = String(upstream.providerId || '').trim().toLowerCase();
  const baseUrl = String(upstream.baseUrl || '').toLowerCase();
  const model = String(modelName || upstream.modelName || '').trim().toLowerCase();
  return provider === 'mimo' || provider.includes('mimo') || baseUrl.includes('xiaomimimo.com') || model.startsWith('mimo-');
}

function buildMimoThinkingOption(upstream = {}, modelName = '') {
  if (!isMimoProvider(upstream, modelName)) return null;
  const mode = String(upstream.thinkingMode || 'disabled').trim().toLowerCase();
  return { type: mode === 'enabled' ? 'enabled' : 'disabled' };
}

function buildDeepSeekThinkingOption(upstream = {}, modelName = '') {
  if (!isDeepSeekModel(upstream, modelName)) return null;
  const mode = String(upstream.thinkingMode || 'disabled').trim().toLowerCase();
  return { type: mode === 'enabled' ? 'enabled' : 'disabled' };
}

function shouldEmitThinkingForUpstream(configOrUpstream = {}, modelName = '') {
  if (!isDeepSeekModel(configOrUpstream, modelName)) return true;
  const upstream = configOrUpstream?.upstream || configOrUpstream || {};
  return String(upstream.thinkingMode || 'disabled').trim().toLowerCase() === 'enabled';
}

function getConfiguredModelRoutes(config = {}) {
  if (!Array.isArray(config.modelRoutes)) return [];
  return config.modelRoutes
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const modelName = String(item.modelName || '').trim();
      const upstream = item.upstream && typeof item.upstream === 'object' ? item.upstream : null;
      if (!modelName || !upstream) return null;
      return { modelName, upstream };
    })
    .filter(Boolean);
}

function resolveUpstreamForModel(config = {}, modelName = '') {
  const requested = String(modelName || '').trim();
  if (!requested) return config.upstream || {};
  const route = getConfiguredModelRoutes(config).find((item) => item.modelName === requested);
  return route?.upstream || config.upstream || {};
}

function findTagPrefixSuffixLength(text, tag) {
  const value = String(text || '').toLowerCase();
  const needle = String(tag || '').toLowerCase();
  const max = Math.min(needle.length - 1, value.length);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(needle.slice(0, length))) return length;
  }
  return 0;
}

function createInlineThinkingTextFilter() {
  const openTag = '<think>';
  const closeTag = '</think>';
  let pending = '';
  let insideThinking = false;

  return {
    push(chunk) {
      let text = `${pending}${String(chunk || '')}`;
      pending = '';
      let output = '';

      while (text) {
        const lower = text.toLowerCase();
        if (insideThinking) {
          const closeIndex = lower.indexOf(closeTag);
          if (closeIndex < 0) {
            pending = text.slice(-Math.max(0, closeTag.length - 1));
            return output;
          }
          text = text.slice(closeIndex + closeTag.length);
          insideThinking = false;
          continue;
        }

        const openIndex = lower.indexOf(openTag);
        if (openIndex < 0) {
          const suffixLength = findTagPrefixSuffixLength(text, openTag);
          if (suffixLength > 0) {
            output += text.slice(0, -suffixLength);
            pending = text.slice(-suffixLength);
          } else {
            output += text;
          }
          return output;
        }

        output += text.slice(0, openIndex);
        text = text.slice(openIndex + openTag.length);
        insideThinking = true;
      }

      return output;
    },
    flush() {
      const tail = insideThinking ? '' : pending;
      pending = '';
      insideThinking = false;
      return tail;
    },
  };
}

const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

function buildDeepSeekReasoningEffortOption(upstream = {}, modelName = '') {
  const thinking = buildDeepSeekThinkingOption(upstream, modelName);
  if (!thinking || thinking.type !== 'enabled') return null;
  const effort = String(upstream.reasoningEffort || '').trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(effort) ? effort : 'medium';
}

function buildOpenAiReasoningOption(upstream = {}, modelName = '') {
  if (isDeepSeekModel(upstream, modelName) || isMimoProvider(upstream, modelName)) return null;
  const effort = String(upstream.reasoningEffort || '').trim().toLowerCase();
  return VALID_REASONING_EFFORTS.includes(effort) ? { effort } : { effort: 'medium' };
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

function imagePartToText(part = {}) {
  const imageUrl = typeof part.image_url === 'string'
    ? part.image_url
    : typeof part.imageUrl === 'string'
      ? part.imageUrl
      : typeof part.image_url?.url === 'string'
        ? part.image_url.url
        : '';
  const detail = part.detail ? ` detail=${part.detail}` : '';
  if (!imageUrl) return '[Image omitted: upstream model only accepts text content.]';
  if (/^data:/i.test(imageUrl)) {
    const mime = imageUrl.slice(5, imageUrl.indexOf(';') > 0 ? imageUrl.indexOf(';') : Math.min(imageUrl.length, 64));
    return `[Image omitted: ${mime || 'inline image'}${detail}. The selected upstream model only accepts text content.]`;
  }
  return `[Image omitted: ${imageUrl}${detail}. The selected upstream model only accepts text content.]`;
}

function normalizeContentForUpstreamContentApi(content, options = {}) {
  if (!Array.isArray(content)) return String(content || '');
  if (options.allowImages !== false) return content;
  return content.map((part) => {
    if (!part || typeof part !== 'object') return String(part || '');
    if (part.type === 'input_text' || part.type === 'text') return String(part.text || '');
    if (part.type === 'input_image' || part.type === 'image_url') return imagePartToText(part);
    return String(part.text || '');
  }).filter(Boolean).join('\n');
}

function toResponsesInput(messages = [], options = {}) {
  const normalized = Array.isArray(messages) ? messages : [];
  const instructions = normalized
    .filter((message) => message?.role === 'system')
    .map((message) => String(message.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const input = normalized
    .filter((message) => message?.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: Array.isArray(message.content)
        ? normalizeContentForUpstreamContentApi(message.content, options)
        : String(message.content || ''),
    }))
    .filter((message) => Array.isArray(message.content) ? message.content.length : message.content);
  return { instructions, input };
}

function toChatContentPart(part = {}, options = {}) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'input_text' || part.type === 'text') {
    return { type: 'text', text: String(part.text || '') };
  }
  if (part.type === 'input_image' || part.type === 'image_url') {
    if (options.allowImages === false) {
      return { type: 'text', text: imagePartToText(part) };
    }
    const imageUrl = typeof part.image_url === 'string'
      ? part.image_url
      : typeof part.imageUrl === 'string'
        ? part.imageUrl
        : typeof part.image_url?.url === 'string'
          ? part.image_url.url
          : '';
    return imageUrl ? { type: 'image_url', image_url: { url: imageUrl } } : null;
  }
  return null;
}

function toChatMessages(messages = [], options = {}) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (Array.isArray(message?.content)) {
      const content = message.content.map((part) => toChatContentPart(part, options)).filter(Boolean);
      return {
        ...message,
        content: content.length ? content : '',
      };
    }
    return {
      ...message,
      content: String(message?.content || ''),
    };
  });
}

function prefersResponsesApi(upstream = {}, options = {}) {
  const preferred = String(options.preferredEndpointMode || '').trim().toLowerCase();
  if (preferred === 'chat') return false;
  if (preferred === 'responses') return true;
  const providerId = String(upstream.providerId || '').trim().toLowerCase();
  if (providerId.includes('gemini') || isMimoProvider(upstream)) return false;
  return String(upstream.endpointMode || 'responses').trim().toLowerCase() !== 'chat';
}

function readOptionalTextFile(filePath, maxChars = 24000) {
  try {
    const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
    return text.slice(0, maxChars);
  } catch {
    return '';
  }
}

function normalizeToolNameSet(names = null) {
  if (!Array.isArray(names) || !names.length) return null;
  const out = new Set();
  names.forEach((name) => {
    const text = String(name || '').trim();
    if (text) out.add(text.toLowerCase());
  });
  return out.size ? out : null;
}

function filterRelayTools(tools = [], allowedNames = null) {
  const allowed = normalizeToolNameSet(allowedNames);
  if (!allowed) return tools;
  const order = new Map((Array.isArray(allowedNames) ? allowedNames : [])
    .map((name, index) => [String(name || '').trim().toLowerCase(), index]));
  return tools
    .filter((tool) => allowed.has(String(tool?.function?.name || '').trim().toLowerCase()))
    .sort((a, b) => {
      const aOrder = order.has(String(a?.function?.name || '').trim().toLowerCase())
        ? order.get(String(a?.function?.name || '').trim().toLowerCase())
        : Number.MAX_SAFE_INTEGER;
      const bOrder = order.has(String(b?.function?.name || '').trim().toLowerCase())
        ? order.get(String(b?.function?.name || '').trim().toLowerCase())
        : Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    });
}

function buildRelayToolDefinitionsForChat(options = {}) {
  const modeName = normalizeAgentModeName(options.mode || 'AGENT_MODE_AGENT');
  return filterRelayTools(
    buildToolDefinitionsForChatByMode({ ...options, mode: modeName }),
    options.allowedToolNames || null,
  );
}

function buildRelayToolDefinitionsForResponses(options = {}) {
  const modeName = normalizeAgentModeName(options.mode || 'AGENT_MODE_AGENT');
  return buildToolDefinitionsForResponsesByMode({ ...options, mode: modeName });
}

function buildUpstreamAttempts(upstream, modelName, messages, options = {}) {
  const baseUrl = String(upstream?.baseUrl || '').replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${upstream.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    'User-Agent': buildRelayUserAgent(baseUrl),
  };
  if (isMimoProvider(upstream, modelName)) {
    headers['api-key'] = upstream.apiKey;
  }
  const contentOptions = { allowImages: supportsImageContent(upstream, modelName) };
  const responseInput = toResponsesInput(messages, contentOptions);
  const deepSeekThinking = buildDeepSeekThinkingOption(upstream, modelName);
  const mimoThinking = buildMimoThinkingOption(upstream, modelName);
  const deepSeekReasoningEffort = buildDeepSeekReasoningEffortOption(upstream, modelName);
  const openAiReasoning = options.disableReasoning === true ? null : buildOpenAiReasoningOption(upstream, modelName);
  const enableTools = options.enableTools !== false;
  const toolChoice = enableTools ? String(options.toolChoice || 'auto') : '';
  const streamUsageOptions = { stream_options: { include_usage: true } };
  const chatAttempt = {
    label: 'chat',
    url: `${baseUrl}/chat/completions`,
    options: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages: toChatMessages(messages, contentOptions),
        stream: true,
        ...(options.mode ? { metadata: { agent_mode: options.mode } } : {}),
        ...streamUsageOptions,
        ...(openAiReasoning ? { reasoning: openAiReasoning } : {}),
        ...(deepSeekThinking ? { thinking: deepSeekThinking } : {}),
        ...(mimoThinking ? { thinking: mimoThinking } : {}),
        ...(deepSeekReasoningEffort ? { reasoning_effort: deepSeekReasoningEffort } : {}),
        ...(enableTools ? { tools: buildRelayToolDefinitionsForChat(options), tool_choice: toolChoice } : {}),
      }),
    },
  };
  const responsesAttempt = {
    label: 'responses',
    url: `${baseUrl}/responses`,
    options: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        ...(responseInput.instructions ? { instructions: responseInput.instructions } : {}),
        input: responseInput.input.length ? responseInput.input : 'ping',
        stream: true,
        ...(options.mode ? { metadata: { agent_mode: options.mode } } : {}),
        ...(openAiReasoning ? { reasoning: openAiReasoning } : {}),
        ...(deepSeekThinking ? { thinking: deepSeekThinking } : {}),
        ...(mimoThinking ? { thinking: mimoThinking } : {}),
        ...(deepSeekReasoningEffort ? { reasoning_effort: deepSeekReasoningEffort } : {}),
        ...(enableTools ? { tools: buildRelayToolDefinitionsForResponses(options), tool_choice: toolChoice } : {}),
      }),
    },
  };
  return prefersResponsesApi(upstream, options) ? [responsesAttempt, chatAttempt] : [chatAttempt, responsesAttempt];
}

function shouldRetryAlternateEndpoint(status, bodyText = '') {
  if ([404, 405, 406, 415].includes(Number(status))) return true;
  if (Number(status) !== 400) return false;
  const text = String(bodyText || '').toLowerCase();
  return [
    'messages',
    'input',
    'unsupported',
    'not supported',
    'unknown parameter',
    'invalid_request_error',
  ].some((needle) => text.includes(needle));
}

function shouldRetryAutoToolChoice(status, bodyText = '') {
  if (Number(status) !== 400) return false;
  const text = String(bodyText || '').toLowerCase();
  return text.includes('tool_choice')
    && (text.includes('required') || text.includes('unsupported') || text.includes('invalid') || text.includes('not supported'));
}

function shouldRetryWithoutReasoning(status, bodyText = '') {
  if (Number(status) !== 400) return false;
  const text = String(bodyText || '').toLowerCase();
  return text.includes('reasoning')
    && (text.includes('unknown') || text.includes('unsupported') || text.includes('invalid') || text.includes('not supported'));
}

function summarizeUpstreamFailure(statusOrKind, errorText = '') {
  const status = Number(statusOrKind) || 0;
  const detail = trimRelayText(String(errorText || '').replace(/\s+/g, ' '), 240);
  if (status >= 500) return `上游服务异常（HTTP ${status}）。${detail ? `详情：${detail}` : '请稍后重试。'}`;
  if (status >= 400) return `上游请求失败（HTTP ${status}）。${detail ? `详情：${detail}` : '请检查 Relay 上游配置。'}`;
  return detail || '上游请求失败，请稍后重试。';
}

function summarizeFetchError(error) {
  const message = trimRelayText(error?.message || String(error || ''), 240);
  if (String(error?.name || '').toLowerCase() === 'aborterror' || /timeout/i.test(message)) {
    return '上游请求暂时无响应，本地 Relay 已保留当前工具上下文，任务未确认完成。';
  }
  return `上游请求失败：${message || '未知错误'}`;
}

function formatUpstreamErrorForUser(errorText = '') {
  const text = trimRelayText(String(errorText || '').replace(/\s+/g, ' '), 240);
  if (/concurrency limit exceeded/i.test(text)) {
    return '上游账号并发数已满，请稍后重试。原始错误：Concurrency limit exceeded for account, please retry later';
  }
  return text;
}

function hasPositiveUsageTokens(usage = {}) {
  if (!usage || typeof usage !== 'object') return false;
  const stack = [usage];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const value of Object.values(current)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return true;
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return false;
}

function buildBillingRequestId(requestId = '', phase = '') {
  const base = String(requestId || '').trim();
  const step = String(phase || '').trim();
  if (!base) return '';
  if (!step || step === 'initial') return base;
  return `${base}::${step}`;
}

async function reportAdvancedModelUsage(config, details = {}) {
  const billing = config?.advancedModelBilling;
  if (!billing?.enabled) return null;
  const apiBase = String(billing.apiBase || '').trim().replace(/\/+$/, '');
  const poolToken = String(config?.upstream?.apiKey || '').trim();
  const requestId = buildBillingRequestId(details.requestId, details.phase);
  if (!apiBase || !poolToken || !requestId) return null;

  const payload = {
    requestId,
    status: String(details.status || 'success'),
    model: String(details.model || config?.upstream?.modelName || ''),
    usage: details.usage && typeof details.usage === 'object' ? details.usage : {},
    phase: String(details.phase || ''),
  };

  try {
    const proxyFetch = createConfigProxyFetch(config);
    const response = await proxyFetch(`${apiBase}/api/advanced-models/report-usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${poolToken}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.message || `report-usage HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function resolveCurrentCursorAgentAccount() {
  try {
    const { stateVscdbPath } = getCursorPaths();
    const { account } = readAccountFromItemTable(stateVscdbPath);
    return resolveCursorDbEmail(account) || '';
  } catch {
    return '';
  }
}

function recordUpstreamUsagePhase(session, config, details = {}) {
  if (!session || !config) return;
  try {
    const usage = details.usage && typeof details.usage === 'object' ? details.usage : {};
    const status = String(details.status || '');
    const requestId = session.requestId || '';
    const platformBilling = isPlatformBillingEnabled(config);
    const recorded = recordRelayUsage(getConfigCustomRoot(config), {
      requestId,
      conversationId: session.conversationId || '',
      mode: getSessionAgentMode(session),
      phase: details.phase || '',
      endpointMode: details.endpointMode || config.upstream?.endpointMode || '',
      model: details.model || config.upstream?.modelName || '',
      status: status === 'success' ? (platformBilling ? 'paid' : 'success') : status,
      httpStatus: details.httpStatus || 0,
      error: details.error || '',
      usage,
      durationMs: details.durationMs || 0,
      promptChars: details.promptChars || 0,
      responseTextChars: details.responseTextChars || 0,
      reasoningChars: details.reasoningChars || 0,
      toolCalls: details.toolCalls || 0,
      upstreamBaseUrl: config.upstream?.baseUrl || '',
      meta: details.meta || null,
      cursorAgentAccount: resolveCurrentCursorAgentAccount(),
      reasoningEffort: details.reasoningEffort || config.upstream?.reasoningEffort || '',
      platformBilling,
    });
    if (platformBilling && status === 'success' && hasPositiveUsageTokens(usage)) {
      reportAdvancedModelUsage(config, {
        requestId,
        phase: details.phase || '',
        status,
        model: details.model || config.upstream?.modelName || '',
        usage,
      }).then((result) => {
        const billedPoints = Number(result?.billedPoints);
        const estimatedPoints = Number(result?.points);
        if (recorded?.id && Number.isFinite(billedPoints) && billedPoints > 0) {
          updateRelayUsageBilledPoints(
            getConfigCustomRoot(config),
            recorded.id,
            billedPoints,
            Number.isFinite(estimatedPoints) && estimatedPoints > 0 ? estimatedPoints : null,
          );
        }
      }).catch(() => {});
    }
  } catch (error) {
    session.logger?.warn?.(`relay usage record failed requestId=${session.requestId || '-'} phase=${details.phase || '-'}: ${error.message}`);
  }
}

function markUpstreamUsageCompleted(session, config, status = 'success', error = '') {
  if (!session || !config) return;
  try {
    const result = updateRelayUsageStatusForRequest(
      getConfigCustomRoot(config),
      session.requestId || '',
      'paid',
      status,
      error,
    );
    if (result?.updated) {
      session.logger?.info?.(`relay usage marked completed requestId=${session.requestId || '-'} rows=${result.updated}`);
    }
  } catch (error) {
    session.logger?.warn?.(`relay usage completion update failed requestId=${session.requestId || '-'}: ${error.message}`);
  }
}

async function fetchUpstreamCompletion(upstream, modelName, messages, logger, options = {}) {
  const attempts = buildUpstreamAttempts(upstream, modelName, messages, options);
  let lastError = null;
  let lastResponse = null;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : UPSTREAM_FETCH_TIMEOUT_MS;
  const requestId = String(options.requestId || '-');
  const phase = String(options.phase || 'upstream');
  const allowedToolNames = Array.isArray(options.allowedToolNames) && options.allowedToolNames.length
    ? options.allowedToolNames.join(',')
    : '-';
  const toolChoice = options.enableTools === false ? '-' : String(options.toolChoice || 'auto');
  const localProxyPorts = []
    .concat(options.localProxyPorts || [])
    .concat(options.localProxyPort || [])
    .map((item) => Number(item) || 0)
    .filter(Boolean);
  const upstreamFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : createProxyAwareFetch(options.outboundProxy || null, { localProxyPorts });
  const outboundProxyLabel = describeOutboundProxyForLog(upstreamFetch.proxy || options.outboundProxy || null);
  const messageChars = (Array.isArray(messages) ? messages : [])
    .reduce((sum, message) => {
      if (Array.isArray(message?.content)) {
        return sum + message.content.reduce((inner, part) => inner + String(part?.text || part?.image_url || '').length, 0);
      }
      return sum + String(message.content || '').length;
    }, 0);

  for (const attempt of attempts) {
    const upstreamAbort = createAbortSignal(timeoutMs, options.signal || null);
    try {
      logger?.info?.(
        `agent local relay upstream fetch start requestId=${requestId} phase=${phase} mode=${attempt.label} timeoutMs=${timeoutMs} messages=${Array.isArray(messages) ? messages.length : 0} messageChars=${messageChars} allowedTools=${allowedToolNames} toolChoice=${toolChoice} outboundProxy=${outboundProxyLabel}`,
      );
      // eslint-disable-next-line no-await-in-loop
      const response = await upstreamFetch(attempt.url, {
        ...attempt.options,
        signal: upstreamAbort.signal,
      });
      logger?.info?.(
        `agent local relay upstream fetch headers requestId=${requestId} phase=${phase} mode=${attempt.label} status=${response.status} ok=${response.ok ? '1' : '0'} contentType=${String(response.headers.get('content-type') || '-')}`,
      );
      if (response.ok) return { response, mode: attempt.label };

      const bodyText = await response.text().catch(() => '');
      lastResponse = { status: response.status, text: bodyText, mode: attempt.label };
      if (String(options.toolChoice || '').toLowerCase() === 'required' && shouldRetryAutoToolChoice(response.status, bodyText)) {
        logger?.warn?.(`agent local relay upstream rejected required tool_choice; retrying auto requestId=${requestId} phase=${phase} mode=${attempt.label}`);
        return fetchUpstreamCompletion(upstream, modelName, messages, logger, {
          ...options,
          toolChoice: 'auto',
          requiredToolChoiceFallback: true,
        });
      }
      if (options.disableReasoning !== true && !isDeepSeekModel(upstream, modelName) && !isMimoProvider(upstream, modelName) && shouldRetryWithoutReasoning(response.status, bodyText)) {
        logger?.warn?.(`agent local relay upstream rejected reasoning effort; retrying without reasoning requestId=${requestId} phase=${phase} mode=${attempt.label}`);
        return fetchUpstreamCompletion(upstream, modelName, messages, logger, {
          ...options,
          disableReasoning: true,
        });
      }
      if (shouldRetryAlternateEndpoint(response.status, bodyText)) {
        logger?.info?.(`agent local relay upstream ${attempt.label} incompatible, trying alternate endpoint`);
        continue;
      }
      return {
        response: { ok: false, status: response.status, text: async () => bodyText },
        mode: attempt.label,
      };
    } catch (error) {
      lastError = { error, mode: attempt.label };
      logger?.error?.(
        `agent local relay upstream fetch error requestId=${requestId} phase=${phase} mode=${attempt.label} timeoutMs=${timeoutMs}: ${error.message || String(error)}`,
      );
    } finally {
      upstreamAbort.clear();
    }
  }

  if (lastResponse) {
    return {
      response: { ok: false, status: lastResponse.status, text: async () => lastResponse.text },
      mode: lastResponse.mode,
    };
  }
  if (lastError) throw lastError.error;
  throw new Error('No upstream endpoint available');
}

async function parseSseStream(response, onDelta, options = {}) {
  const reader = response.body?.getReader();
  if (!reader) {
    const raw = await response.text();
    if (!raw) return;
    try {
      const payload = JSON.parse(raw);
      onDelta(extractOpenAiDelta(payload), '', payload);
    } catch {
      onDelta({ text: raw, reasoning: '', done: true, error: '' });
    }
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let streamDone = false;
  const idleTimeoutMs = Number(options.idleTimeoutMs) > 0
    ? Number(options.idleTimeoutMs)
    : UPSTREAM_STREAM_IDLE_TIMEOUT_MS;
  const maxDurationMs = Number(options.maxDurationMs) > 0 ? Number(options.maxDurationMs) : 0;
  const extendMaxDurationOnActivity = options.extendMaxDurationOnActivity === true;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  const abortSignal = options.signal || null;
  const abortRead = () => {
    try {
      reader.cancel(abortSignal?.reason || new Error('Relay session aborted'));
    } catch {
      /* ignore */
    }
  };
  if (abortSignal) {
    if (abortSignal.aborted) abortRead();
    else abortSignal.addEventListener('abort', abortRead, { once: true });
  }

  function flushEvent() {
    if (!dataLines.length) {
      eventName = '';
      return;
    }
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw) {
      eventName = '';
      return;
    }
    if (raw === '[DONE]') {
      streamDone = true;
      eventName = '';
      return;
    }
    try {
      const payload = JSON.parse(raw);
      onDelta(extractOpenAiDelta(payload), eventName, payload);
      if (options.shouldStop?.()) streamDone = true;
    } catch {
      const pieces = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      let parsedAny = false;
      for (const piece of pieces) {
        try {
          const payload = JSON.parse(piece);
          parsedAny = true;
          onDelta(extractOpenAiDelta(payload), eventName, payload);
          if (options.shouldStop?.()) {
            streamDone = true;
            break;
          }
        } catch {
          /* try the next line */
        }
      }
      if (!parsedAny && !/"type"\s*:\s*"response\./.test(raw)) {
        onDelta({ text: '', reasoning: '', done: false, error: 'Invalid upstream SSE payload' }, eventName);
      }
    }
    eventName = '';
  }

  try {
  while (!streamDone && !abortSignal?.aborted) {
    const durationBaseAt = extendMaxDurationOnActivity ? lastActivityAt : startedAt;
    const remainingDurationMs = maxDurationMs > 0 ? Math.max(1, maxDurationMs - (Date.now() - durationBaseAt)) : 0;
    if (maxDurationMs > 0 && remainingDurationMs <= 1) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      onDelta({
        text: '',
        reasoning: '',
        done: false,
        error: `Upstream stream max duration exceeded after ${maxDurationMs}ms`,
      });
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const readResult = await Promise.race([
      reader.read(),
      new Promise((resolve) => {
        setTimeout(() => resolve({ idleTimeout: true }), idleTimeoutMs);
      }),
      ...(remainingDurationMs > 0
        ? [new Promise((resolve) => {
          setTimeout(() => resolve({ maxDurationTimeout: true }), remainingDurationMs);
        })]
        : []),
    ]);
    if (readResult?.maxDurationTimeout) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      onDelta({
        text: '',
        reasoning: '',
        done: false,
        error: `Upstream stream max duration exceeded after ${maxDurationMs}ms`,
      });
      break;
    }
    if (readResult?.idleTimeout) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      onDelta({
        text: '',
        reasoning: '',
        done: false,
        error: `Upstream stream idle timeout after ${idleTimeoutMs}ms`,
      });
      break;
    }
    const { value, done } = readResult;
    if (done) break;
    lastActivityAt = Date.now();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) {
        flushEvent();
        if (streamDone) break;
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (streamDone) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
  }
  } finally {
    if (abortSignal) abortSignal.removeEventListener('abort', abortRead);
  }
  if (abortSignal?.aborted) return;
  if (buffer.trim() && buffer.trim().startsWith('data:')) {
    dataLines.push(buffer.trim().slice(5).trimStart());
  }
  flushEvent();
}

function normalizeImageMimeType(mimeType = '', filePath = '') {
  const explicit = String(mimeType || '').trim().toLowerCase();
  if (explicit.startsWith('image/')) return explicit;
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function buildUpstreamImageParts(session = {}) {
  const selectedImages = Array.isArray(session.lastUserMessageCapture?.selectedImages)
    ? session.lastUserMessageCapture.selectedImages
    : Array.isArray(session.lastUserMessageCapture?.debug?.selectedImages)
      ? session.lastUserMessageCapture.debug.selectedImages
      : [];
  const parts = [];
  selectedImages.slice(0, 8).forEach((image) => {
    const mimeType = normalizeImageMimeType(image.mimeType, image.path);
    let dataBase64 = String(image.dataBase64 || '').trim();
    if (!dataBase64 && image.path) {
      try {
        const imagePath = normalizeWorkspacePath(image.path);
        const stat = fs.statSync(imagePath);
        if (stat.isFile() && stat.size <= MAX_UPSTREAM_IMAGE_BYTES) {
          dataBase64 = fs.readFileSync(imagePath).toString('base64');
        }
      } catch {
        /* keep path-only fallback */
      }
    }
    if (dataBase64) {
      const approxBytes = Math.floor((dataBase64.length * 3) / 4);
      if (approxBytes <= MAX_UPSTREAM_IMAGE_BYTES) {
        parts.push({
          type: 'input_image',
          image_url: `data:${mimeType};base64,${dataBase64}`,
        });
        return;
      }
    }
    const label = [
      image.uuid ? `uuid=${image.uuid}` : '',
      image.path ? `path=${image.path}` : '',
      image.width && image.height ? `size=${image.width}x${image.height}` : '',
      image.mimeType ? `mime=${image.mimeType}` : '',
    ].filter(Boolean).join(' ');
    if (label) parts.push({ type: 'input_text', text: `[Attached image unavailable inline: ${label}]` });
  });
  return parts;
}

function buildLocalRelayMessages(userText, session = {}) {
  const requestId = String(session.requestId || '');
  const workspaceRoot = String(session.workspaceRoot || '').trim();
  const user = String(userText || '');
  const agentMode = getSessionAgentMode(session);
  const recentEditedFile = getRecentEditedFilePath(session);
  const unfinishedContinuation = getUnfinishedAgentContinuation(session, user);
  const deepSeekGuidance = isDeepSeekModel(session.config)
    ? 'For this DeepSeek upstream, keep hidden reasoning brief. Start the answer or call the required tool quickly; do not loop in Thought/reasoning text.'
    : '';
  const conversationMemory = buildRelayConversationMemory(session, {
    maxChars: Number(session.config?.relayMemoryMaxChars) || DEFAULT_RELAY_MEMORY_MAX_CHARS,
    itemMaxChars: Number(session.config?.relayMemoryItemMaxChars) || DEFAULT_RELAY_MEMORY_ITEM_MAX_CHARS,
    recentEditedFile,
  });
  const imageParts = buildUpstreamImageParts(session);
  return buildLocalRelayMessagesForMode(agentMode, {
    userText: user,
    requestId,
    workspaceRoot,
    recentEditedFile,
    unfinishedContinuation,
    deepSeekGuidance,
    conversationMemory,
    imageParts,
  });
}

function normalizeWorkspacePath(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURIComponent(text.replace(/^file:\/\/\/?/i, '')).replace(/^\/([a-zA-Z]:)/, '$1');
    } catch {
      text = text.replace(/^file:\/\/\/?/i, '').replace(/^\/([a-zA-Z]:)/, '$1');
    }
  }
  text = text.replace(/\//g, path.sep).replace(/[\\/\s]+$/g, '');
  return text;
}

function normalizeWorkspaceRoot(value) {
  let text = normalizeWorkspacePath(value);
  const original = text;
  const windowsMatch = text.match(/[a-zA-Z]:\\[^\r\n"'<>|*?]*/);
  if (windowsMatch) text = windowsMatch[0].replace(/[\\/\s]+$/g, '');
  const absoluteInput = path.isAbsolute(text);
  let foundExisting = false;
  let climbed = false;
  while (text && !fs.existsSync(text)) {
    const parent = path.dirname(text);
    if (!parent || parent === text) break;
    climbed = true;
    text = parent;
  }
  foundExisting = Boolean(text && fs.existsSync(text));
  if (!foundExisting && absoluteInput && original) return original;
  if (climbed && absoluteInput && original && /^[a-zA-Z]:\\?$/.test(text)) return original;
  try {
    if (text && fs.existsSync(text) && fs.statSync(text).isFile()) {
      text = path.dirname(text);
    }
  } catch {
    return '';
  }
  return text;
}

function readRecentWorkspaceRoot() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RECENT_EXECUTION_WORKSPACE_PATH, 'utf8'));
    const root = normalizeWorkspaceRoot(parsed?.root || parsed?.workspaceRoot || '');
    return root && fs.existsSync(root) ? root : '';
  } catch {
    return '';
  }
}

function isInternalRelayWorkspaceRoot(root = '') {
  const normalized = normalizeWorkspacePath(root).replace(/\//g, '\\');
  if (!normalized) return false;
  return /\\\.(?:claude|codex)\\skills(?:\\|$)/i.test(normalized)
    || /\\\.cursorpool(?:\\|$)/i.test(normalized);
}

function selectWorkspaceRootForUserMessage(decodedWorkspaceRoot = '', logger = null, requestId = '-') {
  const decodedRoot = normalizeWorkspaceRoot(decodedWorkspaceRoot || '');
  const recentRoot = readRecentWorkspaceRoot();
  if (decodedRoot && isInternalRelayWorkspaceRoot(decodedRoot) && recentRoot && !isInternalRelayWorkspaceRoot(recentRoot)) {
    logger?.warn?.(
      `agent local relay ignored internal decoded workspace requestId=${requestId || '-'} decoded=${JSON.stringify(decodedRoot)} recent=${JSON.stringify(recentRoot)}`,
    );
    return recentRoot;
  }
  if (decodedRoot) return decodedRoot;
  return recentRoot;
}

function getSessionWorkspaceRoot(session = {}) {
  const direct = normalizeWorkspaceRoot(session.workspaceRoot || session.lastUserMessageCapture?.workspaceRoot || '');
  const recent = readRecentWorkspaceRoot();
  if (direct && isInternalRelayWorkspaceRoot(direct) && recent && !isInternalRelayWorkspaceRoot(recent)) return recent;
  if (direct) return direct;
  if (recent) return recent;
  return process.cwd();
}

function resolveWorkspacePath(inputPath, session = {}) {
  const raw = normalizeWorkspacePath(inputPath);
  const workspaceRoot = getSessionWorkspaceRoot(session);
  if (!raw) return workspaceRoot;
  if (path.isAbsolute(raw)) {
    const normalizedRoot = normalizeWorkspacePath(workspaceRoot || '');
    const rootBase = path.basename(normalizedRoot).toLowerCase();
    const relativeFromRoot = normalizedRoot ? path.relative(normalizedRoot, raw) : '';
    const parts = relativeFromRoot.split(/[\\/]+/).filter(Boolean);
    if (rootBase
      && parts[0]?.toLowerCase() === rootBase
      && !fs.existsSync(raw)) {
      return path.join(normalizedRoot, ...parts.slice(1));
    }
    return raw;
  }
  return path.resolve(workspaceRoot, stripWorkspaceRootPrefix(raw, workspaceRoot));
}

function getMaxLocalToolCallsPerRound(config = {}) {
  const value = Number(config.maxLocalToolCallsPerRound);
  if (!Number.isFinite(value)) return DEFAULT_MAX_LOCAL_TOOL_CALLS_PER_ROUND;
  return Math.max(1, Math.min(32, Math.floor(value)));
}

function getMaxLocalToolRounds(config = {}) {
  const value = Number(config.maxLocalToolRounds);
  if (!Number.isFinite(value)) return DEFAULT_MAX_LOCAL_TOOL_ROUNDS;
  return Math.max(0, Math.min(10000, Math.floor(value)));
}

function getMaxIncompleteContinuationCount(session = {}) {
  const config = session?.config || {};
  const incompleteTodos = getIncompleteTodos(session);
  if (incompleteTodos.length) {
    const value = Number(config.maxIncompleteTodoContinuations);
    if (Number.isFinite(value) && value > 0) return Math.max(8, Math.min(10000, Math.floor(value)));
    return DEFAULT_MAX_INCOMPLETE_TODO_CONTINUATIONS;
  }
  const value = Number(config.maxIncompletePostMutationContinuations);
  if (Number.isFinite(value) && value > 0) return Math.max(4, Math.min(128, Math.floor(value)));
  return DEFAULT_MAX_INCOMPLETE_POST_MUTATION_CONTINUATIONS;
}

function getMaxReadOnlyExplorationContinuationCount(session = {}) {
  const config = session?.config || {};
  const value = Number(config.maxReadOnlyExplorationContinuations);
  if (Number.isFinite(value) && value >= 0) return Math.max(0, Math.min(64, Math.floor(value)));
  return DEFAULT_MAX_READONLY_EXPLORATION_CONTINUATIONS;
}

function resolveWorkspacePathOrEmpty(inputPath, session = {}) {
  const raw = normalizeWorkspacePath(inputPath);
  if (!raw) return '';
  if (path.isAbsolute(raw)) {
    const workspaceRoot = getSessionWorkspaceRoot(session);
    const normalizedRoot = normalizeWorkspacePath(workspaceRoot || '');
    const rootBase = path.basename(normalizedRoot).toLowerCase();
    const relativeFromRoot = normalizedRoot ? path.relative(normalizedRoot, raw) : '';
    const parts = relativeFromRoot.split(/[\\/]+/).filter(Boolean);
    if (rootBase
      && parts[0]?.toLowerCase() === rootBase
      && !fs.existsSync(raw)) {
      return path.join(normalizedRoot, ...parts.slice(1));
    }
    return raw;
  }
  const workspaceRoot = getSessionWorkspaceRoot(session);
  return path.resolve(workspaceRoot, stripWorkspaceRootPrefix(raw, workspaceRoot));
}

function extractTargetPathFromUserText(userText = '', session = {}) {
  const text = String(userText || '');
  const workspaceRoot = getSessionWorkspaceRoot(session);
  const absoluteMatch = text.match(/[a-zA-Z]:\\[^\r\n"'<>|*?，。；;\s]+/);
  if (absoluteMatch) return resolveWorkspacePathOrEmpty(absoluteMatch[0], session);
  const mentionMatch = text.match(/@([^\s"'<>|*?，。；;]+?\.[A-Za-z0-9_+-]{1,12})\b/);
  if (mentionMatch) {
    const mentionedPath = stripWorkspaceRootPrefix(mentionMatch[1].replace(/\//g, path.sep), workspaceRoot);
    return path.resolve(workspaceRoot, mentionedPath);
  }
  return '';
}

function getRecentEditedFilePath(session = {}) {
  const items = Array.isArray(session?.agentHistory?.context?.items)
    ? session.agentHistory.context.items
    : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const toolName = String(item?.payload?.tool_name || '').trim().toLowerCase();
    if (!['write', 'edit', 'patchedit', 'strreplace', 'delete'].includes(toolName)) continue;
    let args = item?.payload?.arguments || {};
    if (typeof args === 'string') args = parseJsonObject(args);
    const filePath = resolveWorkspacePathOrEmpty(args.path || args.target_file || args.targetFile || '', session);
    if (filePath) return filePath;
  }
  const summaries = Array.isArray(session?.toolResultSummaries) ? session.toolResultSummaries : [];
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const entry = summaries[index];
    const toolName = String(entry?.tool || '').trim().toLowerCase();
    if (!entry?.ok || !['write', 'edit', 'patchedit', 'strreplace', 'delete'].includes(toolName)) continue;
    const filePath = resolveWorkspacePathOrEmpty(entry.path || '', session);
    if (filePath) return filePath;
  }
  return '';
}

function resolveExistingWorkspaceFile(inputPath = '', session = {}) {
  const filePath = resolveWorkspacePathOrEmpty(inputPath, session);
  if (!filePath) return '';
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
  } catch {
    /* ignore lookup failures */
  }
  return '';
}

function getRecentReadFilePath(session = {}) {
  const summaries = Array.isArray(session?.toolResultSummaries) ? session.toolResultSummaries : [];
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const entry = summaries[index];
    const toolName = String(entry?.tool || '').trim().toLowerCase();
    if (!entry?.ok || toolName !== 'read') continue;
    const filePath = resolveExistingWorkspaceFile(entry.path || '', session);
    if (filePath) return filePath;
  }
  return '';
}

function getReadOnlyContinuationTargetPath(session = {}) {
  const lastUserText = String(session?.lastUserMessageCapture?.userText || '').trim();
  const userTarget = lastUserText
    ? resolveExistingWorkspaceFile(extractTargetPathFromUserText(lastUserText, session), session)
    : '';
  if (userTarget) return userTarget;
  return getRecentReadFilePath(session);
}

function getRecentToolResultContext(session = {}, limit = 8) {
  const summaries = Array.isArray(session?.toolResultSummaries) ? session.toolResultSummaries : [];
  return summaries
    .slice(-Math.max(1, limit))
    .map((entry) => {
      const tool = String(entry?.tool || '').trim();
      const status = entry?.ok ? 'ok' : 'failed';
      const target = normalizeWorkspacePath(entry?.path || '');
      const result = String(entry?.resultText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      return [tool, status, target ? `path=${target}` : '', result ? `result=${result}` : '']
        .filter(Boolean)
        .join(' ');
    })
    .filter(Boolean);
}

function getUnfinishedAgentContinuation(session = {}, userText = '') {
  if (!String(userText || '').trim()) return null;
  const item = session?.lastUnfinishedAgentTask;
  if (!item || item.expiresAt < Date.now()) return null;
  return {
    ...item,
    currentUserText: String(userText || ''),
  };
}

function getMutationTargetPath(userText = '', session = {}) {
  return extractTargetPathFromUserText(userText, session) || getRecentEditedFilePath(session);
}

function stripWorkspaceRootPrefix(inputPath, workspaceRoot = '') {
  const raw = normalizeWorkspacePath(inputPath);
  if (!raw || path.isAbsolute(raw)) return raw;
  const rootBase = path.basename(normalizeWorkspacePath(workspaceRoot || '')).toLowerCase();
  const firstPart = raw.split(/[\\/]+/).filter(Boolean)[0]?.toLowerCase() || '';
  if (rootBase && firstPart === rootBase) {
    return raw.split(/[\\/]+/).filter(Boolean).slice(1).join(path.sep) || '';
  }
  return raw;
}

function hashRelayText(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function getSessionStableConversationId(session = {}) {
  return extractStableConversationId(session.lastUserMessageCapture?.debug || null)
    || String(session.lastUserMessageCapture?.stableConversationId || '').trim()
    || String(session.requestId || '').trim();
}

function findWaitingSessionByStableConversationId(agentSessions, stableConversationId = '', excludeRequestId = '') {
  const target = String(stableConversationId || '').trim();
  if (!target || !agentSessions?.size) return null;
  for (const session of agentSessions.values()) {
    if (!session || session.aborted || !session.waitingForInteraction) continue;
    if (excludeRequestId && String(session.requestId || '').trim() === String(excludeRequestId || '').trim()) continue;
    if (getSessionStableConversationId(session) === target) return session;
  }
  return null;
}

function getPendingInteractionEntriesForSession(session = {}) {
  const pendingAgentInteractions = session?.pendingAgentInteractions;
  if (!pendingAgentInteractions?.size) return [];
  const stableConversationId = getSessionStableConversationId(session);
  const requestId = String(session.requestId || '').trim();
  return Array.from(pendingAgentInteractions.values())
    .filter((entry) => {
      const entryStableConversationId = String(entry?.stableConversationId || '').trim();
      const entryRequestId = String(entry?.requestId || '').trim();
      if (stableConversationId && entryStableConversationId === stableConversationId) return true;
      return Boolean(requestId) && entryRequestId === requestId;
    })
    .sort((a, b) => String(a?.createdAt || '').localeCompare(String(b?.createdAt || '')));
}

function clearPendingInteractionEntriesForSession(session = {}) {
  const pendingAgentInteractions = session?.pendingAgentInteractions;
  if (!pendingAgentInteractions?.size) return 0;
  const entries = getPendingInteractionEntriesForSession(session);
  let cleared = 0;
  for (const entry of entries) {
    const key = String(entry?.key || '').trim();
    if (!key) continue;
    if (pendingAgentInteractions.delete(key)) cleared += 1;
  }
  return cleared;
}

function rebindSessionPendingInteractionRequestIds(session = {}, previousRequestId = '', nextRequestId = '') {
  const pendingAgentInteractions = session?.pendingAgentInteractions;
  const fromRequestId = String(previousRequestId || '').trim();
  const toRequestId = String(nextRequestId || '').trim();
  if (!pendingAgentInteractions?.size || !fromRequestId || !toRequestId || fromRequestId === toRequestId) return 0;
  let rebound = 0;
  for (const [key, entry] of pendingAgentInteractions.entries()) {
    if (!entry || String(entry.requestId || '').trim() !== fromRequestId) continue;
    const updated = {
      ...entry,
      requestId: toRequestId,
      key: `${toRequestId}:${Number(entry.queryId) || 0}:${String(entry.kind || '').trim()}`,
    };
    pendingAgentInteractions.delete(key);
    pendingAgentInteractions.set(updated.key, updated);
    rebound += 1;
  }
  return rebound;
}

function rebindWaitingSessionRequestId(session = {}, nextRequestId = '', logger = null) {
  const previousRequestId = String(session.requestId || '').trim();
  const normalizedNextRequestId = String(nextRequestId || '').trim();
  if (!session || !normalizedNextRequestId || previousRequestId === normalizedNextRequestId) return 0;
  if (previousRequestId) session.agentSessions?.delete(previousRequestId);
  session.requestId = normalizedNextRequestId;
  session.agentSessions?.set(normalizedNextRequestId, session);
  const rebound = rebindSessionPendingInteractionRequestIds(session, previousRequestId, normalizedNextRequestId);
  logger?.info?.(
    `agent local relay rebound waiting session requestId=${previousRequestId || '-'} -> ${normalizedNextRequestId} pendingInteractions=${rebound}`
  );
  return rebound;
}

function replayPendingInteractionQueries(session = {}, logger = null) {
  const pendingEntries = getPendingInteractionEntriesForSession(session);
  if (!pendingEntries.length) return 0;
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  let replayed = 0;
  for (const pendingInteraction of pendingEntries) {
    if (!pendingInteraction?.queryId || !pendingInteraction?.kind) continue;
    if (typeof handler.buildInteractionQuery !== 'function') continue;
    const replay = handler.buildInteractionQuery(
      session,
      {
        name: pendingInteraction.toolName,
        arguments: pendingInteraction.arguments || {},
      },
      pendingInteraction.toolCallId || '',
      Number(pendingInteraction.queryId) || 0,
      helpers,
    );
    if (!replay?.frame) continue;
    writeAgentFrame(session, replay.frame);
    replayed += 1;
    logger?.info?.(
      `agent local relay replayed interaction_query requestId=${session.requestId || '-'} queryId=${pendingInteraction.queryId} kind=${pendingInteraction.kind} tool=${pendingInteraction.toolName || '-'}`
    );
  }
  return replayed;
}

function isPlaceholderRunSseSession(session = {}) {
  return Boolean(
    session
    && session.active
    && !session.aborted
    && !session.completed
    && !session.relaying
    && !session.waitingForInteraction
    && !session.streamDetached
    && !session.agentHistory
    && !session.lastUserMessageCapture
  );
}

function adoptPlaceholderRunSseSession(waitingSession, placeholderSession, logger) {
  if (!waitingSession || !placeholderSession || waitingSession === placeholderSession) return null;
  clearInterval(placeholderSession.heartbeat);
  placeholderSession.heartbeat = null;
  waitingSession.req = placeholderSession.req;
  waitingSession.res = placeholderSession.res;
  waitingSession.rawBody = placeholderSession.rawBody;
  waitingSession.generatedChunks = Array.isArray(placeholderSession.generatedChunks)
    ? placeholderSession.generatedChunks.slice()
    : [];
  waitingSession.turnEnded = false;
  waitingSession.connectEnded = false;
  waitingSession.completed = false;
  waitingSession.intercepted = true;
  waitingSession.streamDetached = false;
  waitingSession.relaying = false;
  waitingSession.active = true;
  waitingSession.aborted = false;
  startAgentHeartbeat(waitingSession);

  placeholderSession.req = null;
  placeholderSession.res = null;
  placeholderSession.rawBody = null;
  placeholderSession.generatedChunks = [];
  placeholderSession.active = false;
  placeholderSession.completed = true;
  placeholderSession.intercepted = false;
  placeholderSession.waitingForInteraction = false;
  placeholderSession.relaying = false;
  if (placeholderSession.requestId) placeholderSession.agentSessions?.delete(placeholderSession.requestId);
  if (placeholderSession.requestId) {
    rebindWaitingSessionRequestId(waitingSession, placeholderSession.requestId, logger);
  }

  logger?.info?.(
    `agent local relay adopted placeholder RunSSE requestId=${placeholderSession.requestId || '-'} into waiting session requestId=${waitingSession.requestId || '-'}`
  );
  replayPendingInteractionQueries(waitingSession, logger);
  return waitingSession;
}

function getAgentTurnScopeKey(requestId, userText, workspaceRoot = '', debug = null) {
  const textHash = hashRelayText(userText);
  const normalizedWorkspace = normalizeWorkspaceRoot(workspaceRoot || '') || '';
  const turnId = String(requestId || '').trim();
  if (!turnId) return '';
  return `scope:${normalizedWorkspace}:${turnId}:${textHash}`;
}

function extractStableConversationId(debug = {}) {
  return String(
    debug?.stableConversationId
    || debug?.conversationId
    || debug?.agentClientMessage?.runRequest?.stableConversationId
    || '',
  ).trim();
}

function getAgentTurnWorkspaceTextKey(userText, workspaceRoot = '') {
  const textHash = hashRelayText(userText);
  const normalizedWorkspace = normalizeWorkspaceRoot(workspaceRoot || '') || '';
  return `workspace-text:${normalizedWorkspace}:${textHash}`;
}

function getUnfinishedAgentTaskKey(session = {}) {
  const workspaceRoot = normalizeWorkspaceRoot(getSessionWorkspaceRoot(session) || '') || '';
  const stableConversationId = extractStableConversationId(session.lastUserMessageCapture?.debug || null)
    || String(session.lastUserMessageCapture?.stableConversationId || '').trim()
    || String(session.requestId || '').trim();
  return stableConversationId || workspaceRoot
    ? `unfinished:${workspaceRoot}:${stableConversationId || 'workspace'}`
    : '';
}

function rememberUnfinishedAgentTask(session = {}, userText = '', latestAssistantText = '') {
  const key = getUnfinishedAgentTaskKey(session);
  if (!key) return;
  const now = Date.now();
  const item = {
    requestId: session.requestId || '',
    workspaceRoot: getSessionWorkspaceRoot(session),
    userText: String(userText || ''),
    latestAssistantText: String(latestAssistantText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    toolResults: getRecentToolResultContext(session, 10),
    createdAt: now,
    expiresAt: now + 30 * 60 * 1000,
  };
  session.lastUnfinishedAgentTask = item;
  session.completedAgentTurns?.set?.(key, item);
}

function clearUnfinishedAgentTask(session = {}) {
  const key = getUnfinishedAgentTaskKey(session);
  if (key) session.completedAgentTurns?.delete?.(key);
  session.lastUnfinishedAgentTask = null;
}

function loadUnfinishedAgentTask(session = {}) {
  const key = getUnfinishedAgentTaskKey(session);
  const item = key ? session.completedAgentTurns?.get?.(key) : null;
  if (!item) return null;
  if (item.expiresAt && item.expiresAt < Date.now()) {
    session.completedAgentTurns?.delete?.(key);
    return null;
  }
  session.lastUnfinishedAgentTask = item;
  return item;
}

function cloneAgentGeneratedChunks(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => Buffer.from(chunk || []))
    .filter((chunk) => chunk.length > 0 && chunk[0] !== 2);
}

function nextKvServerMessageId(session) {
  const id = Math.max(1, Number(session?.nextKvServerId) || 1);
  if (session) session.nextKvServerId = id + 1;
  return id;
}

function rememberCompletedAgentTurn(completedAgentTurns, requestId, userText, workspaceRoot = '', debug = null, generatedChunks = [], options = {}) {
  if (!completedAgentTurns || !requestId || !userText) return;
  const hadError = Boolean(options.hadError || options.upstreamError);
  if (hadError) return;
  const now = Date.now();
  const clonedChunks = cloneAgentGeneratedChunks(generatedChunks);
  if (!clonedChunks.length) return;
  const entry = {
    requestId,
    textHash: hashRelayText(userText),
    workspaceRoot,
    completedAt: now,
    expiresAt: now + 10 * 60 * 1000,
    generatedChunks: clonedChunks,
    hadError: false,
  };
  completedAgentTurns.set(`${requestId}:${entry.textHash}`, entry);
  const scopeKey = getAgentTurnScopeKey(requestId, userText, workspaceRoot, debug);
  if (scopeKey) completedAgentTurns.set(scopeKey, entry);
  for (const [key, entry] of completedAgentTurns.entries()) {
    if (!entry?.expiresAt || entry.expiresAt < now) completedAgentTurns.delete(key);
  }
}

function getCompletedAgentTurn(completedAgentTurns, requestId, userText, workspaceRoot = '', debug = null) {
  if (!completedAgentTurns || !requestId || !userText) return null;
  const textHash = hashRelayText(userText);
  const scopeKey = getAgentTurnScopeKey(requestId, userText, workspaceRoot, debug);
  const key = `${requestId}:${textHash}`;
  const entry = completedAgentTurns.get(key) || (scopeKey ? completedAgentTurns.get(scopeKey) : null);
  if (!entry) return null;
  if (entry.hadError) {
    completedAgentTurns.delete(key);
    if (scopeKey) completedAgentTurns.delete(scopeKey);
    return null;
  }
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    completedAgentTurns.delete(key);
    if (scopeKey) completedAgentTurns.delete(scopeKey);
    return null;
  }
  return entry;
}

function sendAgentRunSseBootstrap(session, logger) {
  if (session?.config?.emitAgentKvBootstrap !== true) {
    logger.info('agent local relay KV bootstrap skipped');
    return;
  }
  const blobs = [
    { role: 'system', content: '' },
    { role: 'user', content: '<user_info></user_info>' },
  ];
  const rootPromptMessagesJson = [];
  blobs.forEach((entry) => {
    const blobText = JSON.stringify(entry);
    const blobData = Buffer.from(blobText, 'utf8').toString('base64');
    const blobId = crypto.createHash('sha256').update(blobText, 'utf8').digest('base64');
    rootPromptMessagesJson.push(blobId);
    writeAgentFrame(session, buildAgentKvSetBlobFrame(blobId, blobData, { id: nextKvServerMessageId(session) }));
  });
  session.rootPromptMessagesJson = rootPromptMessagesJson;
  logger.info('agent local relay sent KV bootstrap frames');
}

function startAgentHeartbeat(session) {
  clearInterval(session.heartbeat);
  session.heartbeat = setInterval(() => {
    if (!session.active) {
      clearInterval(session.heartbeat);
      session.heartbeat = null;
      return;
    }
    try {
      writeAgentFrame(session, buildAgentHeartbeatFrame());
    } catch {
      session.active = false;
      clearInterval(session.heartbeat);
      session.heartbeat = null;
    }
  }, AGENT_HEARTBEAT_INTERVAL_MS);
}

function startInitialVisibleProgressTimer(session, logger, requestId = '') {
  const delayMs = INITIAL_VISIBLE_PROGRESS_MS;
  if (delayMs <= 0 || !session?.active) return null;
  return setTimeout(() => {
    if (!session?.active || session.aborted || session.turnEnded || session.sentTextDelta) return;
    const text = '上游模型正在处理请求，暂时还没有返回内容...\n\n';
    logger?.info?.(`agent local relay visible progress emitted requestId=${requestId || session.requestId || '-'} delayMs=${delayMs}`);
    writeAgentTextFrame(session, text, { tokenDelta: true });
  }, delayMs);
}

function clearTimer(timer) {
  if (!timer) return;
  try {
    clearTimeout(timer);
  } catch {
    /* ignore */
  }
}

function beginInterceptedAgentSession(session, logger) {
  if (!session?.active || session.intercepted) return;
  session.intercepted = true;
  try {
    if (typeof session.res?.socket?.setNoDelay === 'function') session.res.socket.setNoDelay(true);
    if (typeof session.res?.socket?.setKeepAlive === 'function') session.res.socket.setKeepAlive(true, 1000);
  } catch {
    /* ignore socket tuning failures */
  }
  session.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connect-Protocol-Version': '1',
    'X-Accel-Buffering': 'no',
  });
  if (typeof session.res.flushHeaders === 'function') session.res.flushHeaders();
  sendAgentRunSseBootstrap(session, logger);
  startAgentHeartbeat(session);
}

function completeSessionHistory(session, status = 'completed', modelCallId = '') {
  if (!session?.agentHistory || session.historyCompleted) return;
  session.historyCompleted = true;
  try {
    updateSessionHistoryState(session, {
      current_loop_status: status || 'completed',
      waiting_for_interaction: null,
    });
    completeAgentHistoryTurn(session.agentHistory, {
      status,
      modelCallId: modelCallId || `relay-${session.requestId || Date.now().toString(36)}`,
    });
    updateAgentHistoryUsage(session.config || {}, { turns_completed: status === 'completed' ? 1 : 0 });
  } catch (error) {
    session?.logger?.warn?.(`agent history complete failed requestId=${session?.requestId || '-'}: ${error.message}`);
  }
}

function abortAgentSession(session, logger, reason = 'aborted') {
  if (!session || session.aborted) return;
  if (session.waitingForInteraction && reason === 'runsse_closed') {
    detachWaitingInteractionSession(session, logger, reason);
    return;
  }
  if (!session.turnEnded && session.lastUserMessageCapture?.userText) {
    const latestAssistantText = String(session.agentTextFrameText || '').trim();
    rememberUnfinishedAgentTask(session, session.lastUserMessageCapture.userText, latestAssistantText || reason);
  }
  session.aborted = true;
  session.active = false;
  session.relaying = false;
  session.waitingForInteraction = false;
  session.waitingInteractionSince = 0;
  session.planTurnHandoff = '';
  session.modeTurnHandoff = '';
  session.streamDetached = false;
  session.deferredInteractionResponse = null;
  clearInterval(session.heartbeat);
  session.heartbeat = null;
  const clearedPendingInteractions = clearPendingInteractionEntriesForSession(session);
  try {
    session.abortController?.abort(new Error(reason));
  } catch {
    /* ignore */
  }
  if (session.requestId) session.agentSessions?.delete(session.requestId);
  if (session.agentHistory) {
    const status = session.hadError ? 'failed' : (session.turnEnded ? 'completed' : 'aborted');
    completeSessionHistory(session, status, `abort-${session.requestId || ''}`);
  }
  markUpstreamUsageCompleted(session, session.config, 'stop', reason);
  logger?.info?.(
    `agent local relay session aborted requestId=${session.requestId || '-'} reason=${reason} clearedPendingInteractions=${clearedPendingInteractions}`
  );
}

function finalizeInterceptedAgentSession(session) {
  if (!session || session.completed || session.aborted) return;
  session.completed = true;
  session.active = false;
  session.relaying = false;
  clearInterval(session.heartbeat);
  session.heartbeat = null;
  try {
    session.active = true;
    if (!session.turnEnded) {
      writeAgentFrame(session, buildAgentTurnEndedFrame());
      session.turnEnded = true;
    }
    if (!session.connectEnded) {
      writeAgentFrame(session, buildConnectEndFrame());
      session.connectEnded = true;
    }
    persistGeneratedAgentRunSseResponse(session, session.logger);
    session.active = false;
    session.res.end();
  } catch {
    /* ignore */
  }
  if (session.requestId) session.agentSessions?.delete(session.requestId);
  if (session.agentHistory && !session.historyCompleted) {
    completeSessionHistory(session, session.hadError ? 'failed' : 'completed', `finalize-${session.requestId || ''}`);
  }
}

function detachWaitingInteractionSession(session, logger, reason = 'runsse_closed') {
  if (!session || session.aborted || session.completed) return false;
  clearInterval(session.heartbeat);
  session.heartbeat = null;
  session.streamDetached = true;
  session.intercepted = false;
  session.relaying = false;
  session.req = null;
  session.res = null;
  logger?.info?.(`agent local relay waiting session detached requestId=${session.requestId || '-'} handoff=${session.planTurnHandoff || '-'} reason=${reason}`);
  return true;
}

function reattachWaitingInteractionSession(session, req, res, rawBody, logger) {
  if (!session) return null;
  session.req = req;
  session.res = res;
  session.rawBody = rawBody;
  session.generatedChunks = [];
  session.turnEnded = false;
  session.connectEnded = false;
  session.completed = false;
  session.intercepted = false;
  session.streamDetached = false;
  session.relaying = false;
  beginInterceptedAgentSession(session, logger);
  replayPendingInteractionQueries(session, logger);
  logger?.info?.(`agent local relay waiting session reattached requestId=${session.requestId || '-'} handoff=${session.planTurnHandoff || '-'} deferred=${session.deferredInteractionResponse?.interactionResponse ? '1' : '0'}`);
  return session;
}

function failAgentRelaySession(session, logger, error, label = 'async') {
  if (!session || !session.active) return;
  const message = error?.message || String(error || 'Unknown relay error');
  const requestId = session.requestId || '-';
  session.hadError = true;
  logger?.error?.(`agent local relay ${label} failed requestId=${requestId}: ${error?.stack || message}`);
  try {
    const userVisible = `Relay failed: ${message}`;
    appendSessionHistory(session, {
      role: 'assistant',
      kind: 'assistant_text',
      payload: { text: userVisible, error: true },
    });
    writeAgentTextFrame(session, userVisible);
    writeAgentFrame(session, buildAgentTurnEndedFrame());
    session.turnEnded = true;
    markUpstreamUsageCompleted(session, session.config, 'failed', message);
    completeSessionHistory(session, 'failed', `error-${session.requestId || ''}`);
  } catch (innerError) {
    logger?.error?.(`agent local relay failure finalization failed requestId=${requestId}: ${innerError?.stack || innerError?.message || String(innerError)}`);
  }
  finalizeInterceptedAgentSession(session);
}

function getMitmRequestMeta(req) {
  const pathname = String(req.url || req.headers?.[':path'] || '').split('?')[0];
  const method = String(req.method || req.headers?.[':method'] || 'GET').toUpperCase();
  const protocol = req.httpVersion === '2.0' ? 'h2' : 'h1';
  return { pathname, method, protocol };
}

function isRelayChatPath(pathname) {
  return pathname === CHAT_PATH
    || /\/aiserver\.v1\.ChatService\/StreamUnifiedChatWithTools$/i.test(pathname);
}

function isAgentRunSsePath(pathname) {
  return pathname === AGENT_RUN_SSE_PATH
    || /\/agent\.v1\.AgentService\/RunSSE$/i.test(pathname)
    || /\/aiserver\.v1\.AiService\/RunSSE$/i.test(pathname);
}

function isBidiAppendPath(pathname) {
  return pathname === BIDI_APPEND_PATH
    || /\/aiserver\.v1\.BidiService\/BidiAppend$/i.test(pathname);
}

function isRepositoryServicePath(pathname) {
  return /\/aiserver\.v1\.RepositoryService\//i.test(String(pathname || ''));
}

function localControlPlaneResponseSpec(pathname, config = {}) {
  const fallbackModelName = String(config.upstream?.modelName || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const availableModelNames = Array.isArray(config.upstream?.availableModels) && config.upstream.availableModels.length
    ? config.upstream.availableModels.map((item) => String(item || '').trim()).filter(Boolean)
    : [fallbackModelName];
  const modelName = availableModelNames[0] || fallbackModelName;
  const now = Date.now();
  const cycleEnd = now + (30 * 24 * 60 * 60 * 1000);
  const modelConfig = {
    defaultModel: modelName,
    fallbackModels: availableModelNames.length ? availableModelNames : [modelName],
    bestOfNDefaultModels: availableModelNames.length ? availableModelNames : [modelName],
  };
  const models = availableModelNames.map((name, index) => ({
    name,
    defaultOn: index === 0,
    supportsAgent: true,
    supportsThinking: true,
    supportsImages: true,
    supportsAutoContext: true,
    autoContextMaxTokens: 250000,
    autoContextExtendedMaxTokens: 250000,
    supportsMaxMode: true,
    supportsNonMaxMode: true,
    contextTokenLimit: Number(config.upstream?.contextWindow) || 250000,
    clientDisplayName: name,
    serverModelName: name,
    supportsPlanMode: true,
    supportsSandboxing: true,
    inputboxShortModelName: name,
    supportsCmdK: true,
  }));

  const suffix = String(pathname || '').replace(/^.*\/aiserver\.v1\./i, '');
  switch (suffix) {
    case 'AiService/AvailableModels':
      return {
        typeName: 'aiserver.v1.AvailableModelsResponse',
        value: {
          modelNames: availableModelNames,
          models,
          composerModelConfig: modelConfig,
          cmdKModelConfig: modelConfig,
          backgroundComposerModelConfig: modelConfig,
          planExecutionModelConfig: modelConfig,
          specModelConfig: modelConfig,
          deepSearchModelConfig: modelConfig,
          quickAgentModelConfig: modelConfig,
          useModelParameters: false,
        },
      };
    case 'AiService/GetDefaultModel':
      return {
        typeName: 'aiserver.v1.GetDefaultModelResponse',
        value: {
          model: modelName,
          thinkingModel: modelName,
          maxMode: false,
          nextDefaultSetDate: '',
        },
      };
    case 'AiService/GetDefaultModelNudgeData':
      return {
        typeName: 'aiserver.v1.GetDefaultModelNudgeDataResponse',
        value: {
          nudgeDate: '',
          shouldDefaultSwitchOnNewChat: false,
          modelsWithNoDefaultSwitch: availableModelNames,
        },
      };
    case 'DashboardService/GetCurrentPeriodUsage':
      return {
        typeName: 'aiserver.v1.GetCurrentPeriodUsageResponse',
        value: {
          billingCycleStart: now,
          billingCycleEnd: cycleEnd,
          planUsage: {
            totalSpend: 0,
            includedSpend: 100000000,
            bonusSpend: 0,
            remaining: 100000000,
            limit: 100000000,
            autoSpend: 0,
            apiSpend: 0,
            autoLimit: 100000000,
            apiLimit: 100000000,
            autoPercentUsed: 0,
            apiPercentUsed: 0,
            totalPercentUsed: 0,
          },
          spendLimitUsage: {
            totalSpend: 0,
            pooledLimit: 100000000,
            pooledUsed: 0,
            pooledRemaining: 100000000,
            individualLimit: 100000000,
            individualUsed: 0,
            individualRemaining: 100000000,
            limitType: 'local_relay',
          },
          displayThreshold: 100,
          enabled: true,
          displayMessage: 'Local Relay',
          namedModelSelectedDisplayMessage: 'Local Relay',
        },
      };
    case 'DashboardService/GetPlanInfo':
      return {
        typeName: 'aiserver.v1.GetPlanInfoResponse',
        value: {
          planInfo: {
            planName: 'Local Relay',
            includedAmountCents: 100000000,
            price: 'Local Relay',
            billingCycleEnd: cycleEnd,
          },
        },
      };
    case 'DashboardService/GetTeams':
      return { typeName: 'aiserver.v1.GetTeamsResponse', value: { teams: [] } };
    case 'DashboardService/GetUserPrivacyMode':
      return {
        typeName: 'aiserver.v1.GetUserPrivacyModeResponse',
        value: {
          privacyMode: 1,
          hoursRemainingInGracePeriod: 0,
          isEnforcedByTeam: false,
          isNotMigratedToServerSourceOfTruth: false,
          partnerDataShare: false,
          hasAcknowledgedGracePeriodDisclaimer: true,
        },
      };
    case 'ServerConfigService/GetServerConfig':
      return {
        typeName: 'aiserver.v1.GetServerConfigResponse',
        value: {
          configVersion: 'local-relay',
          isDevDoNotUseForSecretThingsBecauseCanBeSpoofedByUsers: false,
          useNlbForNal: false,
        },
      };
    case 'AnalyticsService/Batch':
      return { typeName: 'aiserver.v1.BatchResponse', value: {} };
    case 'AiService/ReportClientNumericMetrics':
      return { typeName: 'aiserver.v1.ReportClientNumericMetricsResponse', value: {} };
    case 'OnlineMetricsService/ReportAgentSnapshot':
      return { typeName: 'aiserver.v1.ReportAgentSnapshotResponse', value: {} };
    default:
      if (/DashboardService\/GetEffectiveUserPlugins$/i.test(suffix)) {
        return { typeName: '', value: {} };
      }
      return null;
  }
}

function resolveRequestedUpstreamModel(config = {}, options = {}) {
  const fallbackModel = String(config.upstream?.modelName || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const routeModels = getConfiguredModelRoutes(config).map((item) => String(item.modelName || '').trim()).filter(Boolean);
  const availableModels = routeModels.length
    ? routeModels
    : Array.isArray(config.upstream?.availableModels) && config.upstream.availableModels.length
      ? config.upstream.availableModels.map((item) => String(item || '').trim()).filter(Boolean)
    : [fallbackModel];
  const requested = String(options.requestedModel || '').trim();
  if (!requested) return fallbackModel;
  if (requested === 'default' || requested === 'auto') return fallbackModel;
  if (availableModels.includes(requested)) return requested;
  return fallbackModel;
}

async function handleLocalControlPlaneRequest(req, pathname, res, config, logger, stats) {
  const spec = localControlPlaneResponseSpec(pathname, config);
  if (!spec) return false;
  const rawBody = await readRequestBody(req);
  let body = Buffer.alloc(0);
  if (spec.typeName) {
    body = await encodeCursorProtoMessage(spec.typeName, spec.value);
  }
  stats.localControlPlaneResponses = (stats.localControlPlaneResponses || 0) + 1;
  logger.info(`local control-plane response path=${pathname} type=${spec.typeName || 'empty'} rawLen=${rawBody.length} bytes=${body.length}`);
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'application/proto',
      'Content-Length': String(body.length),
    });
  }
  res.end(body);
  return true;
}

function getSamplesDir(config) {
  const logPath = String(config?.logPath || path.join(process.cwd(), 'runner.log'));
  return path.join(path.dirname(logPath), 'samples');
}

function persistProtocolSample(config, label, rawBody, meta = {}) {
  try {
    if (!rawBody?.length) return '';
    const baseDir = getSamplesDir(config);
    fs.mkdirSync(baseDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'sample').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'sample';
    const requestId = String(meta.requestId || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 48) || 'unknown';
    const baseName = `${safeLabel}-${stamp}-${requestId}`;
    const binPath = path.join(baseDir, `${baseName}.bin`);
    const metaPath = path.join(baseDir, `${baseName}.json`);
    fs.writeFileSync(binPath, rawBody);
    fs.writeFileSync(metaPath, `${JSON.stringify({
      savedAt: new Date().toISOString(),
      label: safeLabel,
      size: rawBody.length,
      ...meta,
    }, null, 2)}\n`, 'utf8');
    return binPath;
  } catch {
    return '';
  }
}

function buildCaptureResponsePath(config, label, requestId = '') {
  try {
    const baseDir = getSamplesDir(config);
    fs.mkdirSync(baseDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'response').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'response';
    const safeRequestId = String(requestId || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 48) || 'unknown';
    return path.join(baseDir, `${safeLabel}-${stamp}-${safeRequestId}.response.bin`);
  } catch {
    return '';
  }
}

function sanitizeProxyHeaders(headers, hostHeader, { forHttp2 = false } = {}) {
  const next = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    if (!key || key.startsWith(':')) return;
    const lower = key.toLowerCase();
    if (lower === 'proxy-connection' || lower === 'proxy-authorization') return;
    if (!forHttp2 && lower === 'connection') return;
    next[key] = value;
  });
  if (!forHttp2 && hostHeader) {
    next.host = hostHeader;
  }
  return next;
}

function getMitmForwardTarget(req) {
  const isH2 = req.httpVersion === '2.0';
  const host = normalizeHost(req.headers.host || req.headers[':authority'] || '');
  const reqPath = String(isH2 ? (req.headers[':path'] || req.url) : req.url || '/');
  const method = String(isH2 ? (req.headers[':method'] || req.method) : req.method || 'GET').toUpperCase();
  return { isH2, host, path: reqPath, method };
}

function parseConnectTarget(raw) {
  const text = String(raw || '').trim();
  const ipv6Match = text.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6Match) {
    return { host: ipv6Match[1], port: Number(ipv6Match[2]) || 443 };
  }
  const idx = text.lastIndexOf(':');
  if (idx <= 0) return { host: text, port: 443 };
  return {
    host: text.slice(0, idx),
    port: Number(text.slice(idx + 1)) || 443,
  };
}

function normalizeHost(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split(':')[0];
}

const MITM_HOST_SUFFIXES = ['.cursor.sh', '.cursor.com', '.cursorapi.com'];

function shouldInterceptHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  if (host === 'cursor.sh' || host === 'cursor.com') return true;
  return MITM_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function writeConnectError(socket, message, statusCode = 502) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusCode === 403 ? 'Forbidden' : 'Bad Gateway'}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      message,
    );
  } catch {
    /* ignore */
  }
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
}

async function proxyHttpAbsoluteRequest(req, res, logger) {
  let target;
  try {
    target = new URL(req.url);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: error.message || String(error) }));
    return;
  }

  const transport = target.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method || 'GET',
    path: `${target.pathname}${target.search}`,
    headers: sanitizeProxyHeaders(req.headers, target.host),
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (error) => {
    logger.error(`absolute proxy failed ${target.href}: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ ok: false, message: error.message }));
  });

  req.pipe(upstreamReq);
}

function createResponseCaptureWriter(filePath, logger, label = 'native response') {
  if (!filePath) return null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.alloc(0));
    let bytes = 0;
    return {
      write(chunk) {
        try {
          const buffer = Buffer.from(chunk || []);
          if (!buffer.length) return;
          fs.appendFileSync(filePath, buffer);
          bytes += buffer.length;
        } catch (error) {
          logger?.error?.(`${label} capture append failed: ${error.message}`);
        }
      },
      end() {
        logger?.info?.(`${label} captured path=${filePath} bytes=${bytes}`);
      },
    };
  } catch (error) {
    logger?.error?.(`${label} capture init failed path=${filePath}: ${error.message}`);
    return null;
  }
}

function logAgentRunSseResponseSummary(filePath, requestId, logger) {
  if (!filePath) return;
  try {
    const responseBody = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
    const summary = summarizeAgentServerStream(responseBody, { maxSamples: 8 });
    logger?.info?.(
      `protocol RunSSE response requestId=${requestId || '-'} rawLen=${summary.rawLength} frames=${summary.frameCount} serverMessages=${JSON.stringify(summary.serverMessages)} interaction=${JSON.stringify(summary.interactionUpdates)} execTools=${JSON.stringify(summary.execServerTools)} connectErrors=${JSON.stringify(summary.connectErrors || []).slice(0, 500)} samples=${JSON.stringify(summary.samples).slice(0, 700)}`,
    );
  } catch (error) {
    logger?.error?.(`protocol RunSSE response summary failed requestId=${requestId || '-'}: ${error.message}`);
  }
}

function logGeneratedAgentRunSseSummary(chunks, requestId, logger) {
  try {
    const responseBody = Buffer.concat((Array.isArray(chunks) ? chunks : []).map((chunk) => Buffer.from(chunk || [])));
    const summary = summarizeAgentServerStream(responseBody, { maxSamples: 8 });
    logger?.info?.(
      `protocol RunSSE generated requestId=${requestId || '-'} rawLen=${summary.rawLength} frames=${summary.frameCount} serverMessages=${JSON.stringify(summary.serverMessages)} interaction=${JSON.stringify(summary.interactionUpdates)} execTools=${JSON.stringify(summary.execServerTools)} connectErrors=${JSON.stringify(summary.connectErrors || []).slice(0, 500)} samples=${JSON.stringify(summary.samples).slice(0, 700)}`,
    );
  } catch (error) {
    logger?.error?.(`protocol RunSSE generated summary failed requestId=${requestId || '-'}: ${error.message}`);
  }
}

function persistGeneratedAgentRunSseResponse(session, logger) {
  if (!session) return '';
  try {
    const responseBody = Buffer.concat((Array.isArray(session.generatedChunks) ? session.generatedChunks : []).map((chunk) => Buffer.from(chunk || [])));
    const filePath = buildCaptureResponsePath(session.config || {}, 'runsse-local-response', session.requestId);
    if (!filePath) return '';
    fs.writeFileSync(filePath, responseBody);
    logger?.info?.(`local RunSSE response saved path=${filePath} bytes=${responseBody.length}`);
    return filePath;
  } catch (error) {
    logger?.error?.(`local RunSSE response save failed requestId=${session?.requestId || '-'}: ${error.message}`);
    return '';
  }
}

function writeAgentFrame(session, frame) {
  const buffer = Buffer.from(frame || []);
  if (!buffer.length || !session?.active) return;
  session.generatedChunks = session.generatedChunks || [];
  session.generatedChunks.push(buffer);
  try {
    session.res.write(buffer);
    if (typeof session.res.flush === 'function') session.res.flush();
  } catch (error) {
    abortAgentSession(session, session.logger, `write_failed:${error.message}`);
  }
}

function flushAgentTextToHistory(session) {
  if (!session?.agentHistory) return;
  const full = String(session.agentTextFrameText || '');
  const cursor = Number(session.historyTextCursor) || 0;
  const delta = full.slice(cursor).trim();
  if (!delta) return;
  session.historyTextCursor = full.length;
  appendSessionHistory(session, {
    role: 'assistant',
    kind: 'assistant_text',
    payload: { text: delta },
  });
}

function shouldSuppressVisiblePlanText(session = {}, options = {}) {
  if (getSessionAgentMode(session) !== 'AGENT_MODE_PLAN') return false;
  const phase = String(options.phase || '').trim();
  return phase !== 'post_mutation_summary';
}

function stashSuppressedPlanText(session = {}, text = '') {
  const value = String(text || '');
  if (!value) return;
  session.suppressedPlanText = `${session.suppressedPlanText || ''}${value}`;
}

function clearSuppressedPlanText(session = {}) {
  session.suppressedPlanText = '';
}

function getPlanCheckpointText(session = {}, execution = null) {
  const markdown = String(execution?.markdown || '').trim();
  if (markdown) return markdown;
  return String(session?.suppressedPlanText || '').trim();
}

function getPlanCheckpointTodos(session = {}, execution = null) {
  const todos = Array.isArray(execution?.args?.todos)
    ? execution.args.todos
    : Array.isArray(session?.todos)
      ? session.todos
      : [];
  return todos;
}

function emitPlanConversationCheckpointFrames(session, toolCall, execution, logger) {
  if (!session?.active || !execution?.ok) return;
  const planText = String(execution?.markdown || execution?.resultText || session?.suppressedPlanText || '').trim();
  const planTodos = getPlanCheckpointTodos(session, execution);
  if (!planText) return;
  const workspaceRoot = getSessionWorkspaceRoot(session);
  const readPaths = Array.from(new Set((Array.isArray(session.readPaths) ? session.readPaths : []).filter(Boolean)));
  try {
    writeAgentFrame(session, buildAgentConversationCheckpointFrame({
      workspaceRoot,
      rootPromptMessagesJson: session.rootPromptMessagesJson,
      readPaths,
      pendingToolCalls: [buildToolCallCheckpointJson(toolCall, execution, 'pending')],
      plan: planText,
      todos: planTodos,
    }));
    writeAgentFrame(session, buildAgentConversationCheckpointFrame({
      workspaceRoot,
      rootPromptMessagesJson: session.rootPromptMessagesJson,
      readPaths,
      pendingToolCalls: [],
      plan: planText,
      todos: planTodos,
    }));
    logger?.info?.(`agent local relay plan checkpoint emitted requestId=${session.requestId || '-'} planChars=${planText.length} planPath=${JSON.stringify(execution?.planPath || '')}`);
  } catch (error) {
    logger?.error?.(`agent local relay plan checkpoint emit failed requestId=${session?.requestId || '-'}: ${error.message}`);
  }
}

function buildPlanStateFromExecution(session = {}, execution = {}) {
  const planText = String(execution?.markdown || execution?.resultText || session?.suppressedPlanText || '').trim();
  const planUri = String(execution?.planPath || '').trim();
  const todos = getPlanCheckpointTodos(session, execution);
  return planText || planUri
    ? {
      plan: planText || planUri,
      plan_text: planText || '',
      plan_uri: planUri,
      todos,
    }
    : null;
}

function writeAgentTextFrame(session, text, { tokenDelta = true, recordHistory = false } = {}) {
  const value = String(text || '');
  if (!value || !session?.active) return;
  writeAgentFrame(session, buildAgentTextDeltaFrame(value));
  session.sentTextDelta = true;
  session.lastAgentTextFrame = value;
  session.agentTextFrameText = `${session.agentTextFrameText || ''}${value}`;
  if (tokenDelta) writeAgentFrame(session, buildAgentTokenDeltaFrame(1));
  if (recordHistory) flushAgentTextToHistory(session);
}

function emitUpstreamToolStartedFrame(session, payload) {
  if (!session?.active || !payload || payload.type !== 'response.output_item.added') return;
  const item = payload.item || {};
  if (item.type !== 'function_call') return;
  const toolName = String(item.name || '').trim();
  if (!toolName) return;
  const toolCallId = String(item.call_id || item.id || `tool_${Date.now().toString(36)}`);
  session.upstreamToolStarted = session.upstreamToolStarted || new Set();
  if (session.upstreamToolStarted.has(toolCallId)) return;
  session.upstreamToolStarted.add(toolCallId);
  session.upstreamToolItemIds = session.upstreamToolItemIds || new Map();
  if (item.id) session.upstreamToolItemIds.set(String(item.id), toolCallId);
  if (item.call_id) session.upstreamToolItemIds.set(String(item.call_id), toolCallId);
  session.upstreamToolNames = session.upstreamToolNames || new Map();
  session.upstreamToolNames.set(toolCallId, toolName);
  if (item.id) session.upstreamToolNames.set(String(item.id), toolName);
  if (item.call_id) session.upstreamToolNames.set(String(item.call_id), toolName);
  const modelCallId = `model_${toolCallId}`;
  const args = parseJsonObject(item.arguments || '{}');
  const leanArgs = isEditLikeToolName(toolName) ? buildLeanEditToolArguments(args) : args;
  if (!hasRequiredToolArguments({ name: toolName, arguments: leanArgs })) return;
  writeAgentFrame(session, buildAgentPartialToolCallFrame(toolName, leanArgs, toolCallId, modelCallId));
  if (!isEditLikeToolName(toolName)) {
    writeAgentFrame(session, buildAgentToolCallStartedFrame(toolName, leanArgs, toolCallId, modelCallId));
  }
}

function emitUpstreamToolArgumentProgress(session, payload, userText = '') {
  if (!session?.active || !payload) return;
  const chatCalls = payload.choices?.[0]?.delta?.tool_calls;
  if (Array.isArray(chatCalls) && chatCalls.length) {
    chatCalls.forEach((call, index) => {
      const indexKey = String(call.index ?? index);
      const toolCallId = String(call.id || session.upstreamToolItemIds?.get(indexKey) || `chat_tool_${indexKey}`);
      const toolName = String(call.function?.name || '').trim();
      session.upstreamToolItemIds = session.upstreamToolItemIds || new Map();
      session.upstreamToolItemIds.set(indexKey, toolCallId);
      session.upstreamToolItemIds.set(toolCallId, toolCallId);
      session.upstreamToolNames = session.upstreamToolNames || new Map();
      if (toolName) {
        session.upstreamToolNames.set(indexKey, toolName);
        session.upstreamToolNames.set(toolCallId, toolName);
      }
      const delta = String(call.function?.arguments || '');
      if (!delta) return;
      emitUpstreamToolArgumentProgress(session, {
        type: 'response.function_call_arguments.delta',
        item_id: indexKey,
        call_id: toolCallId,
        delta,
      }, userText);
    });
    return;
  }
  if (!String(payload.type || '').startsWith('response.function_call_arguments.')) return;
  const rawKey = String(payload.item_id || payload.call_id || '');
  const key = session.upstreamToolItemIds?.get(rawKey) || String(payload.call_id || rawKey || '');
  if (!key) return;
  session.upstreamToolArgumentStreams = session.upstreamToolArgumentStreams || new Map();
  const existing = session.upstreamToolArgumentStreams.get(key) || {
    id: String(payload.call_id || key),
    name: session.upstreamToolNames?.get(key) || session.upstreamToolNames?.get(rawKey) || '',
    argumentsText: '',
    emittedContentLength: 0,
    emittedPath: '',
    completedStarted: false,
    pendingContentDelta: '',
    lastContentFlushAt: 0,
  };
  existing.id = String(payload.call_id || existing.id || key);
  if (!existing.name) {
    existing.name = session.upstreamToolNames?.get(key) || session.upstreamToolNames?.get(rawKey) || '';
  }
  if (payload.type === 'response.function_call_arguments.delta') {
    existing.argumentsText += String(payload.delta || '');
  } else if (payload.type === 'response.function_call_arguments.done' && payload.arguments) {
    existing.argumentsText = String(payload.arguments || existing.argumentsText || '');
  }
  const collected = session.currentUpstreamToolState?.toolCalls?.get(key)
    || session.currentUpstreamToolState?.toolCalls?.get(rawKey);
  if (collected?.name) existing.name = String(collected.name || existing.name || '');
  if (!isEditLikeToolName(existing.name)) {
    session.upstreamToolArgumentStreams.set(key, existing);
    return;
  }
  const toolCallId = existing.id;
  const modelCallId = `model_${toolCallId}`;
  const closedPathFromArgs = getClosedStreamingPathFromArgumentsText(existing.argumentsText);
  const mentionedTargetPath = extractTargetPathFromUserText(userText, session);
  const targetPath = closedPathFromArgs
    ? resolveWorkspacePathOrEmpty(closedPathFromArgs, session)
    : mentionedTargetPath;
  if (targetPath && targetPath !== existing.emittedPath) {
    existing.emittedPath = targetPath;
    const leanArgs = { path: targetPath };
    writeAgentFrame(session, buildAgentPartialToolCallFrame(existing.name, leanArgs, toolCallId, modelCallId));
    if (!existing.completedStarted) {
      writeAgentFrame(session, buildAgentToolCallStartedFrame(existing.name, leanArgs, toolCallId, modelCallId));
      existing.completedStarted = true;
    }
  }
  const content = getStreamingEditContentFromArgumentsText(existing.argumentsText);
  if (content.length > existing.emittedContentLength) {
    const delta = content.slice(existing.emittedContentLength);
    existing.emittedContentLength = content.length;
    existing.pendingContentDelta = `${existing.pendingContentDelta || ''}${delta}`;
  }
  const pendingContentDelta = String(existing.pendingContentDelta || '');
  const shouldFlushContent = pendingContentDelta
    && (
      pendingContentDelta.length >= EDIT_STREAM_FLUSH_CHARS
      || !existing.lastContentFlushAt
      || Date.now() - Number(existing.lastContentFlushAt) >= EDIT_STREAM_FLUSH_MS
      || payload.type === 'response.function_call_arguments.done'
      || looksLikeCompleteJsonObject(existing.argumentsText)
    );
  if (shouldFlushContent) {
    const chunkSize = EDIT_STREAM_FRAME_CHARS;
    for (let offset = 0; offset < pendingContentDelta.length; offset += chunkSize) {
      writeAgentFrame(session, buildAgentEditToolCallDeltaFrame(pendingContentDelta.slice(offset, offset + chunkSize), toolCallId, modelCallId));
    }
    existing.pendingContentDelta = '';
    existing.lastContentFlushAt = Date.now();
  }
  if (!existing.completedStarted && looksLikeCompleteJsonObject(existing.argumentsText)) {
    const args = parseJsonObject(existing.argumentsText);
    const leanArgs = buildLeanEditToolArguments(args);
    if (targetPath && !leanArgs.path) leanArgs.path = targetPath;
    writeAgentFrame(session, buildAgentToolCallStartedFrame(existing.name, leanArgs, toolCallId, modelCallId));
    existing.completedStarted = true;
  }
  session.upstreamToolArgumentStreams.set(key, existing);
}

function completeDuplicateAgentSession(session, logger, reason = 'duplicate_user_message', completedTurn = null) {
  if (!session || !session.active || session.completed || session.aborted) return;
  if (completedTurn?.hadError) {
    writeAgentFrame(session, buildAgentTurnEndedFrame());
    session.turnEnded = true;
    logger?.info?.(`agent local relay duplicate skipped errored cache requestId=${session.requestId || '-'} reason=${reason}`);
    logGeneratedAgentRunSseSummary(session.generatedChunks || [], session.requestId, logger);
    finalizeInterceptedAgentSession(session);
    return;
  }
  writeAgentFrame(session, buildAgentTurnEndedFrame());
  session.turnEnded = true;
  logger?.info?.(`agent local relay duplicate ended without replay requestId=${session.requestId || '-'} previousRequestId=${completedTurn?.requestId || '-'} reason=${reason}`);
  logger?.info?.(`agent local relay duplicate session ended requestId=${session.requestId || '-'} reason=${reason}`);
  logGeneratedAgentRunSseSummary(session.generatedChunks || [], session.requestId, logger);
  finalizeInterceptedAgentSession(session);
}

function buildToolCallCheckpointJson(toolCall, execution, state = 'pending') {
  return JSON.stringify({
    id: String(toolCall?.id || ''),
    role: 'assistant',
    tool: String(toolCall?.name || execution?.tool || ''),
    arguments: toolCall?.arguments || execution?.args || {},
    state,
    providerOptions: {
      cursor: {
        pendingToolCallStartedAtMs: Date.now(),
      },
    },
  });
}

function buildLeanEditToolArguments(args = {}) {
  return {
    path: args.path || args.target_file || args.targetFile || '',
  };
}

function getHistory(session = {}) {
  return session.agentHistory || null;
}

function appendSessionHistory(session, item) {
  try {
    appendAgentHistoryItem(getHistory(session), {
      request_id: session?.requestId || '',
      ...item,
    });
  } catch (error) {
    session?.logger?.warn?.(`agent history append failed requestId=${session?.requestId || '-'}: ${error.message}`);
  }
}

function updateSessionHistoryState(session, patch = {}) {
  try {
    updateAgentHistoryConversationState(getHistory(session), patch);
  } catch (error) {
    session?.logger?.warn?.(`agent history state update failed requestId=${session?.requestId || '-'}: ${error.message}`);
  }
}

function appendInteractionQueryToHistory(session = {}, pendingInteraction = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  const item = typeof handler.buildInteractionQueryHistoryItem === 'function'
    ? handler.buildInteractionQueryHistoryItem(pendingInteraction, helpers)
    : null;
  if (!item) return;
  appendSessionHistory(session, item);
}

function appendLatestEditReminder(session, filePath) {
  if (!filePath) return;
  appendSessionHistory(session, {
    role: 'system',
    kind: 'prompt_context',
    payload: {
      source: 'latest_edit_reminder',
      role: 'user',
      content: [
        '<system_reminder>',
        `You recently successfully edited "${filePath}".`,
        '',
        'For this file, the latest source of truth is the most recent successful `success.diff_string`, not earlier reads or memory.',
        '',
        'When modifying this file:',
        '- use PatchEdit with path, old_string, new_string, and optional replace_all',
        '- copy old_string exactly from the latest file content',
        '- replace_all defaults to false',
        '- new_string may be empty to delete old_string',
        '</system_reminder>',
      ].join('\n'),
    },
  });
}

function canonicalToolName(name) {
  const lower = String(name || '').trim().toLowerCase();
  if (lower === 'patchedit' || lower === 'strreplace') return 'PatchEdit';
  if (lower === 'readlints' || lower === 'diagnostics') return 'ReadLints';
  if (isTodoToolName(lower)) return 'TodoWrite';
  if (lower === 'websearch' || lower === 'web_search') return 'WebSearch';
  if (lower === 'webfetch' || lower === 'web_fetch' || lower === 'fetch') return 'WebFetch';
  if (lower === 'write' || lower === 'edit') return 'PatchEdit';
  return String(name || '').trim();
}

function isEditLikeToolName(name) {
  return ['write', 'edit', 'strreplace', 'patchedit'].includes(String(name || '').trim().toLowerCase());
}

function buildLeanEditToolCompletionExecution(execution = {}) {
  const beforeContent = typeof execution.beforeContent === 'string' ? execution.beforeContent : '';
  const afterContent = typeof execution.afterContent === 'string' ? execution.afterContent : '';
  const canInlineFullContents =
    beforeContent.length + afterContent.length <= MAX_INLINE_EDIT_RESULT_CONTENT_CHARS;
  return {
    ...execution,
    beforeContent: canInlineFullContents ? beforeContent : '',
    afterContent: canInlineFullContents ? afterContent : '',
    diffString: execution.diffString || '',
    message: execution.message || execution.summary || execution.resultText || 'Edit completed.',
  };
}

function createCheckpointBlob(content) {
  const text = String(content || '');
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  return {
    id: digest,
    idBase64: digest.toString('base64'),
    dataBase64: Buffer.from(text, 'utf8').toString('base64'),
  };
}

function emitAgentMutationCheckpointFrames(session, toolCall, execution, logger) {
  if (session?.config?.emitLocalMutationCheckpoints !== true) return;
  if (session?.config?.disableLocalMutationCheckpoints === true) return;
  if (!session?.active || !execution?.ok) return;
  const filePath = normalizeWorkspacePath(execution.args?.path || '');
  if (!filePath) return;
  const beforeContent = typeof execution.beforeContent === 'string' ? execution.beforeContent : '';
  const afterContent = typeof execution.afterContent === 'string' ? execution.afterContent : '';
  if (!beforeContent && !afterContent) return;
  const beforeBlob = createCheckpointBlob(beforeContent);
  const afterBlob = createCheckpointBlob(afterContent);
  const workspaceRoot = getSessionWorkspaceRoot(session);
  const fileStates = {
    [filePath]: {
      initialContent: beforeBlob.id,
      content: afterBlob.id,
    },
  };
  const readPaths = Array.from(new Set([
    ...(Array.isArray(session.readPaths) ? session.readPaths : []),
    filePath,
  ].filter(Boolean)));
  session.readPaths = readPaths;
  try {
    writeAgentFrame(session, buildAgentKvSetBlobFrame(beforeBlob.idBase64, beforeBlob.dataBase64, { id: nextKvServerMessageId(session) }));
    if (afterBlob.idBase64 !== beforeBlob.idBase64) {
      writeAgentFrame(session, buildAgentKvSetBlobFrame(afterBlob.idBase64, afterBlob.dataBase64, { id: nextKvServerMessageId(session) }));
    }
    writeAgentFrame(session, buildAgentConversationCheckpointFrame({
      workspaceRoot,
      rootPromptMessagesJson: session.rootPromptMessagesJson,
      readPaths,
      fileStates,
      pendingToolCalls: [buildToolCallCheckpointJson(toolCall, execution, 'pending')],
    }));
    writeAgentFrame(session, buildAgentConversationCheckpointFrame({
      workspaceRoot,
      rootPromptMessagesJson: session.rootPromptMessagesJson,
      readPaths,
      fileStates,
      pendingToolCalls: [],
    }));
    logger?.info?.(`agent local relay checkpoint emitted file=${JSON.stringify(filePath)} readPaths=${readPaths.length} contentBlob=${afterBlob.idBase64}`);
  } catch (error) {
    logger?.error?.(`agent local relay checkpoint emit failed: ${error.message}`);
  }
}

function resolveExecIdFromNumeric(session, numericId) {
  const id = Number(numericId) || 0;
  if (!id || !session?.execIdByNumericId) return '';
  return String(session.execIdByNumericId.get(id) || '').trim();
}

function notifyExecClientWaiters(session, message) {
  if (!session?.execClientWaiters) return;
  const execId = String(message?.execId || resolveExecIdFromNumeric(session, message?.id) || '').trim();
  if (!execId) return;
  const waiter = session.execClientWaiters.get(execId);
  if (!waiter) return;
  message.execId = execId;
  waiter.messages.push(message);
  const control = String(message.control || '').trim();
  const isTerminalControl = !control || control === 'stream_close' || control === 'throw';
  const result = String(message.result || '').trim();
  const hasCompleteResult = message.kind === 'exec_client'
    && result
    && result !== 'shell_stream'
    && (message.resultSummary || message.text || result.endsWith('_result'));
  if (hasCompleteResult) {
    clearTimeout(waiter.timer);
    session.execClientWaiters.delete(execId);
    waiter.resolve({
      ok: true,
      execId,
      messages: waiter.messages,
      durationMs: Date.now() - waiter.startedAt,
    });
    return;
  }
  if (message.kind === 'exec_control' && isTerminalControl) {
    clearTimeout(waiter.timer);
    session.execClientWaiters.delete(execId);
    waiter.resolve({
      ok: true,
      execId,
      messages: waiter.messages,
      durationMs: Date.now() - waiter.startedAt,
    });
  }
}

function waitForExecClientResult(session, execId, timeoutMs = EXEC_CLIENT_WAIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!session?.active || !execId) {
      resolve({ ok: false, execId, timedOut: false, messages: [] });
      return;
    }
    session.execClientWaiters = session.execClientWaiters || new Map();
    const messages = [];
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      session.execClientWaiters?.delete(execId);
      resolve({
        ok: false,
        execId,
        timedOut: true,
        messages,
        durationMs: Date.now() - startedAt,
      });
    }, Math.max(500, Number(timeoutMs) || EXEC_CLIENT_WAIT_TIMEOUT_MS));
    session.execClientWaiters.set(execId, {
      resolve,
      timer,
      messages,
      startedAt,
    });
  });
}

function isMutationToolName(toolName) {
  return ['write', 'edit', 'strreplace', 'patchedit', 'delete'].includes(String(toolName || '').trim().toLowerCase());
}

function canUseNativePatchEditForTool(toolCall, session) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  if (lower !== 'patchedit' && lower !== 'strreplace') return false;
  const args = toolCall?.arguments || {};
  const filePath = resolveWorkspacePathOrEmpty(args.path || args.target_file || args.targetFile || '', session);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const hasOldString = args.old_string != null || args.oldStr != null;
  const hasNewString = args.new_string != null || args.newStr != null;
  if (!hasOldString || !hasNewString) return false;
  const oldString = String(args.old_string ?? args.oldStr ?? '');
  if (!oldString) return false;
  try {
    return fs.readFileSync(filePath, 'utf8').includes(oldString);
  } catch {
    return false;
  }
}

function shouldUseNativeExecForTool(session, toolCall) {
  return shouldUseNativeExecForModeTool(session, toolCall, { canUseNativePatchEditForTool });
}

function normalizeToolCallPathsForWorkspace(toolCall, session) {
  const args = { ...(toolCall?.arguments || {}) };
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  if (['read', 'write', 'edit', 'strreplace', 'patchedit', 'delete'].includes(lower)) {
    const originalPath = args.path || args.target_file || args.targetFile || '';
    const resolvedPath = resolveWorkspacePathOrEmpty(originalPath, session);
    args.path = resolvedPath;
    if (args.target_file) args.target_file = resolvedPath;
    if (args.targetFile) args.targetFile = resolvedPath;
  } else if (lower === 'ls') {
    const originalPath = args.path || args.target_directory || args.targetDirectory || '';
    const resolvedPath = resolveWorkspacePath(originalPath, session);
    args.path = resolvedPath;
    if (args.target_directory) args.target_directory = resolvedPath;
    if (args.targetDirectory) args.targetDirectory = resolvedPath;
  } else if (lower === 'grep') {
    args.path = resolveWorkspacePath(args.path || '.', session);
  } else if (lower === 'shell') {
    const cwd = args.working_directory || args.cwd || '';
    const resolvedCwd = resolveWorkspacePath(cwd, session);
    args.cwd = resolvedCwd;
    args.working_directory = resolvedCwd;
  } else if (lower === 'readlints' || lower === 'diagnostics') {
    const paths = Array.isArray(args.paths) ? args.paths : [args.path].filter(Boolean);
    args.paths = paths.map((item) => resolveWorkspacePathOrEmpty(item, session)).filter(Boolean);
  }
  return { ...toolCall, arguments: args };
}

function getToolCallSignature(toolCall, session) {
  const normalized = normalizeToolCallPathsForWorkspace(toolCall, session);
  const name = canonicalToolName(normalized.name).toLowerCase();
  const args = normalized.arguments || {};
  if (name === 'read') return `read:${normalizeWorkspacePath(args.path || '')}:${Number(args.offset) || 0}:${Number(args.limit) || 0}`;
  if (name === 'grep') return `grep:${normalizeWorkspacePath(args.path || '')}:${String(args.pattern || '')}:${String(args.glob || '')}:${String(args.output_mode || args.outputMode || '')}`;
  if (name === 'ls') return `ls:${normalizeWorkspacePath(args.path || '')}`;
  if (name === 'shell') return `shell:${normalizeWorkspacePath(args.cwd || args.working_directory || '')}:${String(args.command || '')}`;
  if (name === 'readlints') return `readlints:${(Array.isArray(args.paths) ? args.paths : [args.path].filter(Boolean)).map(normalizeWorkspacePath).join('|')}`;
  if (name === 'todowrite') return '';
  return `${name}:${JSON.stringify(args)}`;
}

function buildExecutionFromExecClient(toolCall, clientResult, session) {
  const messages = Array.isArray(clientResult?.messages) ? clientResult.messages : [];
  const output = messages
    .map((message) => String(message?.resultSummary?.text || message?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return {
    ok: clientResult?.ok === true,
    tool: toolCall.name,
    args: {
      ...(toolCall.arguments || {}),
      workspaceRoot: getSessionWorkspaceRoot(session),
      nativeExec: true,
      execClientMessages: messages.length,
    },
    resultText: trimToolOutput(output),
    durationMs: Number(clientResult?.durationMs) || 0,
    nativeExec: true,
  };
}

function isSearchLikeToolName(toolName = '') {
  return ['grep', 'glob', 'ls'].includes(String(toolName || '').trim().toLowerCase());
}

function summarizeVisibleToolResult(toolCall, execution = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  const output = String(execution.resultText || '').trim();
  if (!output) return '';
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (isSearchLikeToolName(lower)) {
    const label = lower === 'grep'
      ? 'Search results'
      : lower === 'glob'
        ? 'Matched files'
        : 'Listed files';
    const preview = lines.slice(0, 12).join('\n');
    const suffix = lines.length > 12 ? `\n...and ${lines.length - 12} more` : '';
    return `\n\n${label}:\n${preview}${suffix}\n`;
  }
  if (lower === 'shell') {
    const preview = lines.slice(0, 20).join('\n');
    const suffix = lines.length > 20 ? `\n...and ${lines.length - 20} more` : '';
    return `\n\nShell output:\n${preview}${suffix}\n`;
  }
  if (lower === 'shell' && execution.terminalLogPath) {
    return `\n\nStarted background command. Terminal log: ${execution.terminalLogPath}\n`;
  }
  return '';
}

function emitVisibleToolResultSummary(session, toolCall, execution) {
  if (!session?.active || session.aborted || session?.config?.emitVisibleToolResultSummaries !== true) return;
  const summary = summarizeVisibleToolResult(toolCall, execution);
  if (!summary) return;
  writeAgentTextFrame(session, summary, { tokenDelta: false });
}

async function buildUpstreamContextExecution(toolCall, session, logger) {
  if (!isLocalContextToolName(toolCall?.name)) return null;
  try {
    const execution = await executeRelayTool(toolCall, session, logger);
    return {
      ...execution,
      uiNativeExec: true,
      nativeExec: false,
    };
  } catch (error) {
    logger?.warn?.(`agent local relay local context execution failed tool=${toolCall?.name || '-'}: ${error.message}`);
    return null;
  }
}

function enrichNativeEditExecution(execution, toolCall, editDetails = null) {
  if (!execution || !isEditLikeToolName(toolCall?.name) || !editDetails) return execution;
  return {
    ...execution,
    args: {
      ...(execution.args || {}),
      path: editDetails.path || execution.args?.path,
      old_string: editDetails.oldString ?? execution.args?.old_string,
      new_string: editDetails.newString ?? execution.args?.new_string,
      contents: editDetails.afterContent,
      stream_content: getEditStreamSnippetFromArgs(toolCall.arguments || {}),
    },
    beforeContent: editDetails.beforeContent,
    afterContent: editDetails.afterContent,
    linesAdded: Math.max(0, countLines(editDetails.afterContent) - countLines(editDetails.beforeContent)),
    linesRemoved: Math.max(0, countLines(editDetails.beforeContent) - countLines(editDetails.afterContent)),
    diffString: buildSimpleUnifiedDiff(editDetails.path, editDetails.beforeContent, editDetails.afterContent),
    message: execution.message || execution.summary || execution.resultText || 'Edit completed.',
  };
}

function buildNativeExecMissingExecution(toolCall, clientResult, session) {
  const timedOut = clientResult?.timedOut === true;
  return {
    ok: false,
    tool: toolCall.name,
    args: {
      ...(toolCall.arguments || {}),
      workspaceRoot: getSessionWorkspaceRoot(session),
      nativeExec: true,
      timedOut,
    },
    resultText: timedOut
      ? 'Cursor native tool execution did not acknowledge before the relay timeout. The relay did not write files locally.'
      : 'Cursor native tool execution did not complete. The relay did not write files locally.',
    durationMs: Number(clientResult?.durationMs) || 0,
    nativeExec: true,
    missingNativeAck: true,
  };
}

function buildNativeMutationHandoffExecution(toolCall, session) {
  return {
    ok: true,
    tool: toolCall.name,
    args: {
      ...(toolCall.arguments || {}),
      workspaceRoot: getSessionWorkspaceRoot(session),
      nativeExec: true,
    },
    resultText: 'Mutation tool request was handed off to Cursor native exec. Relay did not write files locally.',
    durationMs: 0,
    nativeExec: true,
    pendingNativeMutation: true,
  };
}

function buildExecServerFrameForTool(toolName, args = {}, toolCallId = '', numericExecId = 0, session = {}) {
  const lower = String(toolName || '').trim().toLowerCase();
  const execId = String(toolCallId || `exec_${Date.now().toString(36)}`);
  if (lower === 'read') {
    return buildAgentExecReadFrame({
      id: execId,
      execId,
      numericId: numericExecId,
      toolCallId: execId,
      path: String(args.path || ''),
      offset: Number(args.offset) || 0,
      limit: Number(args.limit) || 0,
    });
  }
  if (lower === 'write' || lower === 'edit' || lower === 'patchedit' || lower === 'strreplace') {
    const fileText = buildNativeEditFileText(toolName, args, session);
    return buildAgentExecWriteFrame({
      id: execId,
      execId,
      numericId: numericExecId,
      toolCallId: execId,
      path: String(args.path || ''),
      fileText,
      returnFileContentAfterWrite: false,
    });
  }
  if (lower === 'delete') {
    return buildAgentExecDeleteFrame({
      id: execId,
      execId,
      numericId: numericExecId,
      toolCallId: execId,
      path: String(args.path || args.target_file || args.targetFile || ''),
    });
  }
  if (lower === 'grep') {
    return buildAgentExecGrepFrame({
      id: execId,
      execId,
      numericId: numericExecId,
      toolCallId: execId,
      pattern: String(args.pattern || ''),
      path: String(args.path || ''),
      glob: String(args.glob || ''),
      outputMode: String(args.output_mode || args.outputMode || 'content'),
      headLimit: Number(args.head_limit || args.headLimit) || 0,
    });
  }
  if (lower === 'ls') {
    return buildAgentExecLsFrame({
      id: execId,
      execId,
      numericId: numericExecId,
      toolCallId: execId,
      path: String(args.path || args.target_directory || args.targetDirectory || ''),
      ignore: Array.isArray(args.ignore) ? args.ignore.map((item) => String(item)).filter(Boolean) : [],
      timeoutMs: Number(args.timeout_ms || args.timeoutMs) || 0,
    });
  }
  if (lower === 'shell') {
    return buildAgentExecShellStreamFrame({
      id: execId,
      execId,
      numericId: numericExecId,
      toolCallId: execId,
      command: String(args.command || ''),
      workingDirectory: String(args.working_directory || args.cwd || ''),
      timeoutMs: Number(args.timeout_ms || args.timeoutMs) || 0,
      description: String(args.description || ''),
    });
  }
  if (lower === 'readlints' || lower === 'diagnostics') {
    const firstPath = Array.isArray(args.paths) ? args.paths[0] : args.path;
    return buildAgentExecDiagnosticsFrame({
      id: execId,
      execId,
      numericId: numericExecId,
      toolCallId: execId,
      path: String(firstPath || ''),
    });
  }
  return null;
}

function nextInteractionQueryId(session = {}) {
  session.nextInteractionQueryId = (Number(session.nextInteractionQueryId) || 0) + 1;
  return session.nextInteractionQueryId;
}

function shouldDispatchInteractionQueryForTool(session = {}, toolCall = {}, execution = null) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.shouldDispatchInteractionQuery !== 'function') return false;
  return Boolean(handler.shouldDispatchInteractionQuery(session, toolCall, execution, helpers));
}

function buildInteractionQueryFrameForTool(session = {}, toolCall = {}, toolCallId = '') {
  const queryId = nextInteractionQueryId(session);
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.buildInteractionQuery !== 'function') return null;
  return handler.buildInteractionQuery(session, toolCall, toolCallId, queryId, helpers);
}

function getInteractionPendingKindFromResponseByMode(session = {}, interactionResponse = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.getInteractionPendingKindFromResponse === 'function') {
    const resolved = handler.getInteractionPendingKindFromResponse(interactionResponse, helpers);
    if (resolved) return String(resolved).trim();
  }
  const responseKind = String(interactionResponse?.kind || '').trim();
  if (responseKind === 'create_plan_request_response') return 'create_plan';
  if (responseKind === 'ask_question_interaction_response') return 'ask_question';
  if (responseKind === 'web_search_request_response') return 'web_search';
  return '';
}

function registerPendingInteractionQuery(session = {}, payload = {}) {
  const requestId = String(session.requestId || '').trim();
  const queryId = Number(payload.queryId) || 0;
  const kind = String(payload.kind || '').trim();
  if (!requestId || !queryId || !kind) return;
  session.pendingAgentInteractions = session.pendingAgentInteractions || new Map();
  const key = `${requestId}:${queryId}:${kind}`;
  session.pendingAgentInteractions.set(key, {
    key,
    requestId,
    queryId,
    kind,
    toolCallId: String(payload.toolCallId || '').trim(),
    toolName: String(payload.toolName || '').trim(),
    arguments: payload.arguments || {},
    execution: payload.execution || null,
    modeName: normalizeAgentModeName(payload.modeName || getSessionAgentMode(session)),
    stableConversationId: String(payload.stableConversationId || '').trim(),
    workspaceRoot: String(payload.workspaceRoot || '').trim(),
    resumeState: payload.resumeState || null,
    createdAt: payload.createdAt || new Date().toISOString(),
  });
}

function findPendingInteractionQuery(pendingAgentInteractions, requestId = '', interactionResponse = {}) {
  if (!pendingAgentInteractions?.size || !requestId) return null;
  const responseId = Number(interactionResponse?.id) || 0;
  const stableConversationId = String(
    interactionResponse?.stableConversationId
    || interactionResponse?.conversationId
    || ''
  ).trim();
  const candidates = Array.from(pendingAgentInteractions.values())
    .filter((entry) => entry?.requestId === requestId || (stableConversationId && entry?.stableConversationId === stableConversationId))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (!candidates.length) return null;
  const modeSession = {
    agentMode: normalizeAgentModeName(candidates[0]?.modeName || agentSessions.get(requestId)?.agentMode || 'AGENT_MODE_AGENT'),
  };
  const responseKind = getInteractionPendingKindFromResponseByMode(modeSession, interactionResponse);
  if (responseId > 0) {
    const exact = candidates.find((entry) => Number(entry.queryId) === responseId && (!responseKind || entry.kind === responseKind));
    if (exact) return exact;
  }
  if (responseKind) {
    const sameKind = candidates.find((entry) => entry.kind === responseKind);
    if (sameKind) return sameKind;
  }
  return candidates[0];
}

function findPendingInteractionQueryByExecution(session = {}, executionEntry = {}) {
  const pendingAgentInteractions = session?.pendingAgentInteractions;
  const interactionQueryId = Number(executionEntry?.execution?.interactionQueryId) || 0;
  const interactionQueryKind = String(executionEntry?.execution?.interactionQueryKind || '').trim();
  const toolCallId = String(executionEntry?.toolCall?.id || '').trim();
  if (!pendingAgentInteractions?.size) return null;
  const candidates = Array.from(pendingAgentInteractions.values())
    .filter((entry) => entry?.requestId === String(session.requestId || '').trim());
  if (!candidates.length) return null;
  if (interactionQueryId > 0) {
    const exact = candidates.find((entry) => Number(entry.queryId) === interactionQueryId && (!interactionQueryKind || entry.kind === interactionQueryKind));
    if (exact) return exact;
  }
  if (toolCallId) {
    const byToolCall = candidates.find((entry) => String(entry.toolCallId || '').trim() === toolCallId && (!interactionQueryKind || entry.kind === interactionQueryKind));
    if (byToolCall) return byToolCall;
  }
  if (interactionQueryKind) {
    const byKind = candidates.find((entry) => entry.kind === interactionQueryKind);
    if (byKind) return byKind;
  }
  return candidates[0];
}

function buildInteractionContinuationPrompt(pendingInteraction = {}, interactionResponse = {}) {
  const responseKind = String(interactionResponse?.kind || '').trim();
  const pendingKind = String(pendingInteraction?.kind || '').trim();
  if (responseKind === 'web_search_request_response' || pendingKind === 'web_search') {
    return [
      'The pending WebSearch interaction has completed.',
      `Approval: ${interactionResponse?.webSearchApproved ? 'approved' : 'not approved'}.`,
      'Continue the same turn and use the approved web search path if it is still needed.',
    ].join('\n');
  }
  return [
    'A pending plan interaction has completed.',
    `Interaction payload: ${JSON.stringify(interactionResponse || {})}`,
    'Continue the same turn from this interaction result without restarting from scratch.',
  ].join('\n');
}

function buildPendingInteractionResumeMessages(session = {}, pendingInteraction = {}, interactionResponse = {}) {
  const resumeState = pendingInteraction?.resumeState || {};
  const baseMessages = Array.isArray(resumeState.upstreamMessages)
    ? resumeState.upstreamMessages.map((message) => ({ ...message }))
    : buildLocalRelayMessages(resumeState.userText || session.lastUserMessageCapture?.userText || '', session);
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  const resumeMessage = typeof handler.buildInteractionResumeMessage === 'function'
    ? handler.buildInteractionResumeMessage(pendingInteraction, interactionResponse, helpers)
    : null;
  return [
    ...baseMessages,
    resumeMessage || {
      role: 'user',
      content: buildInteractionContinuationPrompt(pendingInteraction, interactionResponse),
    },
  ];
}

function appendInteractionResponseToHistory(session = {}, pendingInteraction = {}, interactionResponse = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  const item = typeof handler.buildInteractionResponseHistoryItem === 'function'
    ? handler.buildInteractionResponseHistoryItem(pendingInteraction, interactionResponse, helpers)
    : null;
  if (!item) return;
  appendSessionHistory(session, item);
}

function updatePendingInteractionResumeState(session = {}, executions = [], upstreamMessages = [], toolResultMessages = [], streamedText = '', userText = '') {
  const waitingExecutions = (Array.isArray(executions) ? executions : [])
    .filter((entry) => entry?.execution?.awaitingInteractionResponse);
  if (!waitingExecutions.length) return 0;
  const resumeMessages = [
    ...(Array.isArray(upstreamMessages) ? upstreamMessages.map((message) => ({ ...message })) : []),
    { role: 'assistant', content: String(streamedText || '').trim() || `Called ${waitingExecutions.length} tool(s).` },
    ...(Array.isArray(toolResultMessages) ? toolResultMessages.map((message) => ({ ...message })) : []),
  ];
  let updated = 0;
  for (const executionEntry of waitingExecutions) {
    const pendingInteraction = findPendingInteractionQueryByExecution(session, executionEntry);
    if (!pendingInteraction) continue;
    pendingInteraction.resumeState = buildPendingInteractionResumeStateByMode(session, pendingInteraction, {
      userText,
      upstreamMessages: resumeMessages,
      capturedAt: new Date().toISOString(),
      stableConversationId: getSessionStableConversationId(session),
      requestId: String(session.requestId || '').trim(),
      executionEntry,
    });
    updated += 1;
  }
  return updated;
}

function triggerDeferredInteractionResume(session, config, logger, stats, source = 'deferred') {
  if (!session?.active || session.aborted || session.relaying) return false;
  const deferred = session.deferredInteractionResponse || null;
  if (!deferred?.interactionResponse) return false;
  session.deferredInteractionResponse = null;
  logger?.info?.(
    `agent local relay deferred interaction resume requestId=${session.requestId || '-'} source=${source} interactionKind=${deferred.interactionResponse?.kind || '-'} pendingKind=${deferred.pendingInteraction?.kind || '-'} pendingTool=${deferred.pendingInteraction?.toolName || '-'}`
  );
  resumeAgentAfterInteractionResponse(session, deferred.interactionResponse, config, logger, stats, deferred.pendingInteraction || null)
    .catch((error) => failAgentRelaySession(session, logger, error, `deferred_interaction_resume:${source}`));
  return true;
}

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

function looksLikeCompleteJsonObject(text) {
  const value = String(text || '').trim();
  if (!value || !value.startsWith('{') || !value.endsWith('}')) return false;
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function getToolTextArg(args = {}, names = []) {
  for (const name of names) {
    if (args[name] != null) return String(args[name]);
  }
  return '';
}

function trimEditStreamContent(value) {
  const text = String(value || '');
  if (text.length <= MAX_EDIT_STREAM_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_EDIT_STREAM_CONTENT_CHARS)}\n...`;
}

function getEditStreamSnippetFromArgs(args = {}) {
  const explicit = getToolTextArg(args, ['stream_content', 'streamContent']);
  if (explicit) return trimEditStreamContent(explicit);
  const oldString = getToolTextArg(args, ['old_string', 'oldStr']);
  const newString = getToolTextArg(args, ['new_string', 'newStr']);
  if (oldString || newString) {
    return trimEditStreamContent([
      oldString ? `old_string:\n${oldString}` : '',
      newString ? `new_string:\n${newString}` : '',
    ].filter(Boolean).join('\n\n'));
  }
  return '';
}

function getFullEditContentFromArgs(args = {}) {
  return getToolTextArg(args, [
    'contents',
    'content',
    'fileText',
    'file_text',
    'fileContent',
    'file_content',
    'stream_content',
    'streamContent',
  ]);
}

function getEditContentFromArgs(args = {}) {
  const fullContent = getFullEditContentFromArgs(args);
  if (fullContent.length > 0) return fullContent;
  return getToolTextArg(args, [
    'new_string',
    'newStr',
  ]);
}

function extractPartialJsonStringValue(text, key) {
  const source = String(text || '');
  const quotedKey = `"${String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`;
  const keyIndex = source.indexOf(quotedKey);
  if (keyIndex < 0) return { found: false, value: '', closed: false };
  const colonIndex = source.indexOf(':', keyIndex + quotedKey.length);
  if (colonIndex < 0) return { found: true, value: '', closed: false };
  let pos = colonIndex + 1;
  while (pos < source.length && /\s/.test(source[pos])) pos += 1;
  if (source[pos] !== '"') return { found: true, value: '', closed: false };
  pos += 1;
  let out = '';
  let escaped = false;
  for (; pos < source.length; pos += 1) {
    const char = source[pos];
    if (escaped) {
      try {
        out += JSON.parse(`"\\${char}"`);
      } catch {
        out += char;
      }
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') return { found: true, value: out, closed: true };
    out += char;
  }
  return { found: true, value: out, closed: false };
}

function getStreamingEditContentFromArgumentsText(argumentsText) {
  const keys = [
    'stream_content',
    'streamContent',
    'contents',
    'content',
    'fileText',
    'file_text',
    'fileContent',
    'file_content',
    'old_string',
    'oldStr',
    'new_string',
    'newStr',
  ];
  for (const key of keys) {
    const extracted = extractPartialJsonStringValue(argumentsText, key);
    if (extracted.found) return trimEditStreamContent(extracted.value || '');
  }
  return '';
}

function getStreamingPathFromArgumentsText(argumentsText) {
  for (const key of ['path', 'target_file', 'targetFile']) {
    const extracted = extractPartialJsonStringValue(argumentsText, key);
    if (extracted.found && extracted.value) return extracted.value;
  }
  return '';
}

function getClosedStreamingPathFromArgumentsText(argumentsText) {
  for (const key of ['path', 'target_file', 'targetFile']) {
    const extracted = extractPartialJsonStringValue(argumentsText, key);
    if (extracted.found && extracted.closed && extracted.value) return extracted.value;
  }
  return '';
}

function hasRequiredToolArguments(toolCall) {
  const name = String(toolCall?.name || '').trim().toLowerCase();
  const args = toolCall?.arguments || {};
  if (!name) return false;
  if (['write', 'edit'].includes(name)) {
    return getEditContentFromArgs(args).length > 0;
  }
  if (name === 'patchedit' || name === 'strreplace') {
    return (args.old_string != null || args.oldStr != null)
      && (args.new_string != null || args.newStr != null);
  }
  if (name === 'delete' || name === 'read') {
    return Boolean(String(args.path || args.target_file || args.targetFile || '').trim());
  }
  if (name === 'grep') return Boolean(String(args.pattern || '').trim());
  if (name === 'glob') return Boolean(String(args.glob_pattern || args.pattern || '').trim());
  if (name === 'ls') return Boolean(String(args.path || args.target_directory || args.targetDirectory || '').trim());
  if (name === 'shell') return Boolean(String(args.command || '').trim());
  if (isTodoToolName(name)) {
    return Array.isArray(args.todos);
  }
  if (name === 'websearch' || name === 'web_search') {
    return Boolean(String(args.search_term || args.searchTerm || args.query || '').trim());
  }
  if (name === 'webfetch' || name === 'web_fetch' || name === 'fetch') {
    return Boolean(String(args.url || '').trim());
  }
  if (name === 'readlints' || name === 'diagnostics') {
    return Boolean((Array.isArray(args.paths) && args.paths.length) || args.path);
  }
  if (name === 'semanticsearch') {
    return Boolean(String(args.query || '').trim());
  }
  if (name === 'askquestion') {
    return Array.isArray(args.questions) && args.questions.length > 0;
  }
  if (name === 'createplan') {
    return Boolean(String(args.plan || '').trim() || String(args.overview || '').trim());
  }
  return true;
}

function collectToolCallsFromPayload(payload, state) {
  if (!payload || typeof payload !== 'object') return;
  state.toolCalls = state.toolCalls || new Map();

  const chatCalls = payload.choices?.[0]?.delta?.tool_calls;
  if (Array.isArray(chatCalls)) {
    chatCalls.forEach((call, index) => {
      const key = String(call.index ?? index);
      const existing = state.toolCalls.get(key) || { id: '', name: '', argumentsText: '', provider: 'chat', done: false };
      existing.id = String(call.id || existing.id || `tool_${key}`);
      existing.name = String(call.function?.name || existing.name || '');
      existing.argumentsText += String(call.function?.arguments || '');
      if (looksLikeCompleteJsonObject(existing.argumentsText)) existing.done = true;
      state.toolCalls.set(key, existing);
    });
  }

  if (payload.type === 'response.output_item.added' && payload.item?.type === 'function_call') {
    const key = String(payload.item.id || payload.item.call_id || state.toolCalls.size);
    state.toolCalls.set(key, {
      id: String(payload.item.call_id || payload.item.id || `tool_${key}`),
      name: String(payload.item.name || ''),
      argumentsText: String(payload.item.arguments || ''),
      provider: 'responses',
      done: false,
    });
  }
  if (payload.type === 'response.function_call_arguments.delta') {
    const key = String(payload.item_id || payload.call_id || state.toolCalls.size);
    const existing = state.toolCalls.get(key) || {
      id: String(payload.call_id || `tool_${key}`),
      name: '',
      argumentsText: '',
      provider: 'responses',
      done: false,
    };
    existing.argumentsText += String(payload.delta || '');
    existing.id = String(payload.call_id || existing.id || `tool_${key}`);
    if (looksLikeCompleteJsonObject(existing.argumentsText)) existing.done = true;
    state.toolCalls.set(key, existing);
  }
  if (payload.type === 'response.function_call_arguments.done') {
    const key = String(payload.item_id || payload.call_id || state.toolCalls.size);
    const existing = state.toolCalls.get(key) || {
      id: String(payload.call_id || `tool_${key}`),
      name: '',
      argumentsText: '',
      provider: 'responses',
      done: false,
    };
    existing.id = String(payload.call_id || existing.id || `tool_${key}`);
    if (payload.arguments) existing.argumentsText = String(payload.arguments);
    existing.done = true;
    state.toolCalls.set(key, existing);
  }
  if (payload.type === 'response.output_item.done' && payload.item?.type === 'function_call') {
    const key = String(payload.item.id || payload.item.call_id || state.toolCalls.size);
    const existing = state.toolCalls.get(key) || {
      id: String(payload.item.call_id || payload.item.id || `tool_${key}`),
      name: '',
      argumentsText: '',
      provider: 'responses',
      done: false,
    };
    existing.id = String(payload.item.call_id || payload.item.id || existing.id);
    existing.name = String(payload.item.name || existing.name || '');
    if (payload.item.arguments) existing.argumentsText = String(payload.item.arguments);
    existing.done = true;
    state.toolCalls.set(key, existing);
  }
}

function normalizeCollectedToolCalls(state) {
  return Array.from((state.toolCalls || new Map()).values())
    .map((call, index) => ({
      id: String(call.id || `tool_${index}`),
      name: String(call.name || '').trim(),
      arguments: parseJsonObject(call.argumentsText),
      rawArguments: String(call.argumentsText || ''),
      provider: call.provider || 'chat',
      done: call.done === true || looksLikeCompleteJsonObject(call.argumentsText),
    }))
    .filter((call) => {
      if (!call.name || !call.done) return false;
      return hasRequiredToolArguments(call);
    });
}

function attachDefaultMutationTarget(toolCalls = [], session = {}, userText = '') {
  const targetPath = getMutationTargetPath(userText, session);
  if (!targetPath) return toolCalls;
  return toolCalls.map((toolCall) => {
    if (!isMutationToolName(toolCall?.name)) return toolCall;
    const args = { ...(toolCall.arguments || {}) };
    if (!String(args.path || args.target_file || args.targetFile || '').trim()) {
      args.path = targetPath;
      return { ...toolCall, arguments: args, targetPath };
    }
    return toolCall;
  });
}

function getSuccessfulMutationPaths(session = {}) {
  const mutationTools = new Set(['write', 'edit', 'patchedit', 'strreplace', 'delete']);
  const results = Array.isArray(session?.toolResultSummaries) ? session.toolResultSummaries : [];
  return Array.from(new Set(results
    .filter((entry) => entry?.ok && mutationTools.has(String(entry.tool || '').trim().toLowerCase()))
    .map((entry) => normalizeWorkspacePath(entry.path || ''))
    .filter(Boolean)));
}

function toWorkspaceRelativePath(filePath = '', workspaceRoot = '') {
  const normalizedRoot = normalizeWorkspacePath(workspaceRoot || '');
  const normalizedPath = normalizeWorkspacePath(filePath || '');
  if (!normalizedPath) return '';
  try {
    if (normalizedRoot && path.isAbsolute(normalizedPath)) {
      const relative = path.relative(normalizedRoot, normalizedPath);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative.replace(/\\/g, '/');
      }
    }
  } catch {
    /* fall through to basename */
  }
  return path.basename(normalizedPath).replace(/\\/g, '/');
}

function collectWorkspaceFileSnapshot(session = {}, maxFiles = 500) {
  const workspaceRoot = getSessionWorkspaceRoot(session);
  const files = [];
  const skipDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out']);
  const visit = (dir, depth = 0) => {
    if (!dir || files.length >= maxFiles || depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) visit(fullPath, depth + 1);
      } else if (entry.isFile()) {
        files.push(toWorkspaceRelativePath(fullPath, workspaceRoot));
      }
    }
  };
  try {
    if (workspaceRoot && fs.existsSync(workspaceRoot) && fs.statSync(workspaceRoot).isDirectory()) {
      visit(workspaceRoot, 0);
    }
  } catch {
    /* ignore snapshot failures */
  }
  return Array.from(new Set(files.filter(Boolean))).sort();
}

function buildCompletionVerificationMessage(userText = '', finalText = '', session = {}, round = 0) {
  const changedPaths = getSuccessfulMutationPaths(session)
    .map((filePath) => toWorkspaceRelativePath(filePath, getSessionWorkspaceRoot(session)))
    .filter(Boolean);
  const recentToolResults = getRecentToolResultContext(session, 12);
  const fileSnapshot = collectWorkspaceFileSnapshot(session, 500);
  return {
    role: 'user',
    content: [
      `Completion verification ${Number(round) + 1}/${MAX_COMPLETION_VERIFICATION_ROUNDS}.`,
      'Review the original user request, the actual tool results, and the current workspace file snapshot before ending this agent turn.',
      'If the requested work is not fully done, call the required tools now. If it is fully done, provide the final concise answer. Do not only say that you will continue.',
      '',
      `Original user request:\n${String(userText || '').slice(0, 4000)}`,
      String(finalText || '').trim() ? `Candidate final assistant text:\n${String(finalText || '').slice(0, 2000)}` : '',
      changedPaths.length ? `Successful mutation paths:\n${changedPaths.map((item) => `- ${item}`).join('\n')}` : '',
      recentToolResults.length ? `Recent tool results:\n${recentToolResults.map((item) => `- ${item}`).join('\n')}` : '',
      fileSnapshot.length ? `Workspace file snapshot (${fileSnapshot.length} file(s), truncated):\n${fileSnapshot.map((item) => `- ${item}`).join('\n')}` : 'Workspace file snapshot: unavailable or empty.',
    ].filter(Boolean).join('\n'),
  };
}

function buildPostMutationSummaryFallback(session = {}) {
  const changedPaths = getSuccessfulMutationPaths(session);
  if (changedPaths.length) {
    return '';
  }
  return '';
}

function shouldRunPostEditLints(config = {}) {
  return config.postEditReadLints === true
    || String(process.env.CURSOR_RELAY_POST_EDIT_LINTS || '').trim() === '1';
}

function shouldEmitLocalStepFrames(config = {}) {
  return config.emitLocalStepFrames === true
    || String(process.env.CURSOR_RELAY_EMIT_STEP_FRAMES || '').trim() === '1';
}

async function collectPostMutationSummary({
  session,
  config,
  configuredModel,
  upstreamMessages,
  userText,
  logger,
  requestId,
  fallback = '',
}) {
  if (!session?.active || session.aborted) return fallback;
  const changedPaths = getSuccessfulMutationPaths(session);
  const activeUpstream = resolveUpstreamForModel(config, configuredModel);
  const agentMode = getSessionAgentMode(session);
  const summaryPrompt = [
    'The file mutation has already succeeded through Cursor native tools.',
    changedPaths.length ? `Changed file(s): ${changedPaths.join(', ')}` : '',
    `Original user request: ${String(userText || '')}`,
    '',
    'Now provide only the final concise assistant summary for the user, in the same language as the user. Do not call tools. Do not repeat diagnostics unless tool results explicitly reported a problem.',
  ].filter(Boolean).join('\n');
  try {
    const compacted = compactRelayMessagesForContext([
      ...upstreamMessages,
      { role: 'user', content: summaryPrompt },
    ], config, logger, { requestId, phase: 'post_mutation_summary' });
    const { response, mode } = await fetchUpstreamCompletion(
      activeUpstream,
      configuredModel,
      compacted.messages,
      logger,
      buildFetchUpstreamOptionsForSession(session, {
        enableTools: false,
        signal: session.abortController?.signal || null,
        timeoutMs: POST_MUTATION_SUMMARY_TIMEOUT_MS,
        requestId,
        phase: 'post_mutation_summary',
        mode: agentMode,
        outboundProxy: config.outboundProxy || null,
        localProxyPort: config.port,
      }, { phase: 'post_mutation_summary', agentMode }),
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logger.info(`agent local relay post-mutation summary skipped requestId=${requestId} mode=${mode || '-'} status=${response.status} error=${JSON.stringify(trimRelayText(errorText, 180))}`);
      return fallback || '';
    }
    const streamed = await streamAgentUpstreamResponse(response, session, {
      collectTools: false,
      emit: true,
      phase: 'post_mutation_summary',
      idleTimeoutMs: POST_MUTATION_SUMMARY_IDLE_TIMEOUT_MS,
      maxDurationMs: POST_MUTATION_SUMMARY_TIMEOUT_MS,
      stopAfterTextMs: 1200,
    });
    const text = String(streamed.text || '').trim();
    if (text) return text;
  } catch (error) {
    if (!session.aborted) {
      logger.info(`agent local relay post-mutation summary failed requestId=${requestId}: ${error.message || String(error)}`);
    }
  }
  return fallback || '';
}

function trimToolOutput(value) {
  const text = String(value || '');
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...[truncated]`
    : text;
}

function countLines(text) {
  const value = String(text || '');
  if (!value) return 0;
  return value.split(/\r?\n/).length;
}

function buildSimpleUnifiedDiff(filePath, beforeContent, afterContent) {
  if (beforeContent === afterContent) return '';
  const beforeLines = String(beforeContent || '').split(/\r?\n/);
  const afterLines = String(afterContent || '').split(/\r?\n/);
  const maxPreview = 80;
  return [
    `--- a/${path.basename(filePath)}`,
    `+++ b/${path.basename(filePath)}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.slice(0, maxPreview).map((line) => `-${line}`),
    ...afterLines.slice(0, maxPreview).map((line) => `+${line}`),
    beforeLines.length > maxPreview || afterLines.length > maxPreview ? '...diff truncated...' : '',
  ].filter(Boolean).join('\n');
}

function getEditStreamContent(toolCall = {}) {
  return getEditStreamSnippetFromArgs(toolCall.arguments || {});
}

function buildNativeEditFileText(toolName, args = {}, session = {}) {
  const lower = String(toolName || '').trim().toLowerCase();
  if (lower === 'patchedit' || lower === 'strreplace') {
    const filePath = resolveWorkspacePath(args.path || args.target_file || args.targetFile || '', session);
    const hasOldString = args.old_string != null || args.oldStr != null;
    const hasNewString = args.new_string != null || args.newStr != null;
    const oldString = String(args.old_string ?? args.oldStr ?? '');
    const newString = String(args.new_string ?? args.newStr ?? '');
    if (!filePath || !hasOldString || !hasNewString || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return getEditContentFromArgs(args);
    }
    const beforeContent = fs.readFileSync(filePath, 'utf8');
    if (oldString === '') {
      const fullContent = getFullEditContentFromArgs(args);
      if (fullContent.length > 0) return fullContent;
      return beforeContent === '' ? newString : beforeContent;
    }
    if (!beforeContent.includes(oldString)) {
      return getEditContentFromArgs(args);
    }
    const replaceAll = args.replace_all === true || args.replaceAll === true;
    return replaceAll ? beforeContent.split(oldString).join(newString) : beforeContent.replace(oldString, newString);
  }
  return getEditContentFromArgs(args);
}

function emitEditToolCallDeltaFrames(session, toolCall, toolCallId, modelCallId) {
  const streamContent = getEditStreamContent(toolCall);
  if (!streamContent) return 0;
  const chunkSize = EDIT_STREAM_FRAME_CHARS;
  let count = 0;
  for (let offset = 0; offset < streamContent.length; offset += chunkSize) {
    writeAgentFrame(session, buildAgentEditToolCallDeltaFrame(streamContent.slice(offset, offset + chunkSize), toolCallId, modelCallId));
    count += 1;
  }
  return count;
}

function wildcardToRegExp(pattern) {
  const source = String(pattern || '*')
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i');
}

function expandBraceGlob(pattern = '') {
  const value = String(pattern || '*');
  const match = value.match(/\{([^{}]+)\}/);
  if (!match) return [value];
  const parts = match[1].split(',').map((item) => item.trim()).filter(Boolean);
  if (!parts.length) return [value.replace(match[0], '')];
  return parts.flatMap((part) => expandBraceGlob(`${value.slice(0, match.index)}${part}${value.slice(match.index + match[0].length)}`));
}

function buildGlobMatchers(pattern = '') {
  const expanded = expandBraceGlob(String(pattern || '*').trim() || '*');
  return expanded.map((item) => {
    const normalized = String(item || '*').replace(/\\/g, '/');
    return {
      pattern: normalized,
      regex: wildcardToRegExp(normalized),
      basenameRegex: normalized.includes('/') ? null : wildcardToRegExp(normalized),
    };
  });
}

function matchesGlobPath(filePath, rootPath, matchers = []) {
  if (!matchers.length) return true;
  const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
  const basename = path.basename(filePath);
  return matchers.some((matcher) => matcher.regex.test(relativePath)
    || (matcher.basenameRegex && matcher.basenameRegex.test(basename)));
}

function walkFiles(root, options = {}) {
  const out = [];
  const ignore = new Set(['node_modules', '.git', 'dist', 'build', ...(options.ignore || [])].map((item) => String(item).toLowerCase()));
  const max = Number(options.max) || 500;
  function walk(dir) {
    if (out.length >= max) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) break;
      if (ignore.has(entry.name.toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function shouldIgnoreLsEntry(name = '', ignore = []) {
  const normalized = String(name || '').toLowerCase();
  const patterns = Array.isArray(ignore) ? ignore : [];
  return patterns.some((pattern) => {
    const value = String(pattern || '').trim().toLowerCase();
    if (!value) return false;
    const bare = value.replace(/^\*\*\//, '').replace(/\/\*\*$/, '').replace(/\*\*/g, '');
    return normalized === bare
      || normalized === value
      || (bare && normalized.includes(bare));
  });
}

function countFilesInDirectoryTree(tree = {}) {
  const files = Array.isArray(tree.childrenFiles) ? tree.childrenFiles.length : 0;
  const dirs = Array.isArray(tree.childrenDirs) ? tree.childrenDirs : [];
  return files + dirs.reduce((sum, child) => sum + countFilesInDirectoryTree(child), 0);
}

function buildLsDirectoryTreeNode(absPath, ignore = [], depth = 0, maxDepth = 3) {
  const node = {
    absPath,
    childrenDirs: [],
    childrenFiles: [],
    childrenWereProcessed: true,
  };
  if (depth >= maxDepth) return node;
  try {
    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    entries
      .filter((entry) => !shouldIgnoreLsEntry(entry.name, ignore))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 120)
      .forEach((entry) => {
        const childPath = path.join(absPath, entry.name);
        if (entry.isDirectory()) {
          node.childrenDirs.push(buildLsDirectoryTreeNode(childPath, ignore, depth + 1, maxDepth));
        } else if (entry.isFile()) {
          node.childrenFiles.push({ name: entry.name });
        }
      });
  } catch {
    node.childrenWereProcessed = false;
  }
  node.numFiles = countFilesInDirectoryTree(node);
  return node;
}

function listDirectory(pathname, ignore = []) {
  const tree = buildLsDirectoryTreeNode(pathname, ignore, 0, 1);
  const lines = [];
  const walk = (node, depth = 0) => {
    (node.childrenDirs || []).forEach((child) => {
      const name = String(child.absPath || '').split(/[\\/]/).filter(Boolean).pop() || '';
      if (name) lines.push(`${'  '.repeat(depth)}[dir]  ${name}`);
      walk(child, depth + 1);
    });
    (node.childrenFiles || []).forEach((file) => {
      if (file?.name) lines.push(`${'  '.repeat(depth)}[file] ${file.name}`);
    });
  };
  walk(tree, 0);
  return lines.join('\n');
}

function parseGrepOutputToStructured(resultText = '', args = {}, workspaceRoot = '') {
  const outputMode = String(args.output_mode || args.outputMode || 'content').toLowerCase();
  const lines = String(resultText || '').split(/\r?\n/).filter(Boolean);
  if (outputMode === 'files_with_matches' || outputMode === 'files') {
    return {
      outputMode: 'files_with_matches',
      files: lines,
      totalFiles: lines.length,
      workspaceKey: workspaceRoot || args.path || '.',
    };
  }
  const byFile = new Map();
  lines.forEach((line) => {
    const match = line.match(/^(.+?):(\d+)(?::(.*))?$/);
    if (!match) return;
    const [, file, lineNumber, content = ''] = match;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({
      lineNumber: Number(lineNumber) || 0,
      content,
    });
  });
  const matches = Array.from(byFile.entries()).map(([file, fileMatches]) => ({ file, matches: fileMatches }));
  const totalMatchedLines = matches.reduce((sum, item) => sum + item.matches.length, 0);
  return {
    outputMode: 'content',
    pattern: String(args.pattern || ''),
    path: String(args.path || ''),
    matches,
    totalLines: lines.length,
    totalMatchedLines,
    workspaceKey: workspaceRoot || args.path || '.',
  };
}

function buildReadOutput(filePath, args = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Number(args.limit) > 0 ? Number(args.limit) : lines.length;
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  return selected
    .map((line, index) => `${offset + index}: ${line}`)
    .join('\n');
}

function isLocalContextToolName(toolName = '') {
  return ['read', 'grep', 'ls', 'glob', 'semanticsearch'].includes(String(toolName || '').trim().toLowerCase());
}

function isReadOnlyContextToolName(toolName = '') {
  return isLocalContextToolName(toolName);
}

function decodeProcessBuffer(buffer) {
  const bytes = Buffer.from(buffer || []);
  if (!bytes.length) return '';
  const utf8 = bytes.toString('utf8');
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  if (!replacementCount) return utf8;
  try {
    const decoded = new TextDecoder('gb18030').decode(bytes);
    const decodedReplacementCount = (decoded.match(/\uFFFD/g) || []).length;
    if (decodedReplacementCount < replacementCount) return decoded;
  } catch {
    /* keep utf8 fallback */
  }
  return utf8;
}

function shouldRunShellWithCmd(command = '') {
  const value = String(command || '').trim();
  return /(^|\s)cd\s+\/d(\s|$)/i.test(value)
    || /(^|\s)where(?:\.exe)?\s+/i.test(value)
    || /&&|\|\|/.test(value);
}

function buildShellInvocation(command = '') {
  if (process.platform === 'win32' && shouldRunShellWithCmd(command)) {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command], shell: 'cmd' };
  }
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
    shell: 'powershell',
  };
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: Number(options.timeoutMs) || 30000,
      cwd: options.cwd || undefined,
      maxBuffer: 1024 * 1024 * 8,
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: Number(error?.code) || 0,
        stdout: decodeProcessBuffer(stdout),
        stderr: decodeProcessBuffer(stderr),
        error: error?.message || '',
      });
    });
  });
}

function getRelayTerminalsDir(session = {}) {
  const configuredLogPath = String(session?.config?.logPath || path.join(process.cwd(), 'runner.log'));
  return path.join(path.dirname(configuredLogPath), 'terminals');
}

function spawnBackgroundShell(command, cwd, session = {}) {
  const terminalsDir = getRelayTerminalsDir(session);
  fs.mkdirSync(terminalsDir, { recursive: true });
  const terminalId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const logPath = path.join(terminalsDir, `${terminalId}.txt`);
  const invocation = buildShellInvocation(command);
  const child = spawn(invocation.file, invocation.args, {
    cwd: cwd || undefined,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const header = [
    `pid=${child.pid || 0}`,
    `shell=${invocation.shell}`,
    `cwd=${cwd || ''}`,
    `command=${command}`,
    `started_at=${new Date().toISOString()}`,
    '',
  ].join('\n');
  fs.writeFileSync(logPath, header, 'utf8');
  const append = (chunk) => {
    try {
      fs.appendFileSync(logPath, Buffer.from(chunk || []).toString('utf8'), 'utf8');
    } catch {
      /* ignore terminal logging failures */
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code) => {
    append(`\nexit_code=${Number(code) || 0}\nfinished_at=${new Date().toISOString()}\n`);
  });
  child.unref();
  return { pid: child.pid || 0, logPath };
}

function normalizeTodoStatus(status = '') {
  const normalized = String(status || '').trim().toLowerCase();
  if (['pending', 'in_progress', 'completed', 'cancelled'].includes(normalized)) return normalized;
  return 'pending';
}

function normalizeTodoItems(todos = []) {
  return (Array.isArray(todos) ? todos : [])
    .map((todo, index) => {
      const id = String(todo?.id || `todo_${index + 1}`).trim();
      const content = String(todo?.content || todo?.title || '').trim();
      if (!id || !content) return null;
      return { id, content, status: normalizeTodoStatus(todo?.status) };
    })
    .filter(Boolean);
}

function updateSessionTodos(session = {}, todos = [], merge = false) {
  const incoming = normalizeTodoItems(todos);
  if (!merge) {
    session.todos = incoming;
    return session.todos;
  }
  const byId = new Map((Array.isArray(session.todos) ? session.todos : []).map((todo) => [todo.id, { ...todo }]));
  incoming.forEach((todo) => {
    byId.set(todo.id, { ...(byId.get(todo.id) || {}), ...todo });
  });
  session.todos = Array.from(byId.values());
  return session.todos;
}

function formatTodoListForDisplay(todos = []) {
  const icons = {
    pending: '[ ]',
    in_progress: '[>]',
    completed: '[x]',
    cancelled: '[-]',
  };
  const normalized = normalizeTodoItems(todos);
  if (!normalized.length) return 'Todo list is empty.';
  return normalized
    .map((todo) => `${icons[todo.status] || '[ ]'} ${todo.content}`)
    .join('\n');
}

function getIncompleteTodos(session = {}) {
  return normalizeTodoItems(session.todos || [])
    .filter((todo) => todo.status === 'pending' || todo.status === 'in_progress');
}

function looksLikeIncompleteContinuationText(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  return isPlaceholderFinalText(value);
}

function stripCjkAndAsciiPunctuation(text = '') {
  return String(text || '')
    .replace(/[\s"'`*_~()[\]{}<>.,!?;:，。！？；：、（）【】《》“”‘’…-]+/g, '');
}

function countWordsAndCjkChars(text = '') {
  const value = String(text || '').trim();
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const asciiWords = value
    .replace(/[\u3400-\u9fff]/g, ' ')
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean).length;
  return cjk + asciiWords;
}

function textLooksLikeSubstantiveFinalAnswer(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  const compact = stripCjkAndAsciiPunctuation(value);
  if (compact.length >= 160 || countWordsAndCjkChars(value) >= 40) return true;
  if (/\n\s*(?:[-*]|\d+[.)])\s+\S/.test(value)) return true;
  if (/```/.test(value)) return true;
  if (/(?:^|\n)\s*(?:summary|result|done|completed|analysis|findings|conclusion|next steps|总结|结论|分析|结果|完成|已完成|问题|建议|发现)\s*[:：]/i.test(value)) return true;
  return false;
}

function looksLikeReadOnlyExplorationStillInProgress(session = {}, finalText = '', options = {}) {
  if (!options.sawReadOnlyTool || options.sawMutationTool) return false;
  const summaries = Array.isArray(session?.toolResultSummaries) ? session.toolResultSummaries : [];
  const readOnlyCount = summaries.filter((entry) => isReadOnlyContextToolName(entry?.tool)).length;
  const mutationCount = summaries.filter((entry) => isMutationToolName(entry?.tool)).length;
  const continuationTargetPath = getReadOnlyContinuationTargetPath(session);
  const value = String(finalText || '').trim();
  if (!value) return readOnlyCount > 0 && mutationCount === 0;
  if (isPlaceholderFinalText(value)) return true;
  if (textLooksLikeSubstantiveFinalAnswer(value)) return false;
  const compact = stripCjkAndAsciiPunctuation(value);
  if (!compact) return true;
  if (continuationTargetPath && readOnlyCount >= 1 && mutationCount === 0) {
    return compact.length <= 140 && countWordsAndCjkChars(value) <= 32;
  }
  if ((compact.length <= 80 || countWordsAndCjkChars(value) <= 18) && readOnlyCount >= 2 && mutationCount === 0) return true;
  return readOnlyCount >= 2 && mutationCount === 0 && compact.length <= 140;
}

function isPlatformBillingEnabled(config = {}) {
  return Boolean(config?.advancedModelBilling?.enabled);
}

function sanitizeFinalAgentText(text = '', session = {}) {
  let value = String(text || '');
  if (!session?.aborted) {
    value = value.replace(/\n*\[User Cancelled\]\s*$/i, '').trim();
  }
  if (isPlaceholderFinalText(value)) return '';
  return value;
}

function isPlaceholderFinalText(text = '') {
  const value = String(text || '').trim();
  return /^Called\s+\d+\s+tool\(s\)(?:\.\s*No more pending tool calls)?\.?$/i.test(value);
}

function shouldContinueIncompleteWork(session = {}, finalText = '', toolCalls = [], upstreamError = '', continuationCount = 0, options = {}) {
  if (upstreamError) return false;
  if (Array.isArray(toolCalls) && toolCalls.length) return false;
  const maxContinuations = options.sawReadOnlyTool && !options.sawMutationTool
    ? getMaxReadOnlyExplorationContinuationCount(session)
    : getMaxIncompleteContinuationCount(session);
  if (maxContinuations > 0 && continuationCount >= maxContinuations) return false;
  const incompleteTodos = getIncompleteTodos(session);
  if (incompleteTodos.length > 0) return true;
  const incompleteText = looksLikeIncompleteContinuationText(finalText);
  if (incompleteText) return true;
  if (looksLikeReadOnlyExplorationStillInProgress(session, finalText, options)) return true;
  if (!options.sawMutationTool) return false;
  return false;
}

function shouldForceReadOnlyContinuationToolCall(session = {}, finalText = '', options = {}) {
  if (!looksLikeReadOnlyExplorationStillInProgress(session, finalText, options)) return false;
  return Boolean(getReadOnlyContinuationTargetPath(session));
}

function buildIncompleteContinuationMessage(session = {}, finalText = '', continuationCount = 0) {
  const incompleteTodos = getIncompleteTodos(session).slice(0, 12);
  const recentToolResults = getRecentToolResultContext(session, 6);
  const sawMutationTool = Array.isArray(session?.toolResultSummaries)
    && session.toolResultSummaries.some((entry) => isMutationToolName(entry?.tool));
  const sawReadOnlyTool = Array.isArray(session?.toolResultSummaries)
    && session.toolResultSummaries.some((entry) => isReadOnlyContextToolName(entry?.tool));
  const readOnlyContinuationTarget = getReadOnlyContinuationTargetPath(session);
  const readOnlyContinuationTargetDisplay = readOnlyContinuationTarget
    ? toWorkspaceRelativePath(readOnlyContinuationTarget, getSessionWorkspaceRoot(session)) || readOnlyContinuationTarget
    : '';
  const maxContinuations = sawReadOnlyTool && !sawMutationTool
    ? getMaxReadOnlyExplorationContinuationCount(session)
    : getMaxIncompleteContinuationCount(session);
  return {
    role: 'user',
    content: [
      `Continuation request ${Number(continuationCount) + 1}/${formatContinuationLimitForLog(maxContinuations)}.`,
      'Structured relay state: no tool call was emitted in the last upstream response.',
      String(finalText || '').trim() ? `Latest assistant text captured as context only:\n${String(finalText || '').trim()}` : '',
      incompleteTodos.length ? `Incomplete todos:\n${incompleteTodos.map((todo) => `- ${todo.status}: ${todo.content}`).join('\n')}` : '',
      recentToolResults.length ? `Recent tool results:\n${recentToolResults.map((line) => `- ${line}`).join('\n')}` : '',
      readOnlyContinuationTargetDisplay ? `Read-only continuation target: ${readOnlyContinuationTargetDisplay}` : '',
      sawReadOnlyTool && !sawMutationTool
        ? (
          readOnlyContinuationTargetDisplay
            ? `The latest assistant text looks like an intermediate planning/progress note after read-only inspection of "${readOnlyContinuationTargetDisplay}", not a final answer. Use a tool call now to continue working on that file; do not stop at another acknowledgement-only reply.`
            : 'The latest assistant text looks like an intermediate planning/progress note after read-only inspection, not a final answer. Continue with the necessary Read/Grep/Glob/LS/Shell calls, or provide a substantive final answer if the requested analysis is actually complete.'
        )
        : 'Use a tool call now to continue the unresolved work. If you need current file content, call Read/Grep/Glob/LS. If you can apply the change, call Write/PatchEdit/StrReplace/Shell/TodoWrite as appropriate.',
    ].filter(Boolean).join('\n'),
  };
}

function formatContinuationLimitForLog(limit) {
  return Number(limit) > 0 ? String(Math.floor(Number(limit))) : 'unlimited';
}

function buildModeRuntimeHelpers(session = {}) {
  return {
    getIncompleteTodos,
    looksLikeIncompleteContinuationText,
    looksLikeReadOnlyExplorationStillInProgress,
    getMaxReadOnlyExplorationContinuationCount,
    getMaxIncompleteContinuationCount,
    getReadOnlyContinuationTargetPath,
    toWorkspaceRelativePath,
    getSessionWorkspaceRoot,
    getRecentToolResultContext,
    formatContinuationLimitForLog,
    textLooksLikeSubstantiveFinalAnswer,
    isMutationToolName,
    isReadOnlyContextToolName,
    canonicalToolName,
    session,
  };
}

function getModeHandlerForSession(session = {}) {
  return getModeHandler(getSessionAgentMode(session));
}

function getUpstreamRequestOptionsByMode(session = {}, context = {}) {
  return getUpstreamRequestOptionsForMode(getSessionAgentMode(session), {
    ...context,
    session,
  });
}

function buildFetchUpstreamOptionsForSession(session = {}, baseOptions = {}, context = {}) {
  return {
    ...getUpstreamRequestOptionsByMode(session, context),
    ...baseOptions,
  };
}

function interceptToolExecutionByMode(session = {}, toolCall = {}, context = {}) {
  const handler = getModeHandlerForSession(session);
  if (typeof handler.interceptToolExecution !== 'function') return null;
  return handler.interceptToolExecution(session, toolCall, context, buildModeRuntimeHelpers(session));
}

function getMaxContinuationCountByMode(session = {}, options = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.getMaxContinuationCount === 'function') {
    return handler.getMaxContinuationCount(session, options, helpers);
  }
  return options.sawReadOnlyTool && !options.sawMutationTool
    ? getMaxReadOnlyExplorationContinuationCount(session)
    : getMaxIncompleteContinuationCount(session);
}

function shouldContinueIncompleteWorkByMode(session = {}, finalText = '', toolCalls = [], upstreamError = '', continuationCount = 0, options = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.shouldContinueIncompleteWork === 'function') {
    return handler.shouldContinueIncompleteWork(session, finalText, toolCalls, upstreamError, continuationCount, options, helpers);
  }
  return shouldContinueIncompleteWork(session, finalText, toolCalls, upstreamError, continuationCount, options);
}

function shouldForceContinuationToolChoiceByMode(session = {}, finalText = '', options = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.shouldForceContinuationToolChoice === 'function') {
    return handler.shouldForceContinuationToolChoice(session, finalText, options, helpers);
  }
  return shouldForceReadOnlyContinuationToolCall(session, finalText, options)
    || !options.sawReadOnlyTool
    || options.sawMutationTool
    || getIncompleteTodos(session).length > 0;
}

function buildIncompleteContinuationMessageByMode(session = {}, finalText = '', continuationCount = 0, options = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.buildIncompleteContinuationMessage === 'function') {
    return handler.buildIncompleteContinuationMessage(session, finalText, continuationCount, options, helpers);
  }
  return buildIncompleteContinuationMessage(session, finalText, continuationCount);
}

function getPostToolTurnActionByMode(session = {}, executions = [], context = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.getPostToolTurnAction !== 'function') return null;
  return handler.getPostToolTurnAction(session, executions, context, helpers);
}

function buildPendingInteractionResumeStateByMode(session = {}, pendingInteraction = {}, context = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.buildPendingInteractionResumeState === 'function') {
    return handler.buildPendingInteractionResumeState(session, {
      ...context,
      pendingInteraction,
    }, helpers);
  }
  return {
    userText: String(context.userText || '').trim(),
    upstreamMessages: Array.isArray(context.upstreamMessages)
      ? context.upstreamMessages.map((message) => ({ ...message }))
      : [],
    capturedAt: context.capturedAt || new Date().toISOString(),
    stableConversationId: String(context.stableConversationId || '').trim(),
    requestId: String(context.requestId || session.requestId || '').trim(),
  };
}

function shouldFinalizeInteractionResponseTurnByMode(session = {}, interactionResponse = {}, pendingInteraction = null) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.shouldFinalizeInteractionResponseTurn === 'function') {
    return Boolean(handler.shouldFinalizeInteractionResponseTurn(session, interactionResponse, pendingInteraction, helpers));
  }
  return false;
}

function buildCompletedInteractionStatePatchByMode(session = {}, interactionResponse = {}, pendingInteraction = null) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.buildCompletedInteractionStatePatch === 'function') {
    return handler.buildCompletedInteractionStatePatch(session, interactionResponse, pendingInteraction, helpers);
  }
  return {
    current_loop_status: 'completed',
    waiting_for_interaction: null,
  };
}

function hasIncompleteWorkAtEndByMode(session = {}, finalText = '', toolCalls = [], upstreamError = '', options = {}) {
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  if (typeof handler.hasIncompleteWorkAtEnd === 'function') {
    return handler.hasIncompleteWorkAtEnd(session, finalText, toolCalls, upstreamError, options, helpers);
  }
  return !upstreamError
    && !toolCalls.length
    && (
      getIncompleteTodos(session).length > 0
      || looksLikeIncompleteContinuationText(finalText)
      || looksLikeReadOnlyExplorationStillInProgress(session, finalText, options)
    );
}

function decodeHtmlEntities(text = '') {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16) || 0))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function htmlToReadableText(html = '') {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|nav|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n'))
    .trim();
}

function extractHtmlTitle(html = '') {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtmlEntities(match?.[1] || '').replace(/\s+/g, ' ').trim();
}

function isBlockedWebUrl(rawUrl = '') {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local')) return true;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    if (host === '::1' || host === '[::1]') return true;
    return false;
  } catch {
    return true;
  }
}

async function fetchPublicText(url, options = {}) {
  if (isBlockedWebUrl(url)) {
    return { ok: false, status: 0, url, error: 'Only public http(s) URLs are supported.' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 20000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 CursorPoolRelay/1.0',
        Accept: options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      },
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (/image\/|video\/|audio\/|application\/pdf|application\/octet-stream/.test(contentType)) {
      return { ok: false, status: response.status, url: response.url || url, contentType, error: `Unsupported binary content type: ${contentType || 'unknown'}` };
    }
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, url: response.url || url, contentType, text, error: `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status, url: response.url || url, contentType, text };
  } catch (error) {
    return { ok: false, status: 0, url, error: error?.name === 'AbortError' ? 'Fetch timed out' : error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeDuckDuckGoUrl(value = '') {
  const decoded = decodeHtmlEntities(String(value || ''));
  try {
    const parsed = new URL(decoded, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return parsed.href;
  } catch {
    return decoded;
  }
}

function parseDuckDuckGoResults(html = '') {
  const results = [];
  const blockRegex = /<div[^>]+class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*result[^"]*"|<\/body>|$)/gi;
  const blocks = String(html || '').match(blockRegex) || [];
  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = normalizeDuckDuckGoUrl(linkMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = htmlToReadableText(linkMatch[2]).replace(/\s+/g, ' ').trim();
    const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? htmlToReadableText(snippetMatch[1]).replace(/\s+/g, ' ').trim() : '';
    if (title && !results.some((item) => item.url === url)) {
      results.push({ title, url, snippet });
    }
    if (results.length >= 8) break;
  }
  return results;
}

function buildWebSearchReferences(searchTerm, results = []) {
  const links = results.map((item, index) => `${index + 1}. [${item.title}](${item.url})`).join('\n');
  const highlights = results.map((item, index) => [
    `<result id="${index + 1}">`,
    `<title>${item.title}</title>`,
    `<url>${item.url}</url>`,
    item.snippet ? `<content>${item.snippet}</content>` : '',
    '</result>',
  ].filter(Boolean).join('\n')).join('\n');
  const chunk = [
    'Links:',
    links || 'No search results found.',
    '',
    'Synthesis:',
    results.length
      ? `Search results for "${searchTerm}" returned ${results.length} relevant page(s). Use the links and highlights below for current web context.`
      : `No useful web results were found for "${searchTerm}".`,
    '',
    'Highlights:',
    highlights,
  ].filter((part) => part != null).join('\n');
  return [
    { title: 'Web search results', chunk },
    ...results.slice(0, 5).map((item) => ({
      title: item.title,
      url: item.url,
      chunk: item.snippet || item.title,
    })),
  ];
}

async function executeWebSearchTool(args = {}) {
  const searchTerm = String(args.search_term || args.searchTerm || args.query || '').trim();
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(searchTerm)}`;
  const fetched = await fetchPublicText(url, { timeoutMs: 25000, accept: 'text/html,*/*;q=0.8' });
  if (!fetched.ok) {
    return {
      ok: false,
      tool: 'WebSearch',
      args: { ...args, search_term: searchTerm },
      resultText: `Web search failed: ${fetched.error || `HTTP ${fetched.status}`}`,
      durationMs: 0,
    };
  }
  const results = parseDuckDuckGoResults(fetched.text);
  const references = buildWebSearchReferences(searchTerm, results);
  return {
    ok: true,
    tool: 'WebSearch',
    args: { ...args, search_term: searchTerm },
    resultText: references[0]?.chunk || '',
    references,
    durationMs: 0,
  };
}

async function executeWebFetchTool(args = {}) {
  const url = String(args.url || '').trim();
  const fetched = await fetchPublicText(url, { timeoutMs: 25000 });
  if (!fetched.ok) {
    return {
      ok: false,
      tool: 'WebFetch',
      args: { ...args, url },
      resultText: `Error fetching URL, status code: ${fetched.status || 0}${fetched.error ? ` ${fetched.error}` : ''}`,
      durationMs: 0,
    };
  }
  const title = extractHtmlTitle(fetched.text);
  const markdown = [
    title || fetched.url,
    '',
    htmlToReadableText(fetched.text).slice(0, MAX_TOOL_OUTPUT_CHARS),
  ].filter(Boolean).join('\n');
  return {
    ok: true,
    tool: 'WebFetch',
    args: { ...args, url: fetched.url || url },
    resultText: trimToolOutput(markdown),
    durationMs: 0,
  };
}

async function executeRelayTool(toolCall, session, logger) {
  const tool = String(toolCall.name || '').trim();
  const lower = tool.toLowerCase();
  const args = toolCall.arguments || {};
  const startedAt = Date.now();
  const workspaceRoot = getSessionWorkspaceRoot(session);
  try {
    if (lower === 'read') {
      const filePath = resolveWorkspacePath(args.path || '', session);
      const rawContent = fs.readFileSync(filePath, 'utf8');
      const lines = rawContent.split(/\r?\n/);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Number(args.limit) > 0 ? Number(args.limit) : lines.length;
      const output = buildReadOutput(filePath, args);
      session.readPaths = Array.from(new Set([...(Array.isArray(session.readPaths) ? session.readPaths : []), filePath]));
      return {
        ok: true,
        tool: 'Read',
        args: { ...args, path: filePath, workspaceRoot },
        resultText: trimToolOutput(output),
        readMeta: {
          path: filePath,
          totalLines: lines.length,
          fileSize: Buffer.byteLength(rawContent, 'utf8'),
          content: output,
          rawContent,
          offset,
          limit,
        },
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'write' || lower === 'edit') {
      const filePath = resolveWorkspacePath(args.path || '', session);
      const contents = String(args.contents ?? args.content ?? args.fileText ?? '');
      const beforeContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, 'utf8');
      session.readPaths = Array.from(new Set([...(Array.isArray(session.readPaths) ? session.readPaths : []), filePath]));
      return {
        ok: true,
        tool: 'Write',
        args: { ...args, path: filePath, workspaceRoot, contents: contents.length > 200 ? `${contents.slice(0, 200)}...[truncated]` : contents },
        resultText: `Wrote ${Buffer.byteLength(contents)} bytes to ${filePath}`,
        beforeContent,
        afterContent: contents,
        linesAdded: Math.max(0, countLines(contents) - countLines(beforeContent)),
        linesRemoved: Math.max(0, countLines(beforeContent) - countLines(contents)),
        fileSize: Buffer.byteLength(contents, 'utf8'),
        diffString: buildSimpleUnifiedDiff(filePath, beforeContent, contents),
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'strreplace' || lower === 'patchedit') {
      const filePath = resolveWorkspacePath(args.path || args.target_file || args.targetFile || '', session);
      const oldString = String(args.old_string ?? args.oldStr ?? '');
      const newString = String(args.new_string ?? args.newStr ?? '');
      const replaceAll = args.replace_all === true || args.replaceAll === true;
      const beforeContent = fs.readFileSync(filePath, 'utf8');
      if (oldString === '' && beforeContent === '') {
        fs.writeFileSync(filePath, newString, 'utf8');
        session.readPaths = Array.from(new Set([...(Array.isArray(session.readPaths) ? session.readPaths : []), filePath]));
        return {
          ok: true,
          tool: 'PatchEdit',
          args: { ...args, path: filePath, workspaceRoot, old_string: oldString, new_string: newString },
          resultText: `Patched ${filePath}`,
          beforeContent,
          afterContent: newString,
          linesAdded: countLines(newString),
          linesRemoved: 0,
          fileSize: Buffer.byteLength(newString, 'utf8'),
          diffString: buildSimpleUnifiedDiff(filePath, beforeContent, newString),
          durationMs: Date.now() - startedAt,
        };
      }
      if (!oldString || !beforeContent.includes(oldString)) {
        return { ok: false, tool: canonicalToolName(tool), args: { ...args, path: filePath, workspaceRoot }, resultText: 'old_string was not found in the file.', durationMs: Date.now() - startedAt };
      }
      const afterContent = replaceAll ? beforeContent.split(oldString).join(newString) : beforeContent.replace(oldString, newString);
      fs.writeFileSync(filePath, afterContent, 'utf8');
      session.readPaths = Array.from(new Set([...(Array.isArray(session.readPaths) ? session.readPaths : []), filePath]));
      return {
        ok: true,
        tool: 'PatchEdit',
        args: { ...args, path: filePath, workspaceRoot, old_string: oldString, new_string: newString },
        resultText: `Replaced text in ${filePath}`,
        beforeContent,
        afterContent,
        linesAdded: Math.max(0, countLines(afterContent) - countLines(beforeContent)),
        linesRemoved: Math.max(0, countLines(beforeContent) - countLines(afterContent)),
        fileSize: Buffer.byteLength(afterContent, 'utf8'),
        diffString: buildSimpleUnifiedDiff(filePath, beforeContent, afterContent),
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'delete') {
      const filePath = resolveWorkspacePath(args.path || args.target_file || args.targetFile || '', session);
      const beforeContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      fs.unlinkSync(filePath);
      session.readPaths = Array.from(new Set([...(Array.isArray(session.readPaths) ? session.readPaths : []), filePath]));
      return {
        ok: true,
        tool: 'Delete',
        args: { ...args, path: filePath, workspaceRoot },
        resultText: `Deleted ${filePath}`,
        beforeContent,
        prevContent: beforeContent,
        afterContent: '',
        linesAdded: 0,
        linesRemoved: countLines(beforeContent),
        fileSize: Buffer.byteLength(beforeContent, 'utf8'),
        deletedFile: filePath,
        diffString: buildSimpleUnifiedDiff(filePath, beforeContent, ''),
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'grep') {
      const pattern = String(args.pattern || '').trim();
      const targetPath = resolveWorkspacePath(args.path || '', session);
      const outputMode = String(args.output_mode || args.outputMode || '').toLowerCase();
      const headLimit = Number(args.head_limit || args.headLimit) > 0 ? Number(args.head_limit || args.headLimit) : 100;
      const rgArgs = ['--color', 'never', '--line-number'];
      if (args.multiline === true) rgArgs.push('--multiline');
      if (args['-i'] === true || args.ignore_case === true || args.ignoreCase === true) rgArgs.push('--ignore-case');
      const contextLines = Number(args['-C'] ?? args.context ?? 0) || 0;
      const beforeLines = Number(args['-B'] ?? args.before_context ?? args.beforeContext ?? 0) || 0;
      const afterLines = Number(args['-A'] ?? args.after_context ?? args.afterContext ?? 0) || 0;
      if (contextLines > 0) {
        rgArgs.push('-C', String(Math.min(contextLines, 80)));
      } else {
        if (beforeLines > 0) rgArgs.push('-B', String(Math.min(beforeLines, 80)));
        if (afterLines > 0) rgArgs.push('-A', String(Math.min(afterLines, 80)));
      }
      if (outputMode === 'files_with_matches') rgArgs.push('--files-with-matches');
      if (args.glob) rgArgs.push('-g', String(args.glob));
      rgArgs.push(pattern, targetPath);
      const result = await execFilePromise('rg', rgArgs, { timeoutMs: 30000 });
      let output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
      let fallbackUsed = false;
      const noMatch = !result.ok && Number(result.code) === 1;
      if (!result.ok && !noMatch && /access is denied|EPERM|ENOENT|not recognized/i.test(`${output}\n${result.error}`)) {
        fallbackUsed = true;
        const files = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory() ? walkFiles(targetPath, { max: 500 }) : [targetPath];
        const globMatchers = args.glob ? buildGlobMatchers(args.glob) : [];
        const matches = [];
        let regex = null;
        try {
          regex = new RegExp(pattern, args['-i'] === true || args.ignore_case === true || args.ignoreCase === true ? 'i' : '');
        } catch {
          regex = null;
        }
        for (const file of files) {
          if (!matchesGlobPath(file, targetPath, globMatchers)) continue;
          let text = '';
          try {
            text = fs.readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const matched = regex ? regex.test(line) : line.toLowerCase().includes(pattern.toLowerCase());
            if (!matched) continue;
            matches.push(outputMode === 'files_with_matches' ? file : `${file}:${index + 1}:${line}`);
            if (matches.length >= headLimit) break;
          }
          if (matches.length >= headLimit) break;
        }
        output = matches.join('\n');
      }
      const limitedOutput = output
        ? output.split(/\r?\n/).slice(0, headLimit).join('\n')
        : `No matches for ${JSON.stringify(pattern)} under ${targetPath}${args.glob ? ` (glob: ${args.glob})` : ''}.`;
      const grepResult = parseGrepOutputToStructured(limitedOutput, { ...args, output_mode: outputMode }, workspaceRoot);
      return {
        ok: result.ok || noMatch || fallbackUsed || Boolean(result.stdout),
        tool: 'Grep',
        args: { ...args, path: targetPath, workspaceRoot, fallbackUsed, noMatch },
        resultText: trimToolOutput(limitedOutput),
        grepResult,
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'glob') {
      const targetPath = resolveWorkspacePath(args.target_directory || args.path || '', session);
      const pattern = String(args.glob_pattern || args.pattern || '*').trim() || '*';
      const globMatchers = buildGlobMatchers(pattern);
      const files = walkFiles(targetPath, { max: 1000 })
        .filter((file) => matchesGlobPath(file, targetPath, globMatchers))
        .slice(0, 200);
      const resultText = files.length
        ? files.join('\n')
        : `No files matched ${JSON.stringify(pattern)} under ${targetPath}.`;
      return { ok: true, tool: 'Glob', args: { ...args, path: targetPath, glob_pattern: pattern, workspaceRoot }, resultText, noMatches: files.length === 0, durationMs: Date.now() - startedAt };
    }
    if (lower === 'ls') {
      const targetPath = resolveWorkspacePath(args.path || '', session);
      const directoryTree = buildLsDirectoryTreeNode(targetPath, args.ignore);
      const fileCount = countFilesInDirectoryTree(directoryTree);
      const listing = listDirectory(targetPath, args.ignore);
      const resultText = listing
        ? `ls success path=${targetPath} files=${fileCount}\n${listing}`
        : `ls success path=${targetPath} files=0`;
      return {
        ok: true,
        tool: 'LS',
        args: { ...args, path: targetPath, workspaceRoot },
        resultText,
        directoryTree,
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'websearch' || lower === 'web_search') {
      const execution = await executeWebSearchTool(args);
      return {
        ...execution,
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'webfetch' || lower === 'web_fetch' || lower === 'fetch') {
      const execution = await executeWebFetchTool(args);
      return {
        ...execution,
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'semanticsearch') {
      const execution = await executeSemanticSearchTool(args, session);
      return {
        ...execution,
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'readlints' || lower === 'diagnostics') {
      const paths = (Array.isArray(args.paths) ? args.paths : [args.path].filter(Boolean))
        .map((item) => resolveWorkspacePath(item, session))
        .filter(Boolean);
      const existing = paths.filter((item) => {
        try {
          return fs.existsSync(item) && fs.statSync(item).isFile();
        } catch {
          return false;
        }
      });
      const resultText = existing.length
        ? existing.map((item) => `diagnostics success path=${item} count=0`).join('\n')
        : 'diagnostics success count=0';
      return {
        ok: true,
        tool: 'ReadLints',
        args: { ...args, paths: existing.length ? existing : paths, workspaceRoot },
        resultText,
        diagnosticCount: 0,
        durationMs: Date.now() - startedAt,
      };
    }
    if (isTodoToolName(lower)) {
      const todos = updateSessionTodos(session, args.todos, args.merge === true);
      const merge = args.merge === true;
      const resultText = `todo update success count=${todos.length} merge=${merge ? 'true' : 'false'}`;
      return {
        ok: true,
        tool: 'TodoWrite',
        args: { merge, todos },
        resultText,
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'askquestion') {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const title = String(args.title || '').trim();
      const resultText = JSON.stringify({ title, questions }, null, 2);
      return {
        ok: true,
        tool: 'AskQuestion',
        args: { title, questions },
        resultText: trimToolOutput(resultText),
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'createplan') {
      const markdown = formatPlanMarkdown(args);
      const conversationId = String(getSessionStableConversationId(session) || 'plan').trim();
      const planRoot = getRelayPlanRoot(session.config || {});
      const planDir = path.join(planRoot, conversationId);
      fs.mkdirSync(planDir, { recursive: true });
      const fileName = `${sanitizePlanFilename(args.name || 'plan')}.md`;
      const planPath = path.join(planDir, fileName);
      fs.writeFileSync(planPath, markdown, 'utf8');
      const todos = updateSessionTodos(session, args.todos || [], false);
      return {
        ok: true,
        tool: 'CreatePlan',
        args: {
          name: String(args.name || '').trim(),
          overview: String(args.overview || '').trim(),
          plan: String(args.plan || '').trim(),
          todos,
        },
        resultText: `Plan created at ${planPath}`,
        planPath,
        markdown,
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'task') {
      const execution = await executeTaskTool(args, session);
      return {
        ...execution,
        durationMs: Date.now() - startedAt,
      };
    }
    if (lower === 'shell') {
      const command = String(args.command || '').trim();
      const cwd = resolveWorkspacePath(args.working_directory || args.cwd || '', session);
      const timeoutMs = Math.min(Math.max(Number(args.timeout_ms || args.timeoutMs) || 30000, 1000), 120000);
      const blockUntilMs = Number(args.block_until_ms ?? args.blockUntilMs);
      const isBackground = args.is_background === true || args.isBackground === true || blockUntilMs === 0;
      if (isBackground) {
        const spawned = spawnBackgroundShell(command, cwd, session);
        return {
          ok: true,
          tool: 'Shell',
          args: { ...args, cwd, workspaceRoot, is_background: true },
          resultText: `Started background command pid=${spawned.pid}\nTerminal log: ${spawned.logPath}`,
          pid: spawned.pid,
          terminalLogPath: spawned.logPath,
          durationMs: Date.now() - startedAt,
        };
      }
      const invocation = buildShellInvocation(command);
      const result = await execFilePromise(invocation.file, invocation.args, { cwd, timeoutMs });
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
      const resultText = output || `Command exited with code ${Number(result.code) || 0} and produced no output.`;
      return {
        ok: result.ok,
        tool: 'Shell',
        args: { ...args, cwd, workspaceRoot, shell: invocation.shell },
        resultText: trimToolOutput(resultText),
        exitCode: Number(result.code) || 0,
        durationMs: Date.now() - startedAt,
      };
    }
    return { ok: false, tool, args, resultText: `Unsupported tool: ${tool}`, durationMs: Date.now() - startedAt };
  } catch (error) {
    logger?.error?.(`agent local relay tool ${tool || '-'} failed: ${error.message}`);
    return { ok: false, tool, args, resultText: error.message, durationMs: Date.now() - startedAt };
  }
}

function toToolResultMessage(toolCall, execution) {
  return {
    role: 'user',
    content: [
      `Tool ${toolCall.name} (${toolCall.id}) result:`,
      JSON.stringify({
        ok: execution.ok,
        args: execution.args,
        output: execution.resultText,
        durationMs: execution.durationMs,
      }, null, 2),
    ].join('\n'),
  };
}

function sanitizePlanFilename(value = '') {
  const text = String(value || '').trim().replace(/[\\/:*?"<>|]+/g, '-');
  return text ? text.slice(0, 80) : `plan-${Date.now().toString(36)}`;
}

function getRelayPlanRoot(config = {}) {
  return path.join(String(config.historyRoot || process.env.CURSOR_RELAY_HISTORY_ROOT || path.join(process.env.USERPROFILE || process.cwd(), '.cursorpool', 'relay', 'history')), 'plans');
}

function formatPlanMarkdown(args = {}) {
  const title = String(args.name || 'Plan').trim() || 'Plan';
  const overview = String(args.overview || '').trim();
  const planBody = String(args.plan || '').trim();
  const todos = Array.isArray(args.todos) ? args.todos : [];
  const lines = [`# ${title}`];
  if (overview) {
    lines.push('', overview);
  }
  if (planBody) {
    lines.push('', planBody);
  }
  if (todos.length) {
    lines.push('', '## Todos');
    todos.forEach((todo) => {
      const id = String(todo?.id || '').trim();
      const content = String(todo?.content || '').trim();
      if (id && content) lines.push(`- [ ] ${id}: ${content}`);
    });
  }
  return `${lines.join('\n').trim()}\n`;
}

async function executeSemanticSearchTool(args = {}, session = {}) {
  const query = String(args.query || '').trim();
  const requestedTargets = Array.isArray(args.target_directories) ? args.target_directories : [];
  const workspaceRoot = getSessionWorkspaceRoot(session);
  const roots = requestedTargets.length
    ? requestedTargets.map((item) => resolveWorkspacePath(item, session)).filter(Boolean)
    : [workspaceRoot];
  const words = query.split(/\s+/).map((item) => item.trim()).filter((item) => item.length >= 2).slice(0, 6);
  const files = [];
  roots.forEach((root) => {
    walkFiles(root, { max: 300 }).forEach((file) => {
      if (!files.includes(file)) files.push(file);
    });
  });
  const matches = [];
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const haystack = text.toLowerCase();
    const score = words.reduce((count, word) => count + (haystack.includes(word.toLowerCase()) ? 1 : 0), 0);
    if (!score) continue;
    const lines = text.split(/\r?\n/);
    const previewLine = lines.find((line) => words.some((word) => line.toLowerCase().includes(word.toLowerCase()))) || lines[0] || '';
    matches.push({ file, score, previewLine: previewLine.trim() });
  }
  matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const topMatches = matches.slice(0, 8);
  const resultText = topMatches.length
    ? topMatches.map((item) => `${item.file}\n  score=${item.score} preview=${item.previewLine}`).join('\n')
    : `No semantic matches found for ${JSON.stringify(query)}.`;
  return {
    ok: true,
    tool: 'SemanticSearch',
    args: { query, target_directories: requestedTargets, workspaceRoot },
    resultText: trimToolOutput(resultText),
    matches: topMatches.map((item) => ({
      score: item.score,
      codeBlock: {
        relativeWorkspacePath: path.relative(workspaceRoot, item.file).replace(/\\/g, '/'),
        contents: item.previewLine,
        range: {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: Math.max(1, item.previewLine.length),
        },
      },
    })),
    durationMs: 0,
  };
}

async function executeTaskTool(args = {}, session = {}) {
  const description = String(args.description || '').trim();
  const prompt = String(args.prompt || '').trim();
  const subagentType = args.subagent_type || args.subagentType || {};
  const isExplore = typeof subagentType === 'object'
    ? Object.prototype.hasOwnProperty.call(subagentType, 'explore')
    : /explore/i.test(String(subagentType || ''));
  if (isExplore) {
    const query = prompt || description || 'Explore the workspace';
    const search = await executeSemanticSearchTool({ query, target_directories: [] }, session);
    return {
      ok: true,
      tool: 'Task',
      args,
      resultText: trimToolOutput([
        `Explore task completed${description ? `: ${description}` : ''}.`,
        search.resultText,
      ].join('\n')),
      conversationSteps: [
        {
          assistant_message: {
            text: search.resultText,
          },
        },
      ],
      agentId: `explore-${Date.now().toString(36)}`,
      isBackground: false,
      durationMs: 0,
    };
  }
  return {
    ok: false,
    tool: 'Task',
    args,
    resultText: 'Only explore-style Task calls are currently supported in local relay mode.',
    durationMs: 0,
  };
}

async function streamAgentUpstreamResponse(upstream, session, options = {}) {
  const textParts = [];
  const reasoningParts = [];
  const toolState = { toolCalls: new Map() };
  let upstreamError = '';
  let deltaCount = 0;
  let firstDeltaLogged = false;
  const eventTypeCounts = new Map();
  const phase = String(options.phase || 'stream');
  const startedAt = Date.now();
  const stopOnToolCall = options.stopOnToolCall === true;
  const stopAfterTextMs = Number(options.stopAfterTextMs) > 0 ? Number(options.stopAfterTextMs) : 0;
  const reasoningOnlyMaxMs = Number(options.reasoningOnlyMaxMs) > 0 ? Number(options.reasoningOnlyMaxMs) : 0;
  const textFilter = options.filterInlineThinking === true ? createInlineThinkingTextFilter() : null;
  let lastTextAt = 0;
  let sawDone = false;
  let loggedEarlyToolStop = false;
  let thinkingStartedAt = 0;
  let firstReasoningAt = 0;
  let upstreamUsage = null;
  let durationMs = 0;
  let eventTypes = '';
  session.logger?.info?.(`agent local relay upstream stream start requestId=${session.requestId || '-'} phase=${phase}`);
  try {
    session.currentUpstreamToolState = toolState;
    await parseSseStream(upstream, (delta, eventName, payload) => {
      if (!session.active || session.aborted) return;
      deltaCount += 1;
      const payloadType = String(payload?.type || eventName || 'unknown');
      eventTypeCounts.set(payloadType, (eventTypeCounts.get(payloadType) || 0) + 1);
      emitUpstreamToolStartedFrame(session, payload);
      if (!firstDeltaLogged) {
        firstDeltaLogged = true;
        session.logger?.info?.(
          `agent local relay upstream stream first-delta requestId=${session.requestId || '-'} phase=${phase} event=${eventName || '-'} payloadType=${String(payload?.type || '-')} textLen=${String(delta?.text || '').length} reasoningLen=${String(delta?.reasoning || '').length} error=${JSON.stringify(delta?.error || '')}`,
        );
      }
      if (options.collectTools) collectToolCallsFromPayload(payload, toolState);
      emitUpstreamToolArgumentProgress(session, payload, session.lastUserMessageCapture?.userText || '');
      if (payload?.usage && typeof payload.usage === 'object') upstreamUsage = payload.usage;
      else if (delta?.usage && typeof delta.usage === 'object') upstreamUsage = delta.usage;
      if (delta.done) sawDone = true;
      if (stopOnToolCall && !loggedEarlyToolStop && normalizeCollectedToolCalls(toolState).length > 0) {
        loggedEarlyToolStop = true;
        session.logger?.info?.(
          `agent local relay upstream stream early-stop tool-call requestId=${session.requestId || '-'} phase=${phase}`,
        );
      }
      if (delta.done && textParts.length) return;
      if (delta.error) {
        upstreamError = delta.error;
        if (textParts.length) {
          session.logger?.info?.(`agent local relay upstream stream ended with error after text requestId=${session.requestId || '-'} error=${JSON.stringify(upstreamError)}`);
          upstreamError = '';
        }
        return;
      }
      if (delta.reasoning) {
        const reasoning = String(delta.reasoning || '');
        if (reasoning.length) {
          if (!firstReasoningAt) firstReasoningAt = Date.now();
          reasoningParts.push(reasoning);
          if (options.emit !== false && options.emitThinking === true) {
            if (!thinkingStartedAt) thinkingStartedAt = Date.now();
            writeAgentFrame(session, buildAgentThinkingDeltaFrame(reasoning));
          }
        }
      }
      if (delta.text) {
        const text = textFilter ? textFilter.push(delta.text) : delta.text;
        if (!text) return;
        textParts.push(text);
        lastTextAt = Date.now();
        if (shouldSuppressVisiblePlanText(session, options)) {
          stashSuppressedPlanText(session, text);
        } else if (options.emit !== false) {
          writeAgentTextFrame(session, text);
        }
      }
    }, {
      idleTimeoutMs: options.idleTimeoutMs,
      maxDurationMs: options.maxDurationMs,
      signal: session.abortController?.signal || null,
      extendMaxDurationOnActivity: options.extendMaxDurationOnActivity === true,
      shouldStop: () => {
        if (upstreamUsage) return true;
        if (stopOnToolCall && normalizeCollectedToolCalls(toolState).length > 0) return false;
        if (stopAfterTextMs > 0 && lastTextAt > 0 && Date.now() - lastTextAt >= stopAfterTextMs) return true;
        if (
          reasoningOnlyMaxMs > 0
          && firstReasoningAt > 0
          && !lastTextAt
          && normalizeCollectedToolCalls(toolState).length === 0
          && Date.now() - firstReasoningAt >= reasoningOnlyMaxMs
        ) {
          upstreamError = `上游模型持续只输出 Thought/思考内容超过 ${Math.round(reasoningOnlyMaxMs / 1000)} 秒，本地 Relay 已停止等待以避免空转。`;
          session.logger?.warn?.(
            `agent local relay upstream stream reasoning-only stop requestId=${session.requestId || '-'} phase=${phase} maxMs=${reasoningOnlyMaxMs} reasoningLen=${reasoningParts.join('').length}`,
          );
          return true;
        }
        return false;
      },
    });
  } finally {
    const tailText = textFilter ? textFilter.flush() : '';
    if (tailText && session.active && !session.aborted) {
      textParts.push(tailText);
      if (shouldSuppressVisiblePlanText(session, options)) {
        stashSuppressedPlanText(session, tailText);
      } else if (options.emit !== false) {
        writeAgentTextFrame(session, tailText);
      }
    }
    if (thinkingStartedAt && session.active && !session.aborted && options.emit !== false && options.emitThinking === true) {
      writeAgentFrame(session, buildAgentThinkingCompletedFrame(Date.now() - thinkingStartedAt));
    }
    if (session.currentUpstreamToolState === toolState) session.currentUpstreamToolState = null;
    eventTypes = Array.from(eventTypeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([type, count]) => `${type}:${count}`)
      .join(',');
    durationMs = Date.now() - startedAt;
    session.logger?.info?.(
      `agent local relay upstream stream end requestId=${session.requestId || '-'} phase=${phase} deltaCount=${deltaCount} textLen=${textParts.join('').length} reasoningLen=${reasoningParts.join('').length} toolCalls=${normalizeCollectedToolCalls(toolState).length} eventTypes=${JSON.stringify(eventTypes)} error=${JSON.stringify(upstreamError)} durationMs=${durationMs}`,
    );
    if (options.emit !== false && textParts.join('').trim() && !shouldSuppressVisiblePlanText(session, options)) {
      flushAgentTextToHistory(session);
    }
  }
  return {
    text: textParts.join(''),
    reasoning: reasoningParts.join(''),
    upstreamError,
    toolCalls: normalizeCollectedToolCalls(toolState),
    usage: upstreamUsage,
    durationMs,
    deltaCount,
    eventTypes,
  };
}

function isRecoverableStreamError(errorText) {
  return /idle timeout|max duration exceeded|upstream timeout|暂时无响应/i.test(String(errorText || ''));
}

function shouldRecoverPostToolStream(upstreamError, finalText, toolCalls = [], recoveryCount = 0) {
  if (Array.isArray(toolCalls) && toolCalls.length) return false;
  if (recoveryCount >= MAX_POST_TOOL_STREAM_RECOVERIES) return false;
  if (!String(finalText || '').trim()) return true;
  if (isPlaceholderFinalText(finalText)) return true;
  if (isRecoverableStreamError(upstreamError)) return true;
  // After a prior post-tool stall, text-only without tool calls is still structurally incomplete.
  if (recoveryCount > 0) return true;
  return false;
}

function buildPostToolRecoveryMessage(upstreamError, recoveryCount = 0) {
  return {
    role: 'user',
    content: [
      `The previous upstream stream stalled before producing a final answer or another tool call (${String(upstreamError || 'stream stalled')}).`,
      `Recovery attempt ${Number(recoveryCount) + 1}/${MAX_POST_TOOL_STREAM_RECOVERIES}.`,
      'Continue from the tool results above. If another tool is required, call it; otherwise provide the final answer. Do not restart the task from scratch.',
    ].join('\n'),
  };
}

function shouldTreatStreamErrorAsComplete(upstreamError, finalText) {
  void finalText;
  if (!upstreamError) return false;
  if (!isRecoverableStreamError(upstreamError)) return false;
  return false;
}

async function executeRelayToolCalls(session, toolCalls, requestId, logger) {
  flushAgentTextToHistory(session);
  const toolResultMessages = [];
  const executions = [];
  session.executedToolSignatures = session.executedToolSignatures || new Set();
  session.executedToolResultsBySignature = session.executedToolResultsBySignature || new Map();
  session.toolResultSummaries = session.toolResultSummaries || [];
  const maxToolCallsPerRound = getMaxLocalToolCallsPerRound(session?.config || {});
  for (const rawToolCall of toolCalls.slice(0, maxToolCallsPerRound)) {
    const toolCall = normalizeToolCallPathsForWorkspace(rawToolCall, session);
    const signature = getToolCallSignature(toolCall, session);
    if (signature && session.executedToolSignatures.has(signature)) {
      const previousExecution = session.executedToolResultsBySignature.get(signature);
      logger.info(`agent local relay duplicate tool skipped requestId=${requestId} tool=${toolCall.name} signature=${JSON.stringify(signature)}`);
      const duplicateExecution = {
        ok: previousExecution ? Boolean(previousExecution.ok) : false,
        tool: toolCall.name,
        args: previousExecution?.args || toolCall.arguments || {},
        resultText: previousExecution?.resultText
          ? `Duplicate tool call skipped; returning prior result.\n${previousExecution.resultText}`
          : 'Duplicate tool call skipped; prior result is already available.',
        durationMs: 0,
        duplicateToolSkipped: true,
      };
      toolResultMessages.push(toToolResultMessage(toolCall, duplicateExecution));
      executions.push({
        toolCall,
        execution: duplicateExecution,
      });
      continue;
    }
    if (signature) session.executedToolSignatures.add(signature);
    const toolCallId = toolCall.id || `tool_${Date.now().toString(36)}`;
    const modelCallId = `model_${toolCallId}`;
    const historyToolName = canonicalToolName(toolCall.name);
    const editLikeTool = isEditLikeToolName(toolCall.name);
    let nativeEditDetails = null;
    if (editLikeTool) {
      const editPath = resolveWorkspacePath(toolCall.arguments?.path || toolCall.arguments?.target_file || toolCall.arguments?.targetFile || '', session);
      let beforeContent = '';
      if (editPath && fs.existsSync(editPath) && !fs.statSync(editPath).isDirectory()) {
        beforeContent = fs.readFileSync(editPath, 'utf8');
      }
      const afterContent = buildNativeEditFileText(toolCall.name, toolCall.arguments || {}, session);
      nativeEditDetails = {
        path: editPath,
        beforeContent,
        afterContent,
        oldString: String(toolCall.arguments?.old_string ?? toolCall.arguments?.oldStr ?? ''),
        newString: String(toolCall.arguments?.new_string ?? toolCall.arguments?.newStr ?? ''),
      };
      toolCall.arguments = {
        ...(toolCall.arguments || {}),
        path: editPath || toolCall.arguments?.path || '',
        contents: afterContent,
        content: afterContent,
        stream_content: getEditStreamSnippetFromArgs(toolCall.arguments || {}),
      };
    }
    appendSessionHistory(session, {
      role: 'assistant',
      kind: 'tool_call',
      tool_call_id: toolCallId,
      payload: {
        tool_call_id: toolCallId,
        tool_name: historyToolName,
        provider: toolCall.provider || '',
        provider_status: 'completed',
        arguments: toolCall.arguments || {},
      },
    });
    const useNativeExec = shouldUseNativeExecForTool(session, toolCall);
    const isMutation = isMutationToolName(toolCall.name);
    const emitToolInteraction = session?.config?.emitLocalToolInteractionFrames !== false || editLikeTool;
    const emitStepFrames = shouldEmitLocalStepFrames(session?.config || {});
    const stepId = (session.nextStepId = (Number(session.nextStepId) || 0) + 1);
    const stepStartedAt = Date.now();
    let execution = interceptToolExecutionByMode(session, toolCall, { startedAt: stepStartedAt });
    if (emitToolInteraction) {
      if (emitStepFrames) writeAgentFrame(session, buildAgentStepStartedFrame(stepId));
      const streamedEditState = editLikeTool ? session.upstreamToolArgumentStreams?.get(toolCallId) : null;
      if (editLikeTool) {
        if (!streamedEditState?.emittedPath) {
          writeAgentFrame(session, buildAgentPartialToolCallFrame(toolCall.name, buildLeanEditToolArguments(toolCall.arguments), toolCallId, modelCallId));
        }
        if (!session.upstreamToolArgumentStreams?.get(toolCallId)?.emittedContentLength) {
          emitEditToolCallDeltaFrames(session, toolCall, toolCallId, modelCallId);
        }
      } else {
        writeAgentFrame(session, buildAgentPartialToolCallFrame(toolCall.name, toolCall.arguments, toolCallId, modelCallId));
      }
      if (!editLikeTool || !streamedEditState?.completedStarted) {
        writeAgentFrame(session, buildAgentToolCallStartedFrame(
          toolCall.name,
          editLikeTool
            ? buildLeanEditToolArguments(toolCall.arguments)
            : toolCall.arguments,
          toolCallId,
          modelCallId,
        ));
        if (streamedEditState) streamedEditState.completedStarted = true;
      }
    }
    if (!execution && useNativeExec) {
      const numericExecId = (session.nextExecNumericId = (Number(session.nextExecNumericId) || 0) + 1);
      session.execIdByNumericId = session.execIdByNumericId || new Map();
      session.execIdByNumericId.set(numericExecId, toolCallId);
      const execFrame = buildExecServerFrameForTool(toolCall.name, toolCall.arguments, toolCallId, numericExecId, session);
      if (execFrame) {
        writeAgentFrame(session, execFrame);
        appendSessionHistory(session, {
          role: 'system',
          kind: 'metadata',
          payload: {
            type: 'exec_dispatch',
            value: {
              exec_id: toolCallId,
              exec_kind: historyToolName,
              model_call_id: modelCallId,
              tool_call_id: toolCallId,
              tool_name: historyToolName,
              numeric_exec_id: numericExecId,
              dispatch_order: 'started_then_checkpoint_then_exec',
            },
          },
        });
        logger.info(`agent local relay exec_server sent requestId=${requestId} tool=${toolCall.name} execId=${toolCallId} nativeMutation=${isMutation ? '1' : '0'}`);
        // eslint-disable-next-line no-await-in-loop
        const clientResult = await waitForExecClientResult(
          session,
          toolCallId,
          isMutation ? Math.max(EXEC_CLIENT_WAIT_TIMEOUT_MS, 20000) : EXEC_CLIENT_WAIT_TIMEOUT_MS,
        );
        if (clientResult.ok) {
          logger.info(
            `agent local relay exec_client completed requestId=${requestId} tool=${toolCall.name} execId=${toolCallId} messages=${clientResult.messages.length} durationMs=${clientResult.durationMs}`,
          );
          execution = enrichNativeEditExecution(buildExecutionFromExecClient(toolCall, clientResult, session), toolCall, nativeEditDetails);
          if (isLocalContextToolName(toolCall.name)) {
            const contextExecution = await buildUpstreamContextExecution(toolCall, session, logger);
            if (contextExecution) {
              execution = {
                ...contextExecution,
                durationMs: Math.max(Number(execution.durationMs) || 0, Number(contextExecution.durationMs) || 0),
              };
            }
          }
        } else {
          logger.info(
            `agent local relay exec_client wait ended without native ack requestId=${requestId} tool=${toolCall.name} execId=${toolCallId} timedOut=${clientResult.timedOut ? '1' : '0'}`,
          );
          if (isMutation) {
            execution = buildNativeExecMissingExecution(toolCall, clientResult, session);
          }
        }
      } else if (isMutation) {
        execution = buildNativeExecMissingExecution(toolCall, { timedOut: false, durationMs: 0 }, session);
      }
    } else {
      logger.info(`agent local relay exec_server skipped requestId=${requestId} tool=${toolCall.name} reason=disabled`);
    }
    if (!execution) {
      // eslint-disable-next-line no-await-in-loop
      execution = await executeRelayTool(toolCall, session, logger);
    }
    let interactionQueryDispatch = null;
    if (!execution?.pendingNativeMutation && shouldDispatchInteractionQueryForTool(session, toolCall, execution)) {
      interactionQueryDispatch = buildInteractionQueryFrameForTool(session, toolCall, toolCallId);
      if (interactionQueryDispatch?.frame) {
        writeAgentFrame(session, interactionQueryDispatch.frame);
        registerPendingInteractionQuery(session, {
          queryId: interactionQueryDispatch.queryId,
          kind: interactionQueryDispatch.kind,
          toolCallId,
          toolName: historyToolName,
          arguments: toolCall.arguments || {},
          execution,
          stableConversationId: getSessionStableConversationId(session),
          workspaceRoot: getSessionWorkspaceRoot(session),
          createdAt: new Date().toISOString(),
        });
        appendInteractionQueryToHistory(session, {
          queryId: interactionQueryDispatch.queryId,
          kind: interactionQueryDispatch.kind,
          toolCallId,
          toolName: historyToolName,
          arguments: toolCall.arguments || {},
        });
        logger.info(
          `agent local relay interaction_query sent requestId=${requestId} tool=${toolCall.name} queryId=${interactionQueryDispatch.queryId} kind=${interactionQueryDispatch.kind}`,
        );
      }
      execution = {
        ...execution,
        awaitingInteractionResponse: true,
        interactionQueryId: interactionQueryDispatch?.queryId || 0,
        interactionQueryKind: interactionQueryDispatch?.kind || '',
      };
    }
    if (!execution?.pendingNativeMutation) {
      if (emitToolInteraction) {
        const completionArgs = editLikeTool
          ? buildLeanEditToolArguments(toolCall.arguments)
          : toolCall.arguments;
        const completionExecution = editLikeTool
          ? buildLeanEditToolCompletionExecution(execution)
          : execution;
        writeAgentFrame(
          session,
          buildAgentToolCallCompletedFrame(toolCall.name, completionArgs, toolCallId, modelCallId, { execution: completionExecution }),
        );
      }
      if (!interactionQueryDispatch) emitVisibleToolResultSummary(session, toolCall, execution);
      if (String(toolCall.name || '').trim().toLowerCase() === 'createplan' && execution?.ok) {
        session.planTurnHandoff = 'create_plan';
        const planState = buildPlanStateFromExecution(session, execution);
        if (planState) {
          updateSessionHistoryState(session, {
            current_loop_status: 'waiting_for_interaction',
            waiting_for_interaction: {
              handoff: 'create_plan',
              pending_count: 1,
              since: new Date().toISOString(),
            },
            plan: planState,
          });
        }
        emitPlanConversationCheckpointFrames(session, { ...toolCall, id: toolCallId }, execution, logger);
      }
      if (isMutation && execution?.ok) {
        emitAgentMutationCheckpointFrames(session, { ...toolCall, id: toolCallId }, execution, logger);
        appendLatestEditReminder(session, execution.args?.path || toolCall.arguments?.path || '');
      }
    }
    const structuredToolCall = buildStructuredToolCallSnapshot(
      toolCall.name,
      toolCall.arguments || {},
      execution,
      toolCallId,
    );
    if (!execution?.awaitingInteractionResponse) {
      appendSessionHistory(session, {
        role: 'tool',
        kind: 'tool_result',
        tool_call_id: toolCallId,
        payload: {
          tool_call_id: toolCallId,
          tool_name: historyToolName,
          arguments: JSON.stringify(toolCall.arguments || {}),
          result_text: execution?.resultText || '',
          ok: Boolean(execution?.ok),
          duration_ms: Number(execution?.durationMs) || 0,
          ...(structuredToolCall ? { tool_call: structuredToolCall } : {}),
        },
      });
    }
    session.toolResultSummaries.push({
      tool: historyToolName,
      ok: Boolean(execution?.ok),
      path: execution?.args?.path || execution?.args?.cwd || '',
      resultText: execution?.resultText || '',
    });
    logger.info(
      `agent local relay tool result requestId=${requestId} tool=${toolCall.name} ok=${execution.ok ? '1' : '0'} nativeExec=${execution.nativeExec ? '1' : '0'} pendingNativeMutation=${execution.pendingNativeMutation ? '1' : '0'} workspaceRoot=${JSON.stringify(getSessionWorkspaceRoot(session))} path=${JSON.stringify(execution.args?.path || execution.args?.cwd || '')} durationMs=${execution.durationMs} outputLen=${String(execution.resultText || '').length}`,
    );
    if (emitToolInteraction && emitStepFrames) {
      writeAgentFrame(session, buildAgentStepCompletedFrame(stepId, Date.now() - stepStartedAt));
    }
    if (signature) session.executedToolResultsBySignature.set(signature, execution);
    toolResultMessages.push(toToolResultMessage(toolCall, execution));
    executions.push({ toolCall, execution });
  }
  updateAgentHistoryUsage(session?.config || {}, { tool_calls: executions.length });
  return { toolResultMessages, executions };
}

async function continueAgentStreamLoop(session, options = {}) {
  const {
    userText = '',
    config = {},
    logger = null,
    streamed: initialStreamed = {},
    upstreamMessages: initialUpstreamMessages = [],
    usageMeta: initialUsageMeta = {},
    configuredModel = '',
    activeUpstream = {},
    upstreamMode: initialUpstreamMode = '',
    requestId = '',
    agentMode = 'AGENT_MODE_AGENT',
    runPostEditLints = false,
    emitThinking = false,
    filterInlineThinking = false,
    reasoningOnlyMaxMs = 0,
  } = options;

  let streamed = initialStreamed;
  let upstreamMode = initialUpstreamMode;
  let finalText = streamed.text || '';
  let finalReasoning = streamed.reasoning || '';
  let upstreamError = streamed.upstreamError || '';
  let usageMeta = initialUsageMeta;
  let compacted = { messages: initialUpstreamMessages, usage: initialUsageMeta };
  let upstreamMessages = Array.isArray(initialUpstreamMessages)
    ? initialUpstreamMessages.map((message) => ({ ...message }))
    : [];
  const maxToolCallsPerRound = getMaxLocalToolCallsPerRound(config);
  let toolCalls = attachDefaultMutationTarget(
    Array.isArray(streamed.toolCalls) ? streamed.toolCalls.slice(0, maxToolCallsPerRound) : [],
    session,
    userText,
  );
  let toolStep = 0;
  let sawWriteTool = false;
  let sawMutationTool = false;
  let sawReadOnlyTool = false;
  let nativeMutationAckMissing = false;
  let pendingNativeMutation = false;
  let completionVerificationCount = 0;
  let incompletePostMutationContinuationCount = 0;
  const maxToolRounds = getMaxLocalToolRounds(config);

  while (session.active && !session.aborted) {
    if (toolCalls.length) {
      if (maxToolRounds > 0 && toolStep >= maxToolRounds) break;
      toolStep += 1;
      logger?.info?.(
        `agent local relay tool plan requestId=${requestId} step=${toolStep} count=${toolCalls.length} tools=${toolCalls.map((call) => call.name).join(',')}`,
      );
      const { toolResultMessages, executions } = await executeRelayToolCalls(session, toolCalls, requestId, logger);
      if (executions.length && executions.every((entry) => entry.execution?.duplicateToolSkipped)) {
        upstreamError = '';
        logger?.info?.(`agent local relay duplicate tool result forwarded requestId=${requestId}; asking upstream to continue`);
      }
      const postToolTurnAction = getPostToolTurnActionByMode(session, executions, {
        requestId,
        toolStep,
        finalText,
        sawWriteTool,
        sawMutationTool,
        sawReadOnlyTool,
      });
      if (postToolTurnAction?.stopTurn) {
        session.planTurnHandoff = postToolTurnAction.handoff || 'mode_handoff';
        const updatedInteractions = updatePendingInteractionResumeState(
          session,
          executions,
          upstreamMessages,
          toolResultMessages,
          streamed.text || '',
          userText,
        );
      if (updatedInteractions > 0) {
        session.waitingForInteraction = true;
        session.waitingInteractionSince = Date.now();
        session.unfinishedWorkAtEnd = false;
        const handler = getModeHandlerForSession(session);
        const helpers = buildModeRuntimeHelpers(session);
        const planState = String(toolCall.name || '').trim().toLowerCase() === 'createplan'
          ? buildPlanStateFromExecution(session, execution)
          : (session.suppressedPlanText ? {
            plan: String(session.suppressedPlanText || '').trim(),
            plan_text: String(session.suppressedPlanText || '').trim(),
            plan_uri: String(execution?.planPath || '').trim(),
            todos: Array.isArray(session.todos) ? session.todos : [],
          } : null);
        const statePatch = typeof handler.buildWaitingForInteractionStatePatch === 'function'
          ? handler.buildWaitingForInteractionStatePatch(session, {
              handoff: session.planTurnHandoff,
              pendingCount: updatedInteractions,
              since: new Date(session.waitingInteractionSince).toISOString(),
              plan: planState,
            }, helpers)
          : {
              current_loop_status: 'waiting_for_interaction',
              waiting_for_interaction: {
                handoff: String(session.planTurnHandoff || '').trim(),
                pending_count: Number(updatedInteractions) || 0,
                since: new Date(session.waitingInteractionSince).toISOString(),
              },
              plan: planState,
            };
        updateSessionHistoryState(session, statePatch);
          logger?.info?.(
            `agent local relay waiting for interaction_response requestId=${requestId} step=${toolStep} handoff=${session.planTurnHandoff} pendingInteractions=${updatedInteractions}`,
          );
          return { waitingForInteraction: true, handoff: session.planTurnHandoff };
        }
        finalText = '';
        toolCalls = [];
        upstreamError = '';
        logger?.info?.(
          `agent local relay post-tool handoff requestId=${requestId} step=${toolStep} handoff=${session.planTurnHandoff} reason=${JSON.stringify(String(postToolTurnAction.reason || ''))}`,
        );
        break;
      }
      nativeMutationAckMissing = executions.some((entry) => entry.execution?.missingNativeAck);
      pendingNativeMutation = executions.some((entry) => entry.execution?.pendingNativeMutation);
      const sawMutationAttempt = executions.some((entry) => isMutationToolName(entry.toolCall?.name));
      if (sawMutationAttempt) sawMutationTool = true;
      if (executions.some((entry) => isReadOnlyContextToolName(entry.toolCall?.name))) {
        sawReadOnlyTool = true;
      }
      const sawMutationExecution = executions.some((entry) => isMutationToolName(entry.toolCall?.name) && entry.execution?.ok);
      if (sawMutationExecution) {
        sawWriteTool = true;
        const lintPaths = executions
          .filter((entry) => isMutationToolName(entry.toolCall?.name) && entry.execution?.ok)
          .map((entry) => entry.execution?.args?.path)
          .filter(Boolean);
        if (runPostEditLints && lintPaths.length && !executions.some((entry) => canonicalToolName(entry.toolCall?.name) === 'ReadLints')) {
          await executeRelayToolCalls(session, [{
            id: `tool_read_lints_${Date.now().toString(36)}`,
            name: 'ReadLints',
            arguments: { paths: Array.from(new Set(lintPaths)) },
            provider: 'relay_post_edit',
          }], requestId, logger);
        }
        upstreamError = '';
      }
      if (pendingNativeMutation) {
        toolCalls = [];
        finalText = '宸插彂閫?Cursor 鍘熺敓宸ュ叿璋冪敤锛屾鍦ㄧ瓑寰呭鎴风澶勭悊銆?';
        writeAgentTextFrame(session, finalText);
        logger?.info?.(`agent local relay native mutation pending requestId=${requestId}; ending turn without local write or retry`);
        break;
      }
      if (nativeMutationAckMissing) {
        toolCalls = [];
        finalText = 'Cursor 瀹㈡埛绔病鏈夎繑鍥炲師鐢熺紪杈戝伐鍏锋墽琛屽洖鎵э紝鏈疆宸插仠姝紝閬垮厤閲嶅淇敼銆?';
        writeAgentTextFrame(session, finalText);
        logger?.info?.(`agent local relay native mutation ack missing requestId=${requestId}; stopping tool loop without local write`);
        break;
      }
      let postToolRecoveryCount = 0;
      upstreamMessages = [
        ...upstreamMessages,
        { role: 'assistant', content: streamed.text?.trim() || `Called ${toolCalls.length} tool(s).` },
        ...toolResultMessages,
        {
          role: 'user',
          content: 'Continue working from these tool results. If another tool is required, call it; otherwise give the final answer.',
        },
      ];
      while (session.active && !session.aborted) {
        const postToolPhase = postToolRecoveryCount > 0
          ? `post_tool_${toolStep}_recover_${postToolRecoveryCount}`
          : `post_tool_${toolStep}`;
        compacted = compactRelayMessagesForContext(upstreamMessages, config, logger, { requestId, phase: postToolPhase });
        upstreamMessages = compacted.messages;
        usageMeta = compacted.usage;
        let upstream;
        let resumedMode = upstreamMode;
        try {
          ({ response: upstream, mode: resumedMode } = await fetchUpstreamCompletion(
            activeUpstream,
            configuredModel,
            upstreamMessages,
            logger,
            buildFetchUpstreamOptionsForSession(session, {
              enableTools: true,
              signal: session.abortController?.signal || null,
              timeoutMs: sawWriteTool
                ? Math.max(POST_TOOL_UPSTREAM_TIMEOUT_MS, 45 * 1000)
                : POST_TOOL_UPSTREAM_TIMEOUT_MS,
              requestId,
              phase: postToolPhase,
              mode: agentMode,
              outboundProxy: config.outboundProxy || null,
              localProxyPort: config.port,
            }, { phase: postToolPhase, agentMode, sawWriteTool }),
          ));
          upstreamMode = resumedMode || upstreamMode;
          if (!upstream.ok) {
            const errorText = await upstream.text().catch(() => '');
            upstreamError = summarizeUpstreamFailure(upstream.status, errorText);
            recordUpstreamUsagePhase(session, config, {
              phase: postToolPhase,
              endpointMode: upstreamMode || String(config.upstream?.endpointMode || 'responses'),
              model: configuredModel,
              status: 'http_error',
              httpStatus: upstream.status,
              error: errorText,
              promptChars: usageMeta.messageChars,
              meta: usageMeta,
            });
            toolCalls = [];
          } else {
            streamed = await streamAgentUpstreamResponse(upstream, session, {
              collectTools: true,
              emit: !sawWriteTool,
              emitThinking,
              phase: postToolPhase,
              idleTimeoutMs: sawWriteTool
                ? POST_TOOL_MUTATION_STREAM_IDLE_TIMEOUT_MS
                : POST_TOOL_STREAM_IDLE_TIMEOUT_MS,
              maxDurationMs: sawWriteTool
                ? Math.max(POST_TOOL_UPSTREAM_TIMEOUT_MS, 45 * 1000)
                : POST_TOOL_UPSTREAM_TIMEOUT_MS,
              extendMaxDurationOnActivity: sawWriteTool,
              stopOnToolCall: true,
              stopAfterTextMs: sawWriteTool ? POST_MUTATION_STOP_AFTER_TEXT_MS : 0,
              reasoningOnlyMaxMs,
              filterInlineThinking,
            });
            finalText = streamed.text;
            finalReasoning = streamed.reasoning;
            upstreamError = streamed.upstreamError;
            toolCalls = attachDefaultMutationTarget(
              streamed.toolCalls.slice(0, maxToolCallsPerRound),
              session,
              userText,
            );
            recordUpstreamUsagePhase(session, config, {
              phase: postToolPhase,
              endpointMode: upstreamMode || String(config.upstream?.endpointMode || 'responses'),
              model: configuredModel,
              status: streamed.upstreamError ? 'stream_error' : 'success',
              error: streamed.upstreamError,
              usage: streamed.usage,
              durationMs: streamed.durationMs,
              promptChars: usageMeta.messageChars,
              responseTextChars: streamed.text.length,
              reasoningChars: streamed.reasoning.length,
              toolCalls: streamed.toolCalls.length,
              meta: { ...usageMeta, deltaCount: streamed.deltaCount, eventTypes: streamed.eventTypes },
            });
          }
        } catch (error) {
          if (session.aborted) return null;
          upstreamError = summarizeFetchError(error);
          toolCalls = [];
          recordUpstreamUsagePhase(session, config, {
            phase: postToolPhase,
            endpointMode: upstreamMode || String(config.upstream?.endpointMode || 'responses'),
            model: configuredModel,
            status: 'fetch_error',
            error: error.message || String(error),
            promptChars: usageMeta.messageChars,
            meta: usageMeta,
          });
          logger?.error?.(`agent local relay post-tool upstream failed requestId=${requestId} phase=${postToolPhase}: ${error.message}`);
        }
        if (!shouldRecoverPostToolStream(upstreamError, finalText, toolCalls, postToolRecoveryCount)) break;
        logger?.info?.(`agent local relay post-tool stream stalled; recovering requestId=${requestId} step=${toolStep} attempt=${postToolRecoveryCount + 1} error=${JSON.stringify(upstreamError)} textPreview=${JSON.stringify(String(finalText || '').slice(0, 200))}`);
        const trimmedRecoveryText = String(finalText || '').trim();
        upstreamMessages = trimmedRecoveryText
          ? [
            ...upstreamMessages,
            { role: 'assistant', content: trimmedRecoveryText },
            buildPostToolRecoveryMessage(upstreamError, postToolRecoveryCount),
          ]
          : [
            ...upstreamMessages,
            buildPostToolRecoveryMessage(upstreamError, postToolRecoveryCount),
          ];
        finalText = '';
        upstreamError = '';
        postToolRecoveryCount += 1;
      }
      while (session.active
        && !session.aborted
        && (sawWriteTool || postToolRecoveryCount > 0)
        && !upstreamError
        && !toolCalls.length
        && completionVerificationCount < MAX_COMPLETION_VERIFICATION_ROUNDS) {
        const completionPhase = `completion_verify_${completionVerificationCount + 1}`;
        logger?.info?.(`agent local relay completion verification requestId=${requestId} step=${toolStep} attempt=${completionVerificationCount + 1} postToolRecoveries=${postToolRecoveryCount} textPreview=${JSON.stringify(String(finalText || '').slice(0, 200))}`);
        const trimmedCandidate = String(finalText || '').trim();
        upstreamMessages = trimmedCandidate
          ? [
            ...upstreamMessages,
            { role: 'assistant', content: trimmedCandidate },
            buildCompletionVerificationMessage(userText, finalText, session, completionVerificationCount),
          ]
          : [
            ...upstreamMessages,
            buildCompletionVerificationMessage(userText, finalText, session, completionVerificationCount),
          ];
        finalText = '';
        upstreamError = '';
        completionVerificationCount += 1;
        compacted = compactRelayMessagesForContext(upstreamMessages, config, logger, { requestId, phase: completionPhase });
        upstreamMessages = compacted.messages;
        usageMeta = compacted.usage;
        let upstream;
        let resumedMode = upstreamMode;
        try {
          ({ response: upstream, mode: resumedMode } = await fetchUpstreamCompletion(
            config.upstream,
            configuredModel,
            upstreamMessages,
            logger,
            buildFetchUpstreamOptionsForSession(session, {
              enableTools: true,
              signal: session.abortController?.signal || null,
              timeoutMs: POST_TOOL_UPSTREAM_TIMEOUT_MS,
              requestId,
              phase: completionPhase,
              mode: agentMode,
              outboundProxy: config.outboundProxy || null,
              localProxyPort: config.port,
            }, { phase: completionPhase, agentMode }),
          ));
          upstreamMode = resumedMode || upstreamMode;
          if (!upstream.ok) {
            const errorText = await upstream.text().catch(() => '');
            upstreamError = summarizeUpstreamFailure(upstream.status, errorText);
            recordUpstreamUsagePhase(session, config, {
              phase: completionPhase,
              endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
              model: configuredModel,
              status: 'http_error',
              httpStatus: upstream.status,
              error: errorText,
              promptChars: usageMeta.messageChars,
              meta: usageMeta,
            });
            toolCalls = [];
          } else {
              streamed = await streamAgentUpstreamResponse(upstream, session, {
              collectTools: true,
              emit: false,
              emitThinking,
              phase: completionPhase,
              idleTimeoutMs: POST_TOOL_MUTATION_STREAM_IDLE_TIMEOUT_MS,
              maxDurationMs: POST_TOOL_UPSTREAM_TIMEOUT_MS,
              extendMaxDurationOnActivity: true,
              stopOnToolCall: true,
              stopAfterTextMs: POST_MUTATION_STOP_AFTER_TEXT_MS,
              reasoningOnlyMaxMs,
              filterInlineThinking,
            });
            finalText = streamed.text;
            finalReasoning = streamed.reasoning;
            upstreamError = streamed.upstreamError;
            toolCalls = attachDefaultMutationTarget(
              streamed.toolCalls.slice(0, maxToolCallsPerRound),
              session,
              userText,
            );
            recordUpstreamUsagePhase(session, config, {
              phase: completionPhase,
              endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
              model: configuredModel,
              status: streamed.upstreamError ? 'stream_error' : 'success',
              error: streamed.upstreamError,
              usage: streamed.usage,
              durationMs: streamed.durationMs,
              promptChars: usageMeta.messageChars,
              responseTextChars: streamed.text.length,
              reasoningChars: streamed.reasoning.length,
              toolCalls: streamed.toolCalls.length,
              meta: { ...usageMeta, deltaCount: streamed.deltaCount, eventTypes: streamed.eventTypes },
            });
          }
        } catch (error) {
          if (session.aborted) return null;
          upstreamError = summarizeFetchError(error);
          toolCalls = [];
          recordUpstreamUsagePhase(session, config, {
            phase: completionPhase,
            endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
            model: configuredModel,
            status: 'fetch_error',
            error: error.message || String(error),
            promptChars: usageMeta.messageChars,
            meta: usageMeta,
          });
          logger?.error?.(`agent local relay completion verification upstream failed requestId=${requestId}: ${error.message}`);
        }
      }
      if (toolCalls.length) continue;
    }

    while (session.active
      && !session.aborted
      && shouldContinueIncompleteWorkByMode(session, finalText, toolCalls, upstreamError, incompletePostMutationContinuationCount, { sawMutationTool, sawReadOnlyTool })) {
      const continuationPhase = `incomplete_continuation_${incompletePostMutationContinuationCount + 1}`;
      const maxIncompleteContinuations = getMaxContinuationCountByMode(session, { sawMutationTool, sawReadOnlyTool });
      const incompleteTodosForContinuation = getIncompleteTodos(session);
      const forceReadOnlyContinuationTool = shouldForceReadOnlyContinuationToolCall(session, finalText, { sawMutationTool, sawReadOnlyTool });
      const forceToolForContinuation = shouldForceContinuationToolChoiceByMode(session, finalText, { sawMutationTool, sawReadOnlyTool });
      const readOnlyContinuationTarget = forceReadOnlyContinuationTool
        ? (toWorkspaceRelativePath(getReadOnlyContinuationTargetPath(session), getSessionWorkspaceRoot(session)) || getReadOnlyContinuationTargetPath(session))
        : '';
      logger?.info?.(`agent local relay incomplete continuation requestId=${requestId} step=${toolStep} attempt=${incompletePostMutationContinuationCount + 1}/${formatContinuationLimitForLog(maxIncompleteContinuations)} sawMutationTool=${sawMutationTool ? 1 : 0} sawReadOnlyTool=${sawReadOnlyTool ? 1 : 0} toolChoice=${forceToolForContinuation ? 'required' : 'auto'} readOnlyTarget=${JSON.stringify(readOnlyContinuationTarget)} textPreview=${JSON.stringify(String(finalText || '').slice(0, 200))} incompleteTodos=${incompleteTodosForContinuation.length}`);
      const trimmedContinuationText = String(finalText || '').trim();
      upstreamMessages = trimmedContinuationText
        ? [
          ...upstreamMessages,
          { role: 'assistant', content: trimmedContinuationText },
          buildIncompleteContinuationMessageByMode(session, finalText, incompletePostMutationContinuationCount, { sawMutationTool, sawReadOnlyTool }),
        ]
        : [
          ...upstreamMessages,
          buildIncompleteContinuationMessageByMode(session, finalText, incompletePostMutationContinuationCount, { sawMutationTool, sawReadOnlyTool }),
        ];
      finalText = '';
      upstreamError = '';
      incompletePostMutationContinuationCount += 1;
      compacted = compactRelayMessagesForContext(upstreamMessages, config, logger, { requestId, phase: continuationPhase });
      upstreamMessages = compacted.messages;
      usageMeta = compacted.usage;
      let upstream;
      let resumedMode = upstreamMode;
      try {
        ({ response: upstream, mode: resumedMode } = await fetchUpstreamCompletion(
          activeUpstream,
          configuredModel,
          upstreamMessages,
          logger,
          buildFetchUpstreamOptionsForSession(session, {
            enableTools: true,
            toolChoice: forceToolForContinuation ? 'required' : 'auto',
            signal: session.abortController?.signal || null,
            timeoutMs: POST_TOOL_UPSTREAM_TIMEOUT_MS,
            requestId,
            phase: continuationPhase,
            mode: agentMode,
            outboundProxy: config.outboundProxy || null,
            localProxyPort: config.port,
          }, { phase: continuationPhase, agentMode, forceToolForContinuation }),
        ));
        upstreamMode = resumedMode || upstreamMode;
        if (!upstream.ok) {
          const errorText = await upstream.text().catch(() => '');
          upstreamError = summarizeUpstreamFailure(upstream.status, errorText);
          recordUpstreamUsagePhase(session, config, {
            phase: continuationPhase,
            endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
            model: configuredModel,
            status: 'http_error',
            httpStatus: upstream.status,
            error: errorText,
            promptChars: usageMeta.messageChars,
            meta: usageMeta,
          });
          toolCalls = [];
        } else {
          streamed = await streamAgentUpstreamResponse(upstream, session, {
            collectTools: true,
            emit: false,
            emitThinking,
            phase: continuationPhase,
            idleTimeoutMs: POST_TOOL_MUTATION_STREAM_IDLE_TIMEOUT_MS,
            maxDurationMs: POST_TOOL_UPSTREAM_TIMEOUT_MS,
            extendMaxDurationOnActivity: true,
            stopOnToolCall: true,
            stopAfterTextMs: POST_MUTATION_STOP_AFTER_TEXT_MS,
            reasoningOnlyMaxMs,
            filterInlineThinking,
          });
          finalText = streamed.text;
          finalReasoning = streamed.reasoning;
          upstreamError = streamed.upstreamError;
          toolCalls = attachDefaultMutationTarget(
            streamed.toolCalls.slice(0, maxToolCallsPerRound),
            session,
            userText,
          );
          recordUpstreamUsagePhase(session, config, {
            phase: continuationPhase,
            endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
            model: configuredModel,
            status: streamed.upstreamError ? 'stream_error' : 'success',
            error: streamed.upstreamError,
            usage: streamed.usage,
            durationMs: streamed.durationMs,
            promptChars: usageMeta.messageChars,
            responseTextChars: streamed.text.length,
            reasoningChars: streamed.reasoning.length,
            toolCalls: streamed.toolCalls.length,
            meta: { ...usageMeta, deltaCount: streamed.deltaCount, eventTypes: streamed.eventTypes },
          });
        }
      } catch (error) {
        if (session.aborted) return null;
        upstreamError = summarizeFetchError(error);
        toolCalls = [];
        recordUpstreamUsagePhase(session, config, {
          phase: continuationPhase,
          endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
          model: configuredModel,
          status: 'fetch_error',
          error: error.message || String(error),
          promptChars: usageMeta.messageChars,
          meta: usageMeta,
        });
        logger?.error?.(`agent local relay incomplete continuation failed requestId=${requestId} phase=${continuationPhase}: ${error.message}`);
      }
    }
    if (toolCalls.length) continue;
    break;
  }

  const incompleteTodosAtEnd = getIncompleteTodos(session);
  const incompleteWorkAtEnd = hasIncompleteWorkAtEndByMode(
    session,
    finalText,
    toolCalls,
    upstreamError,
    { sawMutationTool, sawReadOnlyTool },
  );
  if (incompleteWorkAtEnd) {
    session.unfinishedWorkAtEnd = true;
    const latestText = String(finalText || '').trim();
    const maxIncompleteContinuations = getMaxContinuationCountByMode(session, { sawMutationTool, sawReadOnlyTool });
    const note = [
      `鏈湴 Relay 宸插皾璇曡嚜鍔ㄧ画璺?${incompletePostMutationContinuationCount}/${formatContinuationLimitForLog(maxIncompleteContinuations)} 娆★紝浣嗕笉浼氭妸鏈畬鎴?To-dos 寮哄埗鏀规垚瀹屾垚銆俙`,
      incompleteTodosAtEnd.length ? `浠嶆湭瀹屾垚鐨?To-dos锛?${incompleteTodosAtEnd.map((todo) => todo.content).slice(0, 6).join('锛?)')}` : '',
      latestText ? `鏈€鍚庝竴娈典笂娓告枃鏈細${latestText}` : '',
    ].filter(Boolean).join('\n');
    rememberUnfinishedAgentTask(session, userText, note);
    finalText = '';
    logger?.warn?.(`agent local relay incomplete work left to upstream requestId=${requestId} toolStep=${toolStep} continuations=${incompletePostMutationContinuationCount}/${formatContinuationLimitForLog(maxIncompleteContinuations)} incompleteTodos=${incompleteTodosAtEnd.length} textPreview=${JSON.stringify(latestText.slice(0, 200))}`);
  } else if (maxToolRounds > 0 && toolCalls.length && toolStep >= maxToolRounds) {
    upstreamError = `鏈湴 Relay 宸ュ叿杞暟淇濇姢宸茶Е鍙戯紙${maxToolRounds} 杞級锛屼换鍔″皻鏈‘璁ゅ畬鎴愩€傚凡淇濈暀褰撳墠宸ュ叿缁撴灉涓婁笅鏂囷紝閬垮厤浼€犲畬鎴愭€荤粨銆俙`;
    rememberUnfinishedAgentTask(session, userText, upstreamError);
    logger?.warn?.(`agent local relay tool round guard reached requestId=${requestId} toolStep=${toolStep} pendingTools=${toolCalls.length}`);
  } else if (upstreamError && isRecoverableStreamError(upstreamError)) {
    rememberUnfinishedAgentTask(session, userText, upstreamError);
    logger?.warn?.(`agent local relay recoverable upstream interruption requestId=${requestId} toolStep=${toolStep} error=${JSON.stringify(upstreamError)}`);
  } else if (!upstreamError) {
    session.unfinishedWorkAtEnd = false;
    clearUnfinishedAgentTask(session);
  }

  if (shouldTreatStreamErrorAsComplete(upstreamError, finalText)) {
    logger?.info?.(`agent local relay treating recoverable stream error as completed requestId=${requestId} error=${JSON.stringify(upstreamError)} textLen=${String(finalText || '').length} toolStep=${toolStep}`);
    upstreamError = '';
  }
  if (!session.active || session.aborted) return null;
  finalText = sanitizeFinalAgentText(finalText, session);
  session.hadError = Boolean(upstreamError);
  const finalStatus = session.unfinishedWorkAtEnd
    ? 'unfinished'
    : (upstreamError ? 'stream_error' : 'success');
  const historyStatus = session.unfinishedWorkAtEnd
    ? 'unfinished'
    : (upstreamError ? 'failed' : 'completed');
  flushAgentTextToHistory(session);
  const sentTextSoFar = String(session.agentTextFrameText || '');
  const placeholderFinalText = isPlaceholderFinalText(finalText);
  const finalTextAlreadySent = String(finalText || '').trim()
    && sentTextSoFar.includes(String(finalText || '').trim());
  const shouldSendFinalText = String(finalText || '').trim() && !finalTextAlreadySent && !placeholderFinalText;
  if (upstreamError) {
    const userVisibleError = formatUpstreamErrorForUser(upstreamError);
    appendSessionHistory(session, {
      role: 'assistant',
      kind: 'assistant_text',
      payload: { text: userVisibleError, error: true, upstream_error: upstreamError },
    });
    writeAgentTextFrame(session, userVisibleError);
  } else if (shouldSendFinalText) {
    appendSessionHistory(session, {
      role: 'assistant',
      kind: 'assistant_text',
      payload: { text: finalText },
    });
    writeAgentTextFrame(session, finalText);
    session.historyTextCursor = String(session.agentTextFrameText || '').length;
  } else if (!String(finalText || '').trim()) {
    if (sawWriteTool || String(session.agentTextFrameText || '').trim()) {
      finalText = '';
    } else {
      logger?.info?.(`agent local relay completed without final text requestId=${requestId} toolStep=${toolStep}`);
    }
  } else if (String(finalText || '').trim() && !placeholderFinalText) {
    session.historyTextCursor = String(session.agentTextFrameText || '').length;
  } else if (placeholderFinalText) {
    logger?.info?.(`agent local relay suppressed placeholder final text requestId=${requestId} text=${JSON.stringify(String(finalText || '').trim())}`);
  }
  logger?.info?.(
    `agent local relay final text frame requestId=${requestId} finalTextLen=${String(finalText || '').length} sentTextDelta=${session.sentTextDelta ? '1' : '0'} finalAlreadySent=${finalTextAlreadySent ? '1' : '0'} sentTextLen=${String(session.agentTextFrameText || '').length}`,
  );
  writeAgentFrame(session, buildAgentTurnEndedFrame());
  session.turnEnded = true;
  markUpstreamUsageCompleted(session, config, finalStatus, upstreamError);
  rememberCompletedAgentTurn(session.completedAgentTurns, session.requestId, userText, getSessionWorkspaceRoot(session), session.lastUserMessageCapture?.debug || null, session.generatedChunks, { upstreamError, hadError: session.unfinishedWorkAtEnd });
  completeSessionHistory(session, historyStatus, `model-${requestId}`);
  logger?.info?.(
    `agent local relay upstream response requestId=${requestId} mode=${upstreamMode || '-'} textLen=${finalText.length} reasoningLen=${finalReasoning.length} errorLen=${upstreamError.length} textPreview=${JSON.stringify(finalText.slice(0, 300))}`,
  );
  logGeneratedAgentRunSseSummary(session.generatedChunks || [], session.requestId, logger);
  finalizeInterceptedAgentSession(session);
  return { waitingForInteraction: false, finalStatus, historyStatus };
}

async function resumeAgentAfterInteractionResponse(session, interactionResponse, config, logger, stats, pendingInteraction = null) {
  if (!session?.active || session.aborted || session.relaying) return;
  session.relaying = true;
  try {
  const requestId = session.requestId || '-';
  const userText = String(pendingInteraction?.resumeState?.userText || session.lastUserMessageCapture?.userText || '').trim();
  if (!userText) {
    logger?.warn?.(`agent local relay interaction resume skipped requestId=${requestId} reason=missing_user_text`);
    return;
  }
  const configuredModel = resolveRequestedUpstreamModel(config, {
    requestedModel: session?.lastUserMessageCapture?.debug?.agentClientMessage?.runRequest?.requestedModelId || '',
  });
  const activeUpstream = resolveUpstreamForModel(config, configuredModel);
  const reasoningOnlyMaxMs = isDeepSeekModel(config, configuredModel)
    ? DEEPSEEK_REASONING_ONLY_STREAM_MAX_MS
    : 0;
  const emitThinking = shouldEmitThinkingForUpstream(config, configuredModel);
  const filterInlineThinking = isDeepSeekModel(config, configuredModel) && !emitThinking;
  const agentMode = getSessionAgentMode(session);
  const runPostEditLints = shouldRunPostEditLints(config);
  const upstreamMessages = buildPendingInteractionResumeMessages(session, pendingInteraction, interactionResponse);
  const compacted = compactRelayMessagesForContext(upstreamMessages, config, logger, { requestId, phase: 'interaction_resume' });
  const usageMeta = compacted.usage;
  const promptChars = usageMeta.messageChars;

  stats.chatTotal = (stats.chatTotal || 0) + 1;
  stats.localRelayTurns = (stats.localRelayTurns || 0) + 1;
  logger?.info?.(
    `agent local relay interaction resume requestId=${requestId} interactionKind=${interactionResponse?.kind || '-'} promptChars=${promptChars}`,
  );

  let upstream;
  let upstreamMode = '';
  try {
    ({ response: upstream, mode: upstreamMode } = await fetchUpstreamCompletion(
      activeUpstream,
      configuredModel,
      compacted.messages,
      logger,
      buildFetchUpstreamOptionsForSession(session, {
        signal: session.abortController?.signal || null,
        requestId,
        phase: 'interaction_resume',
        mode: agentMode,
        outboundProxy: config.outboundProxy || null,
        localProxyPort: config.port,
      }, { phase: 'interaction_resume', agentMode }),
    ));
  } catch (error) {
    if (session.aborted) return;
    const summarized = summarizeFetchError(error);
    recordUpstreamUsagePhase(session, config, {
      phase: 'interaction_resume',
      endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
      model: configuredModel,
      status: 'fetch_error',
      error: error.message || String(error),
      promptChars,
      meta: usageMeta,
    });
    logger?.error?.(`agent local relay interaction resume fetch failed requestId=${requestId}: ${error.message}`);
    appendSessionHistory(session, {
      role: 'assistant',
      kind: 'assistant_text',
      payload: { text: summarized, error: true },
    });
    writeAgentTextFrame(session, summarized);
    writeAgentFrame(session, buildAgentTurnEndedFrame());
    session.turnEnded = true;
    completeSessionHistory(session, 'failed', `interaction-resume-fetch-${requestId}`);
    finalizeInterceptedAgentSession(session);
    return;
  }

  if (!upstream.ok) {
    if (session.aborted) return;
    const errorText = await upstream.text().catch(() => '');
    const summarized = summarizeUpstreamFailure(upstream.status, errorText);
    recordUpstreamUsagePhase(session, config, {
      phase: 'interaction_resume',
      endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
      model: configuredModel,
      status: 'http_error',
      httpStatus: upstream.status,
      error: errorText,
      promptChars,
      meta: usageMeta,
    });
    logger?.error?.(`agent local relay interaction resume HTTP ${upstream.status} requestId=${requestId} bodyPreview=${JSON.stringify(errorText.slice(0, 300))}`);
    appendSessionHistory(session, {
      role: 'assistant',
      kind: 'assistant_text',
      payload: { text: summarized, error: true },
    });
    writeAgentTextFrame(session, summarized);
    writeAgentFrame(session, buildAgentTurnEndedFrame());
    session.turnEnded = true;
    completeSessionHistory(session, 'failed', `interaction-resume-http-${requestId}`);
    finalizeInterceptedAgentSession(session);
    return;
  }

  const streamed = await streamAgentUpstreamResponse(upstream, session, {
    collectTools: true,
    emit: true,
    emitThinking,
    phase: 'interaction_resume',
    idleTimeoutMs: UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
    maxDurationMs: 0,
    reasoningOnlyMaxMs,
    filterInlineThinking,
  });
  recordUpstreamUsagePhase(session, config, {
    phase: 'interaction_resume',
    endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
    model: configuredModel,
    status: streamed.upstreamError ? 'stream_error' : 'success',
    error: streamed.upstreamError,
    usage: streamed.usage,
    durationMs: streamed.durationMs,
    promptChars,
    responseTextChars: streamed.text.length,
    reasoningChars: streamed.reasoning.length,
    toolCalls: streamed.toolCalls.length,
    meta: { ...usageMeta, deltaCount: streamed.deltaCount, eventTypes: streamed.eventTypes },
  });
  if (!session.active || session.aborted) return;
  session.waitingForInteraction = false;
  session.planTurnHandoff = '';
  const handler = getModeHandlerForSession(session);
  const helpers = buildModeRuntimeHelpers(session);
  updateSessionHistoryState(
    session,
    typeof handler.buildResumedInteractionStatePatch === 'function'
      ? handler.buildResumedInteractionStatePatch(session, interactionResponse, pendingInteraction, helpers)
      : {
        current_loop_status: 'running',
        waiting_for_interaction: null,
      },
  );
  await continueAgentStreamLoop(session, {
    userText,
    config,
    logger,
    streamed,
    upstreamMessages: compacted.messages,
    usageMeta,
    configuredModel,
    activeUpstream,
    upstreamMode,
    requestId,
    agentMode,
    runPostEditLints,
    emitThinking,
    filterInlineThinking,
    reasoningOnlyMaxMs,
  });
  } finally {
    if (session) session.relaying = false;
    triggerDeferredInteractionResume(session, config, logger, stats, 'post_interaction_resume');
  }
}

async function relayAgentUserMessage(session, userText, config, logger, stats) {
  if (!session?.active || session.aborted || session.relaying) return;
  session.relaying = true;
  try {
    if (!session.agentHistory) {
      const { conversation, turnSeq } = beginAgentHistoryTurn(
        config,
        session.requestId || '',
        getSessionWorkspaceRoot(session),
        session.lastUserMessageCapture || null,
      );
      session.agentHistory = conversation;
      session.agentTurnSeq = turnSeq;
      const agentModeForHistory = getSessionAgentMode(session);
      if (session.agentHistory?.state) session.agentHistory.state.mode = getCursorModeDirectory(agentModeForHistory);
      appendSessionHistory(session, {
        role: 'user',
        kind: 'request_context',
        payload: {
          env: {
            osVersion: `${process.platform} ${process.getSystemVersion ? process.getSystemVersion() : ''}`.trim(),
            workspacePaths: [getSessionWorkspaceRoot(session)],
            shell: 'powershell',
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
          },
          fileContents: {},
          readLintsEnabled: true,
          mcpInfoComplete: true,
          envInfoComplete: true,
        },
      });
      appendSessionHistory(session, {
        role: 'user',
        kind: 'user_message',
        payload: {
          text: String(userText || ''),
          mode: agentModeForHistory,
        },
      });
      appendSessionHistory(session, {
        role: 'system',
        kind: 'prompt_context',
        payload: {
          source: 'current_user_request',
          role: 'user',
          content: `<current_user_request>
${String(userText || '')}
</current_user_request>`,
        },
      });
      updateAgentHistoryUsage(config, { requests: 1 });
    }

    const configuredModel = resolveRequestedUpstreamModel(config, {
      requestedModel: session?.lastUserMessageCapture?.debug?.agentClientMessage?.runRequest?.requestedModelId || '',
    });
    const activeUpstream = resolveUpstreamForModel(config, configuredModel);
    const reasoningOnlyMaxMs = isDeepSeekModel(config, configuredModel)
      ? DEEPSEEK_REASONING_ONLY_STREAM_MAX_MS
      : 0;
    const emitThinking = shouldEmitThinkingForUpstream(config, configuredModel);
    const filterInlineThinking = isDeepSeekModel(config, configuredModel) && !emitThinking;
    const requestId = session.requestId || '-';
    const agentMode = getSessionAgentMode(session);

    let upstreamMessages = buildLocalRelayMessages(userText, session);
    const compacted = compactRelayMessagesForContext(upstreamMessages, config, logger, { requestId, phase: 'initial' });
    upstreamMessages = compacted.messages;
    const usageMeta = compacted.usage;
    const promptChars = usageMeta.messageChars;

    stats.chatTotal = (stats.chatTotal || 0) + 1;
    stats.localRelayTurns = (stats.localRelayTurns || 0) + 1;

    const { response: upstream, mode: upstreamMode } = await fetchUpstreamCompletion(
      activeUpstream,
      configuredModel,
      upstreamMessages,
      logger,
      buildFetchUpstreamOptionsForSession(session, {
        signal: session.abortController?.signal || null,
        requestId,
        phase: 'initial',
        mode: agentMode,
        outboundProxy: config.outboundProxy || null,
        localProxyPort: config.port,
      }, { phase: 'initial', agentMode }),
    );

    const streamed = await streamAgentUpstreamResponse(upstream, session, {
      collectTools: true,
      emit: true,
      emitThinking,
      phase: 'initial',
      idleTimeoutMs: UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
      maxDurationMs: 0,
      reasoningOnlyMaxMs,
      filterInlineThinking,
    });

    recordUpstreamUsagePhase(session, config, {
      phase: 'initial',
      endpointMode: upstreamMode || String(activeUpstream?.endpointMode || config.upstream?.endpointMode || 'responses'),
      model: configuredModel,
      status: streamed.upstreamError ? 'stream_error' : 'success',
      error: streamed.upstreamError,
      usage: streamed.usage,
      durationMs: streamed.durationMs,
      promptChars,
      responseTextChars: streamed.text.length,
      reasoningChars: streamed.reasoning.length,
      toolCalls: streamed.toolCalls.length,
      meta: { ...usageMeta, deltaCount: streamed.deltaCount, eventTypes: streamed.eventTypes },
    });

    await continueAgentStreamLoop(session, {
      userText,
      config,
      logger,
      streamed,
      upstreamMessages,
      usageMeta,
      configuredModel,
      activeUpstream,
      upstreamMode,
      requestId,
      agentMode,
      emitThinking,
      filterInlineThinking,
      reasoningOnlyMaxMs,
    });
  } finally {
    if (session) session.relaying = false;
    triggerDeferredInteractionResume(session, config, logger, stats, 'post_interaction_resume');
  }
}
function forwardMitmH2Request(req, res, host, reqPath, method, body, logger, options = {}) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}:443`);
    const cleanup = () => {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    };

    client.on('error', (error) => {
      cleanup();
      reject(error);
    });

    const headers = {
      ':method': method,
      ':path': reqPath,
      ':authority': host,
      ':scheme': 'https',
      ...sanitizeProxyHeaders(req.headers, host, { forHttp2: true }),
    };

    const upstreamReq = client.request(headers);
    upstreamReq.on('response', (responseHeaders) => {
      const status = Number(responseHeaders[':status'] || 502);
      const responseHeaderMap = { ...responseHeaders };
      delete responseHeaderMap[':status'];
      logger?.info?.(`h2 upstream response ${host}${reqPath} status=${status} contentType=${String(responseHeaders['content-type'] || '-')}`);
      if (!res.headersSent) {
        res.writeHead(status, responseHeaderMap);
      }
    });
    const captureWriter = createResponseCaptureWriter(options.captureResponsePath, logger, 'native h2 response');
    upstreamReq.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      captureWriter?.write(buffer);
      res.write(buffer);
    });
    upstreamReq.on('end', () => {
      captureWriter?.end();
      res.end();
      cleanup();
      resolve();
    });
    upstreamReq.on('error', (error) => {
      cleanup();
      reject(error);
    });

    if (body?.length) {
      upstreamReq.end(body);
    } else {
      req.pipe(upstreamReq);
    }
  });
}

async function forwardMitmHttpsRequest(req, res, logger, body, options = {}) {
  const { isH2, host, path: reqPath, method } = getMitmForwardTarget(req);
  const payload = body === undefined ? await readRequestBody(req) : body;

  if (isH2) {
    try {
      await forwardMitmH2Request(req, res, host, reqPath, method, payload, logger, options);
    } catch (error) {
      logger.error(`h2 passthrough failed ${host}${reqPath}: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ ok: false, message: error.message }));
    }
    return;
  }

  await new Promise((resolve) => {
    const upstreamReq = https.request({
      hostname: host,
      port: 443,
      method,
      path: reqPath,
      headers: sanitizeProxyHeaders(req.headers, host),
    }, (upstreamRes) => {
      const captureWriter = createResponseCaptureWriter(options.captureResponsePath, logger, 'native response');
      logger?.info?.(`https upstream response ${host}${reqPath} status=${upstreamRes.statusCode || 0} contentType=${String(upstreamRes.headers?.['content-type'] || '-')}`);
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.on('data', (chunk) => {
        const buffer = Buffer.from(chunk);
        captureWriter?.write(buffer);
        res.write(buffer);
      });
      upstreamRes.on('end', () => {
        captureWriter?.end();
        res.end();
        resolve();
      });
      upstreamRes.on('error', (error) => {
        logger.error(`https upstream stream failed ${host}${reqPath}: ${error.message}`);
        captureWriter?.end();
        try {
          res.end();
        } catch {
          /* ignore closed client */
        }
        resolve();
      });
    });

    upstreamReq.on('error', (error) => {
      logger.error(`https passthrough failed ${host}${reqPath}: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ ok: false, message: error.message }));
      resolve();
    });

    upstreamReq.end(payload?.length ? payload : undefined);
  });
}

async function handleAgentRunSse(req, res, config, logger, stats, agentSessions, pendingAgentMessages, completedAgentTurns, pendingAgentInteractions) {
  const rawBody = await readRequestBody(req);
  const requestId = decodeRunSseRequestId(rawBody);
  const frameSummary = summarizeConnectFrames(rawBody);
  let pendingCapture = null;
  if (requestId && pendingAgentMessages?.get?.(requestId)?.capture) {
    pendingCapture = pendingAgentMessages.get(requestId).capture;
  }
  const stableConversationId = extractStableConversationId(pendingCapture?.debug || null)
    || String(pendingCapture?.stableConversationId || '').trim();

  stats.seenAgentRunSse = (stats.seenAgentRunSse || 0) + 1;
  logger.info(
    `protocol RunSSE requestId=${requestId || '-'} rawLen=${rawBody.length} frames=${JSON.stringify(frameSummary.frames).slice(0, 400)} truncated=${frameSummary.truncated ? '1' : '0'} rest=${frameSummary.restLength}`,
  );

  const samplePath = persistProtocolSample(config, 'runsse', rawBody, {
    requestId,
    frameSummary,
  });
  if (samplePath) {
    logger.info(`RunSSE sample saved path=${samplePath}`);
  }

  if (isLocalRelayMode(config)) {
    const existingWaitingSession = requestId ? agentSessions.get(requestId) : null;
    if (existingWaitingSession?.waitingForInteraction && !existingWaitingSession.aborted) {
      const session = reattachWaitingInteractionSession(existingWaitingSession, req, res, rawBody, logger);
      res.on('close', () => {
        if (session?.completed) return;
        abortAgentSession(session, logger, 'runsse_closed');
      });
      if (session?.deferredInteractionResponse?.interactionResponse && !session.relaying) {
        triggerDeferredInteractionResume(session, config, logger, stats, 'runsse_reattach');
      }
      return;
    }
    const crossRequestWaitingSession = findWaitingSessionByStableConversationId(agentSessions, stableConversationId, requestId);
    if (crossRequestWaitingSession && !crossRequestWaitingSession.aborted) {
      if (requestId && requestId !== crossRequestWaitingSession.requestId) {
        agentSessions.set(requestId, crossRequestWaitingSession);
      }
      const session = reattachWaitingInteractionSession(crossRequestWaitingSession, req, res, rawBody, logger);
      if (pendingCapture) {
        session.lastUserMessageCapture = pendingCapture;
        session.workspaceRoot = normalizeWorkspacePath(pendingCapture.workspaceRoot || session.workspaceRoot || '');
      }
      res.on('close', () => {
        if (session?.completed) return;
        abortAgentSession(session, logger, 'runsse_closed');
      });
      if (session?.deferredInteractionResponse?.interactionResponse && !session.relaying) {
        triggerDeferredInteractionResume(session, config, logger, stats, 'runsse_cross_request_reattach');
      }
      return;
    }

    const session = {
      req,
      res,
      config,
      logger,
      requestId,
      rawBody,
      active: true,
      relaying: false,
      intercepted: false,
      completed: false,
      aborted: false,
      abortController: new AbortController(),
      turnEnded: false,
      heartbeat: null,
      agentSessions,
      activeRelayTasks: agentSessions,
      execClientMessages: [],
      execClientControls: [],
      generatedChunks: [],
      lastUserMessageCapture: null,
      workspaceRoot: '',
      completedAgentTurns,
      pendingAgentInteractions,
    };
    logger.info(`agent local relay RunSSE open requestId=${requestId || '-'} mode=${getRunnerMode(config)}`);
    try {
      const runnerStat = fs.statSync(__filename);
      logger.info(`agent local relay runner code mtime requestId=${requestId || '-'} file=${JSON.stringify(__filename)} mtime=${runnerStat.mtime.toISOString()} size=${runnerStat.size}`);
    } catch {
      logger.info(`agent local relay runner code mtime requestId=${requestId || '-'} file=${JSON.stringify(__filename)} mtime=unavailable`);
    }
    beginInterceptedAgentSession(session, logger);
    if (requestId) {
      const previous = agentSessions.get(requestId);
      if (previous && previous !== session) {
        abortAgentSession(previous, logger, 'runsse_replaced');
      }
      agentSessions.set(requestId, session);
      const pending = pendingAgentMessages.get(requestId);
      if (pending?.userText) {
        pendingAgentMessages.delete(requestId);
        session.lastUserMessageCapture = pending.capture || null;
        session.agentMode = normalizeAgentModeName(pending.capture?.mode || session.agentMode || 'AGENT_MODE_AGENT');
        session.workspaceRoot = normalizeWorkspacePath(pending.workspaceRoot || pending.capture?.workspaceRoot || session.workspaceRoot || '');
        if (pending.completedTurn) {
          completeDuplicateAgentSession(session, logger, 'completed_scope_replay_pending', pending.completedTurn);
          return;
        }
        relayAgentUserMessage(session, pending.userText, config, logger, stats)
          .catch((error) => {
            failAgentRelaySession(session, logger, error, 'pending');
          })
      }
    }
    res.on('close', () => {
      if (session.completed) return;
      abortAgentSession(session, logger, 'runsse_closed');
    });
    return;
  }

  const captureResponsePath = buildCaptureResponsePath(config, 'runsse-response', requestId);
  await forwardMitmHttpsRequest(req, res, logger, rawBody, { captureResponsePath });
  logAgentRunSseResponseSummary(captureResponsePath, requestId, logger);
}

async function handleBidiAppend(req, res, config, logger, stats, agentSessions, pendingAgentMessages, completedAgentTurns, pendingAgentInteractions) {
  const rawBody = await readRequestBody(req);
  const decoded = decodeBidiAppendRequest(rawBody);
  const protocolOneof = decoded.debug?.agentClientMessage?.oneof || '-';
  const userTextPreview = String(decoded.userText || '').slice(0, 300);

  stats.seenBidiAppend = (stats.seenBidiAppend || 0) + 1;
  if (decoded.kind === 'user_message' && decoded.userText) {
    stats.seenBidiUserMessage = (stats.seenBidiUserMessage || 0) + 1;
  }
  stats.bidiKinds = stats.bidiKinds || {};
  stats.bidiKinds[decoded.kind || 'unknown'] = (stats.bidiKinds[decoded.kind || 'unknown'] || 0) + 1;
  stats.bidiOneofs = stats.bidiOneofs || {};
  stats.bidiOneofs[protocolOneof] = (stats.bidiOneofs[protocolOneof] || 0) + 1;

  logger.info(
    `protocol BidiAppend kind=${decoded.kind || '-'} requestId=${decoded.requestId || '-'} rawLen=${rawBody.length} agentOneof=${protocolOneof} workspaceRoot=${JSON.stringify(decoded.debug?.workspaceRoot || '')} userTextPreview=${JSON.stringify(userTextPreview)}`,
  );

  if (decoded.kind === 'conversation_action') {
    logger.info(
      `protocol BidiAppend conversation_action debug requestId=${decoded.requestId || '-'} rawTextPreview=${JSON.stringify(decoded.debug?.rawTextPreview || '')} dataTextPreview=${JSON.stringify(decoded.debug?.dataTextPreview || '')} agentShape=${JSON.stringify(decoded.debug?.agentShape || '')} agentClientMessage=${JSON.stringify(decoded.debug?.agentClientMessage || {})}`,
    );
  } else if (decoded.kind !== 'client_heartbeat' && decoded.kind !== 'user_message') {
    const stopCandidateText = `${userTextPreview}\n${decoded.debug?.rawTextPreview || ''}\n${decoded.debug?.dataTextPreview || ''}`;
    if (/abort|aborted|cancel|stop|interrupt|terminate|pause/i.test(stopCandidateText)) {
      logger.info(
        `protocol BidiAppend stop-candidate requestId=${decoded.requestId || '-'} kind=${decoded.kind || '-'} protocolOneof=${protocolOneof} rawTextPreview=${JSON.stringify(decoded.debug?.rawTextPreview || '')} dataTextPreview=${JSON.stringify(decoded.debug?.dataTextPreview || '')} agentClientMessage=${JSON.stringify(decoded.debug?.agentClientMessage || {})}`,
      );
    }
  }

  const samplePath = persistProtocolSample(config, 'bidi', rawBody, {
    requestId: decoded.requestId || '',
    kind: decoded.kind || '',
    protocolOneof,
    userTextPreview,
    debug: decoded.debug || null,
  });
  if (samplePath) {
    logger.info(`BidiAppend sample saved path=${samplePath}`);
  }

  if (isLocalRelayMode(config)) {
    const ack = () => {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/proto' });
      res.end(Buffer.alloc(0));
    };

    if ((decoded.kind === 'exec_client' || decoded.kind === 'exec_control') && decoded.requestId) {
      const session = agentSessions.get(decoded.requestId);
      const execMeta = decoded.debug?.agentClientMessage?.execClient
        || decoded.debug?.agentClientMessage?.execControl
        || {};
      if (session) {
        const bucket = decoded.kind === 'exec_client' ? 'execClientMessages' : 'execClientControls';
        const numericExecId = Number(execMeta.id) || 0;
        const resolvedExecId = String(execMeta.execId || resolveExecIdFromNumeric(session, numericExecId) || '').trim();
        const message = {
          capturedAt: new Date().toISOString(),
          rawLen: rawBody.length,
          oneof: protocolOneof,
          id: numericExecId || null,
          execId: resolvedExecId,
          result: String(execMeta.result || ''),
          text: String(execMeta.text || execMeta.resultSummary?.text || ''),
          resultSummary: execMeta.resultSummary || null,
          status: execMeta.status ?? null,
          control: String(execMeta.control || ''),
          error: String(execMeta.error || ''),
          kind: decoded.kind,
          debug: decoded.debug || null,
        };
        session[bucket] = session[bucket] || [];
        session[bucket].push(message);
        notifyExecClientWaiters(session, message);
      }
      logger.info(
        `agent local relay received ${decoded.kind} requestId=${decoded.requestId || '-'} execId=${String(execMeta.execId || '-')} id=${Number(execMeta.id) || 0} result=${String(execMeta.result || '-')} rawLen=${rawBody.length} agentOneof=${protocolOneof}`,
      );
      ack();
      return;
    }

    if (decoded.kind === 'interaction_response' && decoded.requestId) {
      const interactionResponse = decoded.debug?.agentClientMessage?.interactionResponse || null;
      const matchedPendingByStableConversation = findPendingInteractionQuery(pendingAgentInteractions, decoded.requestId, interactionResponse);
      const session = agentSessions.get(decoded.requestId)
        || findWaitingSessionByStableConversationId(
          agentSessions,
          matchedPendingByStableConversation?.stableConversationId || '',
          decoded.requestId,
        );
      const pendingInteraction = matchedPendingByStableConversation;
      logger.info(
        `agent local relay received interaction_response requestId=${decoded.requestId} interactionKind=${interactionResponse?.kind || '-'} interactionId=${Number(interactionResponse?.id) || 0} matchedPending=${pendingInteraction ? '1' : '0'} pendingKind=${pendingInteraction?.kind || '-'} pendingTool=${pendingInteraction?.toolName || '-'} payload=${JSON.stringify(interactionResponse || {})}`,
      );
      if (session && pendingInteraction) {
        appendInteractionResponseToHistory(session, pendingInteraction, interactionResponse);
      }
      if (pendingInteraction?.key) {
        pendingAgentInteractions.delete(pendingInteraction.key);
      }
      ack();
      if (session?.active && !session.aborted && !session.relaying) {
        resumeAgentAfterInteractionResponse(session, interactionResponse, config, logger, stats, pendingInteraction)
          .catch((error) => failAgentRelaySession(session, logger, error, 'interaction_resume'));
      } else if (session?.active && session.relaying) {
        session.deferredInteractionResponse = {
          interactionResponse,
          pendingInteraction,
          capturedAt: new Date().toISOString(),
        };
        logger.info(`agent local relay deferred interaction resume requestId=${decoded.requestId} reason=session_relaying`);
      }
      return;
    }

    if (decoded.kind === 'conversation_action' && decoded.requestId) {
      const session = agentSessions.get(decoded.requestId);
      const actionText = `${userTextPreview}\n${decoded.debug?.rawTextPreview || ''}\n${decoded.debug?.dataTextPreview || ''}`;
      logger.info(
        `agent local relay conversation_action requestId=${decoded.requestId} sessionActive=${session?.active ? '1' : '0'} sessionAborted=${session?.aborted ? '1' : '0'} matchedAbort=${/abort|aborted|cancel|stop|interrupt|terminate|pause/i.test(actionText) ? '1' : '0'} actionText=${JSON.stringify(actionText.slice(0, 800))} agentClientMessage=${JSON.stringify(decoded.debug?.agentClientMessage || {})}`,
      );
      if (/abort|aborted|cancel|stop|interrupt|terminate|pause/i.test(actionText)) {
        abortAgentSession(session, logger, 'conversation_action_abort');
        logger.info(`agent local relay conversation abort requestId=${decoded.requestId}`);
      }
      ack();
      return;
    }

    if (decoded.kind === 'user_message' && decoded.requestId && decoded.userText) {
      const normalizedUserText = trimRelayText(decoded.userText, 12000);
      const workspaceRoot = selectWorkspaceRootForUserMessage(decoded.debug?.workspaceRoot || '', logger, decoded.requestId);
      const stableConversationId = extractStableConversationId(decoded.debug || null);
      const capture = {
        capturedAt: new Date().toISOString(),
        requestId: decoded.requestId,
        kind: decoded.kind,
        mode: normalizeAgentModeName(decoded.mode || extractAgentModeFromPayload(Buffer.alloc(0))),
        userText: normalizedUserText,
        userTextPreview,
        selectedImages: Array.isArray(decoded.selectedImages) ? decoded.selectedImages : [],
        rawLen: rawBody.length,
        workspaceRoot,
        stableConversationId,
        debug: decoded.debug || null,
      };
      const completedTurn = getCompletedAgentTurn(completedAgentTurns, decoded.requestId, normalizedUserText, workspaceRoot, decoded.debug || null);
      if (completedTurn) {
        logger.info(`agent local relay duplicate user_message acked requestId=${decoded.requestId} previousRequestId=${completedTurn.requestId || '-'} workspaceRoot=${JSON.stringify(workspaceRoot)} textLen=${normalizedUserText.length}`);
        const session = agentSessions.get(decoded.requestId);
        if (session?.active) {
          completeDuplicateAgentSession(session, logger, 'completed_scope_replay', completedTurn);
        } else {
          pendingAgentMessages.set(decoded.requestId, {
            userText: normalizedUserText,
            savedAt: Date.now(),
            workspaceRoot,
            capture,
            completedTurn,
          });
        }
        ack();
        return;
      }
      const session = agentSessions.get(decoded.requestId);
      const waitingSession = findWaitingSessionByStableConversationId(agentSessions, stableConversationId, decoded.requestId);
      if (waitingSession && !waitingSession.relaying && waitingSession !== session) {
        if (isPlaceholderRunSseSession(session)) {
          adoptPlaceholderRunSseSession(waitingSession, session, logger);
        }
        rebindWaitingSessionRequestId(waitingSession, decoded.requestId, logger);
        waitingSession.agentMode = capture.mode;
        waitingSession.lastUserMessageCapture = capture;
        waitingSession.workspaceRoot = workspaceRoot || waitingSession.workspaceRoot || '';
        logger.info(`agent local relay mapped new request to waiting session requestId=${decoded.requestId} previousRequestId=${waitingSession.requestId || '-'} stableConversationId=${JSON.stringify(stableConversationId)} workspaceRoot=${JSON.stringify(getSessionWorkspaceRoot(waitingSession))}`);
        ack();
        return;
      }
      if (session?.active && session.relaying) {
        logger.info(`agent local relay in-flight user_message acked requestId=${decoded.requestId} workspaceRoot=${JSON.stringify(workspaceRoot)} textLen=${normalizedUserText.length}`);
        ack();
        return;
      }
      if (session?.active) {
        session.agentMode = capture.mode;
        session.lastUserMessageCapture = capture;
        session.workspaceRoot = workspaceRoot || session.workspaceRoot || '';
        logger.info(`agent local relay workspace requestId=${decoded.requestId} workspaceRoot=${JSON.stringify(getSessionWorkspaceRoot(session))}`);
        beginInterceptedAgentSession(session, logger);
        relayAgentUserMessage(session, normalizedUserText, config, logger, stats)
          .catch((error) => failAgentRelaySession(session, logger, error, 'async'));
        ack();
        return;
      }
      pendingAgentMessages.set(decoded.requestId, {
        userText: normalizedUserText,
        savedAt: Date.now(),
        workspaceRoot,
        capture,
      });
      logger.info(`agent local relay queued user_message requestId=${decoded.requestId} waiting RunSSE workspaceRoot=${JSON.stringify(workspaceRoot)} textLen=${normalizedUserText.length}`);
      ack();
      return;
    }

    logger.info(`agent local relay ack BidiAppend kind=${decoded.kind || '-'} requestId=${decoded.requestId || '-'}`);
    ack();
    return;
  }

  const captureResponsePath = buildCaptureResponsePath(config, 'bidi-response', decoded.requestId || '');
  await forwardMitmHttpsRequest(req, res, logger, rawBody, { captureResponsePath });
}

async function handleCursorChat(req, res, config, logger, stats) {
  const rawBody = await readRequestBody(req);
  const decoded = decodeCursorChatRequest(rawBody);
  const lastMessage = decoded.messages?.[decoded.messages.length - 1];
  const requestedModel = resolveRequestedUpstreamModel(config, { requestedModel: decoded.model || '' });
  const routedUpstream = resolveUpstreamForModel(config, requestedModel);

  stats.chatTotal = (stats.chatTotal || 0) + 1;
  logger.info(
    `protocol Chat model=${decoded.model || '-'} routedModel=${requestedModel} endpointMode=${String(routedUpstream?.endpointMode || config.upstream?.endpointMode || 'responses')} conversationId=${decoded.conversationId || '-'} rawLen=${rawBody.length} lastRole=${lastMessage?.role || '-'} lastPreview=${JSON.stringify(String(lastMessage?.content || '').slice(0, 200))}`,
  );

  const samplePath = persistProtocolSample(config, 'chat', rawBody, {
    model: decoded.model || '',
    routedModel: requestedModel,
    conversationId: decoded.conversationId || '',
    messageCount: Array.isArray(decoded.messages) ? decoded.messages.length : 0,
  });
  if (samplePath) {
    logger.info(`Chat sample saved path=${samplePath}`);
  }

  await forwardMitmHttpsRequest(req, res, logger, rawBody);
}

async function handleMitmRequest(req, res, config, logger, stats, shutdown, agentSessions, pendingAgentMessages, completedAgentTurns, pendingAgentInteractions) {
  const { pathname, method, protocol } = getMitmRequestMeta(req);
  if (protocol === 'h2') stats.connectH2 = (stats.connectH2 || 0) + 1;
  trackRecentPath(stats, method, pathname);
  logger.info(`mitm request ${method} ${pathname} proto=${protocol}`);

  if (pathname === CONTROL_SHUTDOWN_PATH && method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    shutdown?.();
    return;
  }

  if (isAgentRunSsePath(pathname) && method === 'POST') {
    await handleAgentRunSse(req, res, config, logger, stats, agentSessions, pendingAgentMessages, completedAgentTurns, pendingAgentInteractions);
    return;
  }

  if (isBidiAppendPath(pathname) && method === 'POST') {
    await handleBidiAppend(req, res, config, logger, stats, agentSessions, pendingAgentMessages, completedAgentTurns, pendingAgentInteractions);
    return;
  }

  if (isRelayChatPath(pathname) && method === 'POST') {
    await handleCursorChat(req, res, config, logger, stats);
    return;
  }

  if (isLocalRelayMode(config) && method === 'POST' && await handleLocalControlPlaneRequest(req, pathname, res, config, logger, stats)) {
    return;
  }

  if (isRepositoryServicePath(pathname) && method === 'POST') {
    const rawBody = await readRequestBody(req);
    logger.info(`protocol RepositoryService path=${pathname} rawLen=${rawBody.length}`);
    await forwardMitmHttpsRequest(req, res, logger, rawBody);
    return;
  }

  await forwardMitmHttpsRequest(req, res, logger);
}

function trackRunnerEvent(stats, kind, value) {
  if (!stats[kind]) stats[kind] = {};
  const bucket = stats[kind];
  bucket[value] = (bucket[value] || 0) + 1;
}

function trackRecentPath(stats, method, pathname) {
  if (!stats.recentPaths) stats.recentPaths = [];
  const entry = `${method} ${pathname}`;
  stats.recentPaths = stats.recentPaths.filter((item) => item !== entry);
  stats.recentPaths.unshift(entry);
  if (stats.recentPaths.length > 40) stats.recentPaths.length = 40;
}

function getConfigCustomRoot(config = {}) {
  const logPath = String(config.logPath || '').trim();
  if (logPath) return path.dirname(logPath);
  return '';
}

function startProxy(config) {
  const logger = createLogger(getConfigCustomRoot(config));
  const mode = getRunnerMode(config);
  const agentSessions = new Map();
  const pendingAgentMessages = new Map();
  const completedAgentTurns = new Map();
  const pendingAgentInteractions = new Map();
  const stats = {
    connectTotal: 0,
    connectMitm: 0,
    connectH2: 0,
    chatTotal: 0,
    seenAgentRunSse: 0,
    seenBidiAppend: 0,
    seenBidiUserMessage: 0,
    localRelayTurns: 0,
    directTlsRequests: 0,
    recentPaths: [],
    connectHosts: {},
    directMitmPort: Number(config.directMitmPort) || 0,
  };

  logger.info(
    `runner boot pid=${process.pid} port=${config.port} directMitmPort=${stats.directMitmPort || '-'} mode=${mode}`,
  );

  const certPath = String(config.cert.leafCertPath || '').trim();
  const cert = fs.readFileSync(certPath, 'utf8');
  const key = fs.readFileSync(config.cert.leafKeyPath, 'utf8');

  logger.info(`tls certificate chain path=${certPath}`);

  const tlsOptions = {
    key,
    cert,
    allowHTTP1: true,
    ALPNProtocols: ['h2', 'http/1.1'],
  };

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down cursor relay proxy');
    try {
      for (const session of Array.from(agentSessions.values())) {
        abortAgentSession(session, logger, 'runner_shutdown');
      }
    } catch {
      /* ignore */
    }
    try {
      proxyServer.close();
    } catch {
      /* ignore */
    }
    try {
      connectBridgeServer.close();
    } catch {
      /* ignore */
    }
    try {
      directMitmServer?.close();
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 120).unref();
  }

  function onMitmRequest(req, res, entry) {
    if (entry === 'direct') stats.directTlsRequests += 1;
    const { pathname, method, protocol } = getMitmRequestMeta(req);
    if (protocol === 'h2') stats.connectH2 = (stats.connectH2 || 0) + 1;
    trackRecentPath(stats, method, pathname);
    logger.info(`mitm request ${method} ${pathname} proto=${protocol} entry=${entry}`);
    handleMitmRequest(req, res, config, logger, stats, shutdown, agentSessions, pendingAgentMessages, completedAgentTurns, pendingAgentInteractions).catch((error) => {
      logger.error(`mitm request failed (${entry}): ${error.stack || error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ ok: false, message: error.message }));
    });
  }

  const connectBridgeServer = http2.createSecureServer(tlsOptions, (req, res) => {
    onMitmRequest(req, res, 'connect');
  });
  connectBridgeServer.on('error', (error) => {
    logger.error(`connect-bridge tls error: ${error.message}`);
  });

  let connectBridgePort = 0;
  connectBridgeServer.listen(0, '127.0.0.1', () => {
    connectBridgePort = connectBridgeServer.address().port;
    logger.info(`tls CONNECT-bridge listening on 127.0.0.1:${connectBridgePort}`);
  });

  let directMitmServer = null;
  if (stats.directMitmPort) {
    directMitmServer = http2.createSecureServer(tlsOptions, (req, res) => {
      onMitmRequest(req, res, 'direct');
    });
    directMitmServer.on('error', (error) => {
      logger.error(`direct MITM tls error: ${error.message}`);
    });
    directMitmServer.on('connection', () => {
      stats.directTlsConnects = (stats.directTlsConnects || 0) + 1;
      logger.info('direct MITM inbound TLS connection');
    });
    directMitmServer.listen(stats.directMitmPort, '0.0.0.0', () => {
      logger.info(`direct MITM TLS listening on 0.0.0.0:${stats.directMitmPort}`);
    });
  }

  const proxyServer = http.createServer(async (req, res) => {
    if (req.url === HEALTH_PATH) {
      let runnerStat = null;
      try {
        runnerStat = fs.statSync(__filename);
      } catch {
        runnerStat = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        pid: process.pid,
        runnerScriptPath: __filename,
        runnerScriptMtime: runnerStat ? runnerStat.mtime.toISOString() : '',
        runnerScriptSize: runnerStat ? runnerStat.size : 0,
        port: config.port,
        directMitmPort: stats.directMitmPort,
        mode,
        upstreamBaseUrl: String(config.upstream?.baseUrl || ''),
        upstreamModelName: String(config.upstream?.modelName || ''),
        upstreamAvailableModels: Array.isArray(config.upstream?.availableModels)
          ? config.upstream.availableModels.map((item) => String(item || '').trim()).filter(Boolean)
          : [String(config.upstream?.modelName || '').trim()].filter(Boolean),
        modelRoutes: getConfiguredModelRoutes(config).map((item) => ({
          modelName: item.modelName,
          upstreamBaseUrl: String(item.upstream?.baseUrl || ''),
          upstreamModelName: String(item.upstream?.modelName || ''),
          upstreamEndpointMode: String(item.upstream?.endpointMode || 'responses'),
        })),
        upstreamEndpointMode: String(config.upstream?.endpointMode || 'responses'),
        upstreamReasoningEffort: String(config.upstream?.reasoningEffort || 'medium'),
        upstreamThinkingMode: String(config.upstream?.thinkingMode || ''),
        upstreamContextWindow: Number(config.upstream?.contextWindow) || 250000,
        outboundProxy: config.outboundProxy || null,
        mockAgentTools: Boolean(config.mockAgentTools),
        mockAgentProtoTools: Boolean(config.mockAgentProtoTools),
        localNativeAgentTools: Boolean(config.localNativeAgentTools),
        structuredAgentToolCalls: Boolean(config.structuredAgentToolCalls),
        emitLocalToolInteractionFrames: config.emitLocalToolInteractionFrames !== false,
        emitSyntheticLocalNativeToolFrames: Boolean(config.emitSyntheticLocalNativeToolFrames),
        emitAgentExecServerFrames: Boolean(config.emitAgentExecServerFrames),
        maxLocalToolCallsPerRound: getMaxLocalToolCallsPerRound(config),
        nativeMutationTools: config.nativeMutationTools !== false,
        nativeMutationApplyMode: String(config.nativeMutationApplyMode || 'cursor'),
        emitAgentKvBootstrap: Boolean(config.emitAgentKvBootstrap),
        emitLocalMutationCheckpoints: Boolean(config.emitLocalMutationCheckpoints),
        localMutationCheckpointsEnabled: config.emitLocalMutationCheckpoints === true && config.disableLocalMutationCheckpoints !== true,
        enableReviewBridge: Boolean(config.enableReviewBridge),
        localControlPlane: isLocalRelayMode(config),
        stats,
      }));
      return;
    }

    if (req.url === CONTROL_SHUTDOWN_PATH && (req.method || 'GET').toUpperCase() === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      shutdown();
      return;
    }

    if (/^https?:\/\//i.test(String(req.url || ''))) {
      proxyHttpAbsoluteRequest(req, res, logger).catch((error) => {
        logger.error(`absolute proxy request failed: ${error.stack || error.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ ok: false, message: error.message }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: 'Not found' }));
  });

  proxyServer.on('connect', (req, clientSocket, head) => {
    const target = parseConnectTarget(req.url || '');
    stats.connectTotal += 1;
    if (!target.host) {
      writeConnectError(clientSocket, 'Missing CONNECT target', 400);
      return;
    }

    logger.info(`proxy CONNECT ${target.host}:${target.port} intercept=${shouldInterceptHost(target.host)}`);
    trackRunnerEvent(stats, 'connectHosts', `${target.host}${shouldInterceptHost(target.host) ? '' : ' (passthrough)'}`);
    if (shouldInterceptHost(target.host)) stats.connectMitm += 1;

    if (!shouldInterceptHost(target.host)) {
      const upstreamSocket = net.connect(target.port, target.host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });

      upstreamSocket.on('error', (error) => {
        logger.error(`raw CONNECT failed ${target.host}:${target.port}: ${error.message}`);
        writeConnectError(clientSocket, 'Upstream CONNECT failed');
      });
      clientSocket.on('error', () => {
        try {
          upstreamSocket.destroy();
        } catch {
          /* ignore */
        }
      });
      return;
    }

    logger.info(`mitm CONNECT ${target.host}:${target.port}`);
    if (!connectBridgePort) {
      writeConnectError(clientSocket, 'MITM bridge not ready');
      return;
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const bridgeSocket = net.connect(connectBridgePort, '127.0.0.1', () => {
      if (head?.length) bridgeSocket.write(head);
      clientSocket.pipe(bridgeSocket);
      bridgeSocket.pipe(clientSocket);
    });

    bridgeSocket.on('error', (error) => {
      logger.error(`bridge CONNECT failed ${target.host}:${target.port}: ${error.message}`);
      writeConnectError(clientSocket, 'MITM bridge failed');
    });
    clientSocket.on('error', () => {
      try {
        bridgeSocket.destroy();
      } catch {
        /* ignore */
      }
    });
  });

  proxyServer.listen(config.port, '127.0.0.1', () => {
    logger.info(`cursor relay proxy listening on 127.0.0.1:${config.port}`);
  });

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (error) => {
    logger.error(`runner uncaughtException: ${error?.stack || error?.message || String(error)}`);
    shutdown();
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`runner unhandledRejection: ${reason?.stack || reason?.message || String(reason)}`);
  });
  process.on('exit', (code) => {
    logger.info(`runner exit code=${code}`);
  });
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.configPath) throw new Error('Missing --config path');
  const config = loadConfig(args.configPath);
  startProxy(config);
}

function isRunnerEntrypoint() {
  if (require.main === module) return true;
  const scriptArg = normalizeWorkspacePath(process.argv[1] || '');
  if (!scriptArg) return false;
  return path.basename(scriptArg).toLowerCase() === path.basename(__filename).toLowerCase()
    && process.argv.includes('--config');
}

if (isRunnerEntrypoint()) {
  main();
}

module.exports = {
  startProxy,
  collectToolCallsFromPayload,
  normalizeCollectedToolCalls,
  attachDefaultMutationTarget,
  getMutationTargetPath,
  shouldTreatStreamErrorAsComplete,
  getStreamingEditContentFromArgumentsText,
  getStreamingPathFromArgumentsText,
  buildNativeEditFileText,
};

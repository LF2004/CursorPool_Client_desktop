/**
 * cursor-relay-conversation-fix.js
 *
 * 修复两个核心问题（逆向文档已确认根因）：
 *
 * 问题1：对话被自己结束（turn_ended 提前发送）
 *   根因：runner.js L7964/7993 interaction_resume 阶段 upstream fetch 失败
 *         或 HTTP 非2xx 时，立即发 turn_ended + finalizeInterceptedAgentSession
 *   修复：fetch 失败时重试 + 降级，不立即结束；HTTP 错误时发错误提示但保持会话
 *
 * 问题2：工具未命中（upstream LLM 不返回 tool_call）
 *   根因：runner.js L6668 streamAgentUpstreamResponse 依赖 upstream LLM 返回
 *         结构化 tool_call，但若 schema 未注入或 structuredAgentToolCalls 未开，
 *         LLM 只返回纯文本，relay 只能发 text_delta 后 turn_ended
 *   修复：
 *     a) 确保工具 schema 标准化注入 upstream 请求
 *     b) structuredAgentToolCalls 默认开
 *     c) 上游无 tool_call 时：检测文本中的工具意图（fallback 解析）或重试
 *
 * 使用方式（在 runner.js 中）：
 *   const { shouldRetryInteractionResume, buildToolSchemaForUpstream, detectToolIntentFromText }
 *     = require('./cursor-relay-conversation-fix');
 */

/**
 * 问题1修复：interaction_resume fetch 失败时的重试策略
 *
 * @param {Error} error fetch 错误
 * @param {number} attempt 当前尝试次数（从0开始）
 * @param {object} config relay 配置
 * @returns {{shouldRetry, delayMs, maxAttempts, giveUp}}
 */
function shouldRetryInteractionResume(error, attempt, config = {}) {
  const maxAttempts = Number(config.interactionResumeMaxRetries) || 3;
  const baseDelay = Number(config.interactionResumeRetryDelayMs) || 1000;

  if (attempt >= maxAttempts) {
    return { shouldRetry: false, delayMs: 0, maxAttempts, giveUp: true };
  }

  const msg = String(error?.message || '');
  const isNetworkError =
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('fetch failed') ||
    msg.includes('network');

  if (isNetworkError) {
    // 指数退避
    const delayMs = baseDelay * Math.pow(2, attempt);
    return { shouldRetry: true, delayMs, maxAttempts, giveUp: false };
  }

  // 非网络错误不重试
  return { shouldRetry: false, delayMs: 0, maxAttempts, giveUp: true };
}

/**
 * 问题1修复：interaction_resume HTTP 非2xx 时的处理策略
 *
 * 原逻辑：立即发 turn_ended + finalizeInterceptedAgentSession（过激进）
 * 新逻辑：根据状态码决定
 *   - 429 (rate limit): 等待后重试
 *   - 5xx (server error): 重试
 *   - 4xx (client error): 不重试，但发友好提示而非立即结束
 *
 * @param {number} status HTTP 状态码
 * @param {number} attempt
 * @param {object} config
 * @returns {{shouldRetry, delayMs, shouldEndTurn, userMessage}}
 */
function handleInteractionResumeHttpError(status, attempt, config = {}) {
  const maxAttempts = Number(config.interactionResumeMaxRetries) || 3;
  const baseDelay = Number(config.interactionResumeRetryDelayMs) || 1000;

  // 429 限流：等待后重试
  if (status === 429 && attempt < maxAttempts) {
    const delayMs = baseDelay * Math.pow(2, attempt) * 2; // 限流加倍等待
    return {
      shouldRetry: true,
      delayMs,
      shouldEndTurn: false,
      userMessage: '',
    };
  }

  // 5xx 服务端错误：重试
  if (status >= 500 && status < 600 && attempt < maxAttempts) {
    const delayMs = baseDelay * Math.pow(2, attempt);
    return {
      shouldRetry: true,
      delayMs,
      shouldEndTurn: false,
      userMessage: '',
    };
  }

  // 4xx 客户端错误或其他：不重试，发友好提示
  // 但不立即 turn_ended — 让用户有机会重新输入
  const userMessage = status === 429
    ? '上游模型服务限流，请稍后重试。'
    : status >= 500
      ? `上游模型服务异常 (${status})，请稍后重试。`
      : `请求出错 (${status})，请检查配置后重试。`;

  return {
    shouldRetry: false,
    delayMs: 0,
    shouldEndTurn: false, // 不立即结束，让用户能重试
    userMessage,
  };
}

/**
 * 问题2修复：构建标准化的工具 schema 注入 upstream 请求
 *
 * Cursor 协议里工具定义在 AgentRunRequest.mcp_tools 和 skill_options，
 * 但 upstream LLM (OpenAI 兼容) 需要的是 tools: [{type:"function", function:{name, description, parameters}}]
 *
 * 这个函数把 Cursor 协议的工具定义转成 OpenAI tools 格式
 *
 * @param {object} clientMessage AgentClientMessage 解码对象
 * @returns {Array} OpenAI tools 格式
 */
function buildToolSchemaForUpstream(clientMessage) {
  if (!clientMessage) return [];
  const tools = [];

  // MCP 工具
  try {
    const mcpTools = clientMessage.runRequest?.mcpTools?.tools;
    if (Array.isArray(mcpTools)) {
      for (const tool of mcpTools) {
        if (!tool?.name) continue;
        tools.push({
          type: 'function',
          function: {
            name: String(tool.name),
            description: String(tool.description || ''),
            parameters: normalizeJsonSchema(tool.inputSchema || tool.parameters || {}),
          },
        });
      }
    }
  } catch {}

  // Cursor 内置工具（read/write/grep/ls/shell 等）— 从 skill_options 或硬编码
  const builtinTools = getBuiltinToolSchemas();
  for (const t of builtinTools) {
    if (!tools.find((x) => x.function.name === t.function.name)) {
      tools.push(t);
    }
  }

  return tools;
}

/**
 * 标准化 JSON Schema（protobuf 解码后可能是 camelCase）
 */
function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  // protobufjs 返回的 struct 可能是 { fields: {}, required: [] } 或直接是 schema
  if (schema.type) return schema;
  if (schema.fields) {
    return {
      type: 'object',
      properties: schema.fields,
      required: schema.required || [],
    };
  }
  return schema;
}

/**
 * Cursor 内置工具的 OpenAI schema（从逆向文档还原）
 */
let _builtinToolsCache = null;
function getBuiltinToolSchemas() {
  if (_builtinToolsCache) return _builtinToolsCache;
  _builtinToolsCache = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file path' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Edit a file by replacing old_string with new_string.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a shell command.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search file contents with regex.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ls',
        description: 'List directory contents.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    },
  ];
  return _builtinToolsCache;
}

/**
 * 问题2修复：当 upstream LLM 没返回 tool_call 时，从纯文本中检测工具意图
 *
 * 这是 fallback 策略：如果 LLM 不支持 function calling，
 * 但它在文本里写了类似 "I'll read the file xxx" 的内容，
 * 尝试解析出工具调用
 *
 * @param {string} text LLM 返回的纯文本
 * @returns {Array} 检测到的工具调用 [{name, arguments}]
 */
function detectToolIntentFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const calls = [];

  // 模式1: ```tool_code\nread_file({"path": "xxx"})\n```
  const codeBlockRe = /```(?:tool_code|tool)?\s*\n\s*(\w+)\s*\(([^)]*)\)\s*\n?```/g;
  let m;
  while ((m = codeBlockRe.exec(text)) !== null) {
    const name = m[1];
    let args = {};
    try { args = JSON.parse(m[2]); } catch {}
    calls.push({ name, arguments: args });
  }

  // 模式2: I'll read (the file|file) `xxx` / Let me read `xxx`
  const readIntentRe = /(?:I(?:'ll| will| am going to)\s+)?(?:read|open|check)\s+(?:the\s+)?(?:file\s+)?[`'"]([^`'"]+)[`'"]/gi;
  while ((m = readIntentRe.exec(text)) !== null) {
    calls.push({ name: 'read_file', arguments: { path: m[1] } });
  }

  // 模式3: I'll search for `xxx`
  const grepIntentRe = /(?:I(?:'ll| will)\s+)?(?:search|grep|find)\s+(?:for\s+)?[`'"]([^`'"]+)[`'"]/gi;
  while ((m = grepIntentRe.exec(text)) !== null) {
    calls.push({ name: 'grep', arguments: { pattern: m[1] } });
  }

  return calls;
}

/**
 * 问题2修复：检查 relay config 是否正确启用了工具调用
 */
function validateToolCallConfig(config = {}) {
  const issues = [];
  if (config.structuredAgentToolCalls !== true) {
    issues.push('structuredAgentToolCalls 未开启');
  }
  if (config.emitLocalToolInteractionFrames === false) {
    issues.push('emitLocalToolInteractionFrames 被关闭');
  }
  if (config.localNativeAgentTools === false) {
    issues.push('localNativeAgentTools 被关闭');
  }
  return {
    ok: issues.length === 0,
    issues,
  };
}

/**
 * 问题2修复：确保 config 默认开启工具调用（用于 quickSwitchRelayModel 等场景）
 */
function ensureToolCallDefaults(config = {}) {
  return {
    ...config,
    structuredAgentToolCalls: config.structuredAgentToolCalls !== false, // 默认 true
    emitLocalToolInteractionFrames: config.emitLocalToolInteractionFrames !== false,
    localNativeAgentTools: config.localNativeAgentTools !== false,
  };
}

module.exports = {
  shouldRetryInteractionResume,
  handleInteractionResumeHttpError,
  buildToolSchemaForUpstream,
  normalizeJsonSchema,
  getBuiltinToolSchemas,
  detectToolIntentFromText,
  validateToolCallConfig,
  ensureToolCallDefaults,
};

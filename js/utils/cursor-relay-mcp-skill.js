/**
 * cursor-relay-mcp-skill.js
 *
 * MCP 工具调用与 Skill 透传复刻（阶段六）
 *
 * 逆向文档已确认的数据流：
 *   1. Cursor 客户端通过 BidiAppend 发送 AgentRunRequest，其中包含：
 *      - mcpTools: MCP 工具定义列表（McpToolDefinition: name, description, inputSchema）
 *      - skillOptions: Skill 描述符列表（SkillDescriptor: name, description, folderPath）
 *      - action.userMessageAction.requestContext:
 *        - rules: CursorRule 列表（Skills 的实际内容，含 fullPath, content, type）
 *        - agentSkills: AgentSkill 列表（含 fullPath, content, description）
 *        - mcpInstructions: MCP 服务器使用说明
 *        - tools: McpToolDefinition 列表（requestContext 级别的 MCP 工具）
 *   2. Relay 需要把这些信息透传给上游 LLM：
 *      - MCP 工具 → OpenAI tools 格式（function calling）
 *      - Skills/rules → 系统提示词上下文
 *      - MCP instructions → 系统提示词附加说明
 *   3. 上游 LLM 返回 tool_call 时，Relay 需要通过 Cursor 协议的 exec_server_message
 *      让 Cursor 客户端执行 MCP 工具并返回结果
 *
 * 与 conversation-fix.js 的关系：
 *   conversation-fix.js 的 buildToolSchemaForUpstream 是早期实现，这里是其增强版：
 *   - 支持从 requestContext 提取额外的 MCP 工具
 *   - 支持 Skills/rules 系统提示词构建
 *   - 支持 MCP instructions 注入
 *   - 支持 MCP 工具调用结果的中继
 */

const {
  buildConnectFrame,
} = require('./cursor-relay-protobuf');

// ── MCP 工具提取与转换 ──────────────────────────────────────

/**
 * 从解码后的 AgentClientMessage 中提取所有 MCP 工具定义
 *
 * 来源：
 *   1. runRequest.mcpTools.mcpTools (AgentRunRequest 级别)
 *   2. runRequest.action.userMessageAction.requestContext.tools (RequestContext 级别)
 *   3. runRequest.action.userMessageAction.requestContext.mcpFileSystemOptions.mcpDescriptors[].tools (文件系统级别)
 *
 * @param {object} clientMessage 解码后的 AgentClientMessage
 * @returns {Array<McpToolDefinition>} 去重后的 MCP 工具列表
 */
function extractMcpToolDefinitions(clientMessage) {
  if (!clientMessage) return [];
  const tools = [];
  const seen = new Set();

  // 来源1: AgentRunRequest.mcpTools.mcpTools
  try {
    const mcpTools = clientMessage.runRequest?.mcpTools?.mcpTools;
    if (Array.isArray(mcpTools)) {
      for (const tool of mcpTools) {
        const key = toolKey(tool);
        if (key && !seen.has(key)) {
          seen.add(key);
          tools.push(tool);
        }
      }
    }
  } catch {}

  // 来源2: RequestContext.tools
  try {
    const ctxTools = clientMessage.runRequest?.action?.userMessageAction?.requestContext?.tools;
    if (Array.isArray(ctxTools)) {
      for (const tool of ctxTools) {
        const key = toolKey(tool);
        if (key && !seen.has(key)) {
          seen.add(key);
          tools.push(tool);
        }
      }
    }
  } catch {}

  // 来源3: McpFileSystemOptions.mcpDescriptors[].tools
  try {
    const descriptors = clientMessage.runRequest?.mcpFileSystemOptions?.mcpDescriptors
      || clientMessage.runRequest?.action?.userMessageAction?.requestContext?.mcpFileSystemOptions?.mcpDescriptors;
    if (Array.isArray(descriptors)) {
      for (const desc of descriptors) {
        if (Array.isArray(desc.tools)) {
          for (const toolDesc of desc.tools) {
            // McpToolDescriptor has toolName, description, inputSchema
            const tool = {
              name: toolDesc.toolName || toolDesc.name,
              description: toolDesc.description || '',
              inputSchema: toolDesc.inputSchema || toolDesc.input_schema,
              providerIdentifier: desc.serverName || desc.serverIdentifier || '',
              toolName: toolDesc.toolName || '',
            };
            const key = toolKey(tool);
            if (key && !seen.has(key)) {
              seen.add(key);
              tools.push(tool);
            }
          }
        }
      }
    }
  } catch {}

  return tools;
}

function toolKey(tool) {
  const name = tool.name || tool.toolName;
  if (!name) return '';
  const provider = tool.providerIdentifier || tool.provider_identifier || '';
  return `${provider}/${name}`;
}

/**
 * 把 MCP 工具定义转换为 OpenAI tools 格式
 *
 * McpToolDefinition:
 *   name: string
 *   description: string
 *   inputSchema: google.protobuf.Value (JSON schema)
 *   providerIdentifier: string (MCP 服务器名)
 *   toolName: string (工具在 MCP 服务器内的名称)
 *
 * OpenAI tools:
 *   [{ type: "function", function: { name, description, parameters } }]
 *
 * @param {Array} mcpTools MCP 工具定义列表
 * @returns {Array} OpenAI tools 格式
 */
function convertMcpToolsToOpenAI(mcpTools) {
  if (!Array.isArray(mcpTools)) return [];
  const result = [];
  for (const tool of mcpTools) {
    const name = tool.name || tool.toolName;
    if (!name) continue;
    // 用 provider/name 作为唯一函数名，避免冲突
    const provider = tool.providerIdentifier || tool.provider_identifier || '';
    const fullName = provider ? `${provider}__${name}` : String(name);
    // OpenAI function name 只允许 [a-zA-Z0-9_-]，做一下清理
    const safeName = fullName.replace(/[^a-zA-Z0-9_-]/g, '_');
    result.push({
      type: 'function',
      function: {
        name: safeName,
        description: String(tool.description || ''),
        parameters: normalizeJsonSchema(tool.inputSchema || tool.input_schema),
      },
      // 保留原始信息，用于后续 MCP 工具调用中继
      _mcp: {
        provider: provider,
        toolName: tool.toolName || name,
        originalName: name,
      },
    });
  }
  return result;
}

/**
 * 标准化 JSON Schema（protobuf 解码后可能是各种格式）
 */
function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  // protobufjs 解码 google.protobuf.Value 后可能是嵌套结构
  // 如果已经有 type 字段，直接用
  if (schema.type) return schema;
  // 如果有 fields 或 properties
  if (schema.properties) return schema;
  if (schema.fields) {
    return {
      type: 'object',
      properties: schema.fields,
      required: schema.required || [],
    };
  }
  // google.protobuf.Value 的结构可能是 { structValue: { fields: {...} } }
  if (schema.structValue?.fields) {
    return convertStructValue(schema.structValue);
  }
  // 如果是 null/bool/number/string 的 Value
  if (schema.nullValue !== undefined) return { type: 'object', properties: {} };
  return schema;
}

/**
 * 递归转换 google.protobuf.Struct/Value 为普通 JSON Schema
 */
function convertStructValue(structVal) {
  if (!structVal) return {};
  const fields = structVal.fields || structVal;
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = convertValue(value);
  }
  return result;
}

function convertValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.nullValue !== undefined) return null;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.numberValue !== undefined) return value.numberValue;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.listValue?.values) return value.listValue.values.map(convertValue);
  if (value.structValue?.fields) return convertStructValue(value.structValue);
  return value;
}

// ── Skills / Rules 提取与系统提示词构建 ──────────────────────

/**
 * 从解码后的 AgentClientMessage 中提取所有 Skills 和 Rules
 *
 * 来源：
 *   1. runRequest.action.userMessageAction.requestContext.rules (CursorRule 列表)
 *   2. runRequest.action.userMessageAction.requestContext.agentSkills (AgentSkill 列表)
 *   3. runRequest.action.userMessageAction.requestContext.nonFileRules (非文件规则)
 *   4. runRequest.skillOptions.skillDescriptors (SkillDescriptor 列表，仅元信息)
 *
 * @param {object} clientMessage
 * @returns {{rules: Array, agentSkills: Array, skillDescriptors: Array}}
 */
function extractSkillsAndRules(clientMessage) {
  if (!clientMessage) return { rules: [], agentSkills: [], skillDescriptors: [] };

  let rules = [];
  let agentSkills = [];
  let skillDescriptors = [];

  try {
    const ctx = clientMessage.runRequest?.action?.userMessageAction?.requestContext;
    if (ctx) {
      if (Array.isArray(ctx.rules)) rules = ctx.rules;
      if (Array.isArray(ctx.agentSkills)) agentSkills = ctx.agentSkills;
      // nonFileRules 合并到 rules
      if (Array.isArray(ctx.nonFileRules)) rules = rules.concat(ctx.nonFileRules);
    }
  } catch {}

  try {
    skillDescriptors = clientMessage.runRequest?.skillOptions?.skillDescriptors || [];
    if (!Array.isArray(skillDescriptors)) skillDescriptors = [];
  } catch {}

  return { rules, agentSkills, skillDescriptors };
}

/**
 * 把 Skills 和 Rules 构建为系统提示词上下文
 *
 * 这段文本会附加到系统提示词中，让上游 LLM 知道用户配置了哪些 Skills 和规则
 *
 * @param {{rules: Array, agentSkills: Array, skillDescriptors: Array}} skills
 * @returns {string} 系统提示词片段
 */
function buildSkillSystemPrompt(skills) {
  if (!skills) return '';
  const parts = [];

  // Rules (CursorRule) — 这些是 .cursor/rules 或全局规则
  if (skills.rules && skills.rules.length > 0) {
    parts.push('## Active Rules');
    for (const rule of skills.rules) {
      const content = String(rule.content || '').trim();
      if (!content) continue;
      const path = String(rule.fullPath || '');
      const ruleType = detectRuleType(rule.type);
      if (ruleType === 'agentFetched') {
        // agentFetched 类型的规则只提供描述，让 LLM 决定是否使用
        const desc = rule.type?.agentFetched?.description || '';
        parts.push(`### Rule: ${path || 'agent-fetched'}`);
        if (desc) parts.push(`(Available when needed: ${desc})`);
        parts.push(content);
      } else {
        parts.push(`### Rule: ${path || 'rule'}`);
        parts.push(content);
      }
      parts.push('');
    }
  }

  // Agent Skills (AgentSkill) — 这些是 .cursor/skills 或系统 Skills
  if (skills.agentSkills && skills.agentSkills.length > 0) {
    parts.push('## Available Agent Skills');
    for (const skill of skills.agentSkills) {
      const content = String(skill.content || '').trim();
      const desc = String(skill.description || '').trim();
      const path = String(skill.fullPath || '');
      if (!content && !desc) continue;
      parts.push(`### Skill: ${path || skill.name || 'skill'}`);
      if (desc) parts.push(`Description: ${desc}`);
      if (content) parts.push(content);
      parts.push('');
    }
  }

  // Skill Descriptors (SkillDescriptor) — 仅元信息，不需要完整内容
  if (skills.skillDescriptors && skills.skillDescriptors.length > 0) {
    const enabled = skills.skillDescriptors.filter((s) => s.enabled !== false);
    if (enabled.length > 0) {
      parts.push('## Skill Registry');
      for (const desc of enabled) {
        parts.push(`- ${desc.name}: ${desc.description || ''}`);
      }
      parts.push('');
    }
  }

  return parts.join('\n').trim();
}

function detectRuleType(type) {
  if (!type) return 'global';
  const t = type.type || type;
  if (t?.agentFetched || t?.agent_fetched) return 'agentFetched';
  if (t?.fileGlobbed || t?.file_globbed) return 'fileGlobbed';
  if (t?.manuallyAttached || t?.manually_attached) return 'manuallyAttached';
  return 'global';
}

// ── MCP Instructions 提取 ───────────────────────────────────

/**
 * 从解码后的 AgentClientMessage 中提取 MCP 服务器使用说明
 *
 * 来源：runRequest.action.userMessageAction.requestContext.mcpInstructions
 *
 * @param {object} clientMessage
 * @returns {Array<{serverName, instructions}>}
 */
function extractMcpInstructions(clientMessage) {
  if (!clientMessage) return [];
  try {
    const instructions = clientMessage.runRequest?.action?.userMessageAction?.requestContext?.mcpInstructions;
    if (!Array.isArray(instructions)) return [];
    return instructions.map((item) => ({
      serverName: String(item.serverName || item.server_name || ''),
      instructions: String(item.instructions || item.serverUseInstructions || ''),
    })).filter((item) => item.instructions);
  } catch {
    return [];
  }
}

/**
 * 把 MCP Instructions 构建为系统提示词
 */
function buildMcpInstructionsPrompt(instructions) {
  if (!Array.isArray(instructions) || instructions.length === 0) return '';
  const parts = ['## MCP Server Instructions'];
  for (const item of instructions) {
    parts.push(`### ${item.serverName}`);
    parts.push(item.instructions);
    parts.push('');
  }
  return parts.join('\n').trim();
}

// ── 综合上下文构建 ──────────────────────────────────────────

/**
 * 综合提取 MCP/Skill 上下文，构建完整的透传信息
 *
 * @param {object} clientMessage 解码后的 AgentClientMessage
 * @returns {{
 *   openaiTools: Array,
 *   systemPromptContext: string,
 *   mcpToolMap: Map<string, object>,
 *   mcpInstructions: Array,
 *   skills: {rules, agentSkills, skillDescriptors}
 * }}
 */
function buildMcpSkillContext(clientMessage) {
  // MCP 工具
  const mcpTools = extractMcpToolDefinitions(clientMessage);
  const openaiTools = convertMcpToolsToOpenAI(mcpTools);

  // 构建 tool name → MCP 信息的映射，用于后续 tool_call 中继
  const mcpToolMap = new Map();
  for (const tool of openaiTools) {
    if (tool._mcp) {
      mcpToolMap.set(tool.function.name, tool._mcp);
    }
  }

  // Skills / Rules
  const skills = extractSkillsAndRules(clientMessage);
  const skillPrompt = buildSkillSystemPrompt(skills);

  // MCP Instructions
  const mcpInstructions = extractMcpInstructions(clientMessage);
  const mcpInstrPrompt = buildMcpInstructionsPrompt(mcpInstructions);

  // 合并系统提示词
  const systemPromptParts = [];
  if (skillPrompt) systemPromptParts.push(skillPrompt);
  if (mcpInstrPrompt) systemPromptParts.push(mcpInstrPrompt);
  const systemPromptContext = systemPromptParts.join('\n\n');

  return {
    openaiTools,
    systemPromptContext,
    mcpToolMap,
    mcpInstructions,
    skills,
    mcpToolCount: mcpTools.length,
  };
}

// ── MCP 工具调用结果中继 ────────────────────────────────────

/**
 * 检测一个 OpenAI tool_call 是否是 MCP 工具调用
 *
 * @param {{function: {name: string}}} toolCall OpenAI 格式的 tool_call
 * @param {Map<string, object>} mcpToolMap buildMcpSkillContext 返回的映射
 * @returns {boolean}
 */
function isMcpToolCall(toolCall, mcpToolMap) {
  if (!toolCall?.function?.name || !mcpToolMap) return false;
  return mcpToolMap.has(toolCall.function.name);
}

/**
 * 从 OpenAI tool_call 中提取 MCP 工具调用信息
 *
 * @param {object} toolCall OpenAI 格式的 tool_call
 * @param {Map<string, object>} mcpToolMap
 * @returns {{provider: string, toolName: string, args: object, originalName: string}|null}
 */
function parseMcpToolCall(toolCall, mcpToolMap) {
  if (!isMcpToolCall(toolCall, mcpToolMap)) return null;
  const funcName = toolCall.function.name;
  const mcpInfo = mcpToolMap.get(funcName);
  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch {}
  return {
    provider: mcpInfo.provider,
    toolName: mcpInfo.toolName,
    originalName: mcpInfo.originalName,
    args,
  };
}

/**
 * 构建 MCP 工具调用的 Cursor 协议帧
 *
 * 当上游 LLM 返回 MCP 工具调用时，需要通过 exec_server_message
 * 让 Cursor 客户端执行该 MCP 工具
 *
 * @param {object} mcpCall parseMcpToolCall 的返回值
 * @param {string} toolCallId 工具调用 ID
 * @returns {Buffer|null} Connect 协议帧
 */
function buildMcpToolExecFrame(mcpCall, toolCallId) {
  if (!mcpCall) return null;
  try {
    // 构建一个 ExecServerMessage，让客户端执行 MCP 工具
    // 实际的 MCP 工具执行由 Cursor 客户端处理
    const execMsg = {
      message: 'execServerMessage',
      execServerMessage: {
        message: 'mcpToolCall',
        mcpToolCall: {
          args: mcpCall.args,
          description: `MCP tool: ${mcpCall.provider}/${mcpCall.toolName}`,
        },
      },
    };
    // 编码为 AgentServerMessage
    const { encodeMessageSync } = require('./cursor-relay-protobuf');
    const payload = encodeMessageSync('agent.v1.AgentServerMessage', execMsg);
    return buildConnectFrame(payload);
  } catch {
    return null;
  }
}

/**
 * 从 Cursor 客户端返回的 MCP 工具结果中提取内容
 *
 * @param {object} execClientMessage 客户端返回的 ExecClientMessage
 * @returns {{content: string, isError: boolean, structuredContent: object|null}|null}
 */
function extractMcpToolResult(execClientMessage) {
  if (!execClientMessage) return null;
  try {
    // ExecClientMessage 可能包含 MCP 工具执行结果
    const mcpResult = execClientMessage.mcpToolResult
      || execClientMessage.execClientMessage?.mcpToolResult;
    if (!mcpResult) return null;

    let content = '';
    const contentItems = mcpResult.content || [];
    if (Array.isArray(contentItems)) {
      for (const item of contentItems) {
        if (item.text) {
          content += (content ? '\n' : '') + String(item.text.text || item.text);
        }
      }
    }
    // McpSuccess 的 content
    if (mcpResult.success?.content) {
      for (const item of mcpResult.success.content) {
        if (item.text) {
          content += (content ? '\n' : '') + String(item.text.text || item.text);
        }
      }
    }

    return {
      content,
      isError: !!mcpResult.isError || !!mcpResult.success?.isError,
      structuredContent: mcpResult.structuredContent || mcpResult.success?.structuredContent || null,
    };
  } catch {
    return null;
  }
}

// ── 调试信息 ────────────────────────────────────────────────

/**
 * 生成 MCP/Skill 上下文的调试摘要（不包含完整内容，避免日志过大）
 */
function summarizeMcpSkillContext(ctx) {
  if (!ctx) return 'none';
  return JSON.stringify({
    mcpToolCount: ctx.mcpToolCount || 0,
    openaiToolCount: ctx.openaiTools?.length || 0,
    ruleCount: ctx.skills?.rules?.length || 0,
    agentSkillCount: ctx.skills?.agentSkills?.length || 0,
    skillDescriptorCount: ctx.skills?.skillDescriptors?.length || 0,
    mcpInstructionCount: ctx.mcpInstructions?.length || 0,
    systemPromptLength: ctx.systemPromptContext?.length || 0,
  });
}

module.exports = {
  // MCP 工具提取与转换
  extractMcpToolDefinitions,
  convertMcpToolsToOpenAI,
  normalizeJsonSchema,
  // Skills / Rules
  extractSkillsAndRules,
  buildSkillSystemPrompt,
  // MCP Instructions
  extractMcpInstructions,
  buildMcpInstructionsPrompt,
  // 综合上下文
  buildMcpSkillContext,
  // MCP 工具调用中继
  isMcpToolCall,
  parseMcpToolCall,
  buildMcpToolExecFrame,
  extractMcpToolResult,
  // 调试
  summarizeMcpSkillContext,
};

/**
 * cursor-relay-protocol-v2.js
 *
 * 基于 protobufjs 的协议解码器，作为 cursor-relay-protocol.js（手写）的替代。
 *
 * 设计原则：
 *   1. 返回与手写版兼容的结构（decodeBidiAppendRequest 返回 {requestId, userText, kind, debug}）
 *   2. 同时附带完整解码对象（decoded.clientMessage / decoded.rawBidiRequest），供后续功能使用
 *   3. 保留手写版作为兜底，通过 fallbackToLegacy 选项控制
 *   4. 新增：解析 MCP/Skill/ExecuteHook 字段（手写版只做 shape 摘要）
 *
 * 替换策略（在 runner.js 中）：
 *   const { decodeBidiAppendRequest: decodeV2 } = require('./cursor-relay-protocol-v2');
 *   // 旧: const decoded = decodeBidiAppendRequest(rawBody);
 *   // 新: const decoded = decodeV2(rawBody, { fallbackToLegacy: true });
 *   //        if (!decoded) decoded = decodeBidiAppendRequest(rawBody); // 兜底
 */

const {
  loadCursorProtoRoot,
  getRootSync,
  decodeMessageSync,
  decodeBidiAppendPayload,
  readConnectFrames,
  buildConnectFrame,
  buildConnectEndFrame,
  resolveTypesFromPathSync,
} = require('./cursor-relay-protobuf');

// 手写版兜底
const legacy = require('./cursor-relay-protocol');

/**
 * 解码 BidiAppend 请求，返回与手写版兼容的结构 + 完整解码对象
 *
 * @param {Buffer} rawBody 原始请求体
 * @param {{fallbackToLegacy?: boolean}} options
 * @returns {{requestId, userText, kind, debug, clientMessage?, rawBidiRequest?}|null}
 */
function decodeBidiAppendRequest(rawBody, options = {}) {
  try {
    // 确保 proto 已加载
    try {
      getRootSync();
    } catch {
      // 还没加载完成，走兜底
      if (options.fallbackToLegacy !== false) {
        return legacy.decodeBidiAppendRequest(rawBody);
      }
      return null;
    }

    const result = decodeBidiAppendPayload(rawBody);
    if (!result) {
      if (options.fallbackToLegacy !== false) {
        return legacy.decodeBidiAppendRequest(rawBody);
      }
      return null;
    }

    const { requestId, clientMessage, rawBidiRequest } = result;
    const kind = detectClientMessageKind(clientMessage);
    const userText = extractUserText(clientMessage);
    const mcpTools = extractMcpTools(clientMessage);
    const skillOptions = extractSkillOptions(clientMessage);
    const agentMode = extractAgentMode(clientMessage);
    const workspaceRoot = extractWorkspaceRoot(clientMessage);

    // 把 conversationAction 归一化为 legacy 兼容格式（补充 kind/扁平字段），
    // 让 runner.js 的 conversation_action 处理能正确读取 action.kind 等字段。
    // 保留原始嵌套字段（userMessageAction/cancelAction/...）供 MCP/Skill 提取使用。
    if (clientMessage?.conversationAction) {
      clientMessage.conversationAction = normalizeConversationActionForLegacy(clientMessage.conversationAction);
    }

    return {
      requestId: typeof requestId === 'object' ? requestId.requestId || '' : String(requestId || ''),
      userText,
      kind,
      debug: {
        agentClientMessage: clientMessage,
        rawBidiRequest,
        mcpTools,
        skillOptions,
        agentMode,
        workspaceRoot,
        source: 'protobufjs',
      },
      clientMessage,
      rawBidiRequest,
    };
  } catch (e) {
    if (options.fallbackToLegacy !== false) {
      return legacy.decodeBidiAppendRequest(rawBody);
    }
    return null;
  }
}

/**
 * 检测 AgentClientMessage 的 oneof kind
 */
function detectClientMessageKind(clientMessage) {
  if (!clientMessage) return 'unknown';
  const msg = clientMessage.message || '';
  switch (msg) {
    case 'runRequest':
      return 'user_message';
    case 'execClientMessage':
      return 'exec_client';
    case 'execClientControlMessage':
      return 'exec_control';
    case 'kvClientMessage':
      return 'kv_client';
    case 'conversationAction':
      return 'conversation_action';
    case 'interactionResponse':
      return 'interaction_response';
    case 'clientHeartbeat':
      return 'client_heartbeat';
    case 'prewarmRequest':
      return 'prewarm_request';
    default:
      return msg || 'unknown';
  }
}

/**
 * 提取用户文本（从 runRequest 或 conversationAction）
 */
function extractUserText(clientMessage) {
  if (!clientMessage) return '';
  try {
    const runReq = clientMessage.runRequest;
    if (runReq) {
      // 初始消息：runRequest.action.userMessageAction.userMessage.text
      const action = runReq.action;
      if (action?.userMessageAction?.userMessage?.text) {
        return String(action.userMessageAction.userMessage.text);
      }
      // 或者 runRequest.conversationState 里
    }
    const convAction = clientMessage.conversationAction;
    if (convAction?.userMessageAction?.userMessage?.text) {
      return String(convAction.userMessageAction.userMessage.text);
    }
  } catch {}
  return '';
}

/**
 * 提取 MCP 工具列表（手写版不支持）
 */
function extractMcpTools(clientMessage) {
  if (!clientMessage?.runRequest?.mcpTools) return null;
  try {
    const tools = clientMessage.runRequest.mcpTools;
    return {
      tools: Array.isArray(tools.tools) ? tools.tools : [],
      source: 'protobufjs',
    };
  } catch {
    return null;
  }
}

/**
 * 提取 Skill 选项（手写版不支持）
 */
function extractSkillOptions(clientMessage) {
  if (!clientMessage?.runRequest?.skillOptions) return null;
  try {
    return clientMessage.runRequest.skillOptions;
  } catch {
    return null;
  }
}

/**
 * 提取 AgentMode（agent/ask/plan/debug/triage/project/multitask）
 */
function extractAgentMode(clientMessage) {
  if (!clientMessage?.runRequest?.action) return null;
  try {
    const mode = clientMessage.runRequest.action.mode;
    return mode || null;
  } catch {
    return null;
  }
}

/**
 * 提取 workspaceRoot
 */
function extractWorkspaceRoot(clientMessage) {
  if (!clientMessage?.runRequest) return '';
  try {
    const ctx = clientMessage.runRequest.action?.context
      || clientMessage.runRequest.conversationState;
    // requestContext 里可能有 repositoryInfo
    return '';
  } catch {
    return '';
  }
}

/**
 * 把 protobufjs 解码的 ConversationAction (raw oneof 结构) 转成 runner.js 期望的
 * legacy summary 格式（带 kind/userText/plan/planFileUri/planFileContent/executionMode 等扁平字段）。
 *
 * 背景：runner.js 的 conversation_action 处理 (line 8705+) 读 action.kind / action.plan / action.userText
 * 等扁平字段，这些字段是手写版 summarizeConversationActionPayload 产生的。
 * protobufjs 返回的是原始嵌套结构 (action.userMessageAction.userMessage.text 等)，
 * 没有 kind 字段，导致 runner.js 的 cancel/start_plan/execute_plan/userMessageAction 全部失效。
 *
 * 本函数在保留 raw oneof 字段的同时，补充 legacy 兼容的扁平字段。
 *
 * @param {object} convAction protobufjs 解码的 ConversationAction
 * @returns {object} 带 kind + 扁平字段 + 原始嵌套字段的混合对象
 */
function normalizeConversationActionForLegacy(convAction) {
  if (!convAction || typeof convAction !== 'object') return convAction;

  // oneof 选择器 (protobufjs with oneofs:true 设置)
  const oneof = convAction.action || '';
  // camelCase → snake_case kind 映射
  const kindMap = {
    userMessageAction: 'user_message_action',
    resumeAction: 'resume_action',
    cancelAction: 'cancel_action',
    summarizeAction: 'summarize_action',
    shellCommandAction: 'shell_command_action',
    startPlanAction: 'start_plan_action',
    executePlanAction: 'execute_plan_action',
    asyncAskQuestionCompletionAction: 'async_ask_question_completion_action',
    cancelSubagentAction: 'cancel_subagent_action',
    backgroundTaskCompletionAction: 'background_task_completion_action',
    backgroundShellAction: 'background_shell_action',
    backgroundSubagentAction: 'background_subagent_action',
  };
  const kind = kindMap[oneof] || '';

  // 基础 summary（默认值与 legacy summarizeConversationActionPayload 对齐）
  const summary = {
    kind,
    userText: '',
    cancelReason: '',
    executionMode: 'AGENT_MODE_UNSPECIFIED',
    plan: '',
    planFileUri: '',
    planFileContent: '',
    isSpec: false,
    messageId: '',
    requestContext: null,
    subagentId: '',
  };

  // 按动作类型填充扁平字段
  try {
    switch (oneof) {
      case 'userMessageAction': {
        const um = convAction.userMessageAction?.userMessage;
        if (um) {
          summary.userText = String(um.text || '').trim();
          summary.messageId = String(um.messageId || '').trim();
        }
        summary.requestContext = convAction.userMessageAction?.requestContext || null;
        break;
      }
      case 'startPlanAction': {
        const um = convAction.startPlanAction?.userMessage;
        if (um) {
          summary.userText = String(um.text || '').trim();
          summary.messageId = String(um.messageId || '').trim();
        }
        summary.isSpec = Boolean(convAction.startPlanAction?.isSpec);
        summary.requestContext = convAction.startPlanAction?.requestContext || null;
        break;
      }
      case 'executePlanAction': {
        const ep = convAction.executePlanAction;
        // ConversationPlan { string plan = 1; }
        summary.plan = String(ep?.plan?.plan || '').trim();
        summary.planFileUri = String(ep?.planFileUri || '').trim();
        summary.planFileContent = String(ep?.planFileContent || '').trim();
        summary.requestContext = ep?.requestContext || null;
        break;
      }
      case 'cancelAction': {
        summary.cancelReason = String(convAction.cancelAction?.reason || '').trim();
        break;
      }
      case 'resumeAction': {
        summary.requestContext = convAction.resumeAction?.requestContext || null;
        break;
      }
      case 'cancelSubagentAction': {
        summary.subagentId = String(convAction.cancelSubagentAction?.subagentId || '').trim();
        break;
      }
      default:
        break;
    }
  } catch {
    // 解析失败不阻断主流程
  }

  // 返回混合对象：保留原始嵌套字段 + 补充 legacy 扁平字段
  return { ...convAction, ...summary };
}

/**
 * 解码 RunSSE 响应流，返回结构化的 InteractionUpdate 列表
 * （手写版只返回 shape 摘要，这里返回完整解码）
 *
 * @param {Buffer} responseBody
 * @returns {{frameTypes:[], interactionUpdates:[], execServerTools:[], samples:[]}}
 */
function summarizeAgentServerStream(responseBody, options = {}) {
  const maxSamples = options.maxSamples || 8;
  const frames = readConnectFrames(responseBody);
  const frameTypes = [];
  const interactionUpdates = [];
  const execServerTools = [];
  const samples = [];

  for (const frame of frames) {
    try {
      const msg = decodeMessageSync('agent.v1.AgentServerMessage', frame.payload);
      const oneof = msg.message || '';
      frameTypes.push(oneof);

      if (oneof === 'interactionUpdate') {
        const iu = msg.interactionUpdate;
        const iuKind = iu?.message || '';
        interactionUpdates.push(iuKind);
        if (samples.length < maxSamples) {
          samples.push({ type: 'interaction_update', kind: iuKind, data: iu });
        }
      } else if (oneof === 'execServerMessage') {
        const es = msg.execServerMessage;
        const esKind = es?.message || '';
        execServerTools.push(esKind);
        if (samples.length < maxSamples) {
          samples.push({ type: 'exec_server', kind: esKind, data: es });
        }
      } else if (oneof && samples.length < maxSamples) {
        samples.push({ type: oneof, data: msg[oneof] });
      }
    } catch {
      frameTypes.push('parse_error');
    }
  }

  return { frameTypes, interactionUpdates, execServerTools, samples, source: 'protobufjs' };
}

/**
 * 解码 RunSSE body 提取 requestId
 */
function decodeRunSseRequestId(responseBody) {
  try {
    const frames = readConnectFrames(responseBody);
    for (const frame of frames) {
      try {
        const msg = decodeMessageSync('aiserver.v1.BidiRequestId', frame.payload);
        if (msg.requestId) return String(msg.requestId);
      } catch {}
    }
  } catch {}
  // 兜底走手写版
  return legacy.decodeRunSseRequestId(responseBody);
}

module.exports = {
  decodeBidiAppendRequest,
  detectClientMessageKind,
  extractUserText,
  extractMcpTools,
  extractSkillOptions,
  extractAgentMode,
  normalizeConversationActionForLegacy,
  summarizeAgentServerStream,
  decodeRunSseRequestId,
  // 透传手写版的编码函数（暂不替换，后续可逐步迁移）
  buildAgentTextDeltaFrame: legacy.buildAgentTextDeltaFrame,
  buildAgentTurnEndedFrame: legacy.buildAgentTurnEndedFrame,
  buildAgentToolCallStartedFrame: legacy.buildAgentToolCallStartedFrame,
  buildAgentToolCallCompletedFrame: legacy.buildAgentToolCallCompletedFrame,
  buildAgentPartialToolCallFrame: legacy.buildAgentPartialToolCallFrame,
  buildConnectEndFrame: legacy.buildConnectEndFrame,
  buildConnectErrorFrame: legacy.buildConnectErrorFrame,
};

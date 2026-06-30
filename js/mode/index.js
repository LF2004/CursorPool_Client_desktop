const { normalizeAgentModeName } = require('./registry');
const { getSessionAgentMode } = require('./common/policy');
const agentMode = require('./agent-mode');
const askMode = require('./ask-mode');
const planMode = require('./plan-mode');
const debugMode = require('./debug-mode');
const triageMode = require('./triage-mode');
const projectMode = require('./project-mode');
const multitaskMode = require('./multitask-mode');
const subagentMode = require('./subagent-mode');

const MODE_HANDLERS = {
  AGENT_MODE_AGENT: agentMode,
  AGENT_MODE_ASK: askMode,
  AGENT_MODE_PLAN: planMode,
  AGENT_MODE_DEBUG: debugMode,
  AGENT_MODE_TRIAGE: triageMode,
  AGENT_MODE_PROJECT: projectMode,
  AGENT_MODE_MULTITASK: multitaskMode,
  AGENT_MODE_SUBAGENT: subagentMode,
};

function getModeHandler(modeName = '') {
  return MODE_HANDLERS[normalizeAgentModeName(modeName)] || agentMode;
}

function buildToolDefinitionsForChatByMode(options = {}) {
  const modeName = normalizeAgentModeName(options.mode || 'AGENT_MODE_AGENT');
  return getModeHandler(modeName).buildToolDefinitionsForChat({ ...options, mode: modeName });
}

function buildToolDefinitionsForResponsesByMode(options = {}) {
  const modeName = normalizeAgentModeName(options.mode || 'AGENT_MODE_AGENT');
  return getModeHandler(modeName).buildToolDefinitionsForResponses({ ...options, mode: modeName });
}

function buildLocalRelayMessagesForMode(modeName = '', input = {}) {
  const normalizedMode = normalizeAgentModeName(modeName || input.modeName || 'AGENT_MODE_AGENT');
  return getModeHandler(normalizedMode).buildLocalRelayMessages({ ...input, modeName: normalizedMode });
}

function shouldUseNativeExecForModeTool(session, toolCall, helpers = {}) {
  const modeName = getSessionAgentMode(session);
  return getModeHandler(modeName).shouldUseNativeExecForTool(session, toolCall, helpers);
}

function getUpstreamRequestOptionsForMode(modeName = '', context = {}) {
  const normalizedMode = normalizeAgentModeName(modeName || context.mode || 'AGENT_MODE_AGENT');
  const handler = getModeHandler(normalizedMode);
  if (typeof handler.getUpstreamRequestOptions === 'function') {
    return handler.getUpstreamRequestOptions({ ...context, mode: normalizedMode }) || {};
  }
  return {};
}

module.exports = {
  getModeHandler,
  buildToolDefinitionsForChatByMode,
  buildToolDefinitionsForResponsesByMode,
  buildLocalRelayMessagesForMode,
  shouldUseNativeExecForModeTool,
  getUpstreamRequestOptionsForMode,
};

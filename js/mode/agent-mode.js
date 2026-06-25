const { readModeText } = require('./registry');
const { buildModeRelayMessages } = require('./common/message-builder');
const {
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  mergeAgentModeToolDefinitions,
  buildToolDefinitionsForResponses: buildResponsesToolDefinitions,
} = require('./common/tools');
const { shouldUseNativeExecForToolByMode } = require('./common/policy');

const AGENT_TOOL_NAMES = [
  'Read',
  'Grep',
  'Write',
  'PatchEdit',
  'Edit',
  'StrReplace',
  'Delete',
  'Glob',
  'LS',
  'ReadLints',
  'Shell',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'SemanticSearch',
  'AskQuestion',
  'CreatePlan',
];

function buildToolDefinitionsForChat(options = {}) {
  return filterToolDefinitionsByName(
    mergeAgentModeToolDefinitions(buildFallbackRelayToolDefinitions(), 'AGENT_MODE_AGENT'),
    AGENT_TOOL_NAMES,
  );
}

function buildToolDefinitionsForResponses(options = {}) {
  return filterToolDefinitionsByName(
    buildResponsesToolDefinitions(buildToolDefinitionsForChat(options)),
    AGENT_TOOL_NAMES,
  );
}

function buildLocalRelayMessages(input = {}) {
  return buildModeRelayMessages({
    ...input,
    modeName: 'AGENT_MODE_AGENT',
    cursorAgentPrompt: readModeText('AGENT_MODE_AGENT', 'system_prompt.txt'),
    cursorModeReminder: readModeText('AGENT_MODE_AGENT', 'system_reminder.txt'),
  });
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

function getUpstreamPhaseConfig(context = {}) {
  void context;
  return {
    fetch: {
      preferredEndpointMode: 'chat',
    },
  };
}

module.exports = {
  AGENT_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  shouldUseNativeExecForTool,
  getUpstreamPhaseConfig,
  getUpstreamRequestOptions() {
    return {
      preferredEndpointMode: 'chat',
    };
  },
};

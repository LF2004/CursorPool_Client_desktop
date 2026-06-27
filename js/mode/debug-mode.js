const { readModeText } = require('./registry');
const { buildModeRelayMessages } = require('./common/message-builder');
const {
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  mergeAgentModeToolDefinitions,
  buildToolDefinitionsForResponses: buildResponsesToolDefinitions,
} = require('./common/tools');
const { shouldUseNativeExecForToolByMode } = require('./common/policy');

// Debug mode: focused on diagnosing and fixing bugs
// Has read/write/grep/shell tools, emphasizes error diagnosis and systematic debugging
const DEBUG_TOOL_NAMES = [
  'Read',
  'Grep',
  'Glob',
  'Write',
  'PatchEdit',
  'Edit',
  'StrReplace',
  'Delete',
  'LS',
  'ReadLints',
  'Diagnostics',
  'Shell',
  'WebFetch',
  'WebSearch',
  'SemanticSearch',
  'AskQuestion',
];

function buildToolDefinitionsForChat(options = {}) {
  return filterToolDefinitionsByName(
    mergeAgentModeToolDefinitions(buildFallbackRelayToolDefinitions(), 'AGENT_MODE_DEBUG'),
    DEBUG_TOOL_NAMES,
  );
}

function buildToolDefinitionsForResponses(options = {}) {
  return filterToolDefinitionsByName(
    buildResponsesToolDefinitions(buildToolDefinitionsForChat(options)),
    DEBUG_TOOL_NAMES,
  );
}

function buildLocalRelayMessages(input = {}) {
  const prompt = readModeText('AGENT_MODE_DEBUG', 'system_prompt.txt')
    || readModeText('AGENT_MODE_AGENT', 'system_prompt.txt');
  const reminder = readModeText('AGENT_MODE_DEBUG', 'system_reminder.txt');
  return buildModeRelayMessages({
    ...input,
    modeName: 'AGENT_MODE_DEBUG',
    cursorAgentPrompt: prompt,
    cursorModeReminder: reminder,
    extraSystemLines: [
      'Debug mode is focused on systematic bug diagnosis and fixing.',
      'Start by reproducing the issue, then trace the root cause through logs, stack traces, and code inspection.',
      'Use ReadLints and Diagnostics tools to identify errors before making changes.',
      'Make minimal, targeted fixes. Avoid refactoring unrelated code during debugging.',
      'After applying a fix, verify the issue is resolved by running the relevant tests or commands.',
    ],
  });
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  // Debug mode allows shell for running tests and reproducing issues
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

module.exports = {
  DEBUG_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  shouldUseNativeExecForTool,
  getUpstreamRequestOptions() {
    return {
      preferredEndpointMode: 'chat',
    };
  },
};

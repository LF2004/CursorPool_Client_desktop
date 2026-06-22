const { readModeText } = require('./registry');
const { buildModeRelayMessages } = require('./common/message-builder');
const {
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  mergeAgentModeToolDefinitions,
  buildToolDefinitionsForResponses: buildResponsesToolDefinitions,
} = require('./common/tools');
const { shouldUseNativeExecForToolByMode } = require('./common/policy');

const ASK_TOOL_NAMES = [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'ReadLints',
  'WebFetch',
  'WebSearch',
  'SemanticSearch',
  'AskQuestion',
  'TodoWrite',
];

function buildToolDefinitionsForChat(options = {}) {
  return filterToolDefinitionsByName(
    mergeAgentModeToolDefinitions(buildFallbackRelayToolDefinitions(), 'AGENT_MODE_ASK'),
    ASK_TOOL_NAMES,
  );
}

function buildToolDefinitionsForResponses(options = {}) {
  return filterToolDefinitionsByName(
    buildResponsesToolDefinitions(buildToolDefinitionsForChat(options)),
    ASK_TOOL_NAMES,
  );
}

function buildLocalRelayMessages(input = {}) {
  return buildModeRelayMessages({
    ...input,
    modeName: 'AGENT_MODE_ASK',
    cursorAgentPrompt: readModeText('AGENT_MODE_ASK', 'system_prompt.txt'),
    cursorModeReminder: readModeText('AGENT_MODE_ASK', 'system_reminder.txt'),
    extraSystemLines: [
      'Ask mode is read-only exploration mode.',
      'Do not write, edit, patch, delete, or run mutating shell commands.',
      'Focus on inspecting the workspace, answering questions, and gathering context safely.',
    ],
  });
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  if (['write', 'edit', 'patchedit', 'strreplace', 'delete', 'shell'].includes(lower)) return false;
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

module.exports = {
  ASK_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  shouldUseNativeExecForTool,
};

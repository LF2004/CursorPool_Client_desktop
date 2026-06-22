const { readModeText } = require('./registry');
const { buildModeRelayMessages } = require('./common/message-builder');
const {
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  mergeAgentModeToolDefinitions,
  buildToolDefinitionsForResponses: buildResponsesToolDefinitions,
} = require('./common/tools');
const { shouldUseNativeExecForToolByMode } = require('./common/policy');

const MULTITASK_TOOL_NAMES = [
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
    mergeAgentModeToolDefinitions(buildFallbackRelayToolDefinitions(), 'AGENT_MODE_MULTITASK'),
    MULTITASK_TOOL_NAMES,
  );
}

function buildToolDefinitionsForResponses(options = {}) {
  return filterToolDefinitionsByName(
    buildResponsesToolDefinitions(buildToolDefinitionsForChat(options)),
    MULTITASK_TOOL_NAMES,
  );
}

function buildLocalRelayMessages(input = {}) {
  const prompt = readModeText('AGENT_MODE_MULTITASK', 'system_prompt.txt')
    || readModeText('AGENT_MODE_AGENT', 'system_prompt.txt');
  const reminder = readModeText('AGENT_MODE_MULTITASK', 'system_reminder.txt');
  return buildModeRelayMessages({
    ...input,
    modeName: 'AGENT_MODE_MULTITASK',
    cursorAgentPrompt: prompt,
    cursorModeReminder: reminder,
    extraSystemLines: [
      'Multitask mode should break complex work into independently verifiable steps.',
      'Batch related read-only inspection where helpful, but keep file mutations deliberate and easy to review.',
    ],
  });
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

module.exports = {
  MULTITASK_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  shouldUseNativeExecForTool,
};

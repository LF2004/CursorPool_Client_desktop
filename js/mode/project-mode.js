const { readModeText } = require('./registry');
const { buildModeRelayMessages } = require('./common/message-builder');
const {
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  mergeAgentModeToolDefinitions,
  buildToolDefinitionsForResponses: buildResponsesToolDefinitions,
} = require('./common/tools');
const { shouldUseNativeExecForToolByMode } = require('./common/policy');

// Project mode: focused on project-level planning, architecture, and multi-file coordination
// Full toolset like Agent mode, but emphasizes project structure and multi-file changes
const PROJECT_TOOL_NAMES = [
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
  'CreatePlan',
  'TodoWrite',
];

function buildToolDefinitionsForChat(options = {}) {
  return filterToolDefinitionsByName(
    mergeAgentModeToolDefinitions(buildFallbackRelayToolDefinitions(), 'AGENT_MODE_PROJECT'),
    PROJECT_TOOL_NAMES,
  );
}

function buildToolDefinitionsForResponses(options = {}) {
  return filterToolDefinitionsByName(
    buildResponsesToolDefinitions(buildToolDefinitionsForChat(options)),
    PROJECT_TOOL_NAMES,
  );
}

function buildLocalRelayMessages(input = {}) {
  const prompt = readModeText('AGENT_MODE_PROJECT', 'system_prompt.txt')
    || readModeText('AGENT_MODE_AGENT', 'system_prompt.txt');
  const reminder = readModeText('AGENT_MODE_PROJECT', 'system_reminder.txt');
  return buildModeRelayMessages({
    ...input,
    modeName: 'AGENT_MODE_PROJECT',
    cursorAgentPrompt: prompt,
    cursorModeReminder: reminder,
    extraSystemLines: [
      'Project mode is for project-level architecture, planning, and multi-file coordination.',
      'Before making changes, understand the project structure and how components interact.',
      'Break large changes into reviewable steps. Use CreatePlan and TodoWrite to track progress.',
      'Consider backward compatibility, testing impact, and deployment concerns.',
      'Coordinate changes across multiple files to maintain consistency.',
    ],
  });
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

module.exports = {
  PROJECT_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  shouldUseNativeExecForTool,
  getUpstreamRequestOptions() {
    return {};
  },
};

const { readModeText } = require('./registry');
const { buildModeRelayMessages } = require('./common/message-builder');
const {
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  mergeAgentModeToolDefinitions,
  buildToolDefinitionsForResponses: buildResponsesToolDefinitions,
} = require('./common/tools');
const { shouldUseNativeExecForToolByMode } = require('./common/policy');

// Triage mode: focused on quickly categorizing and prioritizing issues
// Read-only inspection tools, no mutation tools
const TRIAGE_TOOL_NAMES = [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'ReadLints',
  'Diagnostics',
  'WebFetch',
  'WebSearch',
  'SemanticSearch',
  'AskQuestion',
  'TodoWrite',
];

function buildToolDefinitionsForChat(options = {}) {
  return filterToolDefinitionsByName(
    mergeAgentModeToolDefinitions(buildFallbackRelayToolDefinitions(), 'AGENT_MODE_TRIAGE'),
    TRIAGE_TOOL_NAMES,
  );
}

function buildToolDefinitionsForResponses(options = {}) {
  return filterToolDefinitionsByName(
    buildResponsesToolDefinitions(buildToolDefinitionsForChat(options)),
    TRIAGE_TOOL_NAMES,
  );
}

function buildLocalRelayMessages(input = {}) {
  const prompt = readModeText('AGENT_MODE_TRIAGE', 'system_prompt.txt')
    || readModeText('AGENT_MODE_ASK', 'system_prompt.txt');
  const reminder = readModeText('AGENT_MODE_TRIAGE', 'system_reminder.txt');
  return buildModeRelayMessages({
    ...input,
    modeName: 'AGENT_MODE_TRIAGE',
    cursorAgentPrompt: prompt,
    cursorModeReminder: reminder,
    extraSystemLines: [
      'Triage mode is read-only issue assessment and prioritization mode.',
      'Do not write, edit, patch, delete, or run mutating shell commands.',
      'Focus on identifying the scope, severity, and root cause category of issues.',
      'Categorize issues by priority: critical, high, medium, low.',
      'Provide a summary of findings with recommended next steps for each issue.',
    ],
  });
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  // Triage mode is read-only — block all mutation tools
  if (['write', 'edit', 'patchedit', 'strreplace', 'delete', 'shell'].includes(lower)) return false;
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

module.exports = {
  TRIAGE_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  shouldUseNativeExecForTool,
  getUpstreamRequestOptions() {
    return {};
  },
};

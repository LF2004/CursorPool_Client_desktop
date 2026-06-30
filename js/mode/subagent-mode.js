const { readModeText } = require('./registry');
const { buildModeRelayMessages } = require('./common/message-builder');
const {
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  mergeAgentModeToolDefinitions,
  buildToolDefinitionsForResponses: buildResponsesToolDefinitions,
} = require('./common/tools');
const { shouldUseNativeExecForToolByMode } = require('./common/policy');

const SUBAGENT_TOOL_NAMES = [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'ReadLints',
  'WebFetch',
  'WebSearch',
  'SemanticSearch',
  'GetRelatedFiles',
  'TodoWrite',
  'TodoRead',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Mcp',
];

const SUBAGENT_ACTIVE_MODE_CONTRACT = [
  '<system_reminder>',
  'For this turn, you are running as a Cursor-style subagent.',
  'Stay focused on the delegated scope, gather evidence with read-only tools first, and return a concise handoff summary to the parent agent.',
  'Do not claim to modify files unless mutation tools are explicitly available and tool results confirm the edits.',
  '</system_reminder>',
].join('\n');

function buildToolDefinitionsForChat(options = {}) {
  return filterToolDefinitionsByName(
    mergeAgentModeToolDefinitions(buildFallbackRelayToolDefinitions(), 'AGENT_MODE_SUBAGENT'),
    SUBAGENT_TOOL_NAMES,
  );
}

function buildToolDefinitionsForResponses(options = {}) {
  return filterToolDefinitionsByName(
    buildResponsesToolDefinitions(buildToolDefinitionsForChat(options)),
    SUBAGENT_TOOL_NAMES,
  );
}

function buildLocalRelayMessages(input = {}) {
  return buildModeRelayMessages({
    ...input,
    modeName: 'AGENT_MODE_SUBAGENT',
    cursorAgentPrompt: readModeText('AGENT_MODE_SUBAGENT', 'system_prompt.txt', {
      modelName: input.modelName || input.requestedModel || '',
    }),
    cursorModeReminder: SUBAGENT_ACTIVE_MODE_CONTRACT,
    extraSystemLines: [
      'Subagent mode is optimized for delegated investigation and concise parent handoff.',
      'Prefer evidence collection and short, structured summaries over broad implementation unless explicitly delegated.',
    ],
  });
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

module.exports = {
  SUBAGENT_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  buildPlanInitialPromptContexts() {
    return [{
      source: 'active_mode_contract',
      role: 'user',
      content: SUBAGENT_ACTIVE_MODE_CONTRACT,
    }];
  },
  buildModeHistoryMetadata() {
    return {
      mode_contract_id: 'subagent_v1',
      expected_artifacts: ['evidence_summary', 'parent_handoff'],
    };
  },
  shouldUseNativeExecForTool,
  getUpstreamRequestOptions() {
    return {};
  },
};

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
  'Task',
];

const MULTITASK_ACTIVE_MODE_CONTRACT = [
  '<system_reminder>',
  'For the turn that contains this reminder, the active mode is multitask.',
  'Act as the foreground coordinator: delegate non-trivial work to Task-backed workers, keep parent updates concise, and avoid collapsing back into a single long foreground-only conversation.',
  'Prefer maintaining multiple child tasks with distinct scopes and allow parent/child progress to interleave rather than waiting for a fully serialized chain.',
  '</system_reminder>',
].join('\n');

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

function buildPlanInitialPromptContexts(input = {}) {
  void input;
  return [
    {
      source: 'mode_change',
      role: 'user',
      content: '<system_reminder>\nAt this point, the active mode changed to multitask; follow later mode reminders if present.\n</system_reminder>',
    },
    {
      source: 'active_mode_contract',
      role: 'user',
      content: MULTITASK_ACTIVE_MODE_CONTRACT,
    },
  ];
}

function buildModeHistoryMetadata(session = {}) {
  const record = session?.lastTaskSubagentId && typeof session === 'object'
    ? null
    : null;
  void record;
  return {
    mode_contract_id: 'multitask_v1',
    coordinator: 'foreground_parent',
    expected_artifacts: ['task_registry', 'child_tasks', 'task_summaries'],
  };
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

function interceptToolExecution(session = {}, toolCall = {}, context = {}, helpers = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  if (lower !== 'task') return null;
  // Multitask must run the real Task execution path so child task registry,
  // background lifecycle, and native task updates can be emitted.
  void context;
  void helpers;
  return null;
}

function isMissingChildTaskFanout(record = {}) {
  const childCount = Array.isArray(record?.childTaskIds) ? record.childTaskIds.length : 0;
  return Boolean(record) && childCount < 2;
}

function hasCompletedChildWork(record = {}) {
  const childCount = Array.isArray(record?.childTaskIds) ? record.childTaskIds.length : 0;
  const summary = String(record?.summary || record?.resultText || '').trim();
  return childCount > 0 && summary.length > 80;
}

function textLooksLikeCoordinatorWrapUp(text = '') {
  const finalLower = String(text || '').trim().toLowerCase();
  if (!finalLower) return false;
  return (
    finalLower.includes('child task')
    || finalLower.includes('coordinator')
    || finalLower.includes('summary')
    || finalLower.includes('completed')
    || finalLower.includes('next')
    || finalLower.includes('findings')
  );
}

module.exports = {
  MULTITASK_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  buildPlanInitialPromptContexts,
  buildModeHistoryMetadata,
  shouldUseNativeExecForTool,
  interceptToolExecution,
  shouldForceContinuationToolChoice(session = {}, finalText = '', options = {}, helpers = {}) {
    const latestTask = helpers.getLatestSessionTaskRecord?.(session);
    if (isMissingChildTaskFanout(latestTask)) return true;
    void finalText;
    void options;
    return false;
  },
  buildIncompleteContinuationMessage(session = {}, finalText = '', continuationCount = 0, options = {}, helpers = {}) {
    const latestTask = helpers.getLatestSessionTaskRecord?.(session);
    const needsMoreFanout = isMissingChildTaskFanout(latestTask);
    return {
      role: 'user',
      content: [
        `Multitask continuation ${Number(continuationCount) + 1}.`,
        needsMoreFanout
          ? 'Continue in multitask mode by delegating more work to Task-backed child agents now. Do not collapse into a single foreground-only explanation.'
          : 'Continue coordinating the existing child tasks. If another delegated tool call is required, make it now; otherwise provide the concise coordinator summary.',
        String(finalText || '').trim()
          ? `Latest assistant draft:\n${String(finalText || '').slice(0, 2000)}`
          : '',
        latestTask?.summary ? `Latest task summary:\n${String(latestTask.summary).slice(0, 3000)}` : '',
      ].filter(Boolean).join('\n'),
    };
    void session;
    void options;
  },
  shouldContinueIncompleteWork(session = {}, finalText = '', toolCalls = [], upstreamError = '', continuationCount = 0, options = {}, helpers = {}) {
    const latestTask = helpers.getLatestSessionTaskRecord?.(session);
    const status = String(latestTask?.status || '').trim().toLowerCase();
    const hasPendingTask = status === 'pending' || status === 'in_progress';
    const missingChildTaskFanout = isMissingChildTaskFanout(latestTask);
    const completedChildWork = hasCompletedChildWork(latestTask);
    const finalLower = String(finalText || '').trim().toLowerCase();
    const toolCount = Array.isArray(session?.toolResultSummaries) ? session.toolResultSummaries.length : 0;
    const onlyForegroundToolsSoFar = toolCount > 0 && !latestTask;
    if (
      completedChildWork
      && helpers.textLooksLikeSubstantiveFinalAnswer?.(finalText)
      && textLooksLikeCoordinatorWrapUp(finalText)
      && !toolCalls.length
      && !upstreamError
    ) {
      return false;
    }
    if (
      (hasPendingTask || onlyForegroundToolsSoFar || missingChildTaskFanout)
      && !toolCalls.length
      && !upstreamError
      && (
        !finalLower
        || finalLower.includes('background task')
        || finalLower.includes('started successfully')
        || finalLower.includes('child task')
        || finalLower.includes('coordinator')
        || finalLower.includes('继续')
        || finalLower.includes('checking')
      )
    ) {
      return continuationCount < 4;
    }
    void options;
    return false;
  },
  getUpstreamRequestOptions() {
    return {};
  },
};

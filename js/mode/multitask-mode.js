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
  const promptOptions = { modelName: input.modelName || input.requestedModel || '' };
  const prompt = readModeText('AGENT_MODE_MULTITASK', 'system_prompt.txt', promptOptions)
    || readModeText('AGENT_MODE_AGENT', 'system_prompt.txt', promptOptions);
  const reminder = readModeText('AGENT_MODE_MULTITASK', 'system_reminder.txt', promptOptions);
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
  const lastTaskId = session?.lastTaskSubagentId || null;
  return {
    mode_contract_id: 'multitask_v1',
    coordinator: 'foreground_parent',
    expected_artifacts: ['task_registry', 'child_tasks', 'task_summaries'],
    last_task_subagent_id: lastTaskId,
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

function getChildTaskRecords(record = {}, session = {}, helpers = {}) {
  const childIds = Array.isArray(record?.childTaskIds) ? record.childTaskIds : [];
  if (!childIds.length) return [];
  const registrySession = record?.__sessionRef || session || helpers.session || {};
  const registry = typeof helpers.getSessionTaskRegistry === 'function'
    ? helpers.getSessionTaskRegistry(registrySession)
    : null;
  if (!registry?.subagents || typeof registry.subagents.get !== 'function') return [];
  return childIds
    .map((childId) => registry.subagents.get(String(childId || '').trim()))
    .filter(Boolean);
}

function isTerminalTaskStatus(status = '') {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'completed' || normalized === 'failed';
}

function hasChildTaskClosure(record = {}, session = {}, helpers = {}) {
  const childIds = Array.isArray(record?.childTaskIds) ? record.childTaskIds : [];
  if (!childIds.length) return false;
  const childRecords = getChildTaskRecords(record, session, helpers);
  if (childRecords.length !== childIds.length) return false;
  return childRecords.every((child) => {
    const status = String(child?.status || '').trim().toLowerCase();
    const summary = String(child?.summary || child?.resultText || '').trim();
    return isTerminalTaskStatus(status) && Boolean(summary);
  });
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

function buildCoordinatorFinalText(record = {}) {
  const childCount = Array.isArray(record?.childTaskIds) ? record.childTaskIds.length : 0;
  const summary = String(record?.summary || record?.resultText || '').trim();
  const title = String(record?.title || record?.name || 'Multitask coordinator').trim();
  const lines = [
    `${title} completed.`,
    childCount ? `Delegated child tasks: ${childCount}.` : '',
    summary ? `Summary:\n${summary}` : 'Summary is available in the task card.',
  ].filter(Boolean);
  return lines.join('\n\n');
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
  getPostToolTurnAction(session = {}, executions = [], context = {}, helpers = {}) {
    const latestTask = helpers.getLatestSessionTaskRecord?.(session);
    const status = String(latestTask?.status || '').trim().toLowerCase();
    const childTaskClosure = hasChildTaskClosure(latestTask, session, helpers);
    const taskExecuted = (Array.isArray(executions) ? executions : []).some((entry) => (
      String(entry?.toolCall?.name || '').trim().toLowerCase() === 'task'
      || entry?.execution?.isBackground === true
    ));
    if (taskExecuted && status === 'completed' && childTaskClosure) {
      return {
        finalText: buildCoordinatorFinalText(latestTask),
        markCompleted: true,
      };
    }
    void context;
    return null;
  },
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
    const childTaskClosure = hasChildTaskClosure(latestTask, session, helpers);
    const waitingForChildClosure = Array.isArray(latestTask?.childTaskIds)
      && latestTask.childTaskIds.length > 0
      && !childTaskClosure;
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
      (hasPendingTask || onlyForegroundToolsSoFar || missingChildTaskFanout || waitingForChildClosure)
      && !toolCalls.length
      && !upstreamError
      && (
        !finalLower
        || finalLower.includes('background task')
        || finalLower.includes('started successfully')
        || finalLower.includes('child task')
        || finalLower.includes('coordinator')
        || finalLower.includes('delegated child tasks')
        || finalLower.includes('multitask coordinator completed')
        || finalLower.includes('继续')
        || finalLower.includes('checking')
      )
    ) {
      return continuationCount < 6;
    }
    void options;
    return false;
  },
  getUpstreamRequestOptions() {
    return {};
  },
};

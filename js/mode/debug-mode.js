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
  'ReportBugfixResults',
  'DebugLogs',
  'ReproductionSteps',
];

const DEBUG_ACTIVE_MODE_CONTRACT = [
  '<system_reminder>',
  'For the turn that contains this reminder, the active mode is debug.',
  'Operate as a structured bug investigation loop: collect evidence, record debug logs, record reproduction steps, isolate hypotheses, then apply the smallest fix that resolves the verified issue.',
  'Do not present the turn as complete until the evidence chain and verification steps are captured.',
  '</system_reminder>',
].join('\n');

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

function buildPlanInitialPromptContexts(input = {}) {
  void input;
  return [
    {
      source: 'mode_change',
      role: 'user',
      content: '<system_reminder>\nAt this point, the active mode changed to debug; follow later mode reminders if present.\n</system_reminder>',
    },
    {
      source: 'active_mode_contract',
      role: 'user',
      content: DEBUG_ACTIVE_MODE_CONTRACT,
    },
  ];
}

function buildModeHistoryMetadata(session = {}) {
  const capture = session?.lastUserMessageCapture || {};
  const debugConfig = capture?.requestContext?.debugModeConfig || capture?.debugModeConfig || null;
  return {
    mode_contract_id: 'debug_v1',
    expected_artifacts: ['debug_logs', 'reproduction_steps', 'bugfix_summary'],
    ...(debugConfig && typeof debugConfig === 'object'
      ? {
        debug_mode_config: {
          logPath: String(debugConfig.logPath || '').trim(),
          serverEndpoint: String(debugConfig.serverEndpoint || '').trim(),
          sessionId: String(debugConfig.sessionId || '').trim(),
        },
      }
      : {}),
  };
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  // Debug mode allows shell for running tests and reproducing issues
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

function interceptToolExecution(session = {}, toolCall = {}, context = {}, helpers = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  if (lower !== 'reportbugfixresults' && lower !== 'debuglogs' && lower !== 'reproductionsteps') return null;
  const record = helpers.getLatestSessionTaskRecord?.(session);
  if (!record) return null;
  if (lower === 'debuglogs') {
    helpers.appendTaskLog?.(record, 'thought', 'Parent agent attached fresh debug logs to the investigation.', true);
  } else if (lower === 'reproductionsteps') {
    helpers.appendTaskLog?.(record, 'thought', 'Parent agent captured updated reproduction steps.', true);
  } else {
    helpers.appendTaskLog?.(record, 'thought', 'Parent agent summarized the current bugfix findings.', true);
  }
  helpers.syncTaskRecordToGlobalRegistry?.(session.config || {}, record);
  void context;
  return null;
}

function isDebugEvidenceMissing(record = {}) {
  const artifacts = record?.debugArtifacts && typeof record.debugArtifacts === 'object'
    ? record.debugArtifacts
    : null;
  return Boolean(record) && (
    !Array.isArray(artifacts?.debugLogs) || !artifacts.debugLogs.length
    || !Array.isArray(artifacts?.reproductionSteps) || !artifacts.reproductionSteps.length
    || !Array.isArray(artifacts?.bugfixResults) || !artifacts.bugfixResults.length
  );
}

function buildLocalDebugConclusion(record = {}) {
  const artifacts = record?.debugArtifacts && typeof record.debugArtifacts === 'object'
    ? record.debugArtifacts
    : null;
  const summaries = [];
  if (Array.isArray(artifacts?.bugfixResults) && artifacts.bugfixResults.length) {
    artifacts.bugfixResults.forEach((item) => {
      const text = String(item?.summary || '').trim();
      if (text) summaries.push(text);
    });
  }
  const summary = String(
    summaries.find(Boolean)
    || record?.summary
    || record?.resultText
    || '',
  ).trim();
  if (!summary) return '';
  const condensed = summary.length > 2200 ? `${summary.slice(0, 2200)}...` : summary;
  return [
    'Debug investigation summary:',
    condensed,
  ].join('\n');
}

function textLooksLikeConcreteDebugConclusion(text = '') {
  const finalLower = String(text || '').trim().toLowerCase();
  if (!finalLower) return false;
  return (
    finalLower.includes('root cause')
    || finalLower.includes('reproduction')
    || finalLower.includes('debug logs')
    || finalLower.includes('verified')
    || finalLower.includes('resolution')
    || finalLower.includes('fix')
    || finalLower.includes('null')
    || finalLower.includes('getcontext')
    || finalLower.includes('canvas')
  );
}

function hasCompletedDebugBackgroundTask(executions = []) {
  return (Array.isArray(executions) ? executions : []).some((entry) => (
    String(entry?.toolCall?.name || '').trim().toLowerCase() === 'task'
    && entry?.execution?.isBackground === true
  ));
}

function shouldContinueIncompleteWork(session = {}, finalText = '', toolCalls = [], upstreamError = '', continuationCount = 0, options = {}, helpers = {}) {
  const latestTask = helpers.getLatestSessionTaskRecord?.(session);
  const status = String(latestTask?.status || '').trim().toLowerCase();
  const hasPendingDebugTask = status === 'pending' || status === 'in_progress';
  const missingDebugEvidence = isDebugEvidenceMissing(latestTask);
  const finalLower = String(finalText || '').trim().toLowerCase();
  const recentToolSummaryText = Array.isArray(session?.toolResultSummaries)
    ? session.toolResultSummaries.slice(-6).map((entry) => String(entry?.resultText || '')).join('\n').toLowerCase()
    : '';
  const looksLikeMidInvestigationText = (
    finalLower.includes('check')
    || finalLower.includes('checking')
    || finalLower.includes('inspect')
    || finalLower.includes('review')
    || finalLower.includes('verify')
    || finalLower.includes('fix')
    || finalLower.includes('bug')
    || finalLower.includes('再检查')
    || finalLower.includes('继续检查')
    || finalLower.includes('确认')
    || finalLower.includes('看看')
    || finalLower.includes('我再')
  );
  const hasFreshDiagnosticSignal = (
    recentToolSummaryText.includes('could not find name')
    || recentToolSummaryText.includes('diagnostic')
    || recentToolSummaryText.includes('error')
    || recentToolSummaryText.includes('warning')
    || recentToolSummaryText.includes('ts\n')
  );
  if (
    (hasPendingDebugTask || missingDebugEvidence || looksLikeMidInvestigationText || hasFreshDiagnosticSignal)
    && !toolCalls.length
    && !upstreamError
    && (
      !finalLower
      || finalLower.includes('reportbugfixresults')
      || finalLower.includes('debug logs')
      || finalLower.includes('reproduction')
      || finalLower.includes('investigat')
      || finalLower.includes('checking')
      || looksLikeMidInvestigationText
      || hasFreshDiagnosticSignal
    )
  ) {
    return continuationCount < 4;
  }
  void options;
  return false;
}

module.exports = {
  DEBUG_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  buildPlanInitialPromptContexts,
  buildModeHistoryMetadata,
  shouldUseNativeExecForTool,
  interceptToolExecution,
  getPostToolTurnAction(session = {}, executions = [], context = {}, helpers = {}) {
    const latestTask = helpers.getLatestSessionTaskRecord?.(session);
    if (!latestTask || isDebugEvidenceMissing(latestTask)) return null;
    const finalText = String(context?.finalText || '').trim();
    const upstreamError = String(context?.upstreamError || '').trim();
    const toolCalls = Array.isArray(context?.toolCalls) ? context.toolCalls : [];
    if (toolCalls.length) return null;
    const taskStatus = String(latestTask?.status || '').trim().toLowerCase();
    // When the debug background task has completed, finalize the turn with a
    // BRIEF marker. The detailed evidence (root cause, debug logs, reproduction
    // steps) lives inside the subagent card via TaskStreamLog tool_action /
    // tool_result items — not in a wall of textDelta. Returning the full
    // buildLocalDebugConclusion() here (up to 2200 chars) drowns out the native
    // tool-call cards with plain text, which is the opposite of native parity.
    if (taskStatus === 'completed' && hasCompletedDebugBackgroundTask(executions)) {
      return {
        finalText: 'Debug investigation complete. Review the subagent card for evidence and findings.',
        markCompleted: true,
      };
    }
    if (!upstreamError && finalText && !textLooksLikeConcreteDebugConclusion(finalText)) return null;
    if (helpers.textLooksLikeSubstantiveFinalAnswer?.(finalText) && textLooksLikeConcreteDebugConclusion(finalText)) {
      return {
        finalText,
        markCompleted: true,
      };
    }
    // Fallback: finalize with a brief marker so the loop terminates. The
    // localConclusion is preserved in history metadata, not streamed as text.
    return {
      finalText: 'Debug investigation finished. See the subagent card for details.',
      markCompleted: true,
    };
    void executions;
  },
  shouldRecoverPostToolStream(session = {}, upstreamError = '', finalText = '', toolCalls = [], recoveryCount = 0, helpers = {}) {
    if (Array.isArray(toolCalls) && toolCalls.length) return false;
    const latestTask = helpers.getLatestSessionTaskRecord?.(session);
    const missingDebugEvidence = isDebugEvidenceMissing(latestTask);
    if (!missingDebugEvidence && helpers.textLooksLikeSubstantiveFinalAnswer?.(finalText) && textLooksLikeConcreteDebugConclusion(finalText)) {
      return false;
    }
    if (!String(finalText || '').trim()) return true;
    const finalLower = String(finalText || '').trim().toLowerCase();
    const looksLikeConcreteDebugConclusion = (
      finalLower.includes('root cause')
      || finalLower.includes('fix')
      || finalLower.includes('resolved')
      || finalLower.includes('canvas')
      || finalLower.includes('getcontext')
      || finalLower.includes('debug logs')
      || finalLower.includes('reproduction')
    );
    if (!missingDebugEvidence && looksLikeConcreteDebugConclusion) {
      return false;
    }
    if (helpers.textLooksLikeSubstantiveFinalAnswer?.(finalText) && recoveryCount > 0) {
      return false;
    }
    void upstreamError;
    return true;
  },
  shouldForceContinuationToolChoice(session = {}, finalText = '', options = {}, helpers = {}) {
    const latestTask = helpers.getLatestSessionTaskRecord?.(session);
    const finalLower = String(finalText || '').trim().toLowerCase();
    if (
      isDebugEvidenceMissing(latestTask)
      || finalLower.includes('debug logs')
      || finalLower.includes('reproduction')
      || (!helpers.textLooksLikeSubstantiveFinalAnswer?.(finalText) && finalLower.includes('root cause'))
    ) {
      return true;
    }
    void options;
    return false;
  },
  buildIncompleteContinuationMessage(session = {}, finalText = '', continuationCount = 0, options = {}, helpers = {}) {
    const latestTask = helpers.getLatestSessionTaskRecord?.(session);
    const missingDebugEvidence = isDebugEvidenceMissing(latestTask);
    const guidance = missingDebugEvidence
      ? 'Continue in debug mode by calling the required debug evidence-chain tools now. Prefer DebugLogs, ReproductionSteps, and ReportBugfixResults over more exploratory reads when enough evidence already exists.'
      : 'Continue from the verified debug evidence. If one more tool call is required, make it now; otherwise provide the final debug conclusion.';
    return {
      role: 'user',
      content: [
        `Debug continuation ${Number(continuationCount) + 1}.`,
        guidance,
        String(finalText || '').trim()
          ? `Latest assistant draft:\n${String(finalText || '').slice(0, 2000)}`
          : '',
        latestTask?.summary ? `Latest task summary:\n${String(latestTask.summary).slice(0, 3000)}` : '',
      ].filter(Boolean).join('\n'),
    };
    void session;
    void options;
  },
  shouldContinueIncompleteWork,
  getUpstreamRequestOptions() {
    return {};
  },
};

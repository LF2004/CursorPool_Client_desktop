const { readModeText } = require('./registry');
const { buildModeRelayMessages } = require('./common/message-builder');
const {
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  mergeAgentModeToolDefinitions,
  buildToolDefinitionsForResponses: buildResponsesToolDefinitions,
} = require('./common/tools');
const { shouldUseNativeExecForToolByMode } = require('./common/policy');

const PLAN_TOOL_NAMES = [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'ReadLints',
  'Shell',
  'TodoWrite',
  'AskQuestion',
  'CreatePlan',
  'WebFetch',
  'WebSearch',
  'SemanticSearch',
];

const PLAN_MUTATION_TOOL_NAMES = new Set(['write', 'edit', 'patchedit', 'strreplace', 'delete']);

function hasSuccessfulToolResult(session = {}, toolName = '') {
  const target = String(toolName || '').trim().toLowerCase();
  const summaries = Array.isArray(session?.toolResultSummaries) ? session.toolResultSummaries : [];
  return summaries.some((entry) => entry?.ok && String(entry.tool || '').trim().toLowerCase() === target);
}

function hasCreatePlanResult(session = {}) {
  return hasSuccessfulToolResult(session, 'createplan');
}

function getPostToolTurnAction(session = {}, executions = [], context = {}, helpers = {}) {
  const successfulExecutions = Array.isArray(executions)
    ? executions.filter((entry) => entry?.execution?.ok)
    : [];
  const successfulNames = successfulExecutions.map((entry) => String(entry?.toolCall?.name || '').trim().toLowerCase());
  if (successfulNames.includes('askquestion')) {
    return {
      stopTurn: true,
      handoff: 'ask_question',
      reason: 'Plan mode should end the turn after AskQuestion so Cursor can wait for user clarification.',
    };
  }
  if (successfulNames.includes('createplan')) {
    return {
      stopTurn: true,
      handoff: 'create_plan',
      reason: 'Plan mode should end the turn after CreatePlan so Cursor can present the plan confirmation state.',
    };
  }
  void session;
  void context;
  void helpers;
  return null;
}

function isLikelyReadOnlyShellCommand(command = '') {
  const value = String(command || '').trim().toLowerCase();
  if (!value) return true;
  const blockedPatterns = [
    /\b(remove-item|set-content|add-content|new-item|move-item|copy-item|rename-item|clear-content)\b/i,
    /\b(del|erase|rm|mv|move|copy|cp|ren|rename|mkdir|md|rmdir|rd|touch)\b/i,
    /\b(git\s+(apply|am|commit|checkout|switch|reset|revert|merge|rebase|cherry-pick|push))\b/i,
    /\b(npm\s+install|npm\s+update|npm\s+run\s+build|npm\s+run\s+dev|npm\s+run\s+start)\b/i,
    /\b(pnpm\s+(add|install|update|dev|start|build)|yarn\s+(add|install|dev|start|build))\b/i,
    /\b(code\s+--install-extension)\b/i,
    /(^|[^|])>/,
  ];
  if (blockedPatterns.some((pattern) => pattern.test(value))) return false;

  const allowedPrefixes = [
    'dir',
    'ls',
    'pwd',
    'type ',
    'cat ',
    'git status',
    'git diff',
    'git log',
    'git show',
    'where ',
    'which ',
    'rg ',
    'grep ',
    'findstr ',
    'select-string ',
    'get-content ',
    'get-childitem ',
    'npm test',
    'npm run test',
    'npm run lint',
    'pnpm test',
    'pnpm lint',
    'yarn test',
    'yarn lint',
    'node -v',
    'python --version',
  ];
  return allowedPrefixes.some((prefix) => value.startsWith(prefix));
}

function buildBlockedExecution(toolCall, reason, startedAt, extra = {}) {
  return {
    ok: false,
    tool: String(toolCall?.name || ''),
    args: { ...(toolCall?.arguments || {}) },
    resultText: reason,
    durationMs: Date.now() - Number(startedAt || Date.now()),
    blockedByMode: 'plan',
    ...extra,
  };
}

function buildToolDefinitionsForChat(options = {}) {
  return filterToolDefinitionsByName(
    mergeAgentModeToolDefinitions(buildFallbackRelayToolDefinitions(), 'AGENT_MODE_PLAN'),
    PLAN_TOOL_NAMES,
  );
}

function buildToolDefinitionsForResponses(options = {}) {
  return filterToolDefinitionsByName(
    buildResponsesToolDefinitions(buildToolDefinitionsForChat(options)),
    PLAN_TOOL_NAMES,
  );
}

function buildLocalRelayMessages(input = {}) {
  return buildModeRelayMessages({
    ...input,
    modeName: 'AGENT_MODE_PLAN',
    cursorAgentPrompt: readModeText('AGENT_MODE_PLAN', 'system_prompt.txt'),
    cursorModeReminder: readModeText('AGENT_MODE_PLAN', 'system_reminder.txt'),
    extraSystemLines: [
      'In plan mode, prioritize producing and confirming a plan before execution when the task is complex.',
      'Do not write, edit, patch, or delete files unless the user explicitly asks to leave plan mode and execute.',
    ],
  });
}

function shouldUseNativeExecForTool(session, toolCall, helpers = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  if (['write', 'edit', 'patchedit', 'strreplace', 'delete'].includes(lower)) return false;
  return shouldUseNativeExecForToolByMode(session, toolCall, helpers);
}

function interceptToolExecution(session, toolCall, context = {}, helpers = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  const startedAt = context.startedAt || Date.now();
  if (PLAN_MUTATION_TOOL_NAMES.has(lower)) {
    return buildBlockedExecution(
      toolCall,
      'Plan mode blocked this mutation tool before confirmation. Use CreatePlan, TodoWrite, and read-only inspection tools first.',
      startedAt,
    );
  }
  if (lower === 'shell') {
    const command = String(toolCall?.arguments?.command || '').trim();
    if (!isLikelyReadOnlyShellCommand(command)) {
      return buildBlockedExecution(
        toolCall,
        'Plan mode only allows read-only shell inspection before confirmation. Use Read/Grep/Glob/LS or a non-mutating shell command instead.',
        startedAt,
      );
    }
  }
  void session;
  void helpers;
  return null;
}

function getMaxContinuationCount(session = {}, options = {}, helpers = {}) {
  const hasPlan = hasCreatePlanResult(session);
  if (options.sawReadOnlyTool && !options.sawMutationTool) {
    const readOnlyLimit = Number(helpers.getMaxReadOnlyExplorationContinuationCount?.(session)) || 0;
    return Math.max(readOnlyLimit, hasPlan ? 4 : 6);
  }
  const base = Number(helpers.getMaxIncompleteContinuationCount?.(session)) || 0;
  if (hasPlan) return Math.max(base, 6);
  return Math.max(base, 8);
}

function shouldContinueIncompleteWork(session = {}, finalText = '', toolCalls = [], upstreamError = '', continuationCount = 0, options = {}, helpers = {}) {
  if (session?.planTurnHandoff) return false;
  if (upstreamError) return false;
  if (Array.isArray(toolCalls) && toolCalls.length) return false;

  const maxContinuations = getMaxContinuationCount(session, options, helpers);
  if (maxContinuations > 0 && continuationCount >= maxContinuations) return false;

  const incompleteTodos = Array.isArray(helpers.getIncompleteTodos?.(session))
    ? helpers.getIncompleteTodos(session)
    : [];
  if (incompleteTodos.length > 0) return true;

  const hasPlan = hasCreatePlanResult(session);
  if (!hasPlan) return true;

  if (helpers.looksLikeIncompleteContinuationText?.(finalText)) return true;
  if (helpers.looksLikeReadOnlyExplorationStillInProgress?.(session, finalText, options)) return true;

  return !helpers.textLooksLikeSubstantiveFinalAnswer?.(finalText);
}

function shouldForceContinuationToolChoice(session = {}, finalText = '', options = {}, helpers = {}) {
  if (session?.planTurnHandoff) return false;
  const incompleteTodos = Array.isArray(helpers.getIncompleteTodos?.(session))
    ? helpers.getIncompleteTodos(session)
    : [];
  if (!hasCreatePlanResult(session)) return true;
  if (incompleteTodos.length > 0) return true;
  return Boolean(helpers.looksLikeReadOnlyExplorationStillInProgress?.(session, finalText, options));
}

function buildIncompleteContinuationMessage(session = {}, finalText = '', continuationCount = 0, options = {}, helpers = {}) {
  const incompleteTodos = (Array.isArray(helpers.getIncompleteTodos?.(session)) ? helpers.getIncompleteTodos(session) : []).slice(0, 12);
  const recentToolResults = Array.isArray(helpers.getRecentToolResultContext?.(session, 6))
    ? helpers.getRecentToolResultContext(session, 6)
    : [];
  const hasPlan = hasCreatePlanResult(session);
  const readOnlyContinuationTarget = helpers.getReadOnlyContinuationTargetPath?.(session) || '';
  const workspaceRoot = helpers.getSessionWorkspaceRoot?.(session) || '';
  const readOnlyContinuationTargetDisplay = readOnlyContinuationTarget
    ? helpers.toWorkspaceRelativePath?.(readOnlyContinuationTarget, workspaceRoot) || readOnlyContinuationTarget
    : '';
  const maxContinuations = getMaxContinuationCount(session, options, helpers);

  const nextStepInstruction = !hasPlan
    ? 'Plan mode still has not produced a CreatePlan result. Use CreatePlan now with a concise overview, the proposed plan, and 3-7 actionable todo items. Do not execute file mutations.'
    : (incompleteTodos.length
      ? 'There are still unfinished plan todos. Update TodoWrite if needed, then provide the confirmation-ready plan summary for the user. Do not execute file mutations.'
      : 'Provide the confirmation-ready plan summary now. Do not execute file mutations.');

  return {
    role: 'user',
    content: [
      `Plan continuation request ${Number(continuationCount) + 1}/${helpers.formatContinuationLimitForLog?.(maxContinuations) || String(maxContinuations || 'unlimited')}.`,
      'Structured relay state: the last upstream response did not finish the plan-mode turn.',
      String(finalText || '').trim() ? `Latest assistant text captured as context only:\n${String(finalText || '').trim()}` : '',
      hasPlan ? 'CreatePlan has already succeeded in this turn.' : 'CreatePlan has not been called successfully yet in this turn.',
      incompleteTodos.length ? `Incomplete todos:\n${incompleteTodos.map((todo) => `- ${todo.status}: ${todo.content}`).join('\n')}` : '',
      recentToolResults.length ? `Recent tool results:\n${recentToolResults.map((line) => `- ${line}`).join('\n')}` : '',
      readOnlyContinuationTargetDisplay ? `Read-only continuation target: ${readOnlyContinuationTargetDisplay}` : '',
      options.sawReadOnlyTool && !options.sawMutationTool
        ? 'You are still in read-only exploration. Continue inspecting only if necessary to finish the plan; otherwise produce the final plan confirmation message.'
        : '',
      nextStepInstruction,
    ].filter(Boolean).join('\n'),
  };
}

function hasIncompleteWorkAtEnd(session = {}, finalText = '', toolCalls = [], upstreamError = '', options = {}, helpers = {}) {
  if (session?.planTurnHandoff) return false;
  if (upstreamError) return false;
  if (Array.isArray(toolCalls) && toolCalls.length) return false;

  const incompleteTodos = Array.isArray(helpers.getIncompleteTodos?.(session))
    ? helpers.getIncompleteTodos(session)
    : [];
  if (incompleteTodos.length > 0) return true;

  if (!hasCreatePlanResult(session)) return true;
  if (helpers.looksLikeIncompleteContinuationText?.(finalText)) return true;
  if (helpers.looksLikeReadOnlyExplorationStillInProgress?.(session, finalText, options)) return true;
  return !helpers.textLooksLikeSubstantiveFinalAnswer?.(finalText);
}

module.exports = {
  PLAN_TOOL_NAMES,
  buildToolDefinitionsForChat,
  buildToolDefinitionsForResponses,
  buildLocalRelayMessages,
  shouldUseNativeExecForTool,
  interceptToolExecution,
  getPostToolTurnAction,
  getMaxContinuationCount,
  shouldContinueIncompleteWork,
  shouldForceContinuationToolChoice,
  buildIncompleteContinuationMessage,
  hasIncompleteWorkAtEnd,
};

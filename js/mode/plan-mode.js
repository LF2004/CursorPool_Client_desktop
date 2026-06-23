const { readModeText } = require('./registry');
const { buildModeRelayMessages } = require('./common/message-builder');
const {
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  mergeAgentModeToolDefinitions,
  buildToolDefinitionsForResponses: buildResponsesToolDefinitions,
} = require('./common/tools');
const { shouldUseNativeExecForToolByMode } = require('./common/policy');
const {
  buildAgentAskQuestionQueryFrame,
  buildAgentCreatePlanQueryFrame,
} = require('../utils/cursor-relay-protocol');

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
const PLAN_ACTIVE_MODE_CONTRACT = [
  '<system_reminder>',
  'For the turn that contains this reminder, the active mode is plan. Do not modify files or system state. Use CreatePlan when the plan is ready or needs updating.',
  '</system_reminder>',
].join('\n');
const PLAN_LATEST_USER_INTENT = [
  '<system_reminder>',
  'Prefer clear staged plans with concrete checkpoints.',
  '</system_reminder>',
].join('\n');

function buildPlanInitialPromptContexts(input = {}) {
  void input;
  const planReminder = readModeText('AGENT_MODE_PLAN', 'system_reminder.txt');
  return [
    {
      source: 'mode_change',
      role: 'user',
      content: [
        '<system_reminder>',
        'At this point, the active mode changed to plan; follow later mode reminders if present.',
        '</system_reminder>',
      ].join('\n'),
    },
    {
      source: 'plan_turn_contract',
      role: 'user',
      content: planReminder,
    },
    {
      source: 'active_mode_contract',
      role: 'user',
      content: PLAN_ACTIVE_MODE_CONTRACT,
    },
    {
      source: 'latest_user_intent',
      role: 'user',
      content: PLAN_LATEST_USER_INTENT,
    },
  ].filter((entry) => String(entry.content || '').trim());
}

function hasSuccessfulToolResult(session = {}, toolName = '') {
  const target = String(toolName || '').trim().toLowerCase();
  const summaries = Array.isArray(session?.toolResultSummaries) ? session.toolResultSummaries : [];
  return summaries.some((entry) => entry?.ok && String(entry.tool || '').trim().toLowerCase() === target);
}

function hasCreatePlanResult(session = {}) {
  return hasSuccessfulToolResult(session, 'createplan');
}

function isPlanInteractionToolName(toolName = '') {
  const lower = String(toolName || '').trim().toLowerCase();
  return lower === 'createplan' || lower === 'askquestion';
}

function buildHistoryInteractionQueryKind(kind = '') {
  if (kind === 'ask_question') return 'ask_question_interaction_query';
  if (kind === 'create_plan') return 'create_plan_request_query';
  return String(kind || '').trim();
}

function buildHistoryInteractionQueryRequest(kind = '', args = {}) {
  if (kind === 'ask_question') {
    return {
      title: String(args.title || '').trim(),
      questions: Array.isArray(args.questions) ? args.questions : [],
    };
  }
  if (kind === 'create_plan') {
    return {
      name: String(args.name || '').trim(),
      overview: String(args.overview || '').trim(),
      plan: String(args.plan || '').trim(),
      todos: Array.isArray(args.todos) ? args.todos : [],
    };
  }
  return args && typeof args === 'object' ? args : {};
}

function formatAskQuestionAnswersForContinuation(answers = []) {
  const lines = (Array.isArray(answers) ? answers : [])
    .map((answer) => {
      const questionId = String(answer?.questionId || '').trim() || 'question';
      const selected = Array.isArray(answer?.selectedOptionIds) && answer.selectedOptionIds.length
        ? `selected=${answer.selectedOptionIds.join(', ')}`
        : '';
      const freeform = String(answer?.freeformText || '').trim()
        ? `freeform=${String(answer.freeformText).trim()}`
        : '';
      const detail = [selected, freeform].filter(Boolean).join('; ');
      return `- ${questionId}${detail ? `: ${detail}` : ''}`;
    })
    .filter(Boolean);
  return lines.join('\n');
}

function buildInteractionContinuationPrompt(pendingInteraction = {}, interactionResponse = {}) {
  const responseKind = String(interactionResponse?.kind || '').trim();
  const pendingKind = String(pendingInteraction?.kind || '').trim();
  if (responseKind === 'ask_question_interaction_response' || pendingKind === 'ask_question') {
    const askQuestion = interactionResponse?.askQuestion || {};
    const status = String(askQuestion.kind || 'success').trim() || 'success';
    const answersSummary = formatAskQuestionAnswersForContinuation(askQuestion.answers || []);
    return [
      'The pending AskQuestion interaction has completed. Continue the same plan turn from this clarification.',
      `Interaction status: ${status}.`,
      answersSummary ? `Answers:\n${answersSummary}` : 'Answers: none provided.',
      'Do not ask the same clarification again. Use these answers to continue the plan immediately.',
      'Before calling CreatePlan, perform one fresh read-only reconnaissance step in the current workspace after these answers so the plan reflects the updated scope.',
    ].join('\n');
  }
  if (responseKind === 'create_plan_request_response' || pendingKind === 'create_plan') {
    const createPlan = interactionResponse?.createPlan || {};
    const status = String(createPlan.kind || 'success').trim() || 'success';
    const planUri = String(createPlan.planUri || '').trim();
    const error = String(createPlan.error || '').trim();
    return [
      'The pending CreatePlan interaction has completed. Continue the same plan workflow from that plan state.',
      `Interaction status: ${status}.`,
      planUri ? `Plan URI: ${planUri}` : '',
      error ? `Error: ${error}` : '',
      'If the plan is approved, mirror the plan into TodoWrite and continue the workflow instead of recreating the same plan.',
    ].filter(Boolean).join('\n');
  }
  return [
    'A pending plan interaction has completed.',
    `Interaction payload: ${JSON.stringify(interactionResponse || {})}`,
    'Continue the same turn from this interaction result without restarting from scratch.',
  ].join('\n');
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

function shouldDispatchInteractionQuery(session = {}, toolCall = {}, execution = null) {
  if (!execution?.ok) return false;
  void session;
  return isPlanInteractionToolName(toolCall?.name || '');
}

function buildInteractionQuery(session = {}, toolCall = {}, toolCallId = '', queryId = 1) {
  const toolName = String(toolCall?.name || '').trim().toLowerCase();
  void session;
  if (toolName === 'createplan') {
    return {
      queryId,
      kind: 'create_plan',
      frame: buildAgentCreatePlanQueryFrame(toolCall.arguments || {}, toolCallId, queryId),
    };
  }
  if (toolName === 'askquestion') {
    return {
      queryId,
      kind: 'ask_question',
      frame: buildAgentAskQuestionQueryFrame(toolCall.arguments || {}, toolCallId, queryId),
    };
  }
  return null;
}

function buildInteractionQueryHistoryItem(pendingInteraction = {}) {
  return {
    role: 'system',
    kind: 'interaction_query',
    tool_call_id: String(pendingInteraction.toolCallId || '').trim(),
    payload: {
      id: Number(pendingInteraction.queryId) || 0,
      kind: buildHistoryInteractionQueryKind(pendingInteraction.kind),
      tool_call_id: String(pendingInteraction.toolCallId || '').trim(),
      tool_name: String(pendingInteraction.toolName || '').trim(),
      request: buildHistoryInteractionQueryRequest(pendingInteraction.kind, pendingInteraction.arguments || {}),
    },
  };
}

function buildInteractionResponseHistoryItem(pendingInteraction = {}, interactionResponse = {}) {
  return {
    role: 'system',
    kind: 'interaction_response',
    payload: {
      id: Number(interactionResponse?.id) || 0,
      kind: String(interactionResponse?.kind || '').trim(),
      tool_name: String(pendingInteraction?.toolName || '').trim(),
      interaction_kind: String(pendingInteraction?.kind || interactionResponse?.kind || '').trim(),
      query_id: Number(pendingInteraction?.queryId) || 0,
      response: interactionResponse || {},
    },
  };
}

function buildInteractionResumeMessage(pendingInteraction = {}, interactionResponse = {}) {
  return {
    role: 'user',
    content: buildInteractionContinuationPrompt(pendingInteraction, interactionResponse),
  };
}

function getInteractionPendingKindFromResponse(interactionResponse = {}) {
  const responseKind = String(interactionResponse?.kind || '').trim();
  if (responseKind === 'create_plan_request_response') return 'create_plan';
  if (responseKind === 'ask_question_interaction_response') return 'ask_question';
  return '';
}

function resolveCreatePlanPresentationState(session = {}, interactionResponse = {}, pendingInteraction = {}) {
  const latestPlanState = session?.latestPlanState && typeof session.latestPlanState === 'object'
    ? session.latestPlanState
    : {};
  const workflow = session?.planWorkflow && typeof session.planWorkflow === 'object'
    ? session.planWorkflow
    : {};
  const planText = String(
    interactionResponse?.createPlan?.plan
    || pendingInteraction?.arguments?.plan
    || pendingInteraction?.resumeState?.plan?.plan_text
    || pendingInteraction?.resumeState?.plan?.plan
    || latestPlanState.plan_text
    || latestPlanState.plan
    || session?.suppressedPlanText
    || ''
  ).trim();
  const planUri = String(
    interactionResponse?.createPlan?.planUri
    || pendingInteraction?.arguments?.planUri
    || pendingInteraction?.resumeState?.plan?.plan_uri
    || latestPlanState.plan_uri
    || workflow.presentedPlanUri
    || workflow.draftPlanPath
    || ''
  ).trim();
  const todos = Array.isArray(latestPlanState.todos)
    ? latestPlanState.todos.map((todo) => ({ ...todo }))
    : (Array.isArray(pendingInteraction?.arguments?.todos)
      ? pendingInteraction.arguments.todos.map((todo) => ({ ...todo }))
      : []);
  if (!planText && !planUri) return null;
  return {
    plan: planText || planUri,
    plan_text: planText,
    plan_uri: planUri,
    todos,
  };
}

function isSuccessfulCreatePlanInteractionResponse(session = {}, interactionResponse = {}, pendingInteraction = {}) {
  return String(interactionResponse?.kind || '').trim() === 'create_plan_request_response'
    && String(interactionResponse?.createPlan?.kind || '').trim() === 'success'
    && Boolean(resolveCreatePlanPresentationState(session, interactionResponse, pendingInteraction));
}

function buildPendingInteractionResumeState(session = {}, context = {}) {
  return {
    userText: String(context.userText || '').trim(),
    upstreamMessages: Array.isArray(context.upstreamMessages)
      ? context.upstreamMessages.map((message) => ({ ...message }))
      : [],
    capturedAt: context.capturedAt || new Date().toISOString(),
    stableConversationId: String(context.stableConversationId || '').trim(),
    requestId: String(context.requestId || session.requestId || '').trim(),
  };
}

function buildWaitingForInteractionStatePatch(session = {}, context = {}) {
  const since = String(context.since || '').trim() || new Date().toISOString();
  return {
    current_loop_status: 'waiting_for_interaction',
    waiting_for_interaction: {
      handoff: String(context.handoff || session.modeTurnHandoff || session.planTurnHandoff || '').trim(),
      pending_count: Number(context.pendingCount) || 0,
      since,
    },
    plan: context.plan || null,
  };
}

function buildResumedInteractionStatePatch() {
  return {
    current_loop_status: 'running',
    waiting_for_interaction: null,
  };
}

function shouldFinalizeInteractionResponseTurn(session = {}, interactionResponse = {}, pendingInteraction = {}, helpers = {}) {
  void helpers;
  return isSuccessfulCreatePlanInteractionResponse(session, interactionResponse, pendingInteraction);
}

function buildCompletedInteractionStatePatch(session = {}, interactionResponse = {}, pendingInteraction = {}, helpers = {}) {
  const planState = resolveCreatePlanPresentationState(session, interactionResponse, pendingInteraction);
  void helpers;
  if (isSuccessfulCreatePlanInteractionResponse(session, interactionResponse, pendingInteraction)) {
    return buildWaitingForInteractionStatePatch(session, {
      handoff: 'create_plan',
      pendingCount: 1,
      plan: planState,
    });
  }
  return {
    current_loop_status: 'completed',
    waiting_for_interaction: null,
    plan: planState,
  };
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
    promptContextMessages: buildPlanInitialPromptContexts(input),
    extraSystemLines: [
      'In plan mode, prioritize producing and confirming a plan before execution when the task is complex.',
      'If key choices are still unresolved, use AskQuestion before CreatePlan.',
      'Do not output the full plan as plain assistant text. Keep the plan content inside CreatePlan and checkpoint state.',
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
  if (session?.modeTurnHandoff || session?.planTurnHandoff) return false;
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
  if (session?.modeTurnHandoff || session?.planTurnHandoff) return false;
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
    ? 'Plan mode still has not produced a CreatePlan result. Use AskQuestion if important choices remain unclear; otherwise use CreatePlan now with a concise overview, the proposed plan, and 3-7 actionable todo items. Do not execute file mutations.'
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
  if (session?.modeTurnHandoff || session?.planTurnHandoff) return false;
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
  buildPlanInitialPromptContexts,
  shouldUseNativeExecForTool,
  getUpstreamRequestOptions() {
    return {
      preferredEndpointMode: 'chat',
    };
  },
  interceptToolExecution,
  getPostToolTurnAction,
  shouldDispatchInteractionQuery,
  buildInteractionQuery,
  buildInteractionQueryHistoryItem,
  buildInteractionResponseHistoryItem,
  buildInteractionResumeMessage,
  getInteractionPendingKindFromResponse,
  buildPendingInteractionResumeState,
  buildWaitingForInteractionStatePatch,
  buildResumedInteractionStatePatch,
  shouldFinalizeInteractionResponseTurn,
  buildCompletedInteractionStatePatch,
  getMaxContinuationCount,
  shouldContinueIncompleteWork,
  shouldForceContinuationToolChoice,
  buildIncompleteContinuationMessage,
  hasIncompleteWorkAtEnd,
};

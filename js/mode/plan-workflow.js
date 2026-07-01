const PLAN_WORKFLOW_PHASES = Object.freeze({
  IDLE: 'idle',
  PLANNING: 'planning',
  AWAITING_ANSWERS: 'awaiting_answers',
  ANSWERS_COLLECTED: 'answers_collected',
  EXPLORING: 'exploring',
  AWAITING_PLAN_PRESENTATION: 'awaiting_plan_presentation',
  PLAN_PRESENTED: 'plan_presented',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
});

function getAskQuestionResponseStatus(interactionResponse = {}) {
  return String(
    interactionResponse?.askQuestion?.kind
    || interactionResponse?.askQuestion?.status
    || interactionResponse?.askQuestion?.result?.kind
    || interactionResponse?.askQuestion?.result?.status
    || ''
  ).trim().toLowerCase();
}

function normalizeAskQuestionAnswers(answers = []) {
  return (Array.isArray(answers) ? answers : [])
    .map((answer) => ({
      questionId: String(answer?.questionId || answer?.question_id || '').trim(),
      selectedOptionIds: Array.isArray(answer?.selectedOptionIds)
        ? answer.selectedOptionIds.filter(Boolean).map((value) => String(value).trim()).filter(Boolean)
        : (Array.isArray(answer?.selected_option_ids)
          ? answer.selected_option_ids.filter(Boolean).map((value) => String(value).trim()).filter(Boolean)
          : []),
      freeformText: String(answer?.freeformText || answer?.freeform_text || '').trim(),
    }))
    .filter((answer) => answer.questionId || answer.selectedOptionIds.length || answer.freeformText);
}

function hasAskQuestionResponseResolution(interactionResponse = {}) {
  const status = getAskQuestionResponseStatus(interactionResponse);
  if (status === 'success') return true;
  const answers = normalizeAskQuestionAnswers(interactionResponse?.askQuestion?.answers);
  return answers.some((answer) => answer.selectedOptionIds.length > 0 || Boolean(answer.freeformText));
}

function getDefaultPlanWorkflowState() {
  return {
    phase: PLAN_WORKFLOW_PHASES.IDLE,
    updatedAt: new Date().toISOString(),
    lastInteractionKind: '',
    lastToolName: '',
    currentRequestId: '',
    draftPlanPath: '',
    presentedPlanUri: '',
    checkpointEmittedForPlanUri: '',
    needsFreshExploreAfterAnswers: false,
  };
}

function clonePlanWorkflowState(state = null) {
  if (!state || typeof state !== 'object') return getDefaultPlanWorkflowState();
  return {
    phase: String(state.phase || PLAN_WORKFLOW_PHASES.IDLE).trim() || PLAN_WORKFLOW_PHASES.IDLE,
    updatedAt: String(state.updatedAt || '').trim() || new Date().toISOString(),
    lastInteractionKind: String(state.lastInteractionKind || '').trim(),
    lastToolName: String(state.lastToolName || '').trim(),
    currentRequestId: String(state.currentRequestId || '').trim(),
    draftPlanPath: String(state.draftPlanPath || '').trim(),
    presentedPlanUri: String(state.presentedPlanUri || '').trim(),
    checkpointEmittedForPlanUri: String(state.checkpointEmittedForPlanUri || '').trim(),
    needsFreshExploreAfterAnswers: state.needsFreshExploreAfterAnswers === true,
  };
}

function getPlanWorkflowPhaseFromState(state = null) {
  return String(clonePlanWorkflowState(state).phase || PLAN_WORKFLOW_PHASES.IDLE).trim() || PLAN_WORKFLOW_PHASES.IDLE;
}

function isPlanCheckpointVisiblePhase(phase = '') {
  const normalized = String(phase || '').trim();
  return normalized === PLAN_WORKFLOW_PHASES.PLAN_PRESENTED
    || normalized === PLAN_WORKFLOW_PHASES.EXECUTING
    || normalized === PLAN_WORKFLOW_PHASES.COMPLETED;
}

function buildPlanWorkflowStateUpdate(state = null, phase = PLAN_WORKFLOW_PHASES.IDLE, extra = {}, requestId = '') {
  const current = clonePlanWorkflowState(state);
  const nextPhase = String(phase || PLAN_WORKFLOW_PHASES.IDLE).trim() || PLAN_WORKFLOW_PHASES.IDLE;
  return {
    ...current,
    ...extra,
    phase: nextPhase,
    updatedAt: new Date().toISOString(),
    currentRequestId: String(extra.currentRequestId || current.currentRequestId || requestId || '').trim(),
  };
}

function buildPlanWorkflowUpdateForToolExecution({
  state = null,
  toolName = '',
  execution = {},
  requestId = '',
  canonicalToolName = (name) => String(name || '').trim(),
  isReadOnlyContextToolName = () => false,
} = {}) {
  if (!execution?.ok) return null;
  const lower = String(toolName || execution?.tool || '').trim().toLowerCase();
  // Ask-before-Build: 在 PLANNING 首轮，若用户意图模糊，模型应先调用 AskQuestion。
  // AskQuestion 成功 → 进入 AWAITING_ANSWERS，等待用户回答。
  // 该转换从任何阶段（含 PLANNING/IDLE）都能触发。
  if (lower === 'askquestion') {
    return buildPlanWorkflowStateUpdate(state, PLAN_WORKFLOW_PHASES.AWAITING_ANSWERS, {
      lastToolName: 'AskQuestion',
      needsFreshExploreAfterAnswers: false,
    }, requestId);
  }
  // CreatePlan 成功 → 进入 AWAITING_PLAN_PRESENTATION。
  // 在 PLANNING 首轮直接调用 CreatePlan 是允许的（用户意图明确的情况），
  // 但 plan-mode.interceptToolExecution 会在意图模糊且无 AskQuestion 历史时拦截。
  if (lower === 'createplan') {
    return buildPlanWorkflowStateUpdate(state, PLAN_WORKFLOW_PHASES.AWAITING_PLAN_PRESENTATION, {
      lastToolName: 'CreatePlan',
      draftPlanPath: String(execution.planPath || '').trim(),
      needsFreshExploreAfterAnswers: false,
    }, requestId);
  }
  if (isReadOnlyContextToolName(lower)) {
    const currentPhase = getPlanWorkflowPhaseFromState(state);
    const nextPhase = currentPhase === PLAN_WORKFLOW_PHASES.ANSWERS_COLLECTED
      ? PLAN_WORKFLOW_PHASES.EXPLORING
      : (currentPhase === PLAN_WORKFLOW_PHASES.PLANNING || currentPhase === PLAN_WORKFLOW_PHASES.IDLE
        ? PLAN_WORKFLOW_PHASES.EXPLORING
        : currentPhase);
    return buildPlanWorkflowStateUpdate(state, nextPhase, {
      lastToolName: canonicalToolName(toolName || execution?.tool || ''),
      needsFreshExploreAfterAnswers: false,
    }, requestId);
  }
  return null;
}

function buildPlanWorkflowUpdateForInteractionResponse({
  state = null,
  interactionResponse = {},
  pendingInteraction = {},
  requestId = '',
} = {}) {
  const responseKind = String(interactionResponse?.kind || '').trim();
  if (responseKind === 'ask_question_interaction_response') {
    const status = getAskQuestionResponseStatus(interactionResponse);
    const answers = Array.isArray(interactionResponse?.askQuestion?.answers) ? interactionResponse.askQuestion.answers : [];
    const hasConcreteAnswer = answers.some((answer) => {
      if (!answer || typeof answer !== 'object') return false;
      if (Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.length > 0) return true;
      return String(answer.freeformText || '').trim().length > 0;
    });
    if ((status === 'success' || hasAskQuestionResponseResolution(interactionResponse)) && hasConcreteAnswer) {
      return buildPlanWorkflowStateUpdate(state, PLAN_WORKFLOW_PHASES.ANSWERS_COLLECTED, {
        lastInteractionKind: responseKind,
        needsFreshExploreAfterAnswers: true,
      }, requestId);
    }
    return null;
  }
  if (
    responseKind === 'create_plan_request_response'
    && String(interactionResponse?.createPlan?.kind || '').trim().toLowerCase() === 'success'
  ) {
    return buildPlanWorkflowStateUpdate(state, PLAN_WORKFLOW_PHASES.PLAN_PRESENTED, {
      lastInteractionKind: responseKind,
      presentedPlanUri: String(interactionResponse?.createPlan?.planUri || '').trim()
        || String(pendingInteraction?.arguments?.planUri || '').trim(),
      needsFreshExploreAfterAnswers: false,
    }, requestId);
  }
  return null;
}

function shouldAllowFreshPlanExploreDespiteDuplicate({
  state = null,
  toolName = '',
  isReadOnlyContextToolName = () => false,
} = {}) {
  const workflow = clonePlanWorkflowState(state);
  if (getPlanWorkflowPhaseFromState(workflow) !== PLAN_WORKFLOW_PHASES.ANSWERS_COLLECTED) return false;
  if (workflow.needsFreshExploreAfterAnswers !== true) return false;
  return isReadOnlyContextToolName(String(toolName || '').trim().toLowerCase());
}

function buildPlanWorkflowUpdateForConversationAction({
  state = null,
  actionKind = '',
  action = {},
  requestId = '',
} = {}) {
  const current = clonePlanWorkflowState(state);
  if (actionKind === 'start_plan_action') {
    return buildPlanWorkflowStateUpdate(current, PLAN_WORKFLOW_PHASES.PLAN_PRESENTED, {
      lastInteractionKind: actionKind,
      presentedPlanUri: String(action.planFileUri || '').trim() || current.presentedPlanUri,
      needsFreshExploreAfterAnswers: false,
    }, requestId);
  }
  if (actionKind === 'execute_plan_action') {
    return buildPlanWorkflowStateUpdate(current, PLAN_WORKFLOW_PHASES.EXECUTING, {
      lastInteractionKind: actionKind,
      presentedPlanUri: String(action.planFileUri || '').trim() || current.presentedPlanUri,
      needsFreshExploreAfterAnswers: false,
    }, requestId);
  }
  return null;
}

module.exports = {
  PLAN_WORKFLOW_PHASES,
  getAskQuestionResponseStatus,
  normalizeAskQuestionAnswers,
  hasAskQuestionResponseResolution,
  getDefaultPlanWorkflowState,
  clonePlanWorkflowState,
  getPlanWorkflowPhaseFromState,
  isPlanCheckpointVisiblePhase,
  buildPlanWorkflowStateUpdate,
  buildPlanWorkflowUpdateForToolExecution,
  buildPlanWorkflowUpdateForInteractionResponse,
  shouldAllowFreshPlanExploreDespiteDuplicate,
  buildPlanWorkflowUpdateForConversationAction,
};

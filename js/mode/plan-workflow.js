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
  if (lower === 'askquestion') {
    return buildPlanWorkflowStateUpdate(state, PLAN_WORKFLOW_PHASES.AWAITING_ANSWERS, {
      lastToolName: 'AskQuestion',
      needsFreshExploreAfterAnswers: false,
    }, requestId);
  }
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
    const askQuestion = interactionResponse?.askQuestion || {};
    const status = String(askQuestion.kind || '').trim().toLowerCase();
    const answers = Array.isArray(askQuestion.answers) ? askQuestion.answers : [];
    const hasAnswers = answers.some((answer) => {
      const selected = Array.isArray(answer?.selectedOptionIds) ? answer.selectedOptionIds.filter(Boolean) : [];
      const freeform = String(answer?.freeformText || '').trim();
      return selected.length > 0 || Boolean(freeform);
    });
    if (status === 'success' && hasAnswers) {
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

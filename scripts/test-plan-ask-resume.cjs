'use strict';

const {
  PLAN_WORKFLOW_PHASES,
  buildPlanWorkflowUpdateForInteractionResponse,
} = require('../js/mode/plan-workflow');
const planMode = require('../js/mode/plan-mode');
const {
  shouldKeepWaitingForInteractionResponse,
  shouldIgnoreStaleInteractionResponseDuringExecutePlan,
  abortAgentSession,
  shouldBufferAgentFrameWhileDetached,
  findWaitingSessionByStableConversationId,
  shouldReuseWaitingSessionForRunRequest,
  shouldReuseWaitingSessionForPendingCapture,
  rememberCompletedAgentTurn,
  getCompletedAgentTurn,
} = require('../js/utils/cursor-relay-runner');

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

const session = {
  requestId: 'plan-ask-test-001',
  planWorkflow: {
    phase: PLAN_WORKFLOW_PHASES.AWAITING_ANSWERS,
  },
  latestPlanState: null,
};

const pendingInteraction = {
  kind: 'ask_question',
  toolName: 'AskQuestion',
  toolCallId: 'tool_ask_001',
  arguments: {
    title: 'Clarify scope',
    questions: [
      {
        id: 'scope',
        prompt: 'Which module should we focus on?',
      },
    ],
  },
};

const successWithoutAnswers = {
  kind: 'ask_question_interaction_response',
  askQuestion: {
    kind: 'success',
    answers: [],
  },
};

const successWithAnswers = {
  kind: 'ask_question_interaction_response',
  askQuestion: {
    kind: 'success',
    answers: [
      {
        questionId: 'scope',
        selectedOptionIds: ['renderer'],
      },
    ],
  },
};

const rejectedResponse = {
  kind: 'ask_question_interaction_response',
  askQuestion: {
    kind: 'rejected',
    rejectedReason: 'user dismissed',
  },
};

const workflowAfterSuccessWithoutAnswers = buildPlanWorkflowUpdateForInteractionResponse({
  state: session.planWorkflow,
  interactionResponse: successWithoutAnswers,
  pendingInteraction,
  requestId: session.requestId,
});
check(
  'workflow: Ask success without answers advances to answers_collected',
  workflowAfterSuccessWithoutAnswers?.phase === PLAN_WORKFLOW_PHASES.ANSWERS_COLLECTED,
  JSON.stringify(workflowAfterSuccessWithoutAnswers || {}),
);
check(
  'workflow: Ask success without answers requires fresh explore',
  workflowAfterSuccessWithoutAnswers?.needsFreshExploreAfterAnswers === true,
  JSON.stringify(workflowAfterSuccessWithoutAnswers || {}),
);

check(
  'runner: Ask success without answers does not keep waiting',
  shouldKeepWaitingForInteractionResponse(pendingInteraction, successWithoutAnswers) === false,
);
check(
  'runner: Ask rejected does not keep waiting forever',
  shouldKeepWaitingForInteractionResponse(pendingInteraction, rejectedResponse) === false,
);

const statePatchAfterSuccessWithoutAnswers = planMode.buildCompletedInteractionStatePatch(
  session,
  successWithoutAnswers,
  pendingInteraction,
  {},
);
check(
  'plan-mode: Ask success without answers resumes running state',
  statePatchAfterSuccessWithoutAnswers?.current_loop_status === 'running',
  JSON.stringify(statePatchAfterSuccessWithoutAnswers || {}),
);
check(
  'plan-mode: Ask success clears waiting_for_interaction',
  statePatchAfterSuccessWithoutAnswers?.waiting_for_interaction == null,
  JSON.stringify(statePatchAfterSuccessWithoutAnswers || {}),
);

const continuationPrompt = planMode.buildInteractionResumeMessage(
  pendingInteraction,
  successWithoutAnswers,
);
check(
  'plan-mode: continuation prompt mentions completed AskQuestion',
  String(continuationPrompt?.content || '').includes('pending AskQuestion interaction has completed'),
  String(continuationPrompt?.content || ''),
);
check(
  'plan-mode: continuation prompt avoids none-provided on confirm-only success',
  !String(continuationPrompt?.content || '').includes('Answers: none provided.'),
  String(continuationPrompt?.content || ''),
);

const workflowAfterSuccessWithAnswers = buildPlanWorkflowUpdateForInteractionResponse({
  state: session.planWorkflow,
  interactionResponse: successWithAnswers,
  pendingInteraction,
  requestId: session.requestId,
});
check(
  'workflow: Ask success with answers still advances correctly',
  workflowAfterSuccessWithAnswers?.phase === PLAN_WORKFLOW_PHASES.ANSWERS_COLLECTED,
  JSON.stringify(workflowAfterSuccessWithAnswers || {}),
);

const agentSessions = new Map();
const executePlanSession = {
  requestId: 'plan-build-old-001',
  waitingForInteraction: false,
  awaitingRunsseRebind: true,
  aborted: false,
  completed: false,
  active: true,
  relaying: false,
  streamDetached: false,
  planTurnHandoff: '',
  modeTurnHandoff: 'execute_plan',
  heartbeat: null,
  activeUpstreamResponse: null,
  agentSessions,
  abortController: { abort() {} },
  lastUserMessageCapture: {
    stableConversationId: 'stable-plan-build-001',
    userText: 'Implement the accepted plan',
  },
  logger: { info() {}, warn() {}, error() {} },
};
agentSessions.set(executePlanSession.requestId, executePlanSession);

const reboundLookup = findWaitingSessionByStableConversationId(
  agentSessions,
  'stable-plan-build-001',
  'plan-build-new-002',
);
check(
  'build->agent: awaiting rebind session is discoverable by stable conversation id',
  reboundLookup === executePlanSession,
);

check(
  'build->agent: run_request execute_plan can reuse awaiting rebind session',
  shouldReuseWaitingSessionForRunRequest(executePlanSession, {
    debug: {
      agentClientMessage: {
        runRequest: {
          action: { kind: 'execute_plan_action' },
        },
      },
    },
  }) === true,
);

check(
  'build->agent: pending capture execute_plan can reuse awaiting rebind session',
  shouldReuseWaitingSessionForPendingCapture(executePlanSession, {
    debug: {
      agentClientMessage: {
        runRequest: {
          action: { kind: 'execute_plan_action' },
        },
      },
    },
  }) === true,
);

abortAgentSession(executePlanSession, executePlanSession.logger, 'runsse_closed');
check(
  'build->agent: runsse_closed detaches execute-plan handoff instead of aborting',
  executePlanSession.aborted === false && executePlanSession.streamDetached === true,
  JSON.stringify({
    aborted: executePlanSession.aborted,
    streamDetached: executePlanSession.streamDetached,
    active: executePlanSession.active,
  }),
);

const activeDetachedSessions = new Map();
const activeRelaySession = {
  requestId: 'agent-active-old-001',
  waitingForInteraction: false,
  awaitingRunsseRebind: false,
  aborted: false,
  completed: false,
  active: true,
  relaying: true,
  streamDetached: false,
  heartbeat: null,
  activeUpstreamResponse: null,
  agentSessions: activeDetachedSessions,
  abortController: { abort() {} },
  generatedChunks: [Buffer.from([1, 2, 3])],
  lastUserMessageCapture: {
    stableConversationId: 'stable-agent-active-001',
    userText: 'Continue the same agent turn',
    debug: { stableConversationId: 'stable-agent-active-001' },
  },
  logger: { info() {}, warn() {}, error() {} },
};
activeDetachedSessions.set(activeRelaySession.requestId, activeRelaySession);
abortAgentSession(activeRelaySession, activeRelaySession.logger, 'runsse_closed');
check(
  'agent active: runsse_closed detaches in-flight relay instead of aborting',
  activeRelaySession.aborted === false && activeRelaySession.streamDetached === true && activeRelaySession.relaying === true,
  JSON.stringify({
    aborted: activeRelaySession.aborted,
    streamDetached: activeRelaySession.streamDetached,
    relaying: activeRelaySession.relaying,
  }),
);
check(
  'agent active: detached relay remains discoverable by stable conversation id',
  findWaitingSessionByStableConversationId(activeDetachedSessions, 'stable-agent-active-001', 'agent-active-new-002') === activeRelaySession,
);
check(
  'agent active: detached relay frames are buffered instead of write-failing',
  shouldBufferAgentFrameWhileDetached({
    active: true,
    completed: false,
    aborted: false,
    streamDetached: true,
    res: null,
  }) === true,
);
check(
  'agent active: attached relay frames are not treated as detached buffering',
  shouldBufferAgentFrameWhileDetached({
    active: true,
    completed: false,
    aborted: false,
    streamDetached: false,
    res: { write() {} },
  }) === false,
);

const completedTurns = new Map();
rememberCompletedAgentTurn(
  completedTurns,
  'agent-old-001',
  'Continue the same agent turn',
  'E:/workspace/demo',
  { stableConversationId: 'stable-agent-active-001' },
  [Buffer.from([9, 9, 9])],
  {},
);
check(
  'completed turn: stable conversation id can replay across new request id',
  Boolean(
    getCompletedAgentTurn(
      completedTurns,
      'agent-new-002',
      'Continue the same agent turn',
      'E:/workspace/demo',
      { stableConversationId: 'stable-agent-active-001' },
    ),
  ),
);

check(
  'execute-plan: stale ask interaction is ignored during handoff',
  shouldIgnoreStaleInteractionResponseDuringExecutePlan(
    {
      modeTurnHandoff: 'execute_plan',
      awaitingRunsseRebind: true,
      relaying: false,
    },
    successWithoutAnswers,
    null,
  ) === true,
);

check(
  'execute-plan: stale create-plan interaction is ignored during handoff',
  shouldIgnoreStaleInteractionResponseDuringExecutePlan(
    {
      modeTurnHandoff: 'execute_plan',
      awaitingRunsseRebind: false,
      relaying: true,
    },
    {
      kind: 'create_plan_request_response',
      createPlan: { kind: 'success', planUri: 'C:/tmp/demo.plan.md' },
    },
    null,
  ) === true,
);

check(
  'execute-plan: matched pending interaction is not treated as stale',
  shouldIgnoreStaleInteractionResponseDuringExecutePlan(
    {
      modeTurnHandoff: 'execute_plan',
      awaitingRunsseRebind: true,
      relaying: false,
    },
    successWithoutAnswers,
    pendingInteraction,
  ) === false,
);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) {
  console.log('UNIT_TEST_RESULT: FAIL');
  process.exit(1);
}
console.log('UNIT_TEST_RESULT: PASS');

'use strict';

// Round-2 unit tests for native multitask/debug UI parity fixes.
// Verifies:
//   1. emitTaskProgressFrame emits taskToolCallDelta with correct subagentType
//      and NO empty backgroundSubagentAction / backgroundTaskCompletionAction frames.
//   2. taskToolCallDelta omits `result` for partial/started, includes it for completed.
//   3. findTaskRecordAcrossSessions resolves tasks by parentToolCallId alias.
//   4. ToolCall metadata (toolCallId, startedAtMs, completedAtMs) is present.

const path = require('path');
const {
  loadCursorProtoRoot,
  decodeMessageSync,
} = require('../js/utils/cursor-relay-protobuf');
const {
  buildAgentTaskToolCallDeltaFrame,
} = require('../js/utils/cursor-relay-protocol');
const {
  emitTaskProgressFrame,
  findTaskRecordAcrossSessions,
  registerTaskSubagent,
  getSessionTaskRegistry,
} = require('../js/utils/cursor-relay-runner');

// ---------- helpers ----------

function decodeConnectStreamFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const frameType = buf[offset];
    const frameLen = buf.readUInt32BE(offset + 1);
    if (offset + 5 + frameLen > buf.length) break;
    const body = buf.slice(offset + 5, offset + 5 + frameLen);
    frames.push({ type: frameType, body });
    offset += 5 + frameLen;
  }
  return frames;
}

function decodeAgentServerMessage(body) {
  return decodeMessageSync('agent.v1.AgentServerMessage', body);
}

function makeMockSession() {
  const chunks = [];
  return {
    active: true,
    res: {
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      flush() {},
      destroyed: false,
    },
    generatedChunks: chunks,
    logger: { info() {}, warn() {}, error() {} },
    requestId: 'test-req-001',
    config: {},
    agentHistory: { context: { items: [] } },
    _taskRegistry: null,
  };
}

function makeTaskRecord(session, overrides = {}) {
  return registerTaskSubagent(session, {
    agentId: 'task-test-001',
    title: 'Test subagent',
    description: 'Investigate the issue',
    prompt: 'Find the root cause',
    subagentType: 'generalPurpose',
    parentToolCallId: 'tool_testcall001',
    status: 'pending',
    ...overrides,
  });
}

// ---------- tests ----------

async function main() {
  await loadCursorProtoRoot();

  let pass = 0;
  let fail = 0;
  const results = [];

  function check(label, condition, detail = '') {
    if (condition) {
      pass += 1;
      results.push(`  PASS  ${label}`);
    } else {
      fail += 1;
      results.push(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
  }

  // === Test 1: buildAgentTaskToolCallDeltaFrame — partial (no result) ===
  {
    const args = {
      description: 'Investigate the issue',
      prompt: 'Find the root cause',
      subagent_type: 'generalPurpose',
      model: '',
      tool_call_id: 'tool_testcall001',
      name: 'Test subagent',
    };
    const execution = {
      ok: true,
      agentId: 'task-test-001',
      isBackground: true,
      durationMs: 0,
      includeResult: false,
      startedAtMs: Date.now(),
      completedAtMs: 0,
    };
    const frame = buildAgentTaskToolCallDeltaFrame('partial', args, 'tool_testcall001', '', { execution });
    const frames = decodeConnectStreamFrames(frame);
    check('partial frame: 1 connect frame', frames.length === 1, `got ${frames.length}`);
    if (frames.length) {
      const msg = decodeAgentServerMessage(frames[0].body);
      const delta = msg?.interactionUpdate?.toolCallDelta;
      check('partial frame: has toolCallDelta', Boolean(delta), JSON.stringify(msg?.interactionUpdate || {}).slice(0, 200));
      if (delta) {
        const taskDelta = delta.toolCallDelta?.taskToolCallDelta;
        check('partial frame: has taskToolCallDelta', Boolean(taskDelta));
        if (taskDelta) {
          const partial = taskDelta.interactionUpdate?.partialToolCall;
          check('partial frame: has partialToolCall', Boolean(partial));
          if (partial) {
            const tc = partial.toolCall;
            check('partial frame: toolCall present', Boolean(tc));
            check('partial frame: toolCallId metadata', tc?.toolCallId === 'tool_testcall001', `got ${tc?.toolCallId}`);
            check('partial frame: startedAtMs present', Number(tc?.startedAtMs) > 0);
            check('partial frame: NO completedAtMs', !tc?.completedAtMs, `got ${tc?.completedAtMs}`);
            const taskCall = tc?.taskToolCall;
            check('partial frame: has taskToolCall branch', Boolean(taskCall));
            if (taskCall) {
              const subagentType = taskCall.args?.subagentType;
              check('partial frame: subagentType is custom (not unspecified)', Boolean(subagentType?.custom), JSON.stringify(subagentType || {}));
              check('partial frame: NO result (not terminal)', !taskCall.result, `got ${JSON.stringify(taskCall.result || '').slice(0, 100)}`);
              check('partial frame: agentId in args', taskCall.args?.agentId === 'task-test-001');
            }
          }
        }
      }
    }
  }

  // === Test 2: buildAgentTaskToolCallDeltaFrame — completed (has result) ===
  {
    const args = {
      description: 'Investigate the issue',
      prompt: 'Find the root cause',
      subagent_type: 'generalPurpose',
      tool_call_id: 'tool_testcall001',
    };
    const execution = {
      ok: true,
      agentId: 'task-test-001',
      isBackground: true,
      durationMs: 500,
      resultSuffix: 'Root cause found.',
      includeResult: true,
      startedAtMs: Date.now() - 500,
      completedAtMs: Date.now(),
    };
    const frame = buildAgentTaskToolCallDeltaFrame('completed', args, 'tool_testcall001', '', { execution });
    const frames = decodeConnectStreamFrames(frame);
    if (frames.length) {
      const msg = decodeAgentServerMessage(frames[0].body);
      const delta = msg?.interactionUpdate?.toolCallDelta;
      const taskDelta = delta?.toolCallDelta?.taskToolCallDelta;
      const completed = taskDelta?.interactionUpdate?.toolCallCompleted;
      check('completed frame: has toolCallCompleted', Boolean(completed));
      if (completed) {
        const tc = completed.toolCall;
        const taskCall = tc?.taskToolCall;
        check('completed frame: HAS result (terminal)', Boolean(taskCall?.result), 'result missing');
        check('completed frame: result is success', Boolean(taskCall?.result?.success), JSON.stringify(taskCall?.result || {}).slice(0, 100));
        check('completed frame: completedAtMs present', Number(tc?.completedAtMs) > 0, `got ${tc?.completedAtMs}`);
        check('completed frame: resultSuffix', taskCall?.result?.success?.resultSuffix === 'Root cause found.');
      }
    }
  }

  // === Test 3: debug subagentType encoding ===
  {
    const args = { description: 'Debug', prompt: 'Debug', subagent_type: 'debug', tool_call_id: 'tool_dbg' };
    const execution = { ok: true, agentId: 'dbg-001', isBackground: true, includeResult: false, startedAtMs: 1, completedAtMs: 0 };
    const frame = buildAgentTaskToolCallDeltaFrame('started', args, 'tool_dbg', '', { execution });
    const frames = decodeConnectStreamFrames(frame);
    if (frames.length) {
      const msg = decodeAgentServerMessage(frames[0].body);
      const tc = msg?.interactionUpdate?.toolCallDelta?.toolCallDelta?.taskToolCallDelta?.interactionUpdate?.toolCallStarted?.toolCall;
      const subagentType = tc?.taskToolCall?.args?.subagentType;
      check('debug frame: subagentType is debug', Boolean(subagentType?.debug), JSON.stringify(subagentType || {}));
    }
  }

  // === Test 4: emitTaskProgressFrame — no empty background action frames ===
  {
    const session = makeMockSession();
    const record = makeTaskRecord(session, { status: 'in_progress' });
    emitTaskProgressFrame(session, record);
    const allFrames = [];
    for (const chunk of session.generatedChunks) {
      allFrames.push(...decodeConnectStreamFrames(chunk));
    }
    check('emit: at least 1 frame', allFrames.length >= 1, `got ${allFrames.length}`);
    // Verify no frame has an empty interactionUpdate (which is what the broken
    // backgroundSubagentAction / backgroundTaskCompletionAction frames would produce).
    let emptyCount = 0;
    let taskDeltaCount = 0;
    for (const f of allFrames) {
      const msg = decodeAgentServerMessage(f.body);
      const iu = msg?.interactionUpdate;
      if (iu) {
        const keys = Object.keys(iu).filter((k) => iu[k] != null);
        if (!keys.length) emptyCount += 1;
        if (iu.toolCallDelta) taskDeltaCount += 1;
      }
    }
    check('emit: no empty interactionUpdate frames', emptyCount === 0, `${emptyCount} empty frames`);
    check('emit: has taskToolCallDelta frame', taskDeltaCount >= 1, `${taskDeltaCount} taskDelta frames`);
  }

  // === Test 5: findTaskRecordAcrossSessions — parentToolCallId alias ===
  {
    const session = makeMockSession();
    const record = makeTaskRecord(session, {
      parentToolCallId: 'tool_alias_test_001',
      agentId: 'agent-alias-001',
    });
    // Look up by parentToolCallId (what the Cursor client sends as task_uuid)
    const found = findTaskRecordAcrossSessions(session.config, ['tool_alias_test_001'], 'Test subagent');
    check('lookup: found by parentToolCallId', Boolean(found), 'record not found');
    check('lookup: correct record', found?.agentId === 'agent-alias-001', `got ${found?.agentId}`);
    // Also verify lookup by agentId still works
    const foundByAgent = findTaskRecordAcrossSessions(session.config, ['agent-alias-001'], '');
    check('lookup: found by agentId', Boolean(foundByAgent));
  }

  // === Test 6: findTaskRecordAcrossSessions — child task by parentToolCallId ===
  {
    const session = makeMockSession();
    const parent = makeTaskRecord(session, {
      parentToolCallId: 'tool_parent_002',
      agentId: 'agent-parent-002',
    });
    const child = registerTaskSubagent(session, {
      agentId: 'agent-parent-002-child-1',
      title: 'Child task 1',
      description: 'Child investigation',
      prompt: 'Child',
      subagentType: 'generalPurpose',
      parentToolCallId: 'tool_parent_002.child.1',
      status: 'pending',
      parentTaskUuid: 'agent-parent-002',
    });
    const found = findTaskRecordAcrossSessions(session.config, ['tool_parent_002.child.1'], 'Child task 1');
    check('lookup: child found by parentToolCallId', Boolean(found), 'child not found');
    check('lookup: correct child record', found?.agentId === 'agent-parent-002-child-1', `got ${found?.agentId}`);
  }

  // === Summary ===
  console.log(results.join('\n'));
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail > 0) {
    console.log('UNIT_TEST_RESULT: FAIL');
    process.exit(1);
  } else {
    console.log('UNIT_TEST_RESULT: PASS');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});

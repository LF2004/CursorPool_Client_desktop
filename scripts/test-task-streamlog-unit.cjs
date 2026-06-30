// Unit test for handleTaskStreamLogLive: verifies the connect-streaming frame
// sequence emitted for a task matches the official TaskStreamLogResponse schema
// (initial_task_info with task_status, info_update on status change, and
// streamed_log_item frames where the FIRST log item is an instruction).
const path = require('path');
const {
  handleTaskStreamLogLive,
  encodeTaskStreamLogFrame,
  encodeTaskLogItemPayload,
  encodeTaskStatusValue,
} = require('../js/utils/cursor-relay-runner');
const { decodeMessageSync, loadCursorProtoRoot } = require('../js/utils/cursor-relay-protobuf');

function makeMockRes() {
  const chunks = [];
  let ended = false;
  let closeHandlers = [];
  return {
    destroyed: false,
    writeHead() {},
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end() { ended = true; },
    on(evt, handler) { if (evt === 'close') closeHandlers.push(handler); },
    triggerClose() { closeHandlers.forEach((h) => h()); },
    get chunks() { return chunks; },
    get ended() { return ended; },
  };
}

function decodeConnectStreamFrames(buf) {
  // connectLocalFrame format: [type:1][len:4 BE][body]
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const type = buf[offset];
    const len = buf.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + len > buf.length) break;
    frames.push({ type, body: buf.slice(offset, offset + len) });
    offset += len;
  }
  return frames;
}

async function runTest() {
  await loadCursorProtoRoot();
  // Build a task record that mimics what executeTaskTool creates.
  const task = {
    taskUuid: 'task-streamlog-unit-1',
    agentId: 'task-streamlog-unit-1',
    title: 'Multitask coordinator',
    name: 'Multitask coordinator',
    description: 'Investigate project files and report findings.',
    prompt: 'Investigate project files and report findings.',
    status: 'in_progress',
    log: [
      { type: 'instruction', text: 'Investigate project files and report findings.', sequenceNumber: 1, isNotDone: true },
      { type: 'thought', text: 'Planning task: Investigate project files', sequenceNumber: 2, isNotDone: true },
    ],
  };

  const res = makeMockRes();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };

  // Start the live stream from sequence 0.
  await new Promise((resolve) => {
    handleTaskStreamLogLive(res, task, 0, logger);
    // The handler polls every 300ms and closes on terminal status / timeout.
    // We flip the task to completed after a short delay so the stream closes.
    setTimeout(() => {
      task.status = 'completed';
      task.log.push({ type: 'tool_action', text: 'Running Read', sequenceNumber: 3, isNotDone: true });
      task.log.push({ type: 'tool_result', text: 'file contents here', sequenceNumber: 4, isNotDone: false });
      task.log.push({ type: 'output', text: 'Child task completed: found 3 files.', sequenceNumber: 5, isNotDone: false });
    }, 400);
    // Wait for the handler to flush + close.
    setTimeout(resolve, 2500);
  });

  const buf = Buffer.concat(res.chunks);
  const frames = decodeConnectStreamFrames(buf);

  let sawInitial = false, sawInfoUpdate = false;
  let initialStatus = -1, initialTitle = '';
  let updateStatus = -1, updateTitle = '';
  const logTypes = [];

  const STATUS_RUNNING = 'TASK_STATUS_RUNNING';
  const STATUS_DONE = 'TASK_STATUS_DONE';

  for (const f of frames) {
    let decoded;
    try { decoded = decodeMessageSync('aiserver.v1.TaskStreamLogResponse', f.body); } catch { continue; }
    const respKey = decoded.response;
    if (respKey === 'initialTaskInfo') {
      sawInitial = true;
      initialStatus = decoded.initialTaskInfo?.taskStatus ?? '';
      initialTitle = decoded.initialTaskInfo?.humanReadableTitle ?? '';
    } else if (respKey === 'infoUpdate') {
      sawInfoUpdate = true;
      updateStatus = decoded.infoUpdate?.taskStatus ?? '';
      updateTitle = decoded.infoUpdate?.humanReadableTitle ?? '';
    } else if (respKey === 'streamedLogItem') {
      const li = decoded.streamedLogItem?.logItem || '';
      logTypes.push(li);
    }
  }

  console.log('total connect frames:', frames.length);
  console.log('saw initial_task_info:', sawInitial);
  console.log('  initial title:', JSON.stringify(initialTitle));
  console.log('  initial task_status:', initialStatus, `(expect ${STATUS_RUNNING})`);
  console.log('saw info_update:', sawInfoUpdate);
  console.log('  update title:', JSON.stringify(updateTitle));
  console.log('  update task_status:', updateStatus, `(expect ${STATUS_DONE})`);
  console.log('log item types in order:', logTypes.join(', '));
  console.log('first log type:', logTypes[0] || '(none)', '(expect instruction)');

  const pass = sawInitial
    && initialStatus === STATUS_RUNNING
    && sawInfoUpdate
    && updateStatus === STATUS_DONE
    && logTypes[0] === 'instruction'
    && logTypes.includes('toolAction')
    && logTypes.includes('toolResult');

  console.log('---');
  console.log('UNIT_TEST_RESULT:', pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 2);
}

runTest().catch((e) => { console.error('ERR', e.message, e.stack); process.exit(1); });

const fs = require('fs');
const http = require('http');
const http2 = require('http2');
const https = require('https');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const tls = require('tls');

const { ensureRelayCertificates } = require('../js/utils/cursor-relay-cert');
const {
  decodeRunSseRequestId,
  decodeBidiAppendRequest,
  summarizeConnectFrames,
  summarizeAgentServerStream,
  buildAgentTextDeltaFrame,
  buildAgentThinkingDeltaFrame,
  buildAgentTokenDeltaFrame,
  buildAgentTurnEndedFrame,
  buildAgentHeartbeatFrame,
  buildAgentStepStartedFrame,
  buildAgentStepCompletedFrame,
  buildAgentPartialToolCallFrame,
  buildAgentToolCallStartedFrame,
  buildAgentToolCallCompletedFrame,
  buildAgentEditToolCallDeltaFrame,
  buildAgentExecReadFrame,
  buildAgentExecWriteFrame,
  buildAgentExecGrepFrame,
  buildAgentExecLsFrame,
  buildAgentExecShellStreamFrame,
  buildAgentExecDiagnosticsFrame,
  buildAgentAskQuestionQueryFrame,
  buildAgentCreatePlanQueryFrame,
  buildAgentConversationCheckpointFrame,
  buildConnectEndFrame,
} = require('../js/utils/cursor-relay-protocol');

function parseArgs(argv) {
  const out = {
    port: 17888,
    scenario: 'all-tools',
    delayMs: 180,
    dataDir: path.join(process.env.USERPROFILE || process.cwd(), '.cursorpool', 'relay'),
    nativeExec: false,
    once: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') out.port = Number(argv[++i]) || out.port;
    else if (arg === '--scenario') out.scenario = String(argv[++i] || out.scenario);
    else if (arg === '--delay') out.delayMs = Number(argv[++i]) || out.delayMs;
    else if (arg === '--data-dir') out.dataDir = String(argv[++i] || out.dataDir);
    else if (arg === '--native-exec') out.nativeExec = true;
    else if (arg === '--once') out.once = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log([
    'Usage:',
    '  node scripts/mock-cursor-agent-protocol-server.cjs [--port 17888] [--scenario all-tools|edit-stream|file-ops|complex-multifile|minimal|plan-full|plan-explore-task|explore-only|multitask] [--delay 180] [--native-exec] [--dry-run] [--self-test]',
    '',
    'What it does:',
    '  Starts a temporary HTTP CONNECT proxy that intercepts Cursor Agent RunSSE/BidiAppend',
    '  and returns hard-coded protocol frames from this test script only.',
    '',
    'Cursor proxy:',
    '  HTTP proxy: http://127.0.0.1:<port>',
    '',
    'Notes:',
    '  Default mode does not send exec_server frames, so it should not trigger real file writes.',
    '  Add --native-exec only when you explicitly want to test Cursor native exec handling.',
    '  Add --dry-run to print the generated frame summary without starting a proxy.',
  ].join('\n'));
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function getPathname(req) {
  return String(req.url || req.headers?.[':path'] || '').split('?')[0];
}

function getMethod(req) {
  return String(req.method || req.headers?.[':method'] || 'GET').toUpperCase();
}

function isRunSsePath(pathname) {
  return /\/(?:agent\.v1\.AgentService|aiserver\.v1\.AiService)\/RunSSE$/i.test(pathname);
}

function isBidiAppendPath(pathname) {
  return /\/aiserver\.v1\.BidiService\/BidiAppend$/i.test(pathname);
}

function isTaskInitPath(pathname) {
  return /\/aiserver\.v1\.AiService\/TaskInit$/i.test(pathname);
}

function isTaskStreamLogPath(pathname) {
  return /\/aiserver\.v1\.AiService\/TaskStreamLog$/i.test(pathname);
}

function isTaskSendMessagePath(pathname) {
  return /\/aiserver\.v1\.AiService\/TaskSendMessage$/i.test(pathname);
}

function isTaskProvideResultPath(pathname) {
  return /\/aiserver\.v1\.AiService\/TaskProvideResult$/i.test(pathname);
}

function isTaskGetInterfaceAgentStatusPath(pathname) {
  return /\/aiserver\.v1\.AiService\/TaskGetInterfaceAgentStatus$/i.test(pathname);
}

function safeWriteHead(res, status, headers) {
  if (!res.headersSent) res.writeHead(status, headers);
}

function writeProtoAck(res) {
  safeWriteHead(res, 200, { 'Content-Type': 'application/proto' });
  res.end(Buffer.alloc(0));
}

function sendControlPlaneStub(req, res) {
  const pathname = getPathname(req);
  const method = getMethod(req);
  console.log(`[mock-agent] control-plane stub ${method} ${pathname}`);
  if (method === 'GET') {
    safeWriteHead(res, 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, mock: true, path: pathname }));
    return;
  }
  safeWriteHead(res, 200, { 'Content-Type': 'application/proto' });
  res.end(Buffer.alloc(0));
}

function makeEditDiff(filePath, beforeContent, afterContent) {
  const beforeLines = String(beforeContent || '').split(/\r?\n/);
  const afterLines = String(afterContent || '').split(/\r?\n/);
  return [
    `--- a/${path.basename(filePath)}`,
    `+++ b/${path.basename(filePath)}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join('\n');
}

function chunkText(text, maxLen) {
  const value = String(text || '');
  const chunks = [];
  for (let i = 0; i < value.length; i += maxLen) chunks.push(value.slice(i, i + maxLen));
  return chunks;
}

function toolIds(name) {
  const suffix = String(name || 'tool').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const callId = `mock_${suffix}_${Date.now().toString(36)}`;
  return { callId, modelCallId: `model_${callId}` };
}

function buildCompleted(toolName, args, execution, ids) {
  return buildAgentToolCallCompletedFrame(toolName, args, ids.callId, ids.modelCallId, {
    execution,
  });
}

function connectFrame(type, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  const header = Buffer.allocUnsafe(5);
  header[0] = Number(type) || 0;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function encodeFieldTag(fieldNumber, wireType) {
  return encodeVarint(((Number(fieldNumber) || 0) << 3) | (Number(wireType) || 0));
}

function encodeVarintField(fieldNumber, value) {
  return concatBytes([
    encodeFieldTag(fieldNumber, 0),
    encodeVarint(Number(value) || 0),
  ]);
}

function encodeStringField(fieldNumber, value) {
  const text = String(value || '');
  if (!text) return Buffer.alloc(0);
  return encodeBytesField(fieldNumber, text);
}

function encodeMessageField(fieldNumber, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  if (!bytes.length) return Buffer.alloc(0);
  return encodeBytesField(fieldNumber, bytes);
}

function buildRawAgentServerMessageField(fieldNumber, innerPayload) {
  return connectFrame(0, encodeMessage([{ field: fieldNumber, value: innerPayload }]));
}

function encodeTokenDetailsStructure(options = {}) {
  return concatBytes([
    encodeVarintField(1, Number(options.usedTokens) || 1),
    encodeVarintField(2, Number(options.maxTokens) || 200000),
  ]);
}

function encodeSubagentTypeExploreStructure() {
  return encodeMessageField(4, Buffer.alloc(0));
}

function encodeConversationStateStructure(options = {}) {
  const rootPromptMessagesJson = Array.isArray(options.rootPromptMessagesJson) ? options.rootPromptMessagesJson : [];
  const turns = Array.isArray(options.turns) ? options.turns : [];
  const pendingToolCalls = Array.isArray(options.pendingToolCalls) ? options.pendingToolCalls : [];
  const todos = Array.isArray(options.todos) ? options.todos : [];
  const previousWorkspaceUris = Array.isArray(options.previousWorkspaceUris) ? options.previousWorkspaceUris : [];
  const readPaths = Array.isArray(options.readPaths) ? options.readPaths : [];
  const subagentStates = options.subagentStates && typeof options.subagentStates === 'object'
    ? options.subagentStates
    : {};

  return concatBytes([
    ...rootPromptMessagesJson.map((item) => encodeMessageField(
      1,
      Buffer.isBuffer(item) ? item : Buffer.from(String(item || ''), 'base64'),
    )),
    ...todos.map((item) => encodeMessageField(
      3,
      Buffer.isBuffer(item) ? item : Buffer.from(String(item || ''), 'base64'),
    )),
    ...pendingToolCalls.map((item) => encodeStringField(4, item)),
    encodeMessageField(5, encodeTokenDetailsStructure(options)),
    typeof options.summary === 'string' && options.summary
      ? encodeMessageField(6, Buffer.from(options.summary, 'base64'))
      : Buffer.alloc(0),
    typeof options.plan === 'string' && options.plan
      ? encodeMessageField(7, Buffer.from(options.plan, 'base64'))
      : Buffer.alloc(0),
    ...turns.map((item) => encodeMessageField(
      8,
      Buffer.isBuffer(item) ? item : Buffer.from(String(item || ''), 'base64'),
    )),
    ...previousWorkspaceUris.map((item) => encodeStringField(9, item)),
    encodeVarintField(10, Number(options.mode) || 1),
    encodeVarintField(17, Number(options.selfSummaryCount) || 0),
    ...readPaths.map((item) => encodeStringField(18, item)),
    ...Object.entries(subagentStates).map(([subagentId, state]) => encodeMessageField(16, encodeMessage([
      { field: 1, value: String(subagentId || '') },
      { field: 2, value: encodeSubagentPersistedStateStructure(state) },
    ]))),
  ]);
}

function encodeSubagentPersistedStateStructure(options = {}) {
  return concatBytes([
    encodeMessageField(1, encodeConversationStateStructure({
      ...options.conversationState,
      subagentStates: {},
    })),
    encodeVarintField(2, Number(options.createdTimestampMs) || Date.now()),
    encodeVarintField(3, Number(options.lastUsedTimestampMs) || Number(options.createdTimestampMs) || Date.now()),
    options.subagentType?.explore ? encodeMessageField(4, encodeSubagentTypeExploreStructure()) : Buffer.alloc(0),
    encodeStringField(5, options.modelId || ''),
    Number(options.environment) ? encodeVarintField(6, Number(options.environment)) : Buffer.alloc(0),
  ]);
}

function buildTaskInteractionQueryFrame(argumentsValue = {}, toolCallId = '', queryId = 1) {
  const subagentType = argumentsValue?.subagent_type || argumentsValue?.subagentType || {};
  const argsPayload = concatBytes([
    encodeStringField(1, argumentsValue?.description || ''),
    encodeStringField(2, argumentsValue?.prompt || ''),
    subagentType && (subagentType.explore || /explore/i.test(String(subagentType)))
      ? encodeMessageField(3, encodeStringField(1, 'explore'))
      : Buffer.alloc(0),
    encodeStringField(4, toolCallId),
  ]);
  const taskQueryPayload = concatBytes([
    encodeMessageField(1, argsPayload),
    encodeStringField(2, toolCallId),
  ]);
  const interactionQuery = concatBytes([
    encodeVarintField(1, Math.max(1, Number(queryId) || 1)),
    encodeMessageField(19, taskQueryPayload),
  ]);
  return buildRawAgentServerMessageField(7, interactionQuery);
}

function buildConversationCheckpointWithSubagentsFrame(options = {}) {
  return buildRawAgentServerMessageField(3, encodeConversationStateStructure(options));
}

function encodeProtoString(fieldNumber, value) {
  return encodeStringField(fieldNumber, value);
}

function encodeProtoBool(fieldNumber, value) {
  if (!value) return Buffer.alloc(0);
  return encodeVarintField(fieldNumber, 1);
}

function encodeTaskInitResponse(taskUuid, title) {
  return encodeMessage([
    { field: 1, value: String(taskUuid || '') },
    { field: 2, value: String(title || '') },
  ]);
}

function encodeTaskLogOutput(text) {
  return encodeMessage([
    { field: 1, value: String(text || '') },
  ]);
}

function encodeTaskLogThought(text) {
  return encodeMessage([
    { field: 1, value: String(text || '') },
  ]);
}

function encodeTaskLogItem(options = {}) {
  const sequenceNumber = Number(options.sequenceNumber) || 1;
  const itemType = String(options.type || '').trim();
  let logItemPayload = Buffer.alloc(0);
  let fieldNumber = 0;
  if (itemType === 'thought') {
    fieldNumber = 5;
    logItemPayload = encodeTaskLogThought(options.text || '');
  } else {
    fieldNumber = 3;
    logItemPayload = encodeTaskLogOutput(options.text || '');
  }
  return encodeMessage([
    { field: 1, value: encodeVarint(sequenceNumber) },
    ...(options.isNotDone ? [{ field: 2, value: encodeVarint(1) }] : []),
    { field: fieldNumber, value: logItemPayload },
  ]);
}

function encodeTaskStreamInfoUpdate(title, taskStatus = 2) {
  return encodeMessage([
    { field: 1, value: encodeStringField(1, title) + encodeVarintField(2, taskStatus) },
  ]);
}

function encodeTaskStreamInitialTaskInfo(taskUuid, title) {
  return encodeMessage([
    { field: 1, value: String(taskUuid || '') },
    { field: 2, value: String(title || '') },
  ]);
}

function encodeTaskStreamResponse(responseFieldNumber, payload) {
  return connectFrame(0, encodeMessage([
    {
      field: responseFieldNumber,
      value: Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []),
    },
  ]));
}

function safeTaskId(value, fallback = 'task') {
  const text = String(value || '').trim();
  return (text || fallback).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || fallback;
}

function decodePrintableStrings(body) {
  const buffer = Buffer.from(body || []);
  const matches = buffer.toString('utf8').match(/[ -~]{4,}/g);
  return Array.isArray(matches) ? matches : [];
}

function findTaskUuidInBody(body) {
  const strings = decodePrintableStrings(body);
  return strings.find((item) => /^mock-task-|^multitask-|^task_/i.test(String(item || '').trim())) || '';
}

function ensureMockTaskState(state, taskUuid, title = '') {
  if (!state.mockTasks) state.mockTasks = new Map();
  const stableTaskUuid = String(taskUuid || '').trim() || `mock-task-${Date.now().toString(36)}`;
  let existing = state.mockTasks.get(stableTaskUuid);
  if (existing) return existing;
  existing = {
    taskUuid: stableTaskUuid,
    title: title || 'Multitask subagent',
    createdAt: Date.now(),
    log: [
      { sequenceNumber: 1, type: 'thought', text: 'Subagent started and is inspecting the assigned task.', isNotDone: true },
      { sequenceNumber: 2, type: 'output', text: 'Scanning local mock traces and protocol notes...', isNotDone: true },
      { sequenceNumber: 3, type: 'output', text: 'Subagent finished and returned a compact summary to the parent agent.', isNotDone: false },
    ],
  };
  state.mockTasks.set(stableTaskUuid, existing);
  return existing;
}

function encodeTaskGetInterfaceAgentStatusWrappedBackgroundTaskUuid(taskUuid) {
  return connectFrame(0, encodeMessage([
    { field: 2, value: String(taskUuid || '') },
  ]));
}

async function handleTaskInit(req, res, state) {
  const body = await readRequestBody(req);
  const strings = decodePrintableStrings(body);
  const hintedTitle = strings.find((item) => /task|agent|explore|protocol|ui/i.test(item)) || 'Mock Multitask Subagent';
  const task = ensureMockTaskState(
    state,
    `mock-task-${safeTaskId(hintedTitle, Date.now().toString(36))}`,
    hintedTitle,
  );
  const payload = encodeTaskInitResponse(task.taskUuid, task.title);
  safeWriteHead(res, 200, { 'Content-Type': 'application/proto' });
  res.end(payload);
  console.log(`[mock-agent] TaskInit taskUuid=${task.taskUuid} title=${JSON.stringify(task.title)}`);
}

async function handleTaskStreamLog(req, res, state) {
  const body = await readRequestBody(req);
  const taskUuid = findTaskUuidInBody(body) || Array.from(state.mockTasks?.keys?.() || [])[0] || '';
  const task = ensureMockTaskState(state, taskUuid, 'Mock Multitask Subagent');
  safeWriteHead(res, 200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connect-Protocol-Version': '1',
    'X-Accel-Buffering': 'no',
  });
  const frames = [
    encodeTaskStreamResponse(3, encodeTaskStreamInitialTaskInfo(task.taskUuid, task.title)),
    encodeTaskStreamResponse(2, encodeStringField(1, task.title) + encodeVarintField(2, 2)),
    ...task.log.map((item) => encodeTaskStreamResponse(1, encodeTaskLogItem(item))),
  ];
  frames.forEach((frame, index) => {
    setTimeout(() => {
      try {
        if (!res.destroyed) res.write(frame);
        if (index === frames.length - 1 && !res.destroyed) {
          setTimeout(() => {
            try {
              res.end();
            } catch {
              /* ignore */
            }
          }, 80);
        }
      } catch {
        /* ignore */
      }
    }, index * Math.max(60, Math.floor((state.options?.delayMs || 180) / 2)));
  });
  console.log(`[mock-agent] TaskStreamLog taskUuid=${task.taskUuid} frames=${frames.length}`);
}

async function handleTaskSendMessage(req, res, state) {
  const body = await readRequestBody(req);
  const taskUuid = findTaskUuidInBody(body) || Array.from(state.mockTasks?.keys?.() || [])[0] || '';
  const task = ensureMockTaskState(state, taskUuid, 'Mock Multitask Subagent');
  safeWriteHead(res, 200, { 'Content-Type': 'application/proto' });
  res.end(Buffer.alloc(0));
  console.log(`[mock-agent] TaskSendMessage taskUuid=${task.taskUuid}`);
}

async function handleTaskProvideResult(req, res, state) {
  const body = await readRequestBody(req);
  const taskUuid = findTaskUuidInBody(body) || Array.from(state.mockTasks?.keys?.() || [])[0] || '';
  const task = ensureMockTaskState(state, taskUuid, 'Mock Multitask Subagent');
  safeWriteHead(res, 200, { 'Content-Type': 'application/proto' });
  res.end(Buffer.alloc(0));
  console.log(`[mock-agent] TaskProvideResult taskUuid=${task.taskUuid}`);
}

async function handleTaskGetInterfaceAgentStatus(req, res, state) {
  const body = await readRequestBody(req);
  const taskUuid = findTaskUuidInBody(body) || Array.from(state.mockTasks?.keys?.() || [])[0] || '';
  const task = ensureMockTaskState(state, taskUuid, 'Mock Multitask Subagent');
  safeWriteHead(res, 200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connect-Protocol-Version': '1',
    'X-Accel-Buffering': 'no',
  });
  try {
    if (!res.destroyed) res.write(encodeTaskGetInterfaceAgentStatusWrappedBackgroundTaskUuid(task.taskUuid));
    setTimeout(() => {
      try {
        if (!res.destroyed) res.end();
      } catch {
        /* ignore */
      }
    }, 80);
  } catch {
    /* ignore */
  }
  console.log(`[mock-agent] TaskGetInterfaceAgentStatus taskUuid=${task.taskUuid}`);
}

function buildMinimalScenario() {
  return [
    { label: 'heartbeat', frame: buildAgentHeartbeatFrame() },
    { label: 'thinking', frame: buildAgentThinkingDeltaFrame('Mock protocol: thinking delta visible.') },
    { label: 'text', frame: buildAgentTextDeltaFrame('Mock Agent protocol server is connected.') },
    { label: 'token', frame: buildAgentTokenDeltaFrame(1) },
    { label: 'turn_end', frame: buildAgentTurnEndedFrame() },
    { label: 'connect_end', frame: buildConnectEndFrame({ mock: true }) },
  ];
}

function buildPlanFullScenario() {
  const workspaceRoot = 'E:\\project\\h5-test';
  const askIds = toolIds('ask_question');
  const lsIds = toolIds('ls');
  const globPackageIds = toolIds('glob_package');
  const globIndexIds = toolIds('glob_index');
  const globSrcIds = toolIds('glob_src');
  const globReadmeIds = toolIds('glob_readme');
  const planIds = toolIds('create_plan');
  const todos = [
    { id: 'todo_html', content: 'Create index.html shell', status: 'pending' },
    { id: 'todo_css', content: 'Add style.css theme', status: 'pending' },
    { id: 'todo_data', content: 'Define mock attraction dataset', status: 'pending' },
    { id: 'todo_logic', content: 'Wire ranking interactions', status: 'pending' },
  ];
  const planText = [
    '# Travel Ranking Landing Page Plan',
    '',
    '## Overview',
    'Build a static HTML/CSS/JS page that ranks five domestic attractions with mock data and a China-inspired visual direction.',
    '',
    '## Steps',
    '1. Create `index.html` with hero, ranking controls, and attraction cards.',
    '2. Create `style.css` with red/gold palette, textured backgrounds, and responsive layout.',
    '3. Create `data.js` with five attractions and multi-dimension scores.',
    '4. Implement sorting and animated score bars in plain JavaScript.',
    '',
    '## Todos',
    '- Create `index.html` shell',
    '- Add `style.css` theme',
    '- Define mock attraction dataset',
    '- Wire ranking interactions',
  ].join('\n');

  return [
    { label: 'heartbeat_1', frame: buildAgentHeartbeatFrame() },
    { label: 'step_started_1', frame: buildAgentStepStartedFrame(1) },
    { label: 'thinking_ask', frame: buildAgentThinkingDeltaFrame('Mock plan flow: ask, explore, then create the plan card.') },
    { label: 'partial_ask', frame: buildAgentPartialToolCallFrame('AskQuestion', { title: 'Clarify scope' }, askIds.callId, askIds.modelCallId) },
    { label: 'started_ask', frame: buildAgentToolCallStartedFrame('AskQuestion', { title: 'Clarify scope' }, askIds.callId, askIds.modelCallId) },
    {
      label: 'query_ask',
      frame: buildAgentAskQuestionQueryFrame({
        title: 'Clarify scope',
        questions: [
          {
            id: 'project_type',
            prompt: '你希望用什么技术栈来做这个页面？',
            options: [{ id: 'static', label: '纯静态 HTML/CSS/JS 页面' }],
          },
          {
            id: 'features',
            prompt: '你希望页面包含哪些功能？',
            options: [{ id: 'ranking', label: '热门景点排名列表（从夯到拉）' }],
          },
          {
            id: 'data_source',
            prompt: '景点数据来源方式？',
            options: [{ id: 'mock', label: '使用模拟数据（静态 JSON 示例数据）' }],
          },
        ],
      }, askIds.callId, 1),
    },
    {
      label: 'completed_ask',
      frame: buildCompleted('AskQuestion', { title: 'Clarify scope' }, {
        ok: true,
        tool: 'AskQuestion',
        args: { title: 'Clarify scope' },
        resultText: 'ask question answers=3',
        answers: [
          { questionId: 'project_type', selectedOptionIds: ['static'], freeformText: '' },
          { questionId: 'features', selectedOptionIds: ['ranking'], freeformText: '' },
          { questionId: 'data_source', selectedOptionIds: ['mock'], freeformText: '' },
        ],
        durationMs: 1,
      }, askIds),
    },
    { label: 'step_completed_1', frame: buildAgentStepCompletedFrame(1, 120) },
    { label: 'step_started_2', frame: buildAgentStepStartedFrame(2) },
    { label: 'thinking_explore', frame: buildAgentThinkingDeltaFrame('Mock plan flow: inspect project structure with real read-only tools before CreatePlan.') },
    { label: 'partial_ls', frame: buildAgentPartialToolCallFrame('Ls', { path: workspaceRoot }, lsIds.callId, lsIds.modelCallId) },
    { label: 'started_ls', frame: buildAgentToolCallStartedFrame('Ls', { path: workspaceRoot }, lsIds.callId, lsIds.modelCallId) },
    {
      label: 'exec_ls',
      frame: buildAgentExecLsFrame({
        id: lsIds.callId,
        execId: lsIds.callId,
        numericId: 1,
        toolCallId: lsIds.callId,
        path: workspaceRoot,
        ignore: ['node_modules'],
      }),
    },
    {
      label: 'completed_ls',
      frame: buildCompleted('Ls', { path: workspaceRoot }, {
        ok: true,
        tool: 'Ls',
        args: { path: workspaceRoot },
        resultText: [
          `ls success path=${workspaceRoot} files=2`,
          '[dir] src',
          '[file] package.json',
        ].join('\n'),
        durationMs: 1,
      }, lsIds),
    },
    {
      label: 'partial_glob_package',
      frame: buildAgentPartialToolCallFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'package.json',
      }, globPackageIds.callId, globPackageIds.modelCallId),
    },
    {
      label: 'started_glob_package',
      frame: buildAgentToolCallStartedFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'package.json',
      }, globPackageIds.callId, globPackageIds.modelCallId),
    },
    {
      label: 'completed_glob_package',
      frame: buildCompleted('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'package.json',
      }, {
        ok: true,
        tool: 'Glob',
        args: {
          target_directory: workspaceRoot,
          glob_pattern: 'package.json',
        },
        resultText: 'package.json',
        durationMs: 1,
      }, globPackageIds),
    },
    {
      label: 'partial_glob_index',
      frame: buildAgentPartialToolCallFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'index.html',
      }, globIndexIds.callId, globIndexIds.modelCallId),
    },
    {
      label: 'started_glob_index',
      frame: buildAgentToolCallStartedFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'index.html',
      }, globIndexIds.callId, globIndexIds.modelCallId),
    },
    {
      label: 'completed_glob_index',
      frame: buildCompleted('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'index.html',
      }, {
        ok: true,
        tool: 'Glob',
        args: {
          target_directory: workspaceRoot,
          glob_pattern: 'index.html',
        },
        resultText: 'No files matched "index.html" under E:\\project\\h5-test.',
        noMatches: true,
        durationMs: 1,
      }, globIndexIds),
    },
    {
      label: 'partial_glob_src',
      frame: buildAgentPartialToolCallFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'src/**',
      }, globSrcIds.callId, globSrcIds.modelCallId),
    },
    {
      label: 'started_glob_src',
      frame: buildAgentToolCallStartedFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'src/**',
      }, globSrcIds.callId, globSrcIds.modelCallId),
    },
    {
      label: 'completed_glob_src',
      frame: buildCompleted('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'src/**',
      }, {
        ok: true,
        tool: 'Glob',
        args: {
          target_directory: workspaceRoot,
          glob_pattern: 'src/**',
        },
        resultText: 'src/app.js\nsrc/data.js',
        durationMs: 1,
      }, globSrcIds),
    },
    {
      label: 'partial_glob_readme',
      frame: buildAgentPartialToolCallFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'README*',
      }, globReadmeIds.callId, globReadmeIds.modelCallId),
    },
    {
      label: 'started_glob_readme',
      frame: buildAgentToolCallStartedFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'README*',
      }, globReadmeIds.callId, globReadmeIds.modelCallId),
    },
    {
      label: 'completed_glob_readme',
      frame: buildCompleted('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'README*',
      }, {
        ok: true,
        tool: 'Glob',
        args: {
          target_directory: workspaceRoot,
          glob_pattern: 'README*',
        },
        resultText: 'No files matched "README*" under E:\\project\\h5-test.',
        noMatches: true,
        durationMs: 1,
      }, globReadmeIds),
    },
    { label: 'step_completed_2', frame: buildAgentStepCompletedFrame(2, 180) },
    { label: 'step_started_3', frame: buildAgentStepStartedFrame(3) },
    { label: 'thinking_plan', frame: buildAgentThinkingDeltaFrame('Mock plan flow: exploration finished, now emit CreatePlan and Build card state.') },
    { label: 'partial_plan', frame: buildAgentPartialToolCallFrame('CreatePlan', { name: 'Travel Ranking Landing Page' }, planIds.callId, planIds.modelCallId) },
    { label: 'started_plan', frame: buildAgentToolCallStartedFrame('CreatePlan', { name: 'Travel Ranking Landing Page' }, planIds.callId, planIds.modelCallId) },
    {
      label: 'query_plan',
      frame: buildAgentCreatePlanQueryFrame({
        name: 'Travel Ranking Landing Page',
        overview: 'Static travel ranking page with mock data and China-inspired visuals.',
        plan: planText,
        todos,
      }, planIds.callId, 2),
    },
    {
      label: 'completed_plan',
      frame: buildCompleted('CreatePlan', { name: 'Travel Ranking Landing Page' }, {
        ok: true,
        tool: 'CreatePlan',
        args: {
          name: 'Travel Ranking Landing Page',
          overview: 'Static travel ranking page with mock data and China-inspired visuals.',
          plan: planText,
          todos,
        },
        resultText: `Plan created at ${workspaceRoot}\\.cursor\\plans\\travel-ranking.plan.md`,
        planPath: `${workspaceRoot}\\.cursor\\plans\\travel-ranking.plan.md`,
        markdown: planText,
        durationMs: 1,
      }, planIds),
    },
    {
      label: 'checkpoint_plan',
      frame: buildAgentConversationCheckpointFrame({
        workspaceRoot,
        readPaths: [`${workspaceRoot}\\package.json`],
        pendingToolCalls: [],
        plan: planText,
        todos,
      }),
    },
    { label: 'step_completed_3', frame: buildAgentStepCompletedFrame(3, 220) },
    { label: 'turn_end', frame: buildAgentTurnEndedFrame() },
    { label: 'connect_end', frame: buildConnectEndFrame({ mock: true, scenario: 'plan-full' }) },
  ];
}

function buildPlanExploreTaskScenario() {
  const workspaceRoot = 'E:\\project\\h5-test';
  const frames = buildPlanFullScenario();
  const taskIds = toolIds('task_explore');
  const exploreFrames = [
    {
      label: 'partial_task_explore',
      frame: buildAgentPartialToolCallFrame('Task', {
        description: 'Explore project structure',
        prompt: 'Inspect the workspace structure and summarize the key files relevant to the requested landing page plan.',
        subagent_type: { explore: 'explore' },
      }, taskIds.callId, taskIds.modelCallId),
    },
    {
      label: 'started_task_explore',
      frame: buildAgentToolCallStartedFrame('Task', {
        description: 'Explore project structure',
        prompt: 'Inspect the workspace structure and summarize the key files relevant to the requested landing page plan.',
        subagent_type: { explore: 'explore' },
      }, taskIds.callId, taskIds.modelCallId),
    },
    {
      label: 'completed_task_explore',
      frame: buildCompleted('Task', {
        description: 'Explore project structure',
        prompt: 'Inspect the workspace structure and summarize the key files relevant to the requested landing page plan.',
        subagent_type: { explore: 'explore' },
      }, {
        ok: true,
        tool: 'Task',
        args: {
          description: 'Explore project structure',
          prompt: 'Inspect the workspace structure and summarize the key files relevant to the requested landing page plan.',
          subagent_type: { explore: 'explore' },
        },
        resultText: 'Explore task completed: Explore project structure.\nFound package.json and src/ modules relevant to the landing page plan.',
        conversationSteps: [
          {
            assistant_message: {
              text: 'Inspected the workspace and identified the files most relevant to planning: package.json plus src/app.js and src/data.js.',
            },
          },
        ],
        agentId: `explore-${Date.now().toString(36)}`,
        isBackground: false,
        durationMs: 1,
      }, taskIds),
    },
    {
      label: 'checkpoint_explore_task',
      frame: buildAgentConversationCheckpointFrame({
        workspaceRoot,
        readPaths: [
          `${workspaceRoot}\\package.json`,
          `${workspaceRoot}\\src\\app.js`,
          `${workspaceRoot}\\src\\data.js`,
        ],
      }),
    },
  ];
  const insertAt = frames.findIndex((entry) => entry.label === 'partial_ls');
  if (insertAt < 0) return frames;
  return [
    ...frames.slice(0, insertAt),
    ...exploreFrames,
    ...frames.slice(insertAt),
  ];
}

function buildExploreOnlyScenario() {
  const workspaceRoot = 'E:\\project\\h5-test';
  const taskIds = toolIds('task_explore');
  const lsIds = toolIds('ls');
  const globPackageIds = toolIds('glob_package');
  const globIndexIds = toolIds('glob_index');
  const globSrcIds = toolIds('glob_src');
  const globReadmeIds = toolIds('glob_readme');
  return [
    { label: 'heartbeat_1', frame: buildAgentHeartbeatFrame() },
    { label: 'step_started_1', frame: buildAgentStepStartedFrame(1) },
    { label: 'thinking_explore', frame: buildAgentThinkingDeltaFrame('Mock explore-only flow: try to surface the standalone exploration UI without Ask or Plan.') },
    {
      label: 'partial_task_explore',
      frame: buildAgentPartialToolCallFrame('Task', {
        description: 'Explore project structure',
        prompt: 'Inspect the workspace structure and summarize the key files relevant to the current task.',
        subagent_type: { explore: 'explore' },
      }, taskIds.callId, taskIds.modelCallId),
    },
    {
      label: 'started_task_explore',
      frame: buildAgentToolCallStartedFrame('Task', {
        description: 'Explore project structure',
        prompt: 'Inspect the workspace structure and summarize the key files relevant to the current task.',
        subagent_type: { explore: 'explore' },
      }, taskIds.callId, taskIds.modelCallId),
    },
    {
      label: 'completed_task_explore',
      frame: buildCompleted('Task', {
        description: 'Explore project structure',
        prompt: 'Inspect the workspace structure and summarize the key files relevant to the current task.',
        subagent_type: { explore: 'explore' },
      }, {
        ok: true,
        tool: 'Task',
        args: {
          description: 'Explore project structure',
          prompt: 'Inspect the workspace structure and summarize the key files relevant to the current task.',
          subagent_type: { explore: 'explore' },
        },
        resultText: 'Explore task completed: Explore project structure.\nFound package.json and src/ modules relevant to the current task.',
        conversationSteps: [
          {
            assistant_message: {
              text: 'Inspected the workspace and identified package.json, src/app.js, and src/data.js as the most relevant files.',
            },
          },
        ],
        agentId: `explore-${Date.now().toString(36)}`,
        isBackground: false,
        durationMs: 1,
      }, taskIds),
    },
    { label: 'partial_ls', frame: buildAgentPartialToolCallFrame('Ls', { path: workspaceRoot }, lsIds.callId, lsIds.modelCallId) },
    { label: 'started_ls', frame: buildAgentToolCallStartedFrame('Ls', { path: workspaceRoot }, lsIds.callId, lsIds.modelCallId) },
    {
      label: 'exec_ls',
      frame: buildAgentExecLsFrame({
        id: lsIds.callId,
        execId: lsIds.callId,
        numericId: 1,
        toolCallId: lsIds.callId,
        path: workspaceRoot,
        ignore: ['node_modules'],
      }),
    },
    {
      label: 'completed_ls',
      frame: buildCompleted('Ls', { path: workspaceRoot }, {
        ok: true,
        tool: 'Ls',
        args: { path: workspaceRoot },
        resultText: [
          `ls success path=${workspaceRoot} files=2`,
          '[dir] src',
          '[file] package.json',
        ].join('\n'),
        durationMs: 1,
      }, lsIds),
    },
    {
      label: 'partial_glob_package',
      frame: buildAgentPartialToolCallFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'package.json',
      }, globPackageIds.callId, globPackageIds.modelCallId),
    },
    {
      label: 'started_glob_package',
      frame: buildAgentToolCallStartedFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'package.json',
      }, globPackageIds.callId, globPackageIds.modelCallId),
    },
    {
      label: 'completed_glob_package',
      frame: buildCompleted('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'package.json',
      }, {
        ok: true,
        tool: 'Glob',
        args: {
          target_directory: workspaceRoot,
          glob_pattern: 'package.json',
        },
        resultText: 'package.json',
        durationMs: 1,
      }, globPackageIds),
    },
    {
      label: 'partial_glob_index',
      frame: buildAgentPartialToolCallFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'index.html',
      }, globIndexIds.callId, globIndexIds.modelCallId),
    },
    {
      label: 'started_glob_index',
      frame: buildAgentToolCallStartedFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'index.html',
      }, globIndexIds.callId, globIndexIds.modelCallId),
    },
    {
      label: 'completed_glob_index',
      frame: buildCompleted('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'index.html',
      }, {
        ok: true,
        tool: 'Glob',
        args: {
          target_directory: workspaceRoot,
          glob_pattern: 'index.html',
        },
        resultText: 'No files matched "index.html" under E:\\project\\h5-test.',
        noMatches: true,
        durationMs: 1,
      }, globIndexIds),
    },
    {
      label: 'partial_glob_src',
      frame: buildAgentPartialToolCallFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'src/**',
      }, globSrcIds.callId, globSrcIds.modelCallId),
    },
    {
      label: 'started_glob_src',
      frame: buildAgentToolCallStartedFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'src/**',
      }, globSrcIds.callId, globSrcIds.modelCallId),
    },
    {
      label: 'completed_glob_src',
      frame: buildCompleted('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'src/**',
      }, {
        ok: true,
        tool: 'Glob',
        args: {
          target_directory: workspaceRoot,
          glob_pattern: 'src/**',
        },
        resultText: 'src/app.js\nsrc/data.js',
        durationMs: 1,
      }, globSrcIds),
    },
    {
      label: 'partial_glob_readme',
      frame: buildAgentPartialToolCallFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'README*',
      }, globReadmeIds.callId, globReadmeIds.modelCallId),
    },
    {
      label: 'started_glob_readme',
      frame: buildAgentToolCallStartedFrame('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'README*',
      }, globReadmeIds.callId, globReadmeIds.modelCallId),
    },
    {
      label: 'completed_glob_readme',
      frame: buildCompleted('Glob', {
        target_directory: workspaceRoot,
        glob_pattern: 'README*',
      }, {
        ok: true,
        tool: 'Glob',
        args: {
          target_directory: workspaceRoot,
          glob_pattern: 'README*',
        },
        resultText: 'No files matched "README*" under E:\\project\\h5-test.',
        noMatches: true,
        durationMs: 1,
      }, globReadmeIds),
    },
    { label: 'step_completed_1', frame: buildAgentStepCompletedFrame(1, 180) },
    { label: 'turn_end', frame: buildAgentTurnEndedFrame() },
    { label: 'connect_end', frame: buildConnectEndFrame({ mock: true, scenario: 'explore-only' }) },
  ];
}

function buildMultitaskScenario() {
  const workspaceRoot = 'E:\\project\\CursorPool_Client_desktop';
  const taskExploreIds = toolIds('task_explore');
  const taskProtocolIds = toolIds('task_protocol');
  const taskUiIds = toolIds('task_ui');
  const createdTimestampMs = Date.now();
  const subagentExploreId = `multitask-explore-${createdTimestampMs.toString(36)}`;
  const subagentProtocolId = `multitask-protocol-${(createdTimestampMs + 1).toString(36)}`;
  const subagentUiId = `multitask-ui-${(createdTimestampMs + 2).toString(36)}`;
  const subagentReadPaths = {
    [subagentExploreId]: [
      'C:\\Users\\Administrator\\.cursorpool\\relay\\samples',
      `${workspaceRoot}\\skills\\cursor.md`,
    ],
    [subagentProtocolId]: [
      `${workspaceRoot}\\skills\\cursor.md`,
      `${workspaceRoot}\\js\\utils\\cursor-relay-protocol.js`,
    ],
    [subagentUiId]: [
      'D:\\cursor\\resources\\app\\out\\vs\\workbench\\workbench.desktop.main.js',
      `${workspaceRoot}\\html\\tab-advanced.html`,
      `${workspaceRoot}\\js\\modules\\proxy.js`,
    ],
  };

  const exploreArgs = {
    description: 'Explore sample traces',
    prompt: 'Inspect the local relay samples and summarize how parent request IDs and subagent-like follow-up requests appear linked in the captured traffic.',
    subagent_type: { explore: 'explore' },
  };
  const protocolArgs = {
    description: 'Trace task protocol',
    prompt: 'Inspect the local reverse-engineering notes and summarize how TaskInit, TaskSendMessage, and TaskProvideResult map to a parent agent spawning subagents.',
    subagent_type: { explore: 'explore' },
  };
  const uiArgs = {
    description: 'Draft multitask UI',
    prompt: 'Inspect the local workbench notes and summarize how a replica UI should distinguish manual New Agent from Task-based multitask fan-out.',
    subagent_type: { explore: 'explore' },
  };

  return [
    { label: 'heartbeat_1', frame: buildAgentHeartbeatFrame() },
    { label: 'step_started_1', frame: buildAgentStepStartedFrame(1) },
    {
      label: 'thinking_multitask',
      frame: buildAgentThinkingDeltaFrame('Mock multitask flow: clarify that manual New Agent is separate, then fan out three Task subagents and summarize their results back into the parent agent.'),
    },
    {
      label: 'text_intro',
      frame: buildAgentTextDeltaFrame('Mock Multitask scenario: manual New Agent is a separate UI entry. The frames below simulate the parent agent using Task to fan out parallel subagents and then backfeed a concise summary.'),
    },

    { label: 'partial_task_explore', frame: buildAgentPartialToolCallFrame('Task', exploreArgs, taskExploreIds.callId, taskExploreIds.modelCallId) },
    { label: 'started_task_explore', frame: buildAgentToolCallStartedFrame('Task', exploreArgs, taskExploreIds.callId, taskExploreIds.modelCallId) },
    { label: 'query_task_explore', frame: buildTaskInteractionQueryFrame(exploreArgs, taskExploreIds.callId, 1) },
    { label: 'partial_task_protocol', frame: buildAgentPartialToolCallFrame('Task', protocolArgs, taskProtocolIds.callId, taskProtocolIds.modelCallId) },
    { label: 'started_task_protocol', frame: buildAgentToolCallStartedFrame('Task', protocolArgs, taskProtocolIds.callId, taskProtocolIds.modelCallId) },
    { label: 'query_task_protocol', frame: buildTaskInteractionQueryFrame(protocolArgs, taskProtocolIds.callId, 2) },
    { label: 'partial_task_ui', frame: buildAgentPartialToolCallFrame('Task', uiArgs, taskUiIds.callId, taskUiIds.modelCallId) },
    { label: 'started_task_ui', frame: buildAgentToolCallStartedFrame('Task', uiArgs, taskUiIds.callId, taskUiIds.modelCallId) },
    { label: 'query_task_ui', frame: buildTaskInteractionQueryFrame(uiArgs, taskUiIds.callId, 3) },
    {
      label: 'checkpoint_multitask_active',
      frame: buildConversationCheckpointWithSubagentsFrame({
        mode: 1,
        workspaceRoot,
        usedTokens: 1432,
        maxTokens: 200000,
        readPaths: [
          `${workspaceRoot}\\scripts\\mock-cursor-agent-protocol-server.cjs`,
          `${workspaceRoot}\\js\\utils\\cursor-relay-protocol.js`,
          'D:\\cursor\\resources\\app\\out\\vs\\workbench\\workbench.desktop.main.js',
        ],
        subagentStates: {
          [subagentExploreId]: {
            createdTimestampMs,
            lastUsedTimestampMs: createdTimestampMs + 21,
            subagentType: { explore: {} },
            modelId: 'gpt-5',
            conversationState: {
              mode: 2,
              usedTokens: 54816,
              maxTokens: 200000,
              readPaths: subagentReadPaths[subagentExploreId],
            },
          },
          [subagentProtocolId]: {
            createdTimestampMs: createdTimestampMs + 1,
            lastUsedTimestampMs: createdTimestampMs + 32,
            subagentType: { explore: {} },
            modelId: 'gpt-5',
            conversationState: {
              mode: 2,
              usedTokens: 38112,
              maxTokens: 200000,
              readPaths: subagentReadPaths[subagentProtocolId],
            },
          },
          [subagentUiId]: {
            createdTimestampMs: createdTimestampMs + 2,
            lastUsedTimestampMs: createdTimestampMs + 44,
            subagentType: { explore: {} },
            modelId: 'gpt-5',
            conversationState: {
              mode: 2,
              usedTokens: 29504,
              maxTokens: 200000,
              readPaths: subagentReadPaths[subagentUiId],
            },
          },
        },
      }),
    },

    {
      label: 'completed_task_explore',
      frame: buildCompleted('Task', exploreArgs, {
        ok: true,
        tool: 'Task',
        args: exploreArgs,
        resultText: 'Subagent summary: the relay samples show linked request IDs, where a later request can carry the earlier parent request ID and continue the same higher-level objective.',
        conversationSteps: [
          {
            assistant_message: {
              text: 'Inspected relay samples. Observed a second request carrying the earlier request ID, which matches a parent task spawning or resuming a child flow rather than a totally separate conversation.',
            },
          },
        ],
        agentId: subagentExploreId,
        isBackground: false,
        durationMs: 1,
      }, taskExploreIds),
    },
    {
      label: 'completed_task_protocol',
      frame: buildCompleted('Task', protocolArgs, {
        ok: true,
        tool: 'Task',
        args: protocolArgs,
        resultText: 'Subagent summary: official Cursor task orchestration is centered on TaskInit, TaskSendMessage, and TaskProvideResult, which looks like the parent/child agent handoff protocol.',
        conversationSteps: [
          {
            assistant_message: {
              text: 'Inspected the task protocol notes. The child agent lifecycle appears to be created by TaskInit, advanced via TaskSendMessage, and summarized back via TaskProvideResult.',
            },
          },
        ],
        agentId: subagentProtocolId,
        isBackground: false,
        durationMs: 1,
      }, taskProtocolIds),
    },
    {
      label: 'completed_task_ui',
      frame: buildCompleted('Task', uiArgs, {
        ok: true,
        tool: 'Task',
        args: uiArgs,
        resultText: 'Subagent summary: the replica UI should separate manual New Agent sessions from Task-generated subagents, and show only Task results flowing back into the parent timeline.',
        conversationSteps: [
          {
            assistant_message: {
              text: 'Drafted the replica UI shape: one section for manual New Agent sessions, one section for active Task subagents, and a parent summary area that only ingests Task results.',
            },
          },
        ],
        agentId: subagentUiId,
        isBackground: false,
        durationMs: 1,
      }, taskUiIds),
    },
    {
      label: 'checkpoint_multitask',
      frame: buildConversationCheckpointWithSubagentsFrame({
        mode: 1,
        workspaceRoot,
        usedTokens: 2118,
        maxTokens: 200000,
        readPaths: [
          `${workspaceRoot}\\scripts\\mock-cursor-agent-protocol-server.cjs`,
          `${workspaceRoot}\\js\\utils\\cursor-relay-protocol.js`,
          `${workspaceRoot}\\html\\tab-advanced.html`,
          `${workspaceRoot}\\js\\modules\\proxy.js`,
          'C:\\Users\\Administrator\\.cursorpool\\relay\\samples',
          'D:\\cursor\\resources\\app\\out\\vs\\workbench\\workbench.desktop.main.js',
        ],
        subagentStates: {
          [subagentExploreId]: {
            createdTimestampMs,
            lastUsedTimestampMs: createdTimestampMs + 90,
            subagentType: { explore: {} },
            modelId: 'gpt-5',
            conversationState: {
              mode: 2,
              usedTokens: 55392,
              maxTokens: 200000,
              readPaths: subagentReadPaths[subagentExploreId],
            },
          },
          [subagentProtocolId]: {
            createdTimestampMs: createdTimestampMs + 1,
            lastUsedTimestampMs: createdTimestampMs + 96,
            subagentType: { explore: {} },
            modelId: 'gpt-5',
            conversationState: {
              mode: 2,
              usedTokens: 38704,
              maxTokens: 200000,
              readPaths: subagentReadPaths[subagentProtocolId],
            },
          },
          [subagentUiId]: {
            createdTimestampMs: createdTimestampMs + 2,
            lastUsedTimestampMs: createdTimestampMs + 104,
            subagentType: { explore: {} },
            modelId: 'gpt-5',
            conversationState: {
              mode: 2,
              usedTokens: 30144,
              maxTokens: 200000,
              readPaths: subagentReadPaths[subagentUiId],
            },
          },
        },
      }),
    },
    { label: 'step_completed_1', frame: buildAgentStepCompletedFrame(1, 240) },
    { label: 'step_started_2', frame: buildAgentStepStartedFrame(2) },
    {
      label: 'text_summary',
      frame: buildAgentTextDeltaFrame(
        [
          'Parent agent summary:',
          '- Manual New Agent is a separate UI action for opening a standalone agent conversation.',
          '- Multitask is better modeled as the parent agent issuing multiple Task calls in parallel.',
          '- Each Task returns a compact result, and the parent agent is the one that synthesizes those results into the final answer.',
        ].join('\n'),
      ),
    },
    { label: 'token', frame: buildAgentTokenDeltaFrame(22) },
    { label: 'step_completed_2', frame: buildAgentStepCompletedFrame(2, 120) },
    { label: 'turn_end', frame: buildAgentTurnEndedFrame() },
    { label: 'connect_end', frame: buildConnectEndFrame({ mock: true, scenario: 'multitask' }) },
  ];
}

function buildEditStreamScenario(options = {}) {
  const filePath = 'mock-login.html';
  const beforeContent = '<!-- before -->\n';
  const afterContent = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>Mock Login</title>',
    '  <style>',
    '    body { font-family: Arial, sans-serif; display: grid; place-items: center; min-height: 100vh; }',
    '    form { width: 320px; display: grid; gap: 12px; }',
    '    input, button { padding: 10px; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <form>',
    '    <h1>Login</h1>',
    '    <input type="email" placeholder="Email">',
    '    <input type="password" placeholder="Password">',
    '    <button>Sign in</button>',
    '  </form>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  const ids = toolIds('edit');
  const frames = [
    { label: 'step_started:edit', frame: buildAgentStepStartedFrame(1) },
    { label: 'thinking:edit', frame: buildAgentThinkingDeltaFrame('Mock protocol: streaming Edit tool.') },
    { label: 'partial_edit_empty', frame: buildAgentPartialToolCallFrame('Write', {}, ids.callId, ids.modelCallId) },
    { label: 'partial_edit_path', frame: buildAgentPartialToolCallFrame('Write', { path: filePath }, ids.callId, ids.modelCallId) },
    { label: 'tool_started:edit', frame: buildAgentToolCallStartedFrame('Write', { path: filePath }, ids.callId, ids.modelCallId) },
  ];
  for (const [index, chunk] of chunkText(afterContent, 180).entries()) {
    frames.push({
      label: `edit_delta_${index + 1}`,
      frame: buildAgentEditToolCallDeltaFrame(chunk, ids.callId, ids.modelCallId),
    });
  }
  if (options.nativeExec) {
    frames.push({
      label: 'exec_write',
      frame: buildAgentExecWriteFrame({
        id: ids.callId,
        execId: ids.callId,
        numericId: 1,
        toolCallId: ids.callId,
        path: filePath,
        fileText: afterContent,
      }),
    });
  }
  frames.push(
    {
      label: 'tool_completed:edit',
      frame: buildCompleted('Write', { path: filePath }, {
        ok: true,
        resultText: 'Mock edit completed.',
        beforeContent,
        afterContent,
        diffString: makeEditDiff(filePath, beforeContent, afterContent),
        linesAdded: afterContent.split(/\r?\n/).length,
        linesRemoved: beforeContent.split(/\r?\n/).length,
        message: 'Mock edit completed.',
        args: { path: filePath },
      }, ids),
    },
    { label: 'step_completed:edit', frame: buildAgentStepCompletedFrame(1, 900) },
    { label: 'text_final', frame: buildAgentTextDeltaFrame('Mock edit stream finished.') },
    { label: 'token', frame: buildAgentTokenDeltaFrame(1) },
    { label: 'turn_end', frame: buildAgentTurnEndedFrame() },
    { label: 'connect_end', frame: buildConnectEndFrame({ mock: true }) },
  );
  return frames;
}

function buildAllToolsScenario(options = {}) {
  const frames = [
    { label: 'heartbeat', frame: buildAgentHeartbeatFrame() },
    { label: 'step_started:read', frame: buildAgentStepStartedFrame(1) },
    { label: 'thinking:read', frame: buildAgentThinkingDeltaFrame('Mock protocol: Read -> Grep -> LS -> Shell -> Edit -> Diagnostics.') },
  ];

  const readIds = toolIds('read');
  frames.push(
    { label: 'partial_read', frame: buildAgentPartialToolCallFrame('Read', { path: 'mock-login.html' }, readIds.callId, readIds.modelCallId) },
    { label: 'started_read', frame: buildAgentToolCallStartedFrame('Read', { path: 'mock-login.html', offset: 0, limit: 200 }, readIds.callId, readIds.modelCallId) },
  );
  if (options.nativeExec) {
    frames.push({
      label: 'exec_read',
      frame: buildAgentExecReadFrame({ id: readIds.callId, execId: readIds.callId, numericId: 1, toolCallId: readIds.callId, path: 'mock-login.html', offset: 0, limit: 200 }),
    });
  }
  frames.push({
    label: 'completed_read',
    frame: buildCompleted('Read', { path: 'mock-login.html' }, {
      ok: true,
      resultText: '<form><input placeholder="Email"><button>Login</button></form>',
      args: { path: 'mock-login.html' },
    }, readIds),
  });

  const grepIds = toolIds('grep');
  frames.push(
    { label: 'partial_grep', frame: buildAgentPartialToolCallFrame('Grep', { pattern: 'Login', path: '.' }, grepIds.callId, grepIds.modelCallId) },
    { label: 'started_grep', frame: buildAgentToolCallStartedFrame('Grep', { pattern: 'Login', path: '.', output_mode: 'content' }, grepIds.callId, grepIds.modelCallId) },
  );
  if (options.nativeExec) {
    frames.push({
      label: 'exec_grep',
      frame: buildAgentExecGrepFrame({ id: grepIds.callId, execId: grepIds.callId, numericId: 2, toolCallId: grepIds.callId, pattern: 'Login', path: '.', outputMode: 'content' }),
    });
  }
  frames.push({
    label: 'completed_grep',
    frame: buildCompleted('Grep', { pattern: 'Login', path: '.', output_mode: 'content' }, {
      ok: true,
      resultText: 'mock-login.html:<h1>Login</h1>',
      args: { pattern: 'Login', path: '.' },
    }, grepIds),
  });

  const lsIds = toolIds('ls');
  frames.push(
    { label: 'partial_ls', frame: buildAgentPartialToolCallFrame('LS', { path: '.' }, lsIds.callId, lsIds.modelCallId) },
    { label: 'started_ls', frame: buildAgentToolCallStartedFrame('LS', { path: '.', ignore: ['node_modules'] }, lsIds.callId, lsIds.modelCallId) },
  );
  if (options.nativeExec) {
    frames.push({
      label: 'exec_ls',
      frame: buildAgentExecLsFrame({ id: lsIds.callId, execId: lsIds.callId, numericId: 3, toolCallId: lsIds.callId, path: '.', ignore: ['node_modules'] }),
    });
  }
  frames.push({
    label: 'completed_ls',
    frame: buildCompleted('LS', { path: '.', ignore: ['node_modules'] }, {
      ok: true,
      resultText: '[file] mock-login.html\n[file] package.json',
      args: { path: '.' },
    }, lsIds),
  });

  const shellIds = toolIds('shell');
  frames.push(
    { label: 'partial_shell', frame: buildAgentPartialToolCallFrame('Shell', { command: 'npm test -- --mock' }, shellIds.callId, shellIds.modelCallId) },
    { label: 'started_shell', frame: buildAgentToolCallStartedFrame('Shell', { command: 'npm test -- --mock', cwd: '.' }, shellIds.callId, shellIds.modelCallId) },
  );
  if (options.nativeExec) {
    frames.push({
      label: 'exec_shell',
      frame: buildAgentExecShellStreamFrame({ id: shellIds.callId, execId: shellIds.callId, numericId: 4, toolCallId: shellIds.callId, command: 'npm test -- --mock', workingDirectory: '.', description: 'Mock shell command' }),
    });
  }
  frames.push({
    label: 'completed_shell',
    frame: buildCompleted('Shell', { command: 'npm test -- --mock', cwd: '.' }, {
      ok: true,
      resultText: 'mock tests passed',
      args: { command: 'npm test -- --mock', cwd: '.' },
    }, shellIds),
  });

  frames.push(...buildEditStreamScenario(options).filter((entry) => !['connect_end', 'turn_end', 'text_final', 'token'].includes(entry.label)));

  const diagIds = toolIds('diagnostics');
  frames.push(
    { label: 'partial_diagnostics', frame: buildAgentPartialToolCallFrame('ReadLints', { paths: ['mock-login.html'] }, diagIds.callId, diagIds.modelCallId) },
    { label: 'started_diagnostics', frame: buildAgentToolCallStartedFrame('ReadLints', { paths: ['mock-login.html'] }, diagIds.callId, diagIds.modelCallId) },
  );
  if (options.nativeExec) {
    frames.push({
      label: 'exec_diagnostics',
      frame: buildAgentExecDiagnosticsFrame({ id: diagIds.callId, execId: diagIds.callId, numericId: 5, toolCallId: diagIds.callId, path: 'mock-login.html' }),
    });
  }
  frames.push(
    {
      label: 'completed_diagnostics',
      frame: buildCompleted('ReadLints', { paths: ['mock-login.html'] }, {
        ok: true,
        resultText: 'diagnostics success count=0',
        diagnosticCount: 0,
        args: { paths: ['mock-login.html'] },
      }, diagIds),
    },
    { label: 'step_completed:all', frame: buildAgentStepCompletedFrame(1, 1800) },
    { label: 'text_final', frame: buildAgentTextDeltaFrame('Mock all-tools scenario finished.') },
    { label: 'token', frame: buildAgentTokenDeltaFrame(1) },
    { label: 'turn_end', frame: buildAgentTurnEndedFrame() },
    { label: 'connect_end', frame: buildConnectEndFrame({ mock: true }) },
  );
  return frames;
}

function buildFileOpsScenario(options = {}) {
  const createPath = 'mock-created.html';
  const deletePath = 'mock-delete-me.txt';
  const createdContent = [
    '<!doctype html>',
    '<html>',
    '<body>',
    '  <main>Created by mock protocol</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  const editedContent = createdContent.replace('Created by mock protocol', 'Edited by mock protocol');
  const deleteContent = 'temporary mock file\nsecond line\n';
  const frames = [
    { label: 'heartbeat', frame: buildAgentHeartbeatFrame() },
    { label: 'step_started:file_ops', frame: buildAgentStepStartedFrame(1) },
    { label: 'thinking:file_ops', frame: buildAgentThinkingDeltaFrame('Mock protocol: create, edit, and delete files.') },
  ];

  const createIds = toolIds('create');
  frames.push(
    { label: 'partial_create', frame: buildAgentPartialToolCallFrame('Write', { path: createPath }, createIds.callId, createIds.modelCallId) },
    { label: 'started_create', frame: buildAgentToolCallStartedFrame('Write', { path: createPath }, createIds.callId, createIds.modelCallId) },
    { label: 'delta_create', frame: buildAgentEditToolCallDeltaFrame(createdContent, createIds.callId, createIds.modelCallId) },
  );
  if (options.nativeExec) {
    frames.push({
      label: 'exec_create',
      frame: buildAgentExecWriteFrame({ id: createIds.callId, execId: createIds.callId, numericId: 1, toolCallId: createIds.callId, path: createPath, fileText: createdContent }),
    });
  }
  frames.push({
    label: 'completed_create',
    frame: buildCompleted('Write', { path: createPath }, {
      ok: true,
      resultText: 'Mock create completed.',
      beforeContent: '',
      afterContent: createdContent,
      diffString: makeEditDiff(createPath, '', createdContent),
      linesAdded: createdContent.split(/\r?\n/).length,
      linesRemoved: 0,
      fileSize: Buffer.byteLength(createdContent, 'utf8'),
      message: 'Mock create completed.',
      args: { path: createPath },
    }, createIds),
  });

  const editIds = toolIds('patch_edit');
  frames.push(
    { label: 'partial_edit_existing', frame: buildAgentPartialToolCallFrame('PatchEdit', { path: createPath }, editIds.callId, editIds.modelCallId) },
    { label: 'started_edit_existing', frame: buildAgentToolCallStartedFrame('PatchEdit', { path: createPath }, editIds.callId, editIds.modelCallId) },
    { label: 'delta_edit_existing', frame: buildAgentEditToolCallDeltaFrame(editedContent, editIds.callId, editIds.modelCallId) },
    {
      label: 'completed_edit_existing',
      frame: buildCompleted('PatchEdit', { path: createPath }, {
        ok: true,
        resultText: 'Mock edit completed.',
        beforeContent: createdContent,
        afterContent: editedContent,
        diffString: makeEditDiff(createPath, createdContent, editedContent),
        linesAdded: editedContent.split(/\r?\n/).length,
        linesRemoved: createdContent.split(/\r?\n/).length,
        fileSize: Buffer.byteLength(editedContent, 'utf8'),
        message: 'Mock edit completed.',
        args: { path: createPath },
      }, editIds),
    },
  );

  const deleteIds = toolIds('delete');
  frames.push(
    { label: 'partial_delete', frame: buildAgentPartialToolCallFrame('Delete', { path: deletePath }, deleteIds.callId, deleteIds.modelCallId) },
    { label: 'started_delete', frame: buildAgentToolCallStartedFrame('Delete', { path: deletePath }, deleteIds.callId, deleteIds.modelCallId) },
  );
  if (options.nativeExec) {
    frames.push({
      label: 'exec_delete',
      frame: buildAgentExecDeleteFrame({ id: deleteIds.callId, execId: deleteIds.callId, numericId: 2, toolCallId: deleteIds.callId, path: deletePath }),
    });
  }
  frames.push(
    {
      label: 'completed_delete',
      frame: buildCompleted('Delete', { path: deletePath }, {
        ok: true,
        resultText: 'Mock delete completed.',
        beforeContent: deleteContent,
        prevContent: deleteContent,
        afterContent: '',
        deletedFile: deletePath,
        fileSize: Buffer.byteLength(deleteContent, 'utf8'),
        args: { path: deletePath },
      }, deleteIds),
    },
    { label: 'step_completed:file_ops', frame: buildAgentStepCompletedFrame(1, 1600) },
    { label: 'text_final', frame: buildAgentTextDeltaFrame('Mock file operations finished.') },
    { label: 'token', frame: buildAgentTokenDeltaFrame(1) },
    { label: 'turn_end', frame: buildAgentTurnEndedFrame() },
    { label: 'connect_end', frame: buildConnectEndFrame({ mock: true }) },
  );
  return frames;
}

function buildComplexMultifileScenario(options = {}) {
  const pagePath = 'src/pages/RegisterPage.jsx';
  const apiPath = 'src/api/register.js';
  const routePath = 'src/router.js';
  const deletePath = 'tmp/register-draft.txt';
  const pageContent = [
    'import { registerUser } from "../api/register";',
    '',
    'export function RegisterPage() {',
    '  return <form className="register-page">',
    '    <input name="email" placeholder="Email" />',
    '    <input name="password" type="password" placeholder="Password" />',
    '    <button type="submit">Create account</button>',
    '  </form>;',
    '}',
    '',
  ].join('\n');
  const apiContent = [
    'export async function registerUser(payload) {',
    '  const response = await fetch("/api/register", {',
    '    method: "POST",',
    '    headers: { "Content-Type": "application/json" },',
    '    body: JSON.stringify(payload),',
    '  });',
    '  if (!response.ok) throw new Error("Registration failed");',
    '  return response.json();',
    '}',
    '',
  ].join('\n');
  const routeBefore = 'export const routes = [];\n';
  const routeAfter = 'import { RegisterPage } from "./pages/RegisterPage";\n\nexport const routes = [{ path: "/register", component: RegisterPage }];\n';
  const deleteContent = 'old register draft\n';
  const frames = [
    { label: 'heartbeat', frame: buildAgentHeartbeatFrame() },
    { label: 'step_started:complex', frame: buildAgentStepStartedFrame(1) },
    { label: 'thinking:complex', frame: buildAgentThinkingDeltaFrame('Mock protocol: inspect project, create frontend and API files, update route, delete draft, run checks.') },
  ];
  let numericId = 1;
  const addSimpleTool = (label, toolName, args, resultText, execBuilder = null, execArgs = {}) => {
    const ids = toolIds(label);
    frames.push(
      { label: `partial_${label}`, frame: buildAgentPartialToolCallFrame(toolName, args, ids.callId, ids.modelCallId) },
      { label: `started_${label}`, frame: buildAgentToolCallStartedFrame(toolName, args, ids.callId, ids.modelCallId) },
    );
    if (options.nativeExec && execBuilder) {
      frames.push({
        label: `exec_${label}`,
        frame: execBuilder({ id: ids.callId, execId: ids.callId, numericId: numericId++, toolCallId: ids.callId, ...execArgs }),
      });
    }
    frames.push({
      label: `completed_${label}`,
      frame: buildCompleted(toolName, args, {
        ok: true,
        resultText,
        args,
      }, ids),
    });
  };
  const addEditTool = (label, toolName, filePath, beforeContent, afterContent) => {
    const ids = toolIds(label);
    frames.push(
      { label: `partial_${label}`, frame: buildAgentPartialToolCallFrame(toolName, { path: filePath }, ids.callId, ids.modelCallId) },
      { label: `started_${label}`, frame: buildAgentToolCallStartedFrame(toolName, { path: filePath }, ids.callId, ids.modelCallId) },
      { label: `delta_${label}`, frame: buildAgentEditToolCallDeltaFrame(afterContent, ids.callId, ids.modelCallId) },
    );
    if (options.nativeExec) {
      frames.push({
        label: `exec_${label}`,
        frame: buildAgentExecWriteFrame({ id: ids.callId, execId: ids.callId, numericId: numericId++, toolCallId: ids.callId, path: filePath, fileText: afterContent }),
      });
    }
    frames.push({
      label: `completed_${label}`,
      frame: buildCompleted(toolName, { path: filePath }, {
        ok: true,
        resultText: `Mock ${label} completed.`,
        beforeContent,
        afterContent,
        diffString: makeEditDiff(filePath, beforeContent, afterContent),
        linesAdded: Math.max(0, afterContent.split(/\r?\n/).length - beforeContent.split(/\r?\n/).length),
        linesRemoved: Math.max(0, beforeContent.split(/\r?\n/).length - afterContent.split(/\r?\n/).length),
        fileSize: Buffer.byteLength(afterContent, 'utf8'),
        message: `Mock ${label} completed.`,
        args: { path: filePath },
      }, ids),
    });
  };

  addSimpleTool('read_package', 'Read', { path: 'package.json', offset: 0, limit: 120 }, '{"scripts":{"test":"vite --version"}}', buildAgentExecReadFrame, { path: 'package.json', offset: 0, limit: 120 });
  addSimpleTool('ls_src', 'LS', { path: 'src', ignore: ['node_modules'] }, '[dir] pages\n[dir] api\n[file] router.js', buildAgentExecLsFrame, { path: 'src', ignore: ['node_modules'] });
  addSimpleTool('grep_register', 'Grep', { pattern: 'register', path: 'src', output_mode: 'content' }, 'src/router.js:export const routes = [];', buildAgentExecGrepFrame, { pattern: 'register', path: 'src', outputMode: 'content' });
  addEditTool('create_page', 'Write', pagePath, '', pageContent);
  addEditTool('create_api', 'Write', apiPath, '', apiContent);
  addEditTool('update_route', 'PatchEdit', routePath, routeBefore, routeAfter);

  const deleteIds = toolIds('delete_draft');
  frames.push(
    { label: 'partial_delete_draft', frame: buildAgentPartialToolCallFrame('Delete', { path: deletePath }, deleteIds.callId, deleteIds.modelCallId) },
    { label: 'started_delete_draft', frame: buildAgentToolCallStartedFrame('Delete', { path: deletePath }, deleteIds.callId, deleteIds.modelCallId) },
    {
      label: 'completed_delete_draft',
      frame: buildCompleted('Delete', { path: deletePath }, {
        ok: true,
        resultText: 'Mock delete draft completed.',
        beforeContent: deleteContent,
        prevContent: deleteContent,
        afterContent: '',
        deletedFile: deletePath,
        fileSize: Buffer.byteLength(deleteContent, 'utf8'),
        args: { path: deletePath },
      }, deleteIds),
    },
  );
  addSimpleTool('shell_test', 'Shell', { command: 'npm test -- --runInBand', cwd: '.' }, 'mock tests passed', buildAgentExecShellStreamFrame, { command: 'npm test -- --runInBand', workingDirectory: '.', description: 'Mock test command' });
  addSimpleTool('read_lints', 'ReadLints', { paths: [pagePath, apiPath, routePath] }, 'diagnostics success count=0', buildAgentExecDiagnosticsFrame, { path: pagePath });

  frames.push(
    { label: 'step_completed:complex', frame: buildAgentStepCompletedFrame(1, 3200) },
    { label: 'text_final', frame: buildAgentTextDeltaFrame('Mock complex multi-file task finished.') },
    { label: 'token', frame: buildAgentTokenDeltaFrame(1) },
    { label: 'turn_end', frame: buildAgentTurnEndedFrame() },
    { label: 'connect_end', frame: buildConnectEndFrame({ mock: true }) },
  );
  return frames;
}

function buildScenario(name, options = {}) {
  const scenario = String(name || '').trim().toLowerCase();
  if (scenario === 'minimal') return buildMinimalScenario(options);
  if (scenario === 'plan-full') return buildPlanFullScenario(options);
  if (scenario === 'plan-explore-task') return buildPlanExploreTaskScenario(options);
  if (scenario === 'explore-only') return buildExploreOnlyScenario(options);
  if (scenario === 'multitask') return buildMultitaskScenario(options);
  if (scenario === 'edit-stream') return buildEditStreamScenario(options);
  if (scenario === 'file-ops') return buildFileOpsScenario(options);
  if (scenario === 'complex-multifile') return buildComplexMultifileScenario(options);
  return buildAllToolsScenario(options);
}

function requestIdFromRunSseBody(body) {
  const decoded = decodeRunSseRequestId(body);
  return decoded || `mock-${Date.now().toString(36)}`;
}

function requestIdFromBidiBody(body) {
  try {
    const decoded = decodeBidiAppendRequest(body);
    return decoded || { requestId: '', kind: 'unknown', userText: '' };
  } catch (error) {
    return { requestId: '', kind: 'decode_error', userText: '', error: error.message };
  }
}

function writeFrame(session, entry, state) {
  if (!session || session.done || session.res.destroyed) return;
  const buffer = Buffer.from(entry.frame || []);
  if (!buffer.length) return;
  session.chunks.push(buffer);
  session.labels.push(entry.label || 'frame');
  try {
    session.res.write(buffer);
    session.res.flush?.();
    console.log(`[mock-agent] sent requestId=${session.requestId} label=${entry.label || '-'} bytes=${buffer.length}`);
  } catch (error) {
    session.done = true;
    console.error(`[mock-agent] write failed requestId=${session.requestId}: ${error.message}`);
  }
  if (entry.label === 'connect_end') {
    session.done = true;
    setTimeout(() => {
      try {
        session.res.end();
      } catch {
        /* ignore */
      }
      const body = Buffer.concat(session.chunks);
      const summary = summarizeAgentServerStream(body, { maxSamples: 6 });
  console.log(`[mock-agent] completed requestId=${session.requestId} labels=${session.labels.join(',')} summary=${JSON.stringify(summary.interactionUpdates)}`);
      state.sessions.delete(session.requestId);
      if (state.options.once) {
        console.log('[mock-agent] --once completed; press Ctrl+C if the process is still open.');
      }
    }, 30);
  }
}

function encodeVarint(value) {
  const out = [];
  let n = Number(value) >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function concatBytes(parts) {
  return Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
}

function encodeBytesField(field, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return concatBytes([
    encodeVarint((field << 3) | 2),
    encodeVarint(payload.length),
    payload,
  ]);
}

function encodeMessage(fields) {
  return concatBytes(fields.map((field) => encodeBytesField(field.field, field.value)));
}

function buildAgentBidiAppendPayload(requestId, userText) {
  const userMessage = encodeMessage([{ field: 1, value: userText }]);
  const userAction = encodeMessage([{ field: 1, value: userMessage }]);
  const conversationAction = encodeMessage([{ field: 1, value: userAction }]);
  const runRequest = encodeMessage([{ field: 2, value: conversationAction }]);
  const agentPayload = encodeMessage([{ field: 1, value: runRequest }]);
  const requestIdMessage = encodeMessage([{ field: 1, value: requestId }]);
  return encodeMessage([
    { field: 1, value: agentPayload },
    { field: 2, value: requestIdMessage },
  ]);
}

function createProxyTlsConnection(proxyPort, targetHost = 'api2.cursor.sh') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let settled = false;
    let headerBuffer = Buffer.alloc(0);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        reject(error);
      } else {
        resolve(value);
      }
    };
    socket.setTimeout(5000, () => finish(new Error('CONNECT timeout')));
    socket.on('connect', () => {
      socket.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      headerBuffer = Buffer.concat([headerBuffer, Buffer.from(chunk)]);
      const endIndex = headerBuffer.indexOf('\r\n\r\n');
      if (endIndex < 0) return;
      const headerText = headerBuffer.subarray(0, endIndex).toString('utf8');
      const statusLine = headerText.split(/\r?\n/, 1)[0] || '';
      if (!/^HTTP\/1\.[01] 200\b/i.test(statusLine)) {
        finish(new Error(`Proxy CONNECT failed: ${statusLine || headerText}`));
        return;
      }
      const rest = headerBuffer.subarray(endIndex + 4);
      socket.removeAllListeners('data');
      if (rest.length) socket.unshift(rest);
      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      });
      tlsSocket.on('secureConnect', () => finish(null, tlsSocket));
      tlsSocket.on('error', (error) => finish(error));
      socket.on('error', () => {
        /* TLS socket owns errors after CONNECT has been established. */
      });
    });
    socket.on('error', (error) => finish(error));
  });
}

function postViaMockProxy({ port, pathname, body, headers = {}, targetHost = 'api2.cursor.sh' }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: targetHost,
      port: 443,
      method: 'POST',
      path: pathname,
      createConnection: (_options, callback) => {
        createProxyTlsConnection(port, targetHost).then(
          (socket) => callback(null, socket),
          (error) => callback(error),
        );
      },
      headers: {
        Host: targetHost,
        'Content-Length': body.length,
        ...headers,
      },
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        statusCode: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function openRunSseViaMockProxy({ port, requestId, targetHost = 'api2.cursor.sh', timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ requestId }), 'utf8');
    const req = https.request({
      hostname: targetHost,
      port: 443,
      method: 'POST',
      path: '/agent.v1.AgentService/RunSSE',
      createConnection: (_options, callback) => {
        createProxyTlsConnection(port, targetHost).then(
          (socket) => callback(null, socket),
          (error) => callback(error),
        );
      },
      headers: {
        Host: targetHost,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
      rejectUnauthorized: false,
    });
    let timer = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      if (error) reject(error);
      else resolve(value);
    };
    req.on('response', (res) => {
      const chunks = [];
      timer = setTimeout(() => finish(new Error('RunSSE self-test timeout')), timeoutMs);
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => finish(null, {
        statusCode: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', (error) => finish(error));
    req.write(body);
    req.end();
  });
}

async function runSelfTest(options) {
  const started = await startProxy(options);
  try {
    const requestId = crypto.randomUUID();
    const runSsePromise = openRunSseViaMockProxy({ port: options.port, requestId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bidi = await postViaMockProxy({
      port: options.port,
      pathname: '/aiserver.v1.BidiService/BidiAppend',
      body: buildAgentBidiAppendPayload(requestId, 'mock self-test'),
      headers: { 'Content-Type': 'application/proto' },
    });
    const runSse = await runSsePromise;
    const summary = summarizeAgentServerStream(runSse.body, { maxSamples: 12 });
    const interaction = summary.interactionUpdates || {};
    const ok = runSse.statusCode === 200
      && bidi.statusCode === 200
      && Number(interaction.tool_call_started || interaction.toolCallStarted || 0) > 0
      && Number(interaction.tool_call_delta || interaction.toolCallDelta || 0) > 0
      && Number(interaction.tool_call_completed || interaction.toolCallCompleted || 0) > 0;
    console.log(JSON.stringify({
      ok,
      requestId,
      runSseStatus: runSse.statusCode,
      bidiStatus: bidi.statusCode,
      bytes: runSse.body.length,
      serverMessages: summary.serverMessages,
      interactionUpdates: interaction,
      samples: summary.samples,
    }, null, 2));
    if (!ok) throw new Error('mock self-test did not observe expected tool frames');
  } finally {
    started.proxyServer.close();
    started.tlsServer.close();
  }
}

function startScenario(session, state) {
  if (!session || session.started) return;
  session.started = true;
  const frames = buildScenario(state.options.scenario, state.options);
  console.log(`[mock-agent] scenario start requestId=${session.requestId} scenario=${state.options.scenario} frames=${frames.length} nativeExec=${state.options.nativeExec ? '1' : '0'}`);
  frames.forEach((entry, index) => {
    setTimeout(() => writeFrame(session, entry, state), index * state.options.delayMs);
  });
}

async function handleRunSse(req, res, state) {
  const body = await readRequestBody(req);
  const requestId = requestIdFromRunSseBody(body);
  console.log(`[mock-agent] RunSSE open requestId=${requestId} rawLen=${body.length} frames=${JSON.stringify(summarizeConnectFrames(body).frames || [])}`);
  safeWriteHead(res, 200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connect-Protocol-Version': '1',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const session = {
    requestId,
    res,
    chunks: [],
    labels: [],
    started: false,
    done: false,
  };
  state.sessions.set(requestId, session);
  res.on('close', () => {
    if (!session.done) {
      session.done = true;
      state.sessions.delete(requestId);
      console.log(`[mock-agent] RunSSE closed requestId=${requestId}`);
    }
  });
  const pending = state.pendingUserMessages.get(requestId);
  if (pending) {
    state.pendingUserMessages.delete(requestId);
    startScenario(session, state);
  }
}

async function handleBidiAppend(req, res, state) {
  const body = await readRequestBody(req);
  const decoded = requestIdFromBidiBody(body);
  console.log(`[mock-agent] BidiAppend kind=${decoded.kind || '-'} requestId=${decoded.requestId || '-'} text=${JSON.stringify(String(decoded.userText || '').slice(0, 120))}`);
  writeProtoAck(res);
  if (decoded.kind === 'user_message' && decoded.requestId) {
    const session = state.sessions.get(decoded.requestId);
    if (session) startScenario(session, state);
    else state.pendingUserMessages.set(decoded.requestId, decoded);
  }
}

async function handleTlsRequest(req, res, state) {
  const pathname = getPathname(req);
  const method = getMethod(req);
  console.log(`[mock-agent] request ${method} ${pathname}`);
  if (method === 'POST' && isRunSsePath(pathname)) {
    await handleRunSse(req, res, state);
    return;
  }
  if (method === 'POST' && isBidiAppendPath(pathname)) {
    await handleBidiAppend(req, res, state);
    return;
  }
  if (method === 'POST' && isTaskInitPath(pathname)) {
    await handleTaskInit(req, res, state);
    return;
  }
  if (method === 'POST' && isTaskStreamLogPath(pathname)) {
    await handleTaskStreamLog(req, res, state);
    return;
  }
  if (method === 'POST' && isTaskSendMessagePath(pathname)) {
    await handleTaskSendMessage(req, res, state);
    return;
  }
  if (method === 'POST' && isTaskProvideResultPath(pathname)) {
    await handleTaskProvideResult(req, res, state);
    return;
  }
  if (method === 'POST' && isTaskGetInterfaceAgentStatusPath(pathname)) {
    await handleTaskGetInterfaceAgentStatus(req, res, state);
    return;
  }
  sendControlPlaneStub(req, res);
}

function startProxy(options) {
  const cert = ensureRelayCertificates(options.dataDir);
  const state = {
    options,
    sessions: new Map(),
    pendingUserMessages: new Map(),
    mockTasks: new Map(),
  };
  const tlsServer = http2.createSecureServer({
    key: fs.readFileSync(cert.leafKeyPath),
    cert: fs.readFileSync(cert.leafCertPath),
    allowHTTP1: true,
  }, (req, res) => {
    handleTlsRequest(req, res, state).catch((error) => {
      console.error(`[mock-agent] handler failed: ${error.stack || error.message}`);
      try {
        safeWriteHead(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(error.message || String(error));
      } catch {
        /* ignore */
      }
    });
  });

  return new Promise((resolve, reject) => {
    tlsServer.on('error', reject);
    tlsServer.listen(0, '127.0.0.1', () => {
      const tlsPort = tlsServer.address().port;
      const proxyServer = http.createServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Use this as an HTTP CONNECT proxy for Cursor.' }));
      });
      proxyServer.on('connect', (req, clientSocket, head) => {
        console.log(`[mock-agent] CONNECT ${req.url || '-'}`);
        clientSocket.on('error', (error) => {
          if (!/ECONNRESET|EPIPE/i.test(error?.code || error?.message || '')) {
            console.error(`[mock-agent] client socket error: ${error.message}`);
          }
        });
        const bridge = net.connect(tlsPort, '127.0.0.1', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: mock-cursor-agent-protocol\r\n\r\n');
          if (head?.length) bridge.write(head);
          clientSocket.pipe(bridge);
          bridge.pipe(clientSocket);
        });
        bridge.on('error', (error) => {
          if (!/ECONNRESET|EPIPE/i.test(error?.code || error?.message || '')) {
            console.error(`[mock-agent] bridge error: ${error.message}`);
          }
          try {
            clientSocket.destroy();
          } catch {
            /* ignore */
          }
        });
      });
      proxyServer.on('error', reject);
      proxyServer.listen(options.port, '127.0.0.1', () => {
        resolve({ proxyServer, tlsServer, tlsPort, state });
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (options.dryRun) {
    const frames = buildScenario(options.scenario, options);
    const body = Buffer.concat(frames.map((entry) => Buffer.from(entry.frame || [])));
    const summary = summarizeAgentServerStream(body, { maxSamples: 12 });
    console.log(JSON.stringify({
      scenario: options.scenario,
      nativeExec: options.nativeExec,
      labels: frames.map((entry) => entry.label),
      frames: frames.length,
      serverMessages: summary.serverMessages,
      interactionUpdates: summary.interactionUpdates,
      execServerTools: summary.execServerTools,
      samples: summary.samples,
    }, null, 2));
    return;
  }
  if (options.selfTest) {
    await runSelfTest(options);
    return;
  }
  const started = await startProxy(options);
  console.log(`[mock-agent] listening proxy=http://127.0.0.1:${options.port} tlsBridge=127.0.0.1:${started.tlsPort}`);
  console.log(`[mock-agent] scenario=${options.scenario} delayMs=${options.delayMs} nativeExec=${options.nativeExec ? '1' : '0'}`);
  console.log('[mock-agent] Set Cursor HTTP/HTTPS proxy to this port, then send any Agent message. Press Ctrl+C to stop.');
  const shutdown = () => {
    console.log('\n[mock-agent] shutting down');
    started.proxyServer.close();
    started.tlsServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});

const assert = require('assert');

const {
  collectToolCallsFromPayload,
  normalizeCollectedToolCalls,
  attachDefaultMutationTarget,
  shouldTreatStreamErrorAsComplete,
  getStreamingEditContentFromArgumentsText,
  getStreamingPathFromArgumentsText,
} = require('../js/utils/cursor-relay-runner');
const {
  buildAgentEditToolCallDeltaFrame,
  readConnectFrames,
} = require('../js/utils/cursor-relay-protocol');

function collect(events) {
  const state = { toolCalls: new Map() };
  for (const event of events) collectToolCallsFromPayload(event, state);
  return normalizeCollectedToolCalls(state);
}

const partialWrite = collect([
  {
    type: 'response.output_item.added',
    item: {
      id: 'fc_1',
      call_id: 'call_1',
      type: 'function_call',
      name: 'Write',
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    call_id: 'call_1',
    delta: '{"path":"welcome.html"',
  },
]);

assert.deepStrictEqual(partialWrite, []);

const completeWrite = collect([
  {
    type: 'response.output_item.added',
    item: {
      id: 'fc_2',
      call_id: 'call_2',
      type: 'function_call',
      name: 'Write',
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_2',
    call_id: 'call_2',
    delta: '{"path":"welcome.html","contents":"<html>',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_2',
    call_id: 'call_2',
    delta: '</html>"}',
  },
  {
    type: 'response.function_call_arguments.done',
    item_id: 'fc_2',
    call_id: 'call_2',
    arguments: '{"path":"welcome.html","contents":"<html></html>"}',
  },
]);

assert.strictEqual(completeWrite.length, 1);
assert.strictEqual(completeWrite[0].id, 'call_2');
assert.strictEqual(completeWrite[0].name, 'Write');
assert.deepStrictEqual(completeWrite[0].arguments, {
  path: 'welcome.html',
  contents: '<html></html>',
});

const completeWriteWithFileTextAlias = collect([
  {
    type: 'response.output_item.done',
    item: {
      id: 'fc_3',
      call_id: 'call_3',
      type: 'function_call',
      name: 'Write',
      arguments: '{"path":"welcome.html","file_text":"hello"}',
    },
  },
]);

assert.strictEqual(completeWriteWithFileTextAlias.length, 1);
assert.strictEqual(completeWriteWithFileTextAlias[0].arguments.file_text, 'hello');

const completedWriteWithoutPath = collect([
  {
    type: 'response.output_item.done',
    item: {
      id: 'fc_4',
      call_id: 'call_4',
      type: 'function_call',
      name: 'Write',
      arguments: '{"contents":"hello"}',
    },
  },
]);

assert.strictEqual(completedWriteWithoutPath.length, 1);
const withMentionTarget = attachDefaultMutationTarget(
  completedWriteWithoutPath,
  { workspaceRoot: 'F:\\xiaofan_project\\cursor-pool-client-electron\\desktop' },
  '@login.html 帮我完成登录页面',
);
assert.strictEqual(withMentionTarget[0].arguments.path, 'F:\\xiaofan_project\\cursor-pool-client-electron\\desktop\\login.html');

assert.strictEqual(
  shouldTreatStreamErrorAsComplete(
    'Upstream stream max duration exceeded after 30000ms',
    '',
  ),
  false,
);
assert.strictEqual(
  shouldTreatStreamErrorAsComplete(
    'Upstream stream max duration exceeded after 30000ms',
    '',
  ),
  false,
);

const partialArguments = '{"path":"login.html","contents":"<!DOCTYPE html>\\n<html';
assert.strictEqual(getStreamingPathFromArgumentsText(partialArguments), 'login.html');
assert.strictEqual(getStreamingEditContentFromArgumentsText(partialArguments), '<!DOCTYPE html>\n<html');

const deltaFrame = buildAgentEditToolCallDeltaFrame('<main>streaming</main>', 'call_same', 'model_call_same');
const decodedFrames = readConnectFrames(deltaFrame);
assert.strictEqual(decodedFrames.length, 1);
assert.strictEqual(decodedFrames[0].type, 0);
assert(decodedFrames[0].payload.includes(Buffer.from('call_same')));
assert(decodedFrames[0].payload.includes(Buffer.from('<main>streaming</main>')));

const itemIdWrite = collect([
  {
    type: 'response.output_item.added',
    item: {
      id: 'fc_same',
      call_id: 'call_same',
      type: 'function_call',
      name: 'Write',
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_same',
    call_id: 'call_same',
    delta: '{"path":"same.html","contents":"<main>same</main>"}',
  },
]);
assert.strictEqual(itemIdWrite.length, 1);
assert.strictEqual(itemIdWrite[0].id, 'call_same');
assert.strictEqual(itemIdWrite[0].name, 'Write');
assert.strictEqual(itemIdWrite[0].arguments.contents, '<main>same</main>');

console.log('agent tool-call collector tests passed');

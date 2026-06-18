const assert = require('assert');

const {
  buildAgentConversationCheckpointFrame,
  buildAgentThinkingDeltaFrame,
  buildAgentStepStartedFrame,
  buildAgentStepCompletedFrame,
  buildAgentPartialToolCallFrame,
  buildAgentToolCallStartedFrame,
  buildAgentToolCallCompletedFrame,
  buildAgentTurnEndedFrame,
  readConnectFrames,
  summarizeAgentServerStream,
} = require('../js/utils/cursor-relay-protocol');
const {
  decodeAgentServerMessage,
} = require('../js/utils/cursor-relay-protobuf');

const checkpointFrame = buildAgentConversationCheckpointFrame({
  workspaceRoot: 'E:\\cursor_auto_test\\register-page',
  readPaths: ['E:\\cursor_auto_test\\register-page\\index.html'],
  pendingToolCalls: [JSON.stringify({ id: 'tool_test', role: 'assistant', tool: 'Write' })],
  fileStates: {
    'E:\\cursor_auto_test\\register-page\\index.html': {
      initialContent: '<html></html>\n',
      content: '<html></html>\n<!-- relay-diff-test -->\n',
    },
  },
});

const stream = Buffer.concat([
  buildAgentThinkingDeltaFrame('Inspecting files'),
  buildAgentStepStartedFrame(1),
  buildAgentPartialToolCallFrame('Read', { path: 'index.html' }, 'tool_read', 'model_tool_read'),
  buildAgentToolCallStartedFrame('Read', { path: 'index.html' }, 'tool_read', 'model_tool_read'),
  buildAgentToolCallCompletedFrame('Read', { path: 'index.html' }, 'tool_read', 'model_tool_read', {
    execution: {
      ok: true,
      tool: 'Read',
      args: { path: 'E:\\cursor_auto_test\\register-page\\index.html' },
      resultText: '<html></html>',
      durationMs: 1,
    },
  }),
  buildAgentStepCompletedFrame(1, 1),
  buildAgentStepStartedFrame(2),
  buildAgentPartialToolCallFrame('Write', { path: 'index.html', contents: '<html></html>\n<!-- relay-diff-test -->\n' }, 'tool_write', 'model_tool_write'),
  buildAgentToolCallStartedFrame('Write', { path: 'index.html', contents: '<html></html>\n<!-- relay-diff-test -->\n' }, 'tool_write', 'model_tool_write'),
  buildAgentToolCallCompletedFrame('Write', { path: 'index.html', contents: '<html></html>\n<!-- relay-diff-test -->\n' }, 'tool_write', 'model_tool_write', {
    execution: {
      ok: true,
      tool: 'Write',
      args: { path: 'E:\\cursor_auto_test\\register-page\\index.html' },
      resultText: 'Wrote file',
      beforeContent: '<html></html>\n',
      afterContent: '<html></html>\n<!-- relay-diff-test -->\n',
      durationMs: 1,
    },
  }),
  checkpointFrame,
  buildAgentStepCompletedFrame(2, 1),
  buildAgentTurnEndedFrame(),
]);

const summary = summarizeAgentServerStream(stream, { maxSamples: 20 });
assert.strictEqual(summary.frameCount, 13);
assert.strictEqual(summary.serverMessages.conversation_checkpoint_update, 1);
assert.strictEqual(summary.interactionUpdates.thinking_delta, 1);
assert.strictEqual(summary.interactionUpdates.step_started, 2);
assert.strictEqual(summary.interactionUpdates.step_completed, 2);
assert.strictEqual(summary.interactionUpdates.partial_tool_call, 2);
assert.strictEqual(summary.interactionUpdates.tool_call_started, 2);
assert.strictEqual(summary.interactionUpdates.tool_call_completed, 2);
assert.strictEqual(summary.interactionUpdates.turn_ended, 1);

async function main() {
  const deleteFrame = buildAgentToolCallCompletedFrame('Delete', { path: 'delete-me.txt' }, 'tool_delete', 'model_tool_delete', {
    execution: {
      ok: true,
      tool: 'Delete',
      args: { path: 'delete-me.txt' },
      resultText: 'Deleted delete-me.txt',
      beforeContent: 'temporary file\n',
      prevContent: 'temporary file\n',
      deletedFile: 'delete-me.txt',
      fileSize: Buffer.byteLength('temporary file\n', 'utf8'),
      durationMs: 1,
    },
  });
  const deleteDecoded = await decodeAgentServerMessage(readConnectFrames(deleteFrame)[0].payload);
  const success = deleteDecoded.interactionUpdate.toolCallCompleted.toolCall.deleteToolCall.result.success;
  assert.strictEqual(success.path, 'delete-me.txt');
  assert.strictEqual(success.deletedFile, 'delete-me.txt');
  assert.strictEqual(success.prevContent, 'temporary file\n');
  assert.strictEqual(success.fileSize, String(Buffer.byteLength('temporary file\n', 'utf8')));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});

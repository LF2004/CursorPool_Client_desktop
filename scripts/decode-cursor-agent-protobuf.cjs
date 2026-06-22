const fs = require('fs');
const path = require('path');
const { gunzipSync, inflateSync } = require('zlib');

const {
  readConnectFrames,
  summarizeAgentServerStream,
} = require('../js/utils/cursor-relay-protocol');
const {
  decodeAgentServerMessage,
  decodeAgentClientMessage,
  decodeBidiAppendRequest,
} = require('../js/utils/cursor-relay-protobuf');

function firstKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.keys(value)[0] || '';
}

function byteLengthOfString(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function summarizeEditToolCall(toolCall) {
  const edit = toolCall?.editToolCall;
  if (!edit) return null;
  const success = edit.result?.success || null;
  return {
    tool: 'editToolCall',
    hasArgs: Boolean(edit.args),
    argFields: edit.args ? Object.keys(edit.args).sort() : [],
    path: edit.args?.path || success?.path || '',
    streamContentBytes: byteLengthOfString(edit.args?.streamContent),
    hasResult: Boolean(edit.result),
    resultKind: edit.result?.result || firstKey(edit.result) || '',
    diffBytes: byteLengthOfString(success?.diffString),
    beforeBytes: byteLengthOfString(success?.beforeFullFileContent),
    afterBytes: byteLengthOfString(success?.afterFullFileContent),
    message: success?.message || '',
  };
}

function summarizeToolUpdate(decoded) {
  const update = decoded?.interactionUpdate || {};
  const kind = update.message || firstKey(update) || '';
  if (!/toolCall/i.test(kind)) return null;
  const body = update[kind] || {};
  const toolCall = body.toolCall || {};
  const edit = summarizeEditToolCall(toolCall);
  const delta = body.toolCallDelta?.editToolCallDelta
    ? {
      tool: 'editToolCallDelta',
      streamContentDeltaBytes: byteLengthOfString(body.toolCallDelta.editToolCallDelta.streamContentDelta),
    }
    : null;
  return {
    kind,
    callId: body.callId || '',
    modelCallId: body.modelCallId || '',
    toolKind: toolCall.tool || firstKey(toolCall) || body.toolCallDelta?.delta || '',
    edit,
    delta,
  };
}

function decodeHexData(value) {
  const text = String(value || '').trim();
  if (!text || !/^[0-9a-f]+$/i.test(text)) return Buffer.alloc(0);
  return Buffer.from(text, 'hex');
}

async function decodeRunSseFile(filePath, maxSamples = 12) {
  const data = fs.readFileSync(filePath);
  const frames = readConnectFrames(data);
  const streamSummary = summarizeAgentServerStream(data, { maxSamples });
  const summary = {
    filePath,
    bytes: data.length,
    frames: frames.length,
    frameTypes: streamSummary.frameTypes || {},
    serverMessages: {},
    interactionUpdates: {},
    execServerTools: streamSummary.execServerTools || {},
    connectErrors: streamSummary.connectErrors || [],
    textBytes: 0,
    textPreview: '',
    toolUpdates: [],
    decodeErrors: [],
    samples: [],
  };
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame.type !== 0 && frame.type !== 1) continue;
    let decoded;
    try {
      decoded = await decodeAgentServerMessage(frame.payload);
    } catch (error) {
      summary.decodeErrors.push({
        index: i,
        type: frame.type,
        length: frame.payload.length,
        hexPrefix: frame.payload.subarray(0, 16).toString('hex'),
        error: error?.message || String(error),
      });
      continue;
    }
    const oneof = decoded.message || firstKey(decoded) || 'unknown';
    summary.serverMessages[oneof] = (summary.serverMessages[oneof] || 0) + 1;
    if (decoded.interactionUpdate) {
      const interaction = decoded.interactionUpdate.message || firstKey(decoded.interactionUpdate) || 'unknown';
      summary.interactionUpdates[interaction] = (summary.interactionUpdates[interaction] || 0) + 1;
      const textDelta = decoded.interactionUpdate.textDelta?.text || '';
      if (textDelta) {
        summary.textBytes += byteLengthOfString(textDelta);
        if (summary.textPreview.length < 1000) {
          summary.textPreview = `${summary.textPreview}${textDelta}`.slice(0, 1000);
        }
      }
      const toolUpdate = summarizeToolUpdate(decoded);
      if (toolUpdate && summary.toolUpdates.length < maxSamples * 4) {
        summary.toolUpdates.push({
          index: i,
          length: frame.payload.length,
          ...toolUpdate,
        });
      }
    }
    if (summary.samples.length < maxSamples) {
      summary.samples.push({
        index: i,
        type: frame.type,
        oneof,
        interaction: decoded.interactionUpdate?.message || '',
        execMessage: decoded.execServerMessage?.message || '',
        kvMessage: decoded.kvServerMessage?.message || '',
        checkpointFields: decoded.conversationCheckpointUpdate
          ? Object.keys(decoded.conversationCheckpointUpdate).sort()
          : undefined,
      });
    }
  }
  return summary;
}

async function decodeBidiFile(filePath) {
  const data = fs.readFileSync(filePath);
  let decoded = null;
  let payloadLabel = 'raw';
  const candidates = [{ label: 'raw', data }];
  try {
    candidates.push({ label: 'gunzip', data: gunzipSync(data) });
  } catch {
    /* not gzip */
  }
  try {
    candidates.push({ label: 'inflate', data: inflateSync(data) });
  } catch {
    /* not zlib */
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      decoded = await decodeBidiAppendRequest(candidate.data);
      payloadLabel = candidate.label;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!decoded) throw lastError || new Error('Unable to decode BidiAppendRequest');
  const agentPayload = decodeHexData(decoded.data);
  const agent = agentPayload.length ? await decodeAgentClientMessage(agentPayload) : null;
  return {
    filePath,
    bytes: data.length,
    payloadLabel,
    requestId: decoded.requestId?.requestId || '',
    appendSeqno: decoded.appendSeqno || '',
    agentClientMessage: agent?.message || firstKey(agent) || '',
    dataBytes: agentPayload.length,
    userTextPreview: agent?.runRequest?.action?.userMessage?.userMessage?.text
      || agent?.conversationAction?.userMessage?.userMessage?.text
      || '',
  };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    throw new Error('Usage: node scripts/decode-cursor-agent-protobuf.cjs <runsse-response.bin|bidi.bin> [...]');
  }
  const results = [];
  for (const rawPath of files) {
    const filePath = path.resolve(rawPath);
    const name = path.basename(filePath).toLowerCase();
    if ((name.includes('runsse') || name.includes('relay-') || name.includes('response')) && name.endsWith('.bin')) {
      results.push(await decodeRunSseFile(filePath));
    } else if (name.includes('bidi-')) {
      results.push(await decodeBidiFile(filePath));
    } else {
      results.push({ filePath, error: 'unknown sample kind' });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});

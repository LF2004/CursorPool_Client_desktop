const fs = require('fs');
const path = require('path');

const {
  readConnectFrames,
  summarizeAgentClientMessagePayload,
  summarizeAgentServerMessagePayload,
  summarizeAgentServerStream,
} = require('../js/utils/cursor-relay-protocol');

const DEFAULT_OFFICIAL_CAPTURE = path.join(process.cwd(), 'tmp_cursor_tap_records_after_http11.json');
const DEFAULT_LOCAL_DIR = 'E:\\cursor_auto_test';

function inc(bucket, key) {
  const normalized = String(key || 'unknown');
  bucket[normalized] = (bucket[normalized] || 0) + 1;
}

function addSample(samples, sample, limit = 8) {
  if (samples.length < limit) samples.push(sample);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function parseGrpcJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstOwnKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.keys(value)[0] || '';
}

function toSnakeCase(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function analyzeOfficialCapture(capturePath) {
  const records = readJson(capturePath);
  const out = {
    capturePath,
    totalRecords: Array.isArray(records) ? records.length : 0,
    runSse: {
      frames: 0,
      serverMessages: {},
      interactionUpdates: {},
      execServerTools: {},
      checkpointFieldSets: {},
      samples: [],
    },
    bidi: {
      frames: 0,
      clientMessages: {},
      samples: [],
    },
  };

  for (const entry of Array.isArray(records) ? records : []) {
    if (entry?.type !== 'grpc') continue;
    if (entry.grpc_method === 'RunSSE' && entry.direction === 'S2C') {
      const parsed = parseGrpcJson(entry.grpc_data);
      if (!parsed) continue;
      const oneof = toSnakeCase(firstOwnKey(parsed) || 'empty');
      out.runSse.frames += 1;
      inc(out.runSse.serverMessages, oneof);
      if (oneof === 'interaction_update') {
        inc(out.runSse.interactionUpdates, toSnakeCase(firstOwnKey(parsed.interactionUpdate)));
      }
      if (oneof === 'exec_server_message') {
        const tool = toSnakeCase(firstOwnKey(parsed.execServerMessage));
        inc(out.runSse.execServerTools, tool);
      }
      if (oneof === 'conversation_checkpoint_update') {
        const fields = Object.keys(parsed.conversationCheckpointUpdate || {}).sort();
        inc(out.runSse.checkpointFieldSets, fields.join(',') || 'empty');
      }
      addSample(out.runSse.samples, {
        index: entry.index,
        grpcFrameIndex: entry.grpc_frame_index,
        oneof,
        interaction: oneof === 'interaction_update' ? toSnakeCase(firstOwnKey(parsed.interactionUpdate)) : '',
        checkpointFields: oneof === 'conversation_checkpoint_update'
          ? Object.keys(parsed.conversationCheckpointUpdate || {}).sort()
          : undefined,
      });
    }

    if (entry.grpc_method === 'BidiAppend' && entry.direction === 'C2S') {
      const parsed = parseGrpcJson(entry.grpc_data);
      if (!parsed) continue;
      out.bidi.frames += 1;
      let oneof = 'unknown';
      if (typeof parsed.data === 'string' && /^[0-9a-f]+$/i.test(parsed.data)) {
        try {
          const summary = summarizeAgentClientMessagePayload(Buffer.from(parsed.data, 'hex'));
          oneof = summary.oneof || 'unknown';
        } catch {
          oneof = 'decode_error';
        }
      }
      inc(out.bidi.clientMessages, oneof);
      addSample(out.bidi.samples, {
        index: entry.index,
        requestId: parsed.requestId?.requestId || '',
        appendSeqno: parsed.appendSeqno || '',
        dataBytes: typeof parsed.data === 'string' ? parsed.data.length / 2 : 0,
        oneof,
      });
    }
  }

  return out;
}

function listLocalDumpFiles(localDir) {
  if (!fs.existsSync(localDir)) return [];
  return fs.readdirSync(localDir)
    .filter((name) => /(?:relay-.*response|runsse.*response).*\.bin$/i.test(name))
    .map((name) => path.join(localDir, name))
    .sort();
}

function validateProtoTags(payload, maxDepth = 4, depth = 0) {
  const raw = Buffer.from(payload || []);
  const errors = [];
  let pos = 0;
  while (pos < raw.length) {
    const tagStart = pos;
    const tag = readVarint(raw, pos);
    if (!tag) {
      errors.push({ offset: tagStart, reason: 'truncated_tag' });
      break;
    }
    pos = tag.next;
    const field = tag.value >> 3;
    const wireType = tag.value & 7;
    if (field === 0) {
      errors.push({ offset: tagStart, reason: 'field_0', wireType });
      break;
    }
    if (wireType === 0) {
      const value = readVarint(raw, pos);
      if (!value) {
        errors.push({ offset: pos, reason: 'truncated_varint' });
        break;
      }
      pos = value.next;
    } else if (wireType === 1) {
      if (pos + 8 > raw.length) errors.push({ offset: pos, reason: 'truncated_fixed64' });
      pos += 8;
    } else if (wireType === 2) {
      const len = readVarint(raw, pos);
      if (!len) {
        errors.push({ offset: pos, reason: 'truncated_length' });
        break;
      }
      pos = len.next;
      if (pos + len.value > raw.length) {
        errors.push({ offset: pos, reason: 'length_overflow', length: len.value });
        break;
      }
      const bytes = raw.subarray(pos, pos + len.value);
      if (depth < maxDepth && bytes.length && looksLikeProto(bytes)) {
        errors.push(...validateProtoTags(bytes, maxDepth, depth + 1).map((item) => ({
          ...item,
          nestedAt: tagStart,
          depth: depth + 1,
        })));
      }
      pos += len.value;
    } else if (wireType === 5) {
      if (pos + 4 > raw.length) errors.push({ offset: pos, reason: 'truncated_fixed32' });
      pos += 4;
    } else {
      errors.push({ offset: tagStart, reason: 'unsupported_wire_type', wireType });
      break;
    }
  }
  return errors;
}

function readVarint(raw, start) {
  let value = 0;
  let shift = 0;
  for (let pos = start; pos < raw.length && pos < start + 10; pos += 1) {
    const byte = raw[pos];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, next: pos + 1 };
    shift += 7;
  }
  return null;
}

function looksLikeProto(bytes) {
  if (!bytes.length) return false;
  const first = readVarint(bytes, 0);
  if (!first) return false;
  const field = first.value >> 3;
  const wireType = first.value & 7;
  return field > 0 && [0, 1, 2, 5].includes(wireType);
}

function analyzeLocalDumps(localDir) {
  const files = listLocalDumpFiles(localDir);
  const out = {
    localDir,
    files: [],
    aggregate: {
      frameCount: 0,
      serverMessages: {},
      interactionUpdates: {},
      execServerTools: {},
      invalidProtoPayloads: 0,
    },
  };

  for (const filePath of files) {
    const data = fs.readFileSync(filePath);
    const summary = summarizeAgentServerStream(data, { maxSamples: 12 });
    const frames = readConnectFrames(data);
    const invalidFrames = [];
    const checkpointSamples = [];
    frames.forEach((frame, index) => {
      if (frame.type !== 0 && frame.type !== 1) return;
      const errors = validateProtoTags(frame.payload, 1);
      if (errors.length) invalidFrames.push({ index, errors: errors.slice(0, 4) });
      const server = summarizeAgentServerMessagePayload(frame.payload);
      if (server.oneof === 'conversation_checkpoint_update') {
        addSample(checkpointSamples, {
          index,
          shape: server.shape,
          length: frame.payload.length,
        }, 4);
      }
    });

    out.aggregate.frameCount += summary.frameCount;
    for (const [key, value] of Object.entries(summary.serverMessages || {})) out.aggregate.serverMessages[key] = (out.aggregate.serverMessages[key] || 0) + value;
    for (const [key, value] of Object.entries(summary.interactionUpdates || {})) out.aggregate.interactionUpdates[key] = (out.aggregate.interactionUpdates[key] || 0) + value;
    for (const [key, value] of Object.entries(summary.execServerTools || {})) out.aggregate.execServerTools[key] = (out.aggregate.execServerTools[key] || 0) + value;
    out.aggregate.invalidProtoPayloads += invalidFrames.length;

    out.files.push({
      filePath,
      bytes: data.length,
      summary,
      invalidFrames,
      checkpointSamples,
    });
  }

  return out;
}

function missingKeys(required, actual) {
  return Object.keys(required || {}).filter((key) => !Object.prototype.hasOwnProperty.call(actual || {}, key));
}

function buildComparison(official, local) {
  const officialCheckpointFields = Object.keys(official.runSse.checkpointFieldSets)
    .map((key) => key.split(',').filter(Boolean))
    .sort((a, b) => b.length - a.length)[0] || [];
  return {
    missingServerMessageKindsInLocal: missingKeys(official.runSse.serverMessages, local.aggregate.serverMessages),
    missingInteractionKindsInLocal: missingKeys(official.runSse.interactionUpdates, local.aggregate.interactionUpdates),
    missingExecToolKindsInLocal: missingKeys(official.runSse.execServerTools, local.aggregate.execServerTools),
    officialLargestCheckpointFieldSet: officialCheckpointFields,
    localInvalidProtoPayloads: local.aggregate.invalidProtoPayloads,
    notes: [
      'Official RunSSE is Connect/gRPC binary frames under text/event-stream.',
      'Official conversationCheckpointUpdate uses blob ids in rootPromptMessagesJson/turns/fileStatesV2; raw file text must be stored through KvServerMessage SetBlob.',
      'Local Agent frames should not be sent to real Cursor until invalidProtoPayloads is 0 and required official oneof/field coverage matches the target scenario.',
    ],
  };
}

function main() {
  const officialCapture = path.resolve(process.env.OFFICIAL_CAPTURE || process.argv[2] || DEFAULT_OFFICIAL_CAPTURE);
  const localDir = path.resolve(process.env.LOCAL_RELAY_DUMP_DIR || process.argv[3] || DEFAULT_LOCAL_DIR);
  const official = analyzeOfficialCapture(officialCapture);
  const local = analyzeLocalDumps(localDir);
  const comparison = buildComparison(official, local);
  const report = { generatedAt: new Date().toISOString(), official, local, comparison };

  const outPath = process.env.PROTOCOL_COMPARE_OUT
    ? path.resolve(process.env.PROTOCOL_COMPARE_OUT)
    : path.join(localDir, 'cursor-agent-protocol-compare.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    outPath,
    officialRunSseFrames: official.runSse.frames,
    officialServerMessages: official.runSse.serverMessages,
    officialInteractionUpdates: official.runSse.interactionUpdates,
    localFiles: local.files.length,
    localServerMessages: local.aggregate.serverMessages,
    localInteractionUpdates: local.aggregate.interactionUpdates,
    localInvalidProtoPayloads: local.aggregate.invalidProtoPayloads,
    missingServerMessageKindsInLocal: comparison.missingServerMessageKindsInLocal,
    missingInteractionKindsInLocal: comparison.missingInteractionKindsInLocal,
  }, null, 2));
}

main();

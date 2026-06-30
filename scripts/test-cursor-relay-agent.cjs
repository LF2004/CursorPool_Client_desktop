const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  startLocalRelayRunner,
  stopLocalRelayRunner,
} = require('../js/utils/cursor-relay-runner-manager');
const { readRunnerLogTail } = require('../js/utils/cursor-relay-log');
const { decodeBidiAppendRequest } = require('../js/utils/cursor-relay-protocol');
const {
  buildAgentBidiAppendPayload,
  mapAgentModeNameToNumber,
} = require('../js/utils/cursor-relay-agent-test');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function encodeInt32Field(field, value) {
  return concatBytes([
    encodeVarint((field << 3) | 0),
    encodeVarint(Number(value) || 0),
  ]);
}

function decodeVarint(data, start) {
  let value = 0;
  let shift = 0;
  let pos = start;
  while (pos < data.length) {
    const byte = data[pos];
    pos += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [value, pos];
}

function parseFields(data) {
  const out = [];
  let pos = 0;
  while (pos < data.length) {
    const [tag, afterTag] = decodeVarint(data, pos);
    if (afterTag <= pos) break;
    pos = afterTag;
    const field = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const [value, nextPos] = decodeVarint(data, pos);
      out.push({ field, wireType, varint: value });
      pos = nextPos;
      continue;
    }
    if (wireType === 2) {
      const [length, afterLength] = decodeVarint(data, pos);
      pos = afterLength;
      if (length < 0 || pos + length > data.length) break;
      out.push({ field, wireType, bytes: data.subarray(pos, pos + length) });
      pos += length;
      continue;
    }
    if (wireType === 1) {
      pos += 8;
      continue;
    }
    if (wireType === 5) {
      pos += 4;
      continue;
    }
    break;
  }
  return out;
}

function getFieldBytes(fields, fieldNumber) {
  return fields.find((field) => field.field === fieldNumber && field.wireType === 2)?.bytes;
}

function decodeUtf8(bytes) {
  return Buffer.from(bytes || []).toString('utf8');
}

function connectFramesFromBuffer(buffer) {
  const frames = [];
  let pos = 0;
  while (pos + 5 <= buffer.length) {
    const type = buffer[pos];
    const length = buffer.readUInt32BE(pos + 1);
    if (pos + 5 + length > buffer.length) break;
    const payload = buffer.subarray(pos + 5, pos + 5 + length);
    frames.push({ type, payload });
    pos += 5 + length;
  }
  return { frames, rest: buffer.subarray(pos) };
}

function extractAgentFrameInfo(frame) {
  const root = parseFields(frame.payload);
  const checkpoint = getFieldBytes(root, 3);
  if (checkpoint?.length) {
    const checkpointFields = parseFields(checkpoint);
    const pendingToolCalls = checkpointFields.filter((field) => field.field === 4).length;
    const fileStatesV2 = checkpointFields.filter((field) => field.field === 15).length;
    const readPaths = checkpointFields.filter((field) => field.field === 18).length;
    return { kind: 'checkpoint', pendingToolCalls, fileStatesV2, readPaths };
  }
  const execServer = getFieldBytes(root, 2);
  if (execServer?.length) {
    const execFields = parseFields(execServer);
    const toolField = execFields.find((field) => [2, 3, 4, 5, 7, 8, 14].includes(field.field));
    const execId = decodeUtf8(getFieldBytes(execFields, 15) || getFieldBytes(execFields, 1) || Buffer.alloc(0)).trim();
    const toolMap = {
      2: 'shell_args',
      3: 'write_args',
      4: 'delete_args',
      5: 'grep_args',
      7: 'read_args',
      8: 'ls_args',
      14: 'shell_stream_args',
    };
    return {
      kind: 'exec_server',
      execId,
      execTool: toolMap[toolField?.field] || '',
      execField: toolField?.field || 0,
    };
  }
  const interaction = getFieldBytes(root, 1);
  if (interaction?.length) {
    const interactionFields = parseFields(interaction);
    const textDelta = getFieldBytes(interactionFields, 1);
    if (textDelta?.length) {
      const text = decodeUtf8(getFieldBytes(parseFields(textDelta), 1) || Buffer.alloc(0));
      return { kind: 'text', text };
    }
    if (interactionFields.some((field) => field.field === 4)) {
      return { kind: 'thinking' };
    }
    if (interactionFields.some((field) => field.field === 16)) {
      return { kind: 'step_started' };
    }
    if (interactionFields.some((field) => field.field === 17)) {
      return { kind: 'step_completed' };
    }
    if (interactionFields.some((field) => field.field === 2)) {
      return { kind: 'tool_call_started' };
    }
    if (interactionFields.some((field) => field.field === 3)) {
      return { kind: 'tool_call_completed' };
    }
    if (interactionFields.some((field) => field.field === 7)) {
      return { kind: 'partial_tool_call' };
    }
    if (interactionFields.some((field) => field.field === 15)) {
      return { kind: 'tool_call_delta' };
    }
    if (interactionFields.some((field) => field.field === 14)) {
      return { kind: 'turn_end' };
    }
    if (interactionFields.some((field) => field.field === 13)) {
      return { kind: 'heartbeat' };
    }
    return { kind: 'interaction' };
  }
  if (getFieldBytes(root, 4)?.length) {
    return { kind: 'kv' };
  }
  return { kind: 'unknown' };
}

function buildAgentExecClientPayload(requestId, execId, text = '') {
  const execClient = encodeMessage([
    { field: 1, value: String(execId || '') },
    { field: 2, value: String(text || 'relay test exec client ack') },
  ]);
  const agentPayload = encodeMessage([{ field: 2, value: execClient }]);
  const requestIdMessage = encodeMessage([{ field: 1, value: requestId }]);
  return encodeMessage([
    { field: 1, value: agentPayload },
    { field: 2, value: requestIdMessage },
  ]);
}

function buildAgentExecClientControlPayload(requestId, execId, status = 1) {
  const execControl = concatBytes([
    encodeBytesField(1, String(execId || '')),
    encodeInt32Field(2, Number(status) || 1),
  ]);
  const agentPayload = encodeMessage([{ field: 5, value: execControl }]);
  const requestIdMessage = encodeMessage([{ field: 1, value: requestId }]);
  return encodeMessage([
    { field: 1, value: agentPayload },
    { field: 2, value: requestIdMessage },
  ]);
}

function parseBooleanEnv(name, defaultValue = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function parseOptionalBooleanEnv(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return undefined;
}

function runProtocolCompareIfRequested(responseDumpPath, dataDir) {
  if (!parseBooleanEnv('RELAY_TEST_COMPARE_PROTOCOL', Boolean(responseDumpPath))) return null;
  const officialCapture = String(
    process.env.RELAY_TEST_OFFICIAL_CAPTURE
    || path.join(process.cwd(), 'tmp_cursor_tap_records_after_http11.json'),
  ).trim();
  const artifactDir = path.join(dataDir || path.join(os.homedir(), '.cursorpool', 'relay-test-artifacts'), 'artifacts');
  const localDir = String(process.env.RELAY_TEST_COMPARE_LOCAL_DIR || path.dirname(responseDumpPath || path.join(artifactDir, 'relay-local-response.bin'))).trim();
  const outPath = String(
    process.env.RELAY_TEST_COMPARE_OUT
    || path.join(localDir, 'cursor-agent-protocol-compare-test.json'),
  ).trim();
  const env = {
    ...process.env,
    PROTOCOL_COMPARE_OUT: outPath,
  };
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'compare-cursor-agent-protocol.cjs'),
    officialCapture,
    localDir,
  ], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    status: result.status,
    outPath,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function createProxyTlsConnection({
  proxyPort,
  targetHost,
  targetPort = 443,
  timeoutMs = 15000,
}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let finished = false;
    let headerBuffer = Buffer.alloc(0);

    const finish = (error, tlsSocket) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      if (error) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        reject(error);
        return;
      }
      resolve(tlsSocket);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out connecting to proxy 127.0.0.1:${proxyPort}`));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        'Proxy-Connection: keep-alive\r\n' +
        'Connection: keep-alive\r\n' +
        '\r\n',
      );
    });

    socket.on('data', (chunk) => {
      headerBuffer = Buffer.concat([headerBuffer, Buffer.from(chunk)]);
      const endIndex = headerBuffer.indexOf('\r\n\r\n');
      if (endIndex < 0) return;

      const headerText = headerBuffer.subarray(0, endIndex).toString('utf8');
      const statusLine = headerText.split(/\r?\n/, 1)[0] || '';
      if (!/^HTTP\/1\.[01] 200\b/i.test(statusLine)) {
        finish(new Error(`Proxy CONNECT failed: ${statusLine || headerText}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      });

      tlsSocket.on('secureConnect', () => finish(null, tlsSocket));
      tlsSocket.on('error', (error) => finish(error));
    });

    socket.on('error', (error) => finish(error));
  });
}

function postBinary({ port, path, body, headers = {}, targetHost = 'api2.cursor.sh' }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: targetHost,
      port: 443,
      method: 'POST',
      path,
      createConnection: (_options, callback) => {
        createProxyTlsConnection({
          proxyPort: port,
          targetHost,
        }).then(
          (socket) => callback(null, socket),
          (error) => callback(error),
        );
      },
      headers: {
        Host: targetHost,
        'Content-Length': body.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
      headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function openRunSseStream({
  port,
  requestId,
  timeoutMs = 15000,
  targetHost = 'api2.cursor.sh',
  responseDumpPath = '',
  simulateExecClient = true,
}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ requestId }), 'utf8');
    const req = https.request({
      hostname: targetHost,
      port: 443,
      method: 'POST',
      path: '/agent.v1.AgentService/RunSSE',
      createConnection: (_options, callback) => {
        createProxyTlsConnection({
          proxyPort: port,
          targetHost,
        }).then(
          (socket) => callback(null, socket),
          (error) => callback(error),
        );
      },
      headers: {
        Host: targetHost,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    });

    let timer = null;
    let buffer = Buffer.alloc(0);
    const responseFrames = [];
    const textParts = [];
    const frameKinds = [];
    const execServerFrames = [];
    const execReplyPromises = [];
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    req.on('response', (res) => {
      timer = setTimeout(() => {
        finish({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          text: textParts.join(''),
          frameKinds,
          timedOut: true,
        });
      }, timeoutMs);

      res.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        const parsed = connectFramesFromBuffer(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          responseFrames.push(frame);
          const info = extractAgentFrameInfo(frame);
          frameKinds.push(info.kind);
          if (info.kind === 'exec_server') {
            execServerFrames.push(info);
            if (simulateExecClient) {
              const execId = info.execId || `exec_${execServerFrames.length}`;
              execReplyPromises.push(
                postBinary({
                  port,
                  path: '/aiserver.v1.BidiService/BidiAppend',
                  body: buildAgentExecClientPayload(requestId, execId, `${info.execTool || 'exec'} started`),
                  targetHost,
                  headers: { 'Content-Type': 'application/proto' },
                }).catch((error) => ({ error: error.message || String(error) })),
                postBinary({
                  port,
                  path: '/aiserver.v1.BidiService/BidiAppend',
                  body: buildAgentExecClientControlPayload(requestId, execId, 1),
                  targetHost,
                  headers: { 'Content-Type': 'application/proto' },
                }).catch((error) => ({ error: error.message || String(error) })),
              );
            }
          }
          if (info.kind === 'text' && info.text) {
            textParts.push(info.text);
          }
          if (info.kind === 'turn_end') {
            finish({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              text: textParts.join(''),
              frameKinds,
              responseFrames,
              execServerFrames,
              execReplyCount: execReplyPromises.length,
              timedOut: false,
            });
            return;
          }
        }
      });

      res.on('end', () => {
        finish({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          text: textParts.join(''),
          frameKinds,
          responseFrames,
          execServerFrames,
          execReplyCount: execReplyPromises.length,
          ended: true,
          timedOut: false,
        });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const baseUrl = String(process.env.RELAY_TEST_BASE_URL || '').trim();
  const apiKey = String(process.env.RELAY_TEST_API_KEY || '').trim();
  const modelName = String(process.env.RELAY_TEST_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
  const agentMode = String(process.env.RELAY_TEST_AGENT_MODE || 'AGENT_MODE_AGENT').trim() || 'AGENT_MODE_AGENT';
  const agentModeNumber = mapAgentModeNameToNumber(agentMode);
  const port = Number(process.env.RELAY_TEST_PORT || 17790);
  const prompt = String(process.env.RELAY_TEST_PROMPT || 'Reply with exactly PONG and nothing else.').trim();
  const targetHost = String(process.env.RELAY_TEST_TARGET_HOST || 'api2.cursor.sh').trim() || 'api2.cursor.sh';
  const enableReviewBridge = parseBooleanEnv('RELAY_TEST_ENABLE_REVIEW_BRIDGE', false);
  const nativeMutationTools = parseOptionalBooleanEnv('RELAY_TEST_NATIVE_MUTATION_TOOLS');
  const nativeMutationApplyMode = String(process.env.RELAY_TEST_NATIVE_MUTATION_APPLY_MODE || 'local_fallback').trim() || 'local_fallback';
  const localNativeAgentTools = parseOptionalBooleanEnv('RELAY_TEST_LOCAL_NATIVE_AGENT_TOOLS');
  const emitAgentKvBootstrap = parseBooleanEnv('RELAY_TEST_AGENT_KV_BOOTSTRAP', false);
  const emitLocalMutationCheckpoints = parseBooleanEnv('RELAY_TEST_LOCAL_MUTATION_CHECKPOINTS', false);
  const dataDir = String(
    process.env.RELAY_TEST_DATA_DIR
    || path.join(os.homedir(), '.cursorpool', `relay-test-${port}`),
  ).trim();
  const responseDumpPath = String(
    process.env.RELAY_TEST_RESPONSE_DUMP
    || path.join(dataDir, 'artifacts', `runsse-response-${Date.now().toString(36)}.bin`),
  ).trim();
  const controlFrameSample = Buffer.from('0a043361303012260a2462646564336233342d383661372d343936372d613161312d3336633033393536626631321830', 'hex');
  const controlFrameDecoded = decodeBidiAppendRequest(controlFrameSample);

  if (!baseUrl || !apiKey) {
    throw new Error('Missing RELAY_TEST_BASE_URL or RELAY_TEST_API_KEY');
  }

  const requestId = crypto.randomUUID();
  let started = null;
  try {
    started = await startLocalRelayRunner({
      mode: 'local_relay',
      upstream: {
        providerId: 'custom',
        baseUrl,
        apiKey,
        modelName,
      },
      port,
      dataDir,
      enableReviewBridge,
      nativeMutationApplyMode,
      emitAgentKvBootstrap,
      emitLocalMutationCheckpoints,
      historyRoot: path.join(dataDir, 'history'),
      ...(nativeMutationTools === undefined ? {} : { nativeMutationTools }),
      ...(localNativeAgentTools === undefined ? {} : { localNativeAgentTools }),
    });

    const ssePromise = openRunSseStream({
      port,
      requestId,
      timeoutMs: Number(process.env.RELAY_TEST_TIMEOUT_MS || 60000),
      targetHost,
      responseDumpPath,
    });
    await sleep(200);
    const bidiResponse = await postBinary({
      port,
      path: '/aiserver.v1.BidiService/BidiAppend',
      body: buildAgentBidiAppendPayload(requestId, prompt, { mode: agentMode }),
      targetHost,
      headers: {
        'Content-Type': 'application/proto',
      },
    });
    const sseResult = await ssePromise;
    await sleep(400);
    const log = await readRunnerLogTail(dataDir, 120);
    if (responseDumpPath) {
      const body = Buffer.concat((sseResult.responseFrames || []).map((frame) => {
        const header = Buffer.allocUnsafe(5);
        header[0] = frame.type;
        header.writeUInt32BE(frame.payload.length, 1);
        return Buffer.concat([header, frame.payload]);
      }));
      fs.mkdirSync(path.dirname(responseDumpPath), { recursive: true });
      fs.writeFileSync(responseDumpPath, body);
    }
    const protocolCompare = runProtocolCompareIfRequested(responseDumpPath, dataDir);

    const text = String(sseResult.text || '').trim();
    const proof = {
      runner: {
        proxyServer: started.proxyServer,
        port: started.port,
        targetHost,
      },
      bidi: {
        statusCode: bidiResponse.statusCode,
        bodyLength: bidiResponse.body.length,
        agentMode,
        agentModeNumber,
      },
      sse: {
        statusCode: sseResult.statusCode,
        text,
        frameKinds: sseResult.frameKinds,
        timedOut: Boolean(sseResult.timedOut),
        checkpoints: sseResult.frameKinds.filter((kind) => kind === 'checkpoint').length,
        execServerFrames: sseResult.frameKinds.filter((kind) => kind === 'exec_server').length,
        execReplyCount: sseResult.execReplyCount || 0,
        responseDumpPath,
      },
      logChecks: {
        runSseOpen: /agent local relay RunSSE open requestId=/i.test(log.text),
        bidiUserMessage: /BidiAppend kind=user_message/i.test(log.text),
        chatIntercept: /chat intercept agent requestId=|agent local relay request requestId=/i.test(log.text),
      },
      decoderChecks: {
        controlFrameKind: controlFrameDecoded.kind,
        controlFrameRequestId: controlFrameDecoded.requestId,
      },
      protocolCompare,
      logTail: log.text,
    };

    console.log(JSON.stringify(proof, null, 2));

    const ok = proof.bidi.statusCode === 200
      && proof.sse.statusCode === 200
      && proof.logChecks.bidiUserMessage
      && proof.logChecks.chatIntercept
      && !proof.sse.timedOut
      && proof.sse.frameKinds.includes('turn_end')
      && ['client_heartbeat', 'agent_control'].includes(proof.decoderChecks.controlFrameKind)
      && (!/pong/i.test(prompt) || /pong/i.test(proof.sse.text));

    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    stopLocalRelayRunner();
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});

const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const https = require('https');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mapAgentModeNameToNumber(modeName = '') {
  const normalized = String(modeName || '').trim().toUpperCase();
  switch (normalized) {
    case 'AGENT_MODE_AGENT':
    case 'AGENT':
      return 1;
    case 'AGENT_MODE_ASK':
    case 'ASK':
      return 2;
    case 'AGENT_MODE_PLAN':
    case 'PLAN':
      return 3;
    case 'AGENT_MODE_DEBUG':
    case 'DEBUG':
      return 4;
    case 'AGENT_MODE_TRIAGE':
    case 'TRIAGE':
      return 5;
    case 'AGENT_MODE_PROJECT':
    case 'PROJECT':
      return 6;
    case 'AGENT_MODE_MULTITASK':
    case 'MULTITASK':
    case 'TASK':
      return 7;
    case 'AGENT_MODE_SUBAGENT':
    case 'SUBAGENT':
      return 8;
    default:
      return 1;
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
    return {
      kind: 'checkpoint',
      pendingToolCalls: checkpointFields.filter((field) => field.field === 4).length,
      fileStatesV2: checkpointFields.filter((field) => field.field === 15).length,
      readPaths: checkpointFields.filter((field) => field.field === 18).length,
    };
  }
  const execServer = getFieldBytes(root, 2);
  if (execServer?.length) {
    const execFields = parseFields(execServer);
    const toolField = execFields.find((field) => [2, 3, 5, 7, 14, 28].includes(field.field));
    const execId = decodeUtf8(getFieldBytes(execFields, 15) || getFieldBytes(execFields, 1) || Buffer.alloc(0)).trim();
    const toolMap = {
      2: 'shell_args',
      3: 'write_args',
      5: 'grep_args',
      7: 'read_args',
      14: 'shell_stream_args',
      28: 'subagent_args',
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

function buildAgentBidiAppendPayload(requestId, userText, options = {}) {
  const modeNumber = mapAgentModeNameToNumber(options.mode || 'AGENT_MODE_AGENT');
  const userMessage = concatBytes([
    encodeBytesField(1, userText),
    encodeInt32Field(4, modeNumber),
  ]);
  const userAction = encodeMessage([{ field: 1, value: userMessage }]);
  const conversationAction = encodeMessage([{ field: 1, value: userAction }]);
  const runRequest = concatBytes([
    encodeBytesField(2, conversationAction),
    encodeInt32Field(10, modeNumber),
  ]);
  const agentPayload = encodeMessage([{ field: 1, value: runRequest }]);
  const requestIdMessage = encodeMessage([{ field: 1, value: requestId }]);
  return encodeMessage([
    { field: 1, value: agentPayload },
    { field: 2, value: requestIdMessage },
  ]);
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
      finish(new Error(`连接本地代理超时 127.0.0.1:${proxyPort}`));
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
        finish(new Error(`代理 CONNECT 失败: ${statusLine || headerText}`));
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

function postBinary({ port, path, body, headers = {}, targetHost }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = https.request({
      hostname: targetHost,
      port: 443,
      method: 'POST',
      path,
      createConnection: (_options, callback) => {
        createProxyTlsConnection({ proxyPort: port, targetHost }).then(
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
          latencyMs: Date.now() - started,
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
  timeoutMs = 60000,
  targetHost,
  simulateExecClient = true,
}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const body = Buffer.from(JSON.stringify({ requestId }), 'utf8');
    const req = https.request({
      hostname: targetHost,
      port: 443,
      method: 'POST',
      path: '/agent.v1.AgentService/RunSSE',
      createConnection: (_options, callback) => {
        createProxyTlsConnection({ proxyPort: port, targetHost }).then(
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
      resolve({
        ...result,
        latencyMs: Date.now() - started,
      });
    };

    req.on('response', (res) => {
      timer = setTimeout(() => {
        finish({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          text: textParts.join(''),
          frameKinds,
          execServerFrames,
          execReplyCount: execReplyPromises.length,
          timedOut: true,
        });
      }, timeoutMs);

      res.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        const parsed = connectFramesFromBuffer(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
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

const DEFAULT_TARGET_HOSTS = [
  'agent.api5.cursor.sh',
  'api5.cursor.sh',
  'api2.cursor.sh',
];

async function runRelayAgentConnectionTest({
  port = 17789,
  prompt,
  mode = 'AGENT_MODE_AGENT',
  targetHosts = DEFAULT_TARGET_HOSTS,
  timeoutMs = 20000,
  simulateExecClient = true,
} = {}) {
  const userPrompt = String(prompt || '').trim();
  if (!userPrompt) {
    throw new Error('测试消息不能为空');
  }

  const errors = [];
  const attempts = [];
  for (const targetHost of targetHosts) {
    const requestId = crypto.randomUUID();
    try {
      const ssePromise = openRunSseStream({
        port,
        requestId,
        timeoutMs,
        targetHost,
        simulateExecClient,
      });
      await sleep(200);
      const bidiResponse = await postBinary({
        port,
        path: '/aiserver.v1.BidiService/BidiAppend',
        body: buildAgentBidiAppendPayload(requestId, userPrompt, { mode }),
        targetHost,
        headers: {
          'Content-Type': 'application/proto',
        },
      });
      const sseResult = await ssePromise;
      const text = String(sseResult.text || '').trim();
      const ok = bidiResponse.statusCode === 200
        && sseResult.statusCode === 200
        && text.length > 0
        && !sseResult.timedOut;
      attempts.push({
        requestId,
        targetHost,
        bidiStatus: bidiResponse.statusCode,
        sseStatus: sseResult.statusCode,
        textLength: text.length,
        timedOut: Boolean(sseResult.timedOut),
        execServerFrames: sseResult.execServerFrames || [],
        execReplyCount: sseResult.execReplyCount || 0,
      });

      if (ok) {
        return {
          ok: true,
          text,
          requestId,
          mode,
          targetHost,
          bidiStatus: bidiResponse.statusCode,
          sseStatus: sseResult.statusCode,
          frameKinds: sseResult.frameKinds,
          execServerFrames: sseResult.execServerFrames || [],
          execReplyCount: sseResult.execReplyCount || 0,
          latencyMs: Math.max(bidiResponse.latencyMs || 0, sseResult.latencyMs || 0),
        };
      }

      errors.push(`${targetHost}: requestId=${requestId} bidi=${bidiResponse.statusCode} sse=${sseResult.statusCode} textLen=${text.length} timedOut=${sseResult.timedOut ? '1' : '0'}`);
    } catch (error) {
      attempts.push({
        requestId,
        targetHost,
        error: error.message || String(error),
      });
      errors.push(`${targetHost}: ${error.message || String(error)}`);
    }
  }

  return {
    ok: false,
    text: '',
    errors,
    attempts,
    requestId: attempts[0]?.requestId || '',
    mode,
    targetHost: attempts[0]?.targetHost || '',
    message: errors.join('\n') || 'Relay Agent 通路测试失败',
  };
}

module.exports = {
  DEFAULT_TARGET_HOSTS,
  buildAgentBidiAppendPayload,
  buildAgentExecClientPayload,
  buildAgentExecClientControlPayload,
  mapAgentModeNameToNumber,
  runRelayAgentConnectionTest,
};

const path = require('path');
const protobuf = require('protobufjs');

// ── 新生成的 proto 文件（从 workbench.desktop.main.js 提取）──
const PROTO_REGEN_DIR = path.join(__dirname, '..', '..', 'proto', 'regen');
const PROTO_FILES = [
  path.join(PROTO_REGEN_DIR, 'agent_v1.proto'),
  path.join(PROTO_REGEN_DIR, 'aiserver_v1.proto'),
  path.join(PROTO_REGEN_DIR, 'anyrun_v1.proto'),
  path.join(PROTO_REGEN_DIR, 'internapi_v1.proto'),
];

let rootPromise = null;
let _root = null; // 缓存已解析的 root

function loadCursorProtoRoot() {
  if (!rootPromise) {
    rootPromise = protobuf.load(PROTO_FILES).then((root) => {
      root.resolveAll();
      _root = root;
      return root;
    });
  }
  return rootPromise;
}

function getRootSync() {
  if (!_root) throw new Error('Proto root not loaded yet. Call loadCursorProtoRoot() first.');
  return _root;
}

function getTypeSync(typeName) {
  const root = getRootSync();
  const type = root.lookupType(typeName);
  if (!type) throw new Error(`Missing protobuf type: ${typeName}`);
  return type;
}

function toPlainObject(type, message) {
  return type.toObject(message, {
    longs: String,
    enums: String,
    bytes: String,
    defaults: false,
    arrays: true,
    objects: true,
    oneofs: true,
  });
}

// ═══════════════════════════════════════════════════════════════
//  基础编解码
// ═══════════════════════════════════════════════════════════════

async function decodeMessage(typeName, payload) {
  const root = await loadCursorProtoRoot();
  const type = root.lookupType(typeName);
  const message = type.decode(Buffer.from(payload || []));
  return toPlainObject(type, message);
}

async function encodeMessage(typeName, value) {
  const root = await loadCursorProtoRoot();
  const type = root.lookupType(typeName);
  const error = type.verify(value || {});
  if (error) throw new Error(`Invalid ${typeName}: ${error}`);
  return Buffer.from(type.encode(type.create(value || {})).finish());
}

// 同步版本（需要先确保 root 已加载）
function decodeMessageSync(typeName, payload) {
  const type = getTypeSync(typeName);
  const message = type.decode(Buffer.from(payload || []));
  return toPlainObject(type, message);
}

function encodeMessageSync(typeName, value) {
  const type = getTypeSync(typeName);
  return Buffer.from(type.encode(type.create(value || {})).finish());
}

// ═══════════════════════════════════════════════════════════════
//  Connect 协议帧处理 (长度前缀 + 消息体)
// ═══════════════════════════════════════════════════════════════

/**
 * Connect 协议帧格式: 1字节flags + 4字节BE长度 + payload
 * flags bit 0: 压缩标志
 * 参考 cursor-reverse-notes 文档
 */

// 读取 Connect 帧流，返回 [{flags, payload}], 自动解压
function readConnectFrames(buffer) {
  const frames = [];
  let offset = 0;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  while (offset + 5 <= buf.length) {
    const flags = buf.readUInt8(offset);
    const length = buf.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + length > buf.length) break; // 不完整帧
    let payload = buf.slice(offset, offset + length);
    offset += length;
    // flags bit 0 = 压缩
    if (flags & 1) {
      try {
        const zlib = require('zlib');
        payload = zlib.gunzipSync(payload);
      } catch (e) {
        // 非 gzip，保持原样
      }
    }
    frames.push({ flags, payload });
  }
  return frames;
}

// 构造单个 Connect 帧
function buildConnectFrame(payload, flags = 0) {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// 构造 End 帧 (flags=2, 空payload)
function buildConnectEndFrame() {
  return buildConnectFrame(Buffer.alloc(0), 2);
}

// ═══════════════════════════════════════════════════════════════
//  MITM 类型自动匹配 (service/method → message 类型)
// ═══════════════════════════════════════════════════════════════

// 路径 → service 映射: /aiserver.v1.AiService/AvailableModels → {service:"aiserver.v1.AiService", method:"AvailableModels"}
function parseServiceMethod(httpPath) {
  // 去掉查询参数
  const cleanPath = httpPath.split('?')[0];
  // 匹配 /pkg.svc.Service/Method 或 /pkg.Service/Method
  const m = cleanPath.match(/^\/([^/]+)\/([^/?]+)$/);
  if (!m) return null;
  return { service: m[1], method: m[2] };
}

// service+method → {requestType, responseType, kind}
// 两级策略: 1) ServiceDescriptor 精确查  2) 命名约定猜
let _methodCache = new Map();

async function resolveMethodTypes(service, method) {
  await loadCursorProtoRoot();
  const cacheKey = `${service}/${method}`;
  if (_methodCache.has(cacheKey)) return _methodCache.get(cacheKey);

  let result = null;
  try {
    const svc = _root.lookupService(service);
    if (svc && svc.methods[method]) {
      const m = svc.methods[method];
      result = {
        requestType: m.resolvedRequestType ? m.resolvedRequestType.fullName : m.requestType,
        responseType: m.resolvedResponseType ? m.resolvedResponseType.fullName : m.responseType,
        kind: m.type || 'unary', // unary, server_streaming, etc
      };
    }
  } catch (e) {
    // service 不存在
  }

  // 策略2: 命名约定猜 (Method → MethodRequest / MethodResponse)
  if (!result) {
    const guessReq = `${service}.${method}Request`;
    const guessResp = `${service}.${method}Response`;
    try {
      _root.lookupType(guessReq);
      _root.lookupType(guessResp);
      result = { requestType: guessReq, responseType: guessResp, kind: 'unary' };
    } catch (e) {
      // 猜测失败
    }
  }

  _methodCache.set(cacheKey, result);
  return result;
}

// 同步版本
function resolveMethodTypesSync(service, method) {
  if (!_root) return null;
  const cacheKey = `${service}/${method}`;
  if (_methodCache.has(cacheKey)) return _methodCache.get(cacheKey);

  let result = null;
  try {
    const svc = _root.lookupService(service);
    if (svc && svc.methods[method]) {
      const m = svc.methods[method];
      result = {
        requestType: m.resolvedRequestType ? m.resolvedRequestType.fullName : m.requestType,
        responseType: m.resolvedResponseType ? m.resolvedResponseType.fullName : m.responseType,
        kind: m.type || 'unary',
      };
    }
  } catch (e) {}

  if (!result) {
    const guessReq = `${service}.${method}Request`;
    const guessResp = `${service}.${method}Response`;
    try {
      _root.lookupType(guessReq);
      _root.lookupType(guessResp);
      result = { requestType: guessReq, responseType: guessResp, kind: 'unary' };
    } catch (e) {}
  }

  _methodCache.set(cacheKey, result);
  return result;
}

// 从 HTTP 路径直接解析并获取类型
async function resolveTypesFromPath(httpPath) {
  const sm = parseServiceMethod(httpPath);
  if (!sm) return null;
  return resolveMethodTypes(sm.service, sm.method);
}

function resolveTypesFromPathSync(httpPath) {
  const sm = parseServiceMethod(httpPath);
  if (!sm) return null;
  return resolveMethodTypesSync(sm.service, sm.method);
}

// ═══════════════════════════════════════════════════════════════
//  便捷函数 — 针对常用类型
// ═══════════════════════════════════════════════════════════════

async function decodeAgentServerMessage(payload) {
  return decodeMessage('agent.v1.AgentServerMessage', payload);
}
async function decodeAgentClientMessage(payload) {
  return decodeMessage('agent.v1.AgentClientMessage', payload);
}
async function decodeBidiAppendRequest(payload) {
  return decodeMessage('aiserver.v1.BidiAppendRequest', payload);
}
async function decodeBidiRequestId(payload) {
  return decodeMessage('agent.v1.BidiRequestId', payload);
}

async function encodeAgentServerMessage(value) {
  return encodeMessage('agent.v1.AgentServerMessage', value);
}
async function encodeAgentClientMessage(value) {
  return encodeMessage('agent.v1.AgentClientMessage', value);
}
async function encodeBidiAppendRequest(value) {
  return encodeMessage('aiserver.v1.BidiAppendRequest', value);
}
async function encodeBidiRequestId(value) {
  return encodeMessage('agent.v1.BidiRequestId', value);
}

// 同步便捷函数
function decodeAgentServerMessageSync(payload) {
  return decodeMessageSync('agent.v1.AgentServerMessage', payload);
}
function decodeAgentClientMessageSync(payload) {
  return decodeMessageSync('agent.v1.AgentClientMessage', payload);
}
function decodeBidiAppendRequestSync(payload) {
  return decodeMessageSync('aiserver.v1.BidiAppendRequest', payload);
}
function decodeBidiRequestIdSync(payload) {
  return decodeMessageSync('agent.v1.BidiRequestId', payload);
}

// 解码 BidiAppend 请求并提取内部的 AgentClientMessage
// BidiAppendRequest 格式: {request_id, data(hex), ...}
// data 字段是 hex 编码的 AgentClientMessage
function decodeBidiAppendPayload(buffer) {
  const frames = readConnectFrames(buffer);
  for (const frame of frames) {
    try {
      const bidiReq = decodeMessageSync('aiserver.v1.BidiAppendRequest', frame.payload);
      if (bidiReq.data) {
        // data 可能是 hex 字符串或 Buffer
        let dataBuf;
        if (typeof bidiReq.data === 'string') {
          dataBuf = Buffer.from(bidiReq.data, 'hex');
        } else {
          dataBuf = Buffer.from(bidiReq.data);
        }
        try {
          const clientMsg = decodeAgentClientMessageSync(dataBuf);
          return { requestId: bidiReq.requestId, clientMessage: clientMsg, rawBidiRequest: bidiReq };
        } catch (e) {
          // data 不是 AgentClientMessage
        }
      }
    } catch (e) {
      // 非 BidiAppendRequest
    }
  }
  return null;
}

module.exports = {
  // proto 加载
  loadCursorProtoRoot,
  getRootSync,
  getTypeSync,
  // 基础编解码
  decodeMessage,
  encodeMessage,
  decodeMessageSync,
  encodeMessageSync,
  // Connect 帧
  readConnectFrames,
  buildConnectFrame,
  buildConnectEndFrame,
  // MITM 类型匹配
  parseServiceMethod,
  resolveMethodTypes,
  resolveMethodTypesSync,
  resolveTypesFromPath,
  resolveTypesFromPathSync,
  // 便捷函数 (async)
  decodeAgentServerMessage,
  decodeAgentClientMessage,
  decodeBidiAppendRequest,
  decodeBidiRequestId,
  encodeAgentServerMessage,
  encodeAgentClientMessage,
  encodeBidiAppendRequest,
  encodeBidiRequestId,
  // 便捷函数 (sync)
  decodeAgentServerMessageSync,
  decodeAgentClientMessageSync,
  decodeBidiAppendRequestSync,
  decodeBidiRequestIdSync,
  // BidiAppend 复合解码
  decodeBidiAppendPayload,
};

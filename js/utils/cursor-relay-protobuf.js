const path = require('path');
const protobuf = require('protobufjs');

const PROTO_ROOT = path.join(__dirname, '..', '..', 'proto');
const AGENT_PROTO = path.join(PROTO_ROOT, 'agent_v1.proto');
const AISERVER_PROTO = path.join(PROTO_ROOT, 'aiserver_v1.proto');

let rootPromise = null;

function loadCursorProtoRoot() {
  if (!rootPromise) {
    rootPromise = protobuf.load([AGENT_PROTO, AISERVER_PROTO]).then((root) => root.resolveAll());
  }
  return rootPromise;
}

function getTypeSync(root, typeName) {
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

async function decodeMessage(typeName, payload) {
  const root = await loadCursorProtoRoot();
  const type = getTypeSync(root, typeName);
  const message = type.decode(Buffer.from(payload || []));
  return toPlainObject(type, message);
}

async function encodeMessage(typeName, value) {
  const root = await loadCursorProtoRoot();
  const type = getTypeSync(root, typeName);
  const error = type.verify(value || {});
  if (error) throw new Error(`Invalid ${typeName}: ${error}`);
  return Buffer.from(type.encode(type.create(value || {})).finish());
}

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

module.exports = {
  loadCursorProtoRoot,
  decodeMessage,
  encodeMessage,
  decodeAgentServerMessage,
  decodeAgentClientMessage,
  decodeBidiAppendRequest,
  decodeBidiRequestId,
  encodeAgentServerMessage,
  encodeAgentClientMessage,
  encodeBidiAppendRequest,
  encodeBidiRequestId,
};

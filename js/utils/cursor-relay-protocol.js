const { gunzipSync, inflateSync, brotliDecompressSync } = require('zlib');
const { encodeMessageSync: encodeCursorProtoMessageSync } = require('./cursor-relay-protobuf');

const AGENT_CLIENT_MESSAGE_FIELDS = {
  1: 'run_request',
  2: 'exec_client_message',
  3: 'kv_client_message',
  4: 'conversation_action',
  5: 'exec_client_control_message',
  6: 'interaction_response',
  7: 'client_heartbeat',
  8: 'prewarm_request',
};

const AGENT_SERVER_MESSAGE_FIELDS = {
  1: 'interaction_update',
  2: 'exec_server_message',
  3: 'conversation_checkpoint_update',
  4: 'kv_server_message',
  5: 'exec_server_control_message',
  7: 'interaction_query',
};

const EXEC_SERVER_MESSAGE_FIELDS = {
  2: 'shell_args',
  3: 'write_args',
  4: 'delete_args',
  5: 'grep_args',
  7: 'read_args',
  8: 'ls_args',
  9: 'diagnostics_args',
  10: 'request_context_args',
  11: 'mcp_args',
  14: 'shell_stream_args',
  16: 'background_shell_spawn_args',
  17: 'list_mcp_resources_exec_args',
  18: 'read_mcp_resource_exec_args',
  20: 'fetch_args',
  21: 'record_screen_args',
  22: 'computer_use_args',
  23: 'write_shell_stdin_args',
  27: 'execute_hook_args',
};

const EXEC_CLIENT_RESULT_FIELDS = {
  2: 'shell_result',
  3: 'write_result',
  4: 'delete_result',
  5: 'grep_result',
  7: 'read_result',
  8: 'ls_result',
  9: 'diagnostics_result',
  10: 'request_context_result',
  11: 'mcp_result',
  14: 'shell_stream',
  16: 'background_shell_spawn_result',
  17: 'list_mcp_resources_exec_result',
  18: 'read_mcp_resource_exec_result',
  20: 'fetch_result',
  21: 'record_screen_result',
  22: 'computer_use_result',
  23: 'write_shell_stdin_result',
  27: 'execute_hook_result',
};

const INTERACTION_UPDATE_FIELDS = {
  1: 'text_delta',
  2: 'tool_call_started',
  3: 'tool_call_completed',
  4: 'thinking_delta',
  5: 'thinking_completed',
  7: 'partial_tool_call',
  8: 'token_delta',
  13: 'heartbeat',
  14: 'turn_ended',
  15: 'tool_call_delta',
  16: 'step_started',
  17: 'step_completed',
};

function decodeVarint(data, start = 0) {
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

function concatBytes(parts = []) {
  const buffers = parts
    .filter((part) => part != null)
    .map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)));
  return Buffer.concat(buffers);
}

function encodeBytesField(field, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return concatBytes([
    encodeVarint((field << 3) | 2),
    encodeVarint(payload.length),
    payload,
  ]);
}

function encodeInt32Field(field, value) {
  return concatBytes([
    encodeVarint((field << 3) | 0),
    encodeVarint(Number(value) || 0),
  ]);
}

function encodeBoolField(field, value) {
  return encodeInt32Field(field, value ? 1 : 0);
}

function encodeMessage(fields = []) {
  return concatBytes(fields.map((item) => encodeBytesField(item.field, item.value)));
}

function connectFrame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.allocUnsafe(5);
  header[0] = type;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function readConnectFrames(data) {
  const raw = Buffer.from(data || []);
  const frames = [];
  let pos = 0;
  while (pos + 5 <= raw.length) {
    const type = raw[pos];
    const length = raw.readUInt32BE(pos + 1);
    pos += 5;
    if (pos + length > raw.length) break;
    let payload = raw.subarray(pos, pos + length);
    pos += length;
    try {
      if (type === 1 || type === 3) payload = gunzipSync(payload);
    } catch {
      /* ignore compressed frame decode failures */
    }
    frames.push({ type, payload });
  }
  return frames;
}

function summarizeConnectFrames(data) {
  const raw = Buffer.from(data || []);
  let looksLikeJson = false;
  try {
    const text = raw.toString('utf8').trim();
    looksLikeJson = Boolean(text) && (text.startsWith('{') || text.startsWith('['));
  } catch {
    looksLikeJson = false;
  }
  if (looksLikeJson) {
    return {
      rawLength: raw.length,
      frames: [],
      restLength: raw.length,
      truncated: false,
      format: 'json',
    };
  }
  const frames = [];
  let pos = 0;
  let truncated = false;
  while (pos + 5 <= raw.length) {
    const type = raw[pos];
    const length = raw.readUInt32BE(pos + 1);
    pos += 5;
    if (pos + length > raw.length) {
      truncated = true;
      break;
    }
    frames.push({ index: frames.length, type, length });
    pos += length;
  }
  return {
    rawLength: raw.length,
    frames,
    restLength: Math.max(0, raw.length - pos),
    truncated,
    format: frames.length ? 'envelope' : 'unknown',
  };
}

function parseFields(data) {
  const raw = Buffer.from(data || []);
  const out = [];
  let pos = 0;
  while (pos < raw.length) {
    const [tag, afterTag] = decodeVarint(raw, pos);
    if (afterTag <= pos) break;
    pos = afterTag;
    const field = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const [value, nextPos] = decodeVarint(raw, pos);
      out.push({ field, wireType, varint: value });
      pos = nextPos;
      continue;
    }
    if (wireType === 2) {
      const [length, afterLength] = decodeVarint(raw, pos);
      pos = afterLength;
      if (length < 0 || pos + length > raw.length) break;
      out.push({ field, wireType, bytes: raw.subarray(pos, pos + length) });
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

function decodePrintableUtf8(bytes) {
  const raw = Buffer.from(bytes || []);
  if (!raw.length) return '';
  const text = raw.toString('utf8').replace(/\0/g, '').trim();
  if (!text) return '';
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return '';
  return text;
}

function decodeUtf8Safe(bytes, limit = 160) {
  try {
    return decodeUtf8(bytes).replace(/\0/g, '').trim().slice(0, limit);
  } catch {
    return '';
  }
}

function getFieldNumbers(fields = []) {
  return fields.map((field) => field.field).filter((field) => Number.isFinite(field));
}

function detectOneofField(fields = [], mapping = {}) {
  const fieldNumber = getFieldNumbers(fields).find((field) => Object.prototype.hasOwnProperty.call(mapping, field));
  if (!fieldNumber) return '';
  return mapping[fieldNumber] || `field_${fieldNumber}`;
}

function summarizeFieldShape(fields, depth = 0, maxDepth = 2) {
  return (fields || []).slice(0, 12).map((field) => {
    const entry = {
      field: field.field,
      wireType: field.wireType,
    };
    if (field.wireType === 0) {
      entry.varint = field.varint;
      return entry;
    }
    if (field.wireType !== 2 || !field.bytes) {
      return entry;
    }
    entry.len = field.bytes.length;
    if (depth >= maxDepth || !field.bytes.length) return entry;
    const nested = parseFields(field.bytes);
    if (nested.length) {
      entry.children = summarizeFieldShape(nested, depth + 1, maxDepth);
      return entry;
    }
    const text = decodeUtf8(field.bytes).trim();
    if (text) entry.textPreview = text.slice(0, 80);
    return entry;
  });
}

function summarizeAgentClientMessagePayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const oneofField = fields.find((field) => Object.prototype.hasOwnProperty.call(AGENT_CLIENT_MESSAGE_FIELDS, field.field));
  const out = {
    oneof: detectOneofField(fields, AGENT_CLIENT_MESSAGE_FIELDS),
    fields: getFieldNumbers(fields),
    shape: summarizeFieldShape(fields),
  };
  if (oneofField?.bytes?.length) {
    const innerFields = parseFields(oneofField.bytes);
    out.innerShape = summarizeFieldShape(innerFields);
    if (out.oneof === 'exec_client_message') {
      const resultField = innerFields.find((field) => Object.prototype.hasOwnProperty.call(EXEC_CLIENT_RESULT_FIELDS, field.field));
      const legacyExecId = decodePrintableUtf8(getFieldBytes(innerFields, 1) || Buffer.alloc(0));
      out.execClient = {
        id: getFieldVarint(innerFields, 1) ?? null,
        execId: decodePrintableUtf8(getFieldBytes(innerFields, 15) || Buffer.alloc(0)) || legacyExecId,
        result: resultField ? EXEC_CLIENT_RESULT_FIELDS[resultField.field] : '',
        text: decodeUtf8(getFieldBytes(innerFields, 2) || Buffer.alloc(0)),
      };
      if (resultField?.bytes?.length) {
        out.execClient.resultSummary = summarizeExecClientResult(out.execClient.result, resultField.bytes);
        if (!out.execClient.text) out.execClient.text = out.execClient.resultSummary.text || '';
      }
    } else if (out.oneof === 'exec_client_control_message') {
      const controlOneof = innerFields.find((field) => [1, 2, 3].includes(field.field));
      const controlFields = controlOneof?.bytes?.length ? parseFields(controlOneof.bytes) : [];
      const legacyExecId = decodePrintableUtf8(getFieldBytes(innerFields, 15) || Buffer.alloc(0));
      out.execControl = {
        id: getFieldVarint(controlFields, 1) ?? getFieldVarint(innerFields, 1) ?? null,
        execId: legacyExecId,
        status: innerFields.find((field) => field.field === 2 && field.wireType === 0)?.varint ?? null,
        control: controlOneof ? ({ 1: 'stream_close', 2: 'throw', 3: 'heartbeat' }[controlOneof.field] || '') : '',
        error: decodeUtf8(getFieldBytes(controlFields, 2) || Buffer.alloc(0)).trim(),
      };
    } else if (out.oneof === 'run_request') {
      const requestedModelField = getFieldBytes(innerFields, 9);
      const requestedModelFields = parseFields(requestedModelField || Buffer.alloc(0));
      const conversationStateFields = parseFields(getFieldBytes(innerFields, 8) || Buffer.alloc(0));
      const runMode = getFieldVarint(innerFields, 10);
      const conversationMode = getFieldVarint(conversationStateFields, 10);
      const actionFields = parseFields(getFieldBytes(innerFields, 2) || Buffer.alloc(0));
      out.runRequest = {
        stableConversationId: decodeUtf8(getFieldBytes(innerFields, 5) || Buffer.alloc(0)).trim(),
        requestedModelId: decodeUtf8(getFieldBytes(requestedModelFields, 1) || Buffer.alloc(0)).trim(),
        mode: mapAgentModeNumberToName(runMode || conversationMode || 0),
        action: actionFields.length ? summarizeConversationActionPayload(actionFields) : null,
      };
    } else if (out.oneof === 'conversation_action') {
      out.conversationAction = summarizeConversationActionPayload(innerFields);
    } else if (out.oneof === 'interaction_response') {
      out.interactionResponse = summarizeInteractionResponse(innerFields);
    }
  }
  return out;
}

function summarizeAgentServerMessagePayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const oneofField = fields.find((field) => Object.prototype.hasOwnProperty.call(AGENT_SERVER_MESSAGE_FIELDS, field.field));
  const oneof = oneofField ? AGENT_SERVER_MESSAGE_FIELDS[oneofField.field] : '';
  const out = {
    oneof,
    fields: getFieldNumbers(fields),
    shape: summarizeFieldShape(fields),
  };
  if (oneof === 'exec_server_message' && oneofField?.bytes?.length) {
    const execFields = parseFields(oneofField.bytes);
    const toolField = execFields.find((field) => Object.prototype.hasOwnProperty.call(EXEC_SERVER_MESSAGE_FIELDS, field.field));
    out.execServerMessage = {
      execId: decodeUtf8(getFieldBytes(execFields, 15) || Buffer.alloc(0)).trim(),
      tool: toolField ? EXEC_SERVER_MESSAGE_FIELDS[toolField.field] : '',
      fields: getFieldNumbers(execFields),
      shape: summarizeFieldShape(execFields),
    };
    if (toolField?.bytes?.length) {
      out.execServerMessage.args = summarizeExecServerToolArgs(out.execServerMessage.tool, toolField.bytes);
    }
  }
  if (oneof === 'interaction_update' && oneofField?.bytes?.length) {
    const interactionFields = parseFields(oneofField.bytes);
    out.interactionUpdate = {
      kind: detectOneofField(interactionFields, INTERACTION_UPDATE_FIELDS),
      fields: getFieldNumbers(interactionFields),
      shape: summarizeFieldShape(interactionFields),
    };
  }
  if (oneof === 'interaction_query' && oneofField?.bytes?.length) {
    out.interactionQuery = summarizeInteractionQuery(oneofField.bytes);
  }
  return out;
}

function getFieldVarint(fields, fieldNumber) {
  return fields.find((field) => field.field === fieldNumber && field.wireType === 0)?.varint;
}

function summarizeAskQuestionArgsPayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const argsFields = parseFields(getFieldBytes(fields, 1) || Buffer.alloc(0));
  const questions = argsFields
    .filter((field) => field.field === 2 && field.wireType === 2)
    .map((field) => {
      const questionFields = parseFields(field.bytes);
      return {
        id: decodeUtf8(getFieldBytes(questionFields, 1) || Buffer.alloc(0)).trim(),
        prompt: decodeUtf8(getFieldBytes(questionFields, 2) || Buffer.alloc(0)).trim(),
        allowMultiple: Boolean(getFieldVarint(questionFields, 4)),
        options: questionFields
          .filter((optionField) => optionField.field === 3 && optionField.wireType === 2)
          .map((optionField) => {
            const optionFields = parseFields(optionField.bytes);
            return {
              id: decodeUtf8(getFieldBytes(optionFields, 1) || Buffer.alloc(0)).trim(),
              label: decodeUtf8(getFieldBytes(optionFields, 2) || Buffer.alloc(0)).trim(),
            };
          }),
      };
    });
  return {
    title: decodeUtf8(getFieldBytes(argsFields, 1) || Buffer.alloc(0)).trim(),
    questions,
    toolCallId: decodeUtf8(getFieldBytes(fields, 2) || Buffer.alloc(0)).trim(),
  };
}

function summarizeCreatePlanArgsPayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const argsFields = parseFields(getFieldBytes(fields, 1) || Buffer.alloc(0));
  const todos = argsFields
    .filter((field) => field.field === 2 && field.wireType === 2)
    .map((field) => {
      const todoFields = parseFields(field.bytes);
      return {
        id: decodeUtf8(getFieldBytes(todoFields, 1) || Buffer.alloc(0)).trim(),
        content: decodeUtf8(getFieldBytes(todoFields, 2) || Buffer.alloc(0)).trim(),
        status: decodeUtf8(getFieldBytes(todoFields, 3) || Buffer.alloc(0)).trim(),
      };
    });
  return {
    plan: decodeUtf8(getFieldBytes(argsFields, 1) || Buffer.alloc(0)).trim(),
    todos,
    overview: decodeUtf8(getFieldBytes(argsFields, 3) || Buffer.alloc(0)).trim(),
    name: decodeUtf8(getFieldBytes(argsFields, 4) || Buffer.alloc(0)).trim(),
    toolCallId: decodeUtf8(getFieldBytes(fields, 2) || Buffer.alloc(0)).trim(),
  };
}

function summarizeTaskArgsPayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const argsFields = parseFields(getFieldBytes(fields, 1) || Buffer.alloc(0));
  const subagentTypeValue = decodeUtf8(getFieldBytes(argsFields, 3) || Buffer.alloc(0)).trim();
  const subagentType = subagentTypeValue ? { [subagentTypeValue]: subagentTypeValue } : {};
  return {
    description: decodeUtf8(getFieldBytes(argsFields, 1) || Buffer.alloc(0)).trim(),
    prompt: decodeUtf8(getFieldBytes(argsFields, 2) || Buffer.alloc(0)).trim(),
    subagentType,
    model: decodeUtf8(getFieldBytes(argsFields, 4) || Buffer.alloc(0)).trim(),
    name: decodeUtf8(getFieldBytes(argsFields, 5) || Buffer.alloc(0)).trim(),
    toolCallId: decodeUtf8(getFieldBytes(fields, 2) || Buffer.alloc(0)).trim(),
  };
}

function summarizeReportBugfixResultsArgsPayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const argsFields = parseFields(getFieldBytes(fields, 1) || Buffer.alloc(0));
  const results = argsFields
    .filter((field) => field.field === 2 && field.wireType === 2)
    .map((field) => {
      const resultFields = parseFields(field.bytes);
      return {
        title: decodeUtf8(getFieldBytes(resultFields, 1) || Buffer.alloc(0)).trim(),
        summary: decodeUtf8(getFieldBytes(resultFields, 2) || Buffer.alloc(0)).trim(),
        status: decodeUtf8(getFieldBytes(resultFields, 3) || Buffer.alloc(0)).trim(),
      };
    });
  return {
    summary: decodeUtf8(getFieldBytes(argsFields, 1) || Buffer.alloc(0)).trim(),
    results,
    toolCallId: decodeUtf8(getFieldBytes(fields, 2) || Buffer.alloc(0)).trim(),
  };
}

function summarizeAskQuestionInteractionResponsePayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const resultFields = parseFields(getFieldBytes(fields, 1) || Buffer.alloc(0));
  const answers = parseFields(getFieldBytes(resultFields, 1) || Buffer.alloc(0))
    .filter((field) => field.field === 1 && field.wireType === 2)
    .map((field) => {
      const answerFields = parseFields(field.bytes);
      return {
        questionId: decodeUtf8(getFieldBytes(answerFields, 1) || Buffer.alloc(0)).trim(),
        selectedOptionIds: answerFields
          .filter((answerField) => answerField.field === 2 && answerField.wireType === 2)
          .map((answerField) => decodeUtf8(answerField.bytes || Buffer.alloc(0)).trim())
          .filter(Boolean),
        freeformText: decodeUtf8(getFieldBytes(answerFields, 3) || Buffer.alloc(0)).trim(),
      };
    });
  return {
    kind: getFieldBytes(resultFields, 1)
      ? 'success'
      : getFieldBytes(resultFields, 2)
        ? 'error'
        : getFieldBytes(resultFields, 3)
          ? 'rejected'
          : getFieldBytes(resultFields, 4)
            ? 'async'
            : '',
    error: decodeUtf8(getFieldBytes(parseFields(getFieldBytes(resultFields, 2) || Buffer.alloc(0)), 1) || Buffer.alloc(0)).trim(),
    rejectedReason: decodeUtf8(getFieldBytes(parseFields(getFieldBytes(resultFields, 3) || Buffer.alloc(0)), 1) || Buffer.alloc(0)).trim(),
    answers,
  };
}

function summarizeCreatePlanInteractionResponsePayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const resultFields = parseFields(getFieldBytes(fields, 1) || Buffer.alloc(0));
  return {
    kind: getFieldBytes(resultFields, 1) ? 'success' : getFieldBytes(resultFields, 2) ? 'error' : '',
    planUri: decodeUtf8(getFieldBytes(resultFields, 3) || Buffer.alloc(0)).trim(),
    error: decodeUtf8(getFieldBytes(parseFields(getFieldBytes(resultFields, 2) || Buffer.alloc(0)), 1) || Buffer.alloc(0)).trim(),
  };
}

function summarizeInteractionResponse(fields = []) {
  const askPayload = getFieldBytes(fields, 3);
  const createPlanPayload = getFieldBytes(fields, 7);
  const webSearchPayload = getFieldBytes(fields, 2);
  return {
    id: getFieldVarint(fields, 1) ?? null,
    kind: askPayload
      ? 'ask_question_interaction_response'
      : createPlanPayload
        ? 'create_plan_request_response'
        : webSearchPayload
          ? 'web_search_request_response'
          : '',
    askQuestion: askPayload ? summarizeAskQuestionInteractionResponsePayload(askPayload) : null,
    createPlan: createPlanPayload ? summarizeCreatePlanInteractionResponsePayload(createPlanPayload) : null,
    webSearchApproved: Boolean(webSearchPayload && getFieldBytes(parseFields(webSearchPayload), 1)),
  };
}

function summarizeInteractionQuery(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const askPayload = getFieldBytes(fields, 3);
  const createPlanPayload = getFieldBytes(fields, 7);
  const webSearchPayload = getFieldBytes(fields, 2);
  const taskPayload = getFieldBytes(fields, 19);
  const taskV2Payload = getFieldBytes(fields, 69);
  const reportBugfixPayload = getFieldBytes(fields, 78);
  return {
    id: getFieldVarint(fields, 1) ?? null,
    kind: askPayload
      ? 'ask_question_interaction_query'
      : createPlanPayload
        ? 'create_plan_request_query'
        : taskV2Payload || taskPayload
          ? 'task_tool_query'
          : reportBugfixPayload
            ? 'report_bugfix_results_query'
        : webSearchPayload
          ? 'web_search_request_query'
          : '',
    askQuestion: askPayload ? summarizeAskQuestionArgsPayload(askPayload) : null,
    createPlan: createPlanPayload ? summarizeCreatePlanArgsPayload(createPlanPayload) : null,
    task: taskV2Payload
      ? summarizeTaskArgsPayload(taskV2Payload)
      : taskPayload
        ? summarizeTaskArgsPayload(taskPayload)
        : null,
    reportBugfixResults: reportBugfixPayload ? summarizeReportBugfixResultsArgsPayload(reportBugfixPayload) : null,
    webSearch: webSearchPayload
      ? {
          searchTerm: decodeUtf8(getFieldBytes(parseFields(webSearchPayload), 1) || Buffer.alloc(0)).trim(),
        }
      : null,
  };
}

function summarizeExecServerToolArgs(tool, payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const textField = (fieldNumber, limit = 220) => {
    const text = decodeUtf8(getFieldBytes(fields, fieldNumber) || Buffer.alloc(0)).trim();
    return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
  };
  const base = {};
  switch (tool) {
    case 'grep_args':
      base.path = textField(2);
      base.glob = textField(3);
      base.outputMode = textField(4);
      base.toolCallId = textField(14);
      break;
    case 'read_args':
      base.path = textField(1);
      base.toolCallId = textField(2);
      base.offset = getFieldVarint(fields, 4);
      base.limit = getFieldVarint(fields, 5);
      break;
    case 'write_args':
      base.path = textField(1);
      base.fileTextBytes = getFieldBytes(fields, 2)?.length || 0;
      base.toolCallId = textField(3);
      break;
    case 'delete_args':
      base.path = textField(1);
      base.toolCallId = textField(2);
      break;
    case 'shell_stream_args':
      base.command = textField(1);
      base.timeoutMs = getFieldVarint(fields, 3);
      base.toolCallId = textField(4);
      base.description = textField(15);
      break;
    case 'shell_args':
      base.command = textField(1);
      base.cwd = textField(2);
      base.timeoutMs = getFieldVarint(fields, 3);
      base.toolCallId = textField(4);
      break;
    case 'ls_args':
      base.path = textField(1);
      base.toolCallId = textField(3);
      break;
    case 'diagnostics_args':
      base.path = textField(1);
      base.toolCallId = textField(2);
      break;
    default:
      base.fields = getFieldNumbers(fields);
      break;
  }
  Object.keys(base).forEach((key) => {
    if (base[key] == null || base[key] === '') delete base[key];
  });
  return base;
}

function collectStringFields(fields = [], depth = 0, maxDepth = 4, out = []) {
  if (depth > maxDepth || out.length >= 80) return out;
  for (const field of fields || []) {
    if (out.length >= 80) break;
    if (field.wireType !== 2 || !field.bytes?.length) continue;
    const nested = parseFields(field.bytes);
    if (nested.length) {
      collectStringFields(nested, depth + 1, maxDepth, out);
      continue;
    }
    const text = decodeUtf8(field.bytes).replace(/\0/g, '').trim();
    if (text && /[\p{L}\p{N}_./\\:-]/u.test(text)) out.push(text);
  }
  return out;
}

function summarizeLsDirectoryNode(payload, depth = 0, maxDepth = 3) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const absPath = decodeUtf8(getFieldBytes(fields, 1) || Buffer.alloc(0)).trim();
  const lines = [];
  if (absPath && depth === 0) lines.push(absPath);
  if (depth > maxDepth) return { absPath, text: lines.join('\n') };
  const dirs = fields.filter((field) => field.field === 2 && field.wireType === 2 && field.bytes?.length);
  const files = fields.filter((field) => field.field === 3 && field.wireType === 2 && field.bytes?.length);
  for (const dir of dirs.slice(0, 80)) {
    const child = summarizeLsDirectoryNode(dir.bytes, depth + 1, maxDepth);
    const name = child.absPath ? child.absPath.split(/[\\/]+/).filter(Boolean).pop() : '';
    if (name) lines.push(`${'  '.repeat(depth)}[dir] ${name}`);
    if (child.text) {
      const childLines = child.text.split(/\r?\n/).filter(Boolean);
      lines.push(...childLines.slice(depth === 0 ? 1 : 0).map((line) => `${'  '.repeat(depth + 1)}${line}`));
    }
  }
  for (const file of files.slice(0, 160)) {
    const fileFields = parseFields(file.bytes);
    const name = decodeUtf8(getFieldBytes(fileFields, 1) || Buffer.alloc(0)).trim();
    if (name) lines.push(`${'  '.repeat(depth)}${name}`);
  }
  return { absPath, text: lines.join('\n') };
}

function summarizeExecClientResult(result, payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const textFromFields = () => collectStringFields(fields).join('\n');
  if (result === 'read_result') {
    const success = getFieldBytes(fields, 1);
    const error = getFieldBytes(fields, 2) || getFieldBytes(fields, 3) || getFieldBytes(fields, 4) || getFieldBytes(fields, 5) || getFieldBytes(fields, 6);
    if (success?.length) {
      const successFields = parseFields(success);
      const pathText = decodeUtf8(getFieldBytes(successFields, 1) || Buffer.alloc(0)).trim();
      const content = decodeUtf8(getFieldBytes(successFields, 2) || getFieldBytes(successFields, 5) || Buffer.alloc(0));
      return {
        ok: true,
        path: pathText,
        text: [pathText ? `Read ${pathText}` : '', content].filter(Boolean).join('\n\n'),
      };
    }
    return { ok: false, text: error?.length ? collectStringFields(parseFields(error)).join('\n') : textFromFields() };
  }
  if (result === 'ls_result') {
    const success = getFieldBytes(fields, 1) || getFieldBytes(fields, 4);
    const error = getFieldBytes(fields, 2) || getFieldBytes(fields, 3);
    if (success?.length) {
      const successFields = parseFields(success);
      const root = getFieldBytes(successFields, 1);
      const tree = summarizeLsDirectoryNode(root || success);
      return { ok: true, path: tree.absPath, text: tree.text || textFromFields() };
    }
    return { ok: false, text: error?.length ? collectStringFields(parseFields(error)).join('\n') : textFromFields() };
  }
  if (result === 'grep_result') {
    return { ok: true, text: textFromFields() };
  }
  if (result === 'shell_stream' || result === 'shell_result') {
    return { ok: true, text: textFromFields() };
  }
  return { ok: true, text: textFromFields() };
}

function incrementCount(bucket, key) {
  const normalized = key == null || key === '' ? 'unknown' : String(key).trim() || 'unknown';
  bucket[normalized] = (bucket[normalized] || 0) + 1;
}

function summarizeAgentServerStream(data, options = {}) {
  const frames = readConnectFrames(data);
  const maxSamples = Math.max(0, Number(options.maxSamples) || 8);
  const summary = {
    rawLength: Buffer.from(data || []).length,
    frameCount: frames.length,
    frameTypes: {},
    serverMessages: {},
    interactionUpdates: {},
    execServerTools: {},
    connectErrors: [],
    samples: [],
  };

  frames.forEach((frame, index) => {
    incrementCount(summary.frameTypes, frame.type);
    if (frame.type === 3 || frame.type === 2) {
      try {
        const parsed = JSON.parse(Buffer.from(frame.payload || []).toString('utf8'));
        const error = parsed?.error || parsed;
        if (error && typeof error === 'object') {
          const details = Array.isArray(error.details) ? error.details : [];
          const debug = details.find((item) => item?.debug)?.debug || {};
          const item = {
            index,
            code: String(error.code || ''),
            message: String(error.message || ''),
            debugError: String(debug.error || ''),
            title: String(debug.details?.title || ''),
            detail: String(debug.details?.detail || ''),
          };
          if (item.code || item.message || item.debugError || item.title || item.detail) {
            summary.connectErrors.push(item);
          }
        }
      } catch {
        const text = decodeUtf8Safe(frame.payload, 300);
        if (text) summary.connectErrors.push({ index, text });
      }
      return;
    }
    if (frame.type !== 0 && frame.type !== 1) return;
    const server = summarizeAgentServerMessagePayload(frame.payload);
    incrementCount(summary.serverMessages, server.oneof || 'unknown');
    if (server.interactionUpdate?.kind) {
      incrementCount(summary.interactionUpdates, server.interactionUpdate.kind);
    }
    if (server.execServerMessage?.tool) {
      incrementCount(summary.execServerTools, server.execServerMessage.tool);
    }
    if (summary.samples.length < maxSamples) {
      summary.samples.push({
        index,
        type: frame.type,
        oneof: server.oneof || '',
        interaction: server.interactionUpdate?.kind || '',
        execTool: server.execServerMessage?.tool || '',
        execId: server.execServerMessage?.execId || '',
        execArgs: server.execServerMessage?.args || undefined,
        length: frame.payload?.length || 0,
      });
    }
  });

  return summary;
}

function collectTextParts(fields = []) {
  const chunks = [];
  fields.forEach((field) => {
    if (field.wireType !== 2 || !field.bytes?.length) return;
    const nested = parseFields(field.bytes);
    const direct = decodeUtf8(getFieldBytes(nested, 1) || field.bytes);
    if (direct.trim()) chunks.push(direct);
    nested
      .filter((item) => item.field === 1 && item.wireType === 2 && item.bytes?.length)
      .forEach((item) => {
        const text = decodeUtf8(getFieldBytes(parseFields(item.bytes), 1) || item.bytes);
        if (text.trim()) chunks.push(text);
      });
  });
  return chunks.join('\n').trim();
}

function normalizeRole(roleValue) {
  return roleValue === 2 ? 'assistant' : 'user';
}

function decodeCursorChatRequest(bodyBuffer) {
  const frames = readConnectFrames(bodyBuffer);
  const messageFrame = frames.find((frame) => frame.type === 0 || frame.type === 1);
  if (!messageFrame) {
    return {
      model: 'default',
      conversationId: '',
      messages: [{ role: 'user', content: '' }],
    };
  }

  const frameFields = parseFields(messageFrame.payload);
  const requestPayload = getFieldBytes(frameFields, 1) || messageFrame.payload;
  const requestFields = parseFields(requestPayload);
  const messages = requestFields
    .filter((field) => field.field === 1 && field.wireType === 2 && field.bytes?.length)
    .map((field) => {
      const messageFields = parseFields(field.bytes);
      return {
        role: normalizeRole(messageFields.find((item) => item.field === 2)?.varint),
        content: collectTextParts(messageFields),
      };
    })
    .filter((message) => message.content.trim());

  const modelFields = parseFields(getFieldBytes(requestFields, 5) || Buffer.alloc(0));
  const model = decodeUtf8(getFieldBytes(modelFields, 1) || Buffer.from('default'));
  const conversationId = decodeUtf8(getFieldBytes(requestFields, 23) || Buffer.alloc(0));

  return {
    model: model || 'default',
    conversationId,
    messages: messages.length ? messages : [{ role: 'user', content: '' }],
  };
}

function extractUserTextFromConversationAction(convAction) {
  return String(summarizeConversationActionPayload(convAction)?.userText || '').trim();
}

function extractUserTextFromAgentPayload(payload) {
  if (!payload?.length) return '';
  const fields = parseFields(payload);
  const runRequest = getFieldBytes(fields, 1);
  if (runRequest?.length) {
    const runFields = parseFields(runRequest);
    const convAction = getFieldBytes(runFields, 2);
    if (convAction?.length) {
      const text = extractUserTextFromConversationAction(convAction);
      if (text) return text;
    }
  }
  const convAction = getFieldBytes(fields, 4);
  if (convAction?.length) {
    const text = extractUserTextFromConversationAction(convAction);
    if (text) return text;
  }
  return collectTextParts(fields);
}

function summarizeUserMessagePayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  return {
    text: decodeUtf8(getFieldBytes(fields, 1) || Buffer.alloc(0)).trim(),
    messageId: decodeUtf8(getFieldBytes(fields, 2) || Buffer.alloc(0)).trim(),
    mode: mapAgentModeNumberToName(getFieldVarint(fields, 4) || 0),
    richText: decodeUtf8(getFieldBytes(fields, 8) || Buffer.alloc(0)).trim(),
  };
}

function summarizeConversationPlanPayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  return {
    plan: decodeUtf8(getFieldBytes(fields, 1) || Buffer.alloc(0)).trim(),
  };
}

function summarizeRequestContextPayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const envFields = parseFields(getFieldBytes(fields, 4) || Buffer.alloc(0));
  return {
    workspacePaths: envFields
      .filter((field) => field.field === 2 && field.wireType === 2)
      .map((field) => decodeUtf8(field.bytes || Buffer.alloc(0)).trim())
      .filter(Boolean),
    projectFolder: decodeUtf8(getFieldBytes(envFields, 11) || Buffer.alloc(0)).trim(),
    shell: decodeUtf8(getFieldBytes(envFields, 3) || Buffer.alloc(0)).trim(),
    timeZone: decodeUtf8(getFieldBytes(envFields, 10) || Buffer.alloc(0)).trim(),
    userIntentSummary: decodeUtf8(getFieldBytes(fields, 21) || Buffer.alloc(0)).trim(),
  };
}

function summarizeConversationActionPayload(payload) {
  const fields = Array.isArray(payload) ? payload : parseFields(payload || Buffer.alloc(0));
  const actionField = fields.find((field) => [1, 2, 3, 4, 5, 6, 7, 8, 10].includes(field.field) && field.wireType === 2);
  const kind = actionField
    ? ({
      1: 'user_message_action',
      2: 'resume_action',
      3: 'cancel_action',
      4: 'summarize_action',
      5: 'shell_command_action',
      6: 'start_plan_action',
      7: 'execute_plan_action',
      8: 'async_ask_question_completion_action',
      10: 'cancel_subagent_action',
    }[actionField.field] || '')
    : '';
  const summary = {
    kind,
    userText: '',
    cancelReason: '',
    executionMode: 'AGENT_MODE_UNSPECIFIED',
    plan: '',
    planFileUri: '',
    planFileContent: '',
    isSpec: false,
    messageId: '',
    requestContext: null,
    fields: getFieldNumbers(fields),
  };
  if (!actionField?.bytes?.length) return summary;
  const actionFields = parseFields(actionField.bytes);
  switch (kind) {
    case 'user_message_action': {
      const userMessage = summarizeUserMessagePayload(getFieldBytes(actionFields, 1) || Buffer.alloc(0));
      summary.userText = userMessage.text;
      summary.messageId = userMessage.messageId;
      summary.executionMode = userMessage.mode;
      summary.requestContext = summarizeRequestContextPayload(getFieldBytes(actionFields, 2) || Buffer.alloc(0));
      break;
    }
    case 'start_plan_action': {
      const userMessage = summarizeUserMessagePayload(getFieldBytes(actionFields, 1) || Buffer.alloc(0));
      summary.userText = userMessage.text;
      summary.messageId = userMessage.messageId;
      summary.executionMode = userMessage.mode;
      summary.isSpec = Boolean(getFieldVarint(actionFields, 3));
      summary.requestContext = summarizeRequestContextPayload(getFieldBytes(actionFields, 2) || Buffer.alloc(0));
      break;
    }
    case 'execute_plan_action': {
      const planSummary = summarizeConversationPlanPayload(getFieldBytes(actionFields, 2) || Buffer.alloc(0));
      summary.plan = planSummary.plan;
      summary.planFileUri = decodeUtf8(getFieldBytes(actionFields, 3) || Buffer.alloc(0)).trim();
      summary.planFileContent = decodeUtf8(getFieldBytes(actionFields, 4) || Buffer.alloc(0)).trim();
      summary.executionMode = mapAgentModeNumberToName(getFieldVarint(actionFields, 5) || 0);
      summary.requestContext = summarizeRequestContextPayload(getFieldBytes(actionFields, 1) || Buffer.alloc(0));
      break;
    }
    case 'cancel_action':
      summary.cancelReason = decodeUtf8(getFieldBytes(actionFields, 1) || Buffer.alloc(0)).trim();
      break;
    case 'resume_action':
      summary.requestContext = summarizeRequestContextPayload(getFieldBytes(actionFields, 2) || Buffer.alloc(0));
      break;
    case 'cancel_subagent_action':
      summary.subagentId = decodeUtf8(getFieldBytes(actionFields, 1) || Buffer.alloc(0)).trim();
      break;
    default:
      break;
  }
  return summary;
}

function mapAgentModeNumberToName(value) {
  switch (Number(value) || 0) {
    case 1:
      return 'AGENT_MODE_AGENT';
    case 2:
      return 'AGENT_MODE_ASK';
    case 3:
      return 'AGENT_MODE_PLAN';
    case 4:
      return 'AGENT_MODE_DEBUG';
    case 5:
      return 'AGENT_MODE_TRIAGE';
    case 6:
      return 'AGENT_MODE_PROJECT';
    case 7:
      return 'AGENT_MODE_MULTITASK';
    default:
      return 'AGENT_MODE_UNSPECIFIED';
  }
}

function extractAgentModeFromPayload(payload) {
  if (!payload?.length) return 'AGENT_MODE_UNSPECIFIED';
  const fields = parseFields(payload);
  const runRequest = getFieldBytes(fields, 1);
  if (runRequest?.length) {
    const runFields = parseFields(runRequest);
    const directMode = mapAgentModeNumberToName(getFieldVarint(runFields, 10));
    if (directMode !== 'AGENT_MODE_UNSPECIFIED') return directMode;
    const convAction = getFieldBytes(runFields, 2);
    if (convAction?.length) {
      const convFields = parseFields(convAction);
      const userAction = getFieldBytes(convFields, 1);
      if (userAction?.length) {
        const userActionFields = parseFields(userAction);
        const userMessage = getFieldBytes(userActionFields, 1);
        if (userMessage?.length) {
          const userFields = parseFields(userMessage);
          const userMode = mapAgentModeNumberToName(getFieldVarint(userFields, 4));
          if (userMode !== 'AGENT_MODE_UNSPECIFIED') return userMode;
        }
      }
    }
    const conversationStateFields = parseFields(getFieldBytes(runFields, 8) || Buffer.alloc(0));
    const stateMode = mapAgentModeNumberToName(getFieldVarint(conversationStateFields, 10));
    if (stateMode !== 'AGENT_MODE_UNSPECIFIED') return stateMode;
  }
  const convAction = getFieldBytes(fields, 4);
  if (convAction?.length) {
    const convFields = parseFields(convAction);
    const userAction = getFieldBytes(convFields, 1);
    if (userAction?.length) {
      const userActionFields = parseFields(userAction);
      const userMessage = getFieldBytes(userActionFields, 1);
      if (userMessage?.length) {
        const userFields = parseFields(userMessage);
        const userMode = mapAgentModeNumberToName(getFieldVarint(userFields, 4));
        if (userMode !== 'AGENT_MODE_UNSPECIFIED') return userMode;
      }
    }
  }
  return 'AGENT_MODE_UNSPECIFIED';
}

function unwrapBidiDataField(dataBytes) {
  if (!dataBytes?.length) return Buffer.alloc(0);
  const asText = decodeUtf8(dataBytes).trim();
  if (!asText) return dataBytes;
  if (/^[0-9a-f\s]+$/i.test(asText)) {
    const normalizedHex = asText.replace(/\s/g, '');
    if (normalizedHex.length >= 4 && normalizedHex.length % 2 === 0) {
      try {
        const decoded = Buffer.from(normalizedHex, 'hex');
        if (decoded.length && parseFields(decoded).length) return decoded;
      } catch {
        /* ignore */
      }
    }
  }
  if (asText.startsWith('{') || asText.startsWith('[')) {
    try {
      const json = JSON.parse(asText);
      if (json?.data) {
        const inner = String(json.data);
        if (/^[A-Za-z0-9+/=\r\n]+$/.test(inner)) {
          try {
            const decoded = Buffer.from(inner.replace(/\s/g, ''), 'base64');
            if (decoded.length) return decoded;
          } catch {
            /* ignore */
          }
        }
        return Buffer.from(inner, 'utf8');
      }
    } catch {
      /* ignore */
    }
  }
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(asText) && asText.length > 16) {
    try {
      const decoded = Buffer.from(asText.replace(/\s/g, ''), 'base64');
      if (decoded.length) return decoded;
    } catch {
      /* ignore */
    }
  }
  return dataBytes;
}

function collectUuidCandidatesFromBuffers(buffers = []) {
  const seen = new Set();
  const out = [];
  buffers.forEach((buffer) => {
    if (!buffer?.length) return;
    const text = decodeUtf8Safe(buffer, 200000);
    [...text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)]
      .map((match) => match[0].toLowerCase())
      .forEach((uuid) => {
        if (seen.has(uuid)) return;
        seen.add(uuid);
        out.push(uuid);
      });
  });
  return out.slice(0, 32);
}

function inferMimeTypeFromBytes(data) {
  const bytes = Buffer.from(data || []);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  return '';
}

function getPngDimensions(data) {
  const bytes = Buffer.from(data || []);
  if (bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function getGifDimensions(data) {
  const bytes = Buffer.from(data || []);
  if (bytes.length < 10 || !/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function getJpegDimensions(data) {
  const bytes = Buffer.from(data || []);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function getImageDimensions(data) {
  return getPngDimensions(data) || getJpegDimensions(data) || getGifDimensions(data) || null;
}

function summarizeSelectedImagesFromAgentPayload(payload) {
  const fields = parseFields(payload || Buffer.alloc(0));
  const runRequest = getFieldBytes(fields, 1);
  if (!runRequest?.length) return [];
  const runFields = parseFields(runRequest);
  const convAction = getFieldBytes(runFields, 2);
  if (!convAction?.length) return [];
  const convFields = parseFields(convAction);
  const userAction = getFieldBytes(convFields, 1);
  if (!userAction?.length) return [];
  const userActionFields = parseFields(userAction);
  const userMessage = getFieldBytes(userActionFields, 1);
  if (!userMessage?.length) return [];
  const userFields = parseFields(userMessage);
  const selectedContext = getFieldBytes(userFields, 3);
  if (!selectedContext?.length) return [];
  const selectedContextFields = parseFields(selectedContext);
  return selectedContextFields
    .filter((field) => field.field === 1 && field.wireType === 2 && field.bytes?.length)
    .map((field) => {
      const imageFields = parseFields(field.bytes);
      const directData = getFieldBytes(imageFields, 8);
      const blobWithData = getFieldBytes(imageFields, 9);
      let blobId = getFieldBytes(imageFields, 1) || Buffer.alloc(0);
      let data = directData || Buffer.alloc(0);
      if (blobWithData?.length) {
        const blobFields = parseFields(blobWithData);
        blobId = getFieldBytes(blobFields, 1) || blobId;
        data = getFieldBytes(blobFields, 2) || data;
      }
      const dimensionFields = parseFields(getFieldBytes(imageFields, 4) || Buffer.alloc(0));
      const inferredDimensions = getImageDimensions(data);
      const mimeType = decodeUtf8(getFieldBytes(imageFields, 7) || Buffer.alloc(0)).trim()
        || inferMimeTypeFromBytes(data);
      return {
        uuid: decodeUtf8(getFieldBytes(imageFields, 2) || Buffer.alloc(0)).trim(),
        path: decodeUtf8(getFieldBytes(imageFields, 3) || Buffer.alloc(0)).trim(),
        mimeType,
        width: getFieldVarint(dimensionFields, 1) || inferredDimensions?.width || 0,
        height: getFieldVarint(dimensionFields, 2) || inferredDimensions?.height || 0,
        dataBase64: data?.length ? Buffer.from(data).toString('base64') : '',
        blobIdBase64: blobId?.length ? Buffer.from(blobId).toString('base64') : '',
        byteLength: data?.length || 0,
      };
    })
    .filter((image) => image.dataBase64 || image.path || image.uuid);
}

function collectStringFieldsFromMessage(bytes, options = {}) {
  const maxDepth = Math.max(1, Number(options.maxDepth) || 12);
  const maxItems = Math.max(1, Number(options.maxItems) || 300);
  const out = [];
  const seen = new Set();

  function isReadableText(text) {
    if (!text || text.length < 3 || text.length > 10000) return false;
    if (text.includes('\ufffd')) return false;
    if (!/[A-Za-z\u4e00-\u9fff]/u.test(text)) return false;
    return /^[\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+$/u.test(text);
  }

  function walk(buffer, fieldPath, depth) {
    if (!buffer?.length || depth > maxDepth || out.length >= maxItems) return;
    const fields = parseFields(buffer);
    if (!fields.length) return;
    fields.forEach((field) => {
      if (out.length >= maxItems || field.wireType !== 2 || !field.bytes?.length) return;
      const nextPath = fieldPath ? `${fieldPath}.${field.field}` : String(field.field);
      const text = decodeUtf8(field.bytes).replace(/\0/g, '').trim();
      if (isReadableText(text)) {
        const key = `${nextPath}:${text}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ fieldPath: nextPath, text });
        }
      }
      if (parseFields(field.bytes).length) {
        walk(field.bytes, nextPath, depth + 1);
      }
    });
  }

  walk(Buffer.from(bytes || []), '', 0);
  return out;
}

function extractWorkspaceRootFromAgentPayload(payload) {
  if (!payload?.length) return '';
  const strings = collectStringFieldsFromMessage(payload, { maxDepth: 12, maxItems: 500 });
  const pathCandidates = [];

  strings.forEach((item) => {
    const text = String(item.text || '').trim();
    const windowsMatches = text.match(/[a-zA-Z]:\\[^\r\n"'<>|*?]+/g) || [];
    windowsMatches.forEach((candidate) => pathCandidates.push(candidate.trim()));
    const fileMatches = text.match(/file:\/\/\/[^\s\r\n"'<>]+/gi) || [];
    fileMatches.forEach((candidate) => {
      try {
        pathCandidates.push(decodeURIComponent(candidate.replace(/^file:\/\/\//i, '').replace(/^\/([a-zA-Z]:)/, '$1')).replace(/\//g, '\\'));
      } catch {
        pathCandidates.push(candidate.replace(/^file:\/\/\//i, '').replace(/\//g, '\\'));
      }
    });
  });

  const normalized = new Map();
  pathCandidates.forEach((candidate) => {
    let value = String(candidate || '').replace(/\//g, '\\').replace(/[\\\s]+$/g, '').trim();
    if (!/^[a-zA-Z]:\\/.test(value)) return;
    if (/\\\.(?:cursor|codex)(?:\\|$)/i.test(value)) return;
    if (/\\\.claude\\skills(?:\\|$)/i.test(value)) return;
    if (/\\\.cursorpool(?:\\|$)/i.test(value)) return;
    value = value.replace(/\\(?:\.cursor|node_modules|\.git|agent-notes|agent-transcripts|terminals)(?:\\.*)?$/i, '');
    const basename = value.split('\\').pop() || '';
    if (/\.[a-z0-9]{1,8}$/i.test(basename)) value = value.replace(/\\[^\\]+$/, '');
    if (!value) return;
    const key = value.toLowerCase();
    normalized.set(key, {
      value,
      count: (normalized.get(key)?.count || 0) + 1,
    });
  });

  const candidates = Array.from(normalized.values());
  if (!candidates.length) return '';
  const scoreCandidate = (entry) => {
    const value = entry.value;
    const lower = value.toLowerCase();
    const internalCursorPath = /\\\.(?:cursor|codex)(?:\\|$)/i.test(value);
    const internalRelayPath = /\\\.(?:claude|codex)\\skills(?:\\|$)|\\\.cursorpool(?:\\|$)/i.test(value);
    const prefixCount = candidates.filter((other) => (
      other.value.toLowerCase() !== lower
      && other.value.toLowerCase().startsWith(`${lower}\\`)
    )).length;
    return (internalCursorPath || internalRelayPath ? -200 : 100)
      + (entry.count * 12)
      + (prefixCount * 20)
      + Math.min(value.length, 120) / 120;
  };
  candidates.sort((a, b) => {
    const scoreDelta = scoreCandidate(b) - scoreCandidate(a);
    if (Math.abs(scoreDelta) > 0.001) return scoreDelta;
    return b.value.length - a.value.length;
  });
  return candidates[0]?.value || '';
}

function extractLexicalTextNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.text === 'string' && node.text.trim()) {
    out.push(node.text.trim());
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => extractLexicalTextNodes(child, out));
  }
  return out;
}

function extractLexicalJsonTextsFromString(text) {
  const source = String(text || '');
  const out = [];
  let start = source.indexOf('{"root":');
  while (start >= 0) {
    const maxEnd = Math.min(source.length, start + 30000);
    let found = false;
    for (let end = start + 8; end < maxEnd; end += 1) {
      if (source[end] !== '}') continue;
      const candidate = source.slice(start, end + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed?.root) {
          const texts = extractLexicalTextNodes(parsed.root, []);
          if (texts.length) out.push(texts.join('\n').trim());
          start = source.indexOf('{"root":', end + 1);
          found = true;
          break;
        }
      } catch {
        /* keep scanning */
      }
    }
    if (!found) break;
  }
  return out.filter(Boolean);
}

function extractLexicalJsonTextsFromBuffer(bytes) {
  if (!bytes?.length) return [];
  const previews = [decodeUtf8(bytes)];
  try {
    previews.push(gunzipSync(bytes).toString('utf8'));
  } catch {
    /* ignore */
  }
  return previews.flatMap((text) => extractLexicalJsonTextsFromString(text));
}

function collectUnknownPayloadCandidates(raw) {
  const candidates = [{ label: 'raw', bytes: raw }];
  const seen = new Set([Buffer.from(raw).toString('hex')]);

  if (raw.length >= 5 && (raw[0] === 0 || raw[0] === 1)) {
    try {
      const frameLength = raw.readUInt32BE(1);
      if (frameLength > 0 && frameLength <= raw.length - 5) {
        const frameBytes = raw.subarray(5, 5 + frameLength);
        const key = Buffer.from(frameBytes).toString('hex');
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ label: 'grpc_frame', bytes: frameBytes });
        }
      }
    } catch {
      /* ignore */
    }
  }

  [
    ['gunzip', gunzipSync],
    ['inflate', inflateSync],
    ['brotli', brotliDecompressSync],
  ].forEach(([label, fn]) => {
    try {
      const next = fn(raw);
      if (!next?.length) return;
      const key = Buffer.from(next).toString('hex');
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ label, bytes: next });
    } catch {
      /* ignore */
    }
  });

  const rawText = decodeUtf8Safe(raw, 10000);
  if (/^[0-9a-f\s]+$/i.test(rawText) && rawText.replace(/\s/g, '').length >= 32) {
    try {
      const next = Buffer.from(rawText.replace(/\s/g, ''), 'hex');
      const key = Buffer.from(next).toString('hex');
      if (next.length && !seen.has(key)) {
        seen.add(key);
        candidates.push({ label: 'hex_text', bytes: next });
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const maybeJson = JSON.parse(decodeUtf8(raw));
    if (maybeJson && typeof maybeJson === 'object') {
      const dataValue = typeof maybeJson.data === 'string'
        ? maybeJson.data
        : typeof maybeJson.body === 'string'
          ? maybeJson.body
          : '';
      if (dataValue) {
        const next = unwrapBidiDataField(Buffer.from(JSON.stringify({ data: dataValue }), 'utf8'));
        if (next?.length) {
          const key = Buffer.from(next).toString('hex');
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push({ label: 'json_data', bytes: next });
          }
        }
      }
    }
  } catch {
    /* ignore */
  }

  return candidates;
}

function decodeRunSseRequestId(bodyBuffer) {
  const raw = Buffer.from(bodyBuffer || []);
  if (!raw.length) return '';
  try {
    const json = JSON.parse(raw.toString('utf8'));
    if (json?.requestId) return String(json.requestId).trim();
  } catch {
    /* not plain json */
  }
  const frames = readConnectFrames(raw);
  for (const frame of frames) {
    const fields = parseFields(frame.payload);
    const id = decodeUtf8(getFieldBytes(fields, 1) || Buffer.alloc(0)).trim();
    if (/^[0-9a-f-]{36}$/i.test(id)) return id;
  }
  const uuidMatch = raw.toString('utf8').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuidMatch ? uuidMatch[0] : '';
}

function decodeBidiAppendRequest(bodyBuffer) {
  const raw = Buffer.from(bodyBuffer || []);
  if (!raw.length) {
    return {
      requestId: '',
      userText: '',
      kind: 'empty',
      debug: { rawLength: 0 },
    };
  }

  let payload = raw;
  const frames = readConnectFrames(raw);
  if (frames.length) {
    payload = frames.find((frame) => frame.type === 0 || frame.type === 1)?.payload || frames[0].payload;
  }

  const candidateInputs = collectUnknownPayloadCandidates(payload);
  let chosen = { label: 'raw', bytes: payload };
  let fields = parseFields(payload);
  if (!fields.length) {
    const candidate = candidateInputs.find((entry) => parseFields(entry.bytes).length);
    if (candidate) {
      chosen = candidate;
      fields = parseFields(candidate.bytes);
    }
  }

  const data = getFieldBytes(fields, 1);
  const requestIdMsg = getFieldBytes(fields, 2);
  let requestId = decodeUtf8(getFieldBytes(parseFields(requestIdMsg || Buffer.alloc(0)), 1) || Buffer.alloc(0)).trim();
  if (!requestId) {
    try {
      const json = JSON.parse(decodeUtf8(raw));
      requestId = String(
        json?.requestId
        || json?.sessionId
        || json?.runRequestId
        || json?.conversationId
        || '',
      ).trim();
    } catch {
      /* ignore */
    }
  }

  const debug = {
    rawLength: raw.length,
    frameTypes: frames.map((frame) => frame.type),
    frameSummary: summarizeConnectFrames(raw),
    payloadLength: payload.length,
    chosenPayloadLabel: chosen.label,
    rawHexPrefix: raw.subarray(0, 24).toString('hex'),
    rawTextPreview: decodeUtf8Safe(raw),
    candidateLabels: candidateInputs.map((entry) => entry.label),
    rootShape: summarizeFieldShape(fields),
    uuidCandidates: collectUuidCandidatesFromBuffers([raw, payload, chosen.bytes]),
  };

  if (data?.length) {
    const agentPayload = unwrapBidiDataField(data);
    const agentFields = parseFields(agentPayload);
    const firstField = agentFields[0]?.field;
    debug.dataLength = data.length;
    debug.agentPayloadLength = agentPayload.length;
    debug.agentClientMessage = summarizeAgentClientMessagePayload(agentPayload);
    debug.agentMode = extractAgentModeFromPayload(agentPayload);
    debug.agentShape = summarizeFieldShape(agentFields);
    debug.dataTextPreview = decodeUtf8Safe(data);
    debug.uuidCandidates = collectUuidCandidatesFromBuffers([raw, payload, chosen.bytes, data, agentPayload]);
    debug.workspaceRoot = extractWorkspaceRootFromAgentPayload(agentPayload);
    const selectedImages = summarizeSelectedImagesFromAgentPayload(agentPayload);
    debug.selectedImages = selectedImages.map(({ dataBase64, blobIdBase64, ...image }) => ({
      ...image,
      hasData: Boolean(dataBase64),
      hasBlobId: Boolean(blobIdBase64),
    }));
    const agentOneof = debug.agentClientMessage?.oneof || '';
    const runRequestActionKind = String(debug.agentClientMessage?.runRequest?.action?.kind || '').trim();
    debug.runRequestActionKind = runRequestActionKind;
    if (agentOneof === 'kv_client_message' || firstField === 3) {
      return { requestId, userText: '', kind: 'kv_client', debug };
    }
    if (agentOneof === 'exec_client_message' || firstField === 2) {
      return { requestId, userText: '', kind: 'exec_client', debug };
    }
    if (agentOneof === 'exec_client_control_message' || firstField === 5) {
      return { requestId, userText: '', kind: 'exec_control', debug };
    }
    if (agentOneof === 'interaction_response' || firstField === 6) {
      return { requestId, userText: '', kind: 'interaction_response', debug };
    }
    if (agentOneof === 'client_heartbeat' || firstField === 7) {
      return { requestId, userText: '', kind: 'client_heartbeat', debug };
    }
    if (agentOneof === 'run_request' && runRequestActionKind && runRequestActionKind !== 'user_message_action') {
      return {
        requestId,
        userText: '',
        selectedImages,
        mode: debug.agentMode || debug.agentClientMessage?.runRequest?.mode || 'AGENT_MODE_UNSPECIFIED',
        kind: 'run_request',
        debug,
      };
    }
    const userText = extractUserTextFromAgentPayload(agentPayload);
    if (userText) {
      return {
        requestId,
        userText,
        selectedImages,
        mode: debug.agentMode || debug.agentClientMessage?.runRequest?.mode || 'AGENT_MODE_UNSPECIFIED',
        kind: agentOneof === 'run_request' || firstField === 1 ? 'user_message' : agentOneof || 'user_message',
        debug,
      };
    }
    const fallbackText = collectTextParts(agentFields).trim();
    if ((agentOneof === 'run_request' || firstField === 1) && fallbackText.length >= 2) {
      return {
        requestId,
        userText: fallbackText,
        selectedImages,
        mode: debug.agentMode || debug.agentClientMessage?.runRequest?.mode || 'AGENT_MODE_UNSPECIFIED',
        kind: 'user_message',
        debug,
      };
    }
    if (agentOneof) {
      return { requestId, userText: '', kind: agentOneof, debug };
    }
  }

  const lexicalCandidates = [raw, payload, chosen.bytes, data].filter((item) => item?.length);
  for (const candidate of lexicalCandidates) {
    const lexicalTexts = extractLexicalJsonTextsFromBuffer(candidate);
    if (lexicalTexts.length) {
      debug.lexicalTexts = lexicalTexts.slice(0, 3);
      return {
        requestId,
        userText: lexicalTexts[0],
        mode: 'AGENT_MODE_UNSPECIFIED',
        kind: 'user_message',
        debug,
      };
    }
  }

  return { requestId, userText: '', kind: 'unknown', debug };
}

function encodeOptionalStringField(field, value) {
  const text = typeof value === 'string' ? value : '';
  return text ? encodeBytesField(field, text) : Buffer.alloc(0);
}

function encodeOptionalBoolField(field, value) {
  return typeof value === 'boolean' ? encodeInt32Field(field, value ? 1 : 0) : Buffer.alloc(0);
}

function encodeOptionalIntField(field, value) {
  return Number.isInteger(Number(value)) ? encodeInt32Field(field, Number(value)) : Buffer.alloc(0);
}

function encodeOptionalInt64Field(field, value) {
  return Number.isInteger(Number(value)) ? concatBytes([
    encodeVarint((field << 3) | 0),
    encodeVarint(Number(value)),
  ]) : Buffer.alloc(0);
}

function encodeOptionalBytesField(field, value) {
  if (!Buffer.isBuffer(value)) return Buffer.alloc(0);
  return encodeBytesField(field, value);
}

function encodeRepeatedStringField(field, values) {
  const list = Array.isArray(values) ? values.filter((value) => typeof value === 'string' && value) : [];
  return concatBytes(list.map((value) => encodeBytesField(field, value)));
}

function buildCursorTextFrame(text) {
  return connectFrame(0, encodeMessage([
    {
      field: 2,
      value: encodeMessage([{ field: 1, value: text }]),
    },
  ]));
}

function buildCursorReasoningFrame(text) {
  return connectFrame(0, encodeMessage([
    {
      field: 2,
      value: encodeMessage([
        {
          field: 25,
          value: encodeMessage([{ field: 1, value: text }]),
        },
      ]),
    },
  ]));
}

function buildConnectEndFrame(metadata = {}) {
  return connectFrame(2, Buffer.from(JSON.stringify(metadata), 'utf8'));
}

function buildConnectErrorFrame(message, code = 'internal') {
  return connectFrame(2, Buffer.from(JSON.stringify({
    error: {
      code,
      message: String(message || 'Upstream relay failed'),
    },
  }), 'utf8'));
}

function buildAgentServerMessageField(fieldNumber, innerPayload) {
  return connectFrame(0, encodeMessage([{ field: fieldNumber, value: innerPayload }]));
}

function buildAgentExecServerMessageFrame(execFieldNumber, execPayload, options = {}) {
  const execId = String(options.execId || options.id || '').trim();
  const numericId = Number(options.numericId || options.requestNumber || options.sequence || 0);
  const execMessage = concatBytes([
    numericId > 0 ? encodeInt32Field(1, numericId) : Buffer.alloc(0),
    encodeBytesField(execFieldNumber, execPayload),
    encodeOptionalStringField(15, execId),
  ]);
  return buildAgentServerMessageField(2, execMessage);
}

function buildAgentExecReadFrame(options = {}) {
  return buildAgentExecServerMessageFrame(7, concatBytes([
    encodeOptionalStringField(1, options.path),
    encodeOptionalStringField(2, options.toolCallId),
    encodeOptionalIntField(4, options.offset),
    encodeOptionalIntField(5, options.limit),
    encodeOptionalStringField(6, options.encodingHint),
  ]), options);
}

function buildAgentExecWriteFrame(options = {}) {
  return buildAgentExecServerMessageFrame(3, concatBytes([
    encodeOptionalStringField(1, options.path),
    encodeOptionalStringField(2, options.fileText),
    encodeOptionalStringField(3, options.toolCallId),
    encodeOptionalBoolField(4, options.returnFileContentAfterWrite),
    options.fileBytes ? encodeBytesField(5, options.fileBytes) : Buffer.alloc(0),
  ]), options);
}

function buildAgentExecDeleteFrame(options = {}) {
  return buildAgentExecServerMessageFrame(4, concatBytes([
    encodeOptionalStringField(1, options.path),
    encodeOptionalStringField(2, options.toolCallId),
  ]), options);
}

function buildAgentExecGrepFrame(options = {}) {
  return buildAgentExecServerMessageFrame(5, concatBytes([
    encodeOptionalStringField(1, options.pattern),
    encodeOptionalStringField(2, options.path),
    encodeOptionalStringField(3, options.glob),
    encodeOptionalStringField(4, options.outputMode || options.output_mode),
    encodeOptionalIntField(10, options.headLimit || options.head_limit),
    encodeOptionalStringField(14, options.toolCallId),
  ]), options);
}

function buildAgentExecLsFrame(options = {}) {
  return buildAgentExecServerMessageFrame(8, concatBytes([
    encodeOptionalStringField(1, options.path),
    encodeRepeatedStringField(2, options.ignore),
    encodeOptionalStringField(3, options.toolCallId),
    encodeOptionalIntField(5, options.timeoutMs || options.timeout_ms || options.timeout),
  ]), options);
}

function buildAgentExecShellStreamFrame(options = {}) {
  return buildAgentExecServerMessageFrame(14, concatBytes([
    encodeOptionalStringField(1, options.command),
    encodeOptionalStringField(2, options.workingDirectory || options.working_directory || options.cwd),
    encodeOptionalIntField(3, options.timeoutMs || options.timeout_ms || options.timeout),
    encodeOptionalStringField(4, options.toolCallId),
    encodeOptionalStringField(15, options.description),
  ]), options);
}

function buildAgentExecDiagnosticsFrame(options = {}) {
  return buildAgentExecServerMessageFrame(9, concatBytes([
    encodeOptionalStringField(1, options.path),
    encodeOptionalStringField(2, options.toolCallId),
  ]), options);
}

function decodeBase64Bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  const text = String(value || '').trim();
  if (!text) return Buffer.alloc(0);
  try {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length && decoded.toString('base64').replace(/=+$/g, '') === text.replace(/=+$/g, '')) {
      return decoded;
    }
  } catch {
    /* fall back to utf8 below */
  }
  return Buffer.from(text, 'utf8');
}

function buildAgentKvSetBlobFrame(blobId, blobDataBase64, options = {}) {
  const setBlobArgs = encodeMessage([
    { field: 1, value: decodeBase64Bytes(blobId) },
    { field: 2, value: decodeBase64Bytes(blobDataBase64) },
  ]);
  const kvServer = concatBytes([
    encodeInt32Field(1, Math.max(1, Number(options.id) || 1)),
    encodeMessage([{ field: 3, value: setBlobArgs }]),
  ]);
  return buildAgentServerMessageField(4, kvServer);
}

function buildAgentInteractionFrame(innerField, innerPayload) {
  const interaction = encodeMessage([{ field: innerField, value: innerPayload }]);
  return buildAgentServerMessageField(1, interaction);
}

function buildAgentInteractionUpdateProtoFrame(interactionUpdate = {}) {
  try {
    const payload = encodeCursorProtoMessageSync('agent.v1.AgentServerMessage', {
      interactionUpdate,
    });
    return connectFrame(0, payload);
  } catch {
    return Buffer.alloc(0);
  }
}

function buildAgentBackgroundSubagentActionFrame(toolCallId = '') {
  const normalizedToolCallId = String(toolCallId || '').trim();
  if (!normalizedToolCallId) return Buffer.alloc(0);
  return buildAgentInteractionUpdateProtoFrame({
    conversationAction: {
      backgroundSubagentAction: {
        toolCallId: normalizedToolCallId,
      },
    },
  });
}

function buildAgentBackgroundTaskCompletionActionFrame(record = {}) {
  const taskId = String(record?.taskUuid || record?.agentId || '').trim();
  const toolCallId = String(record?.parentToolCallId || taskId).trim();
  if (!taskId || !toolCallId) return Buffer.alloc(0);
  const status = String(record?.status || '').trim().toLowerCase();
  return buildAgentInteractionUpdateProtoFrame({
    conversationAction: {
      backgroundTaskCompletionAction: {
        completions: [{
          taskId,
          kind: 'BACKGROUND_TASK_KIND_SUBAGENT',
          status: status === 'failed' ? 'BACKGROUND_TASK_COMPLETION_STATUS_ERROR' : 'BACKGROUND_TASK_COMPLETION_STATUS_SUCCESS',
          title: String(record?.title || record?.name || 'Background task').trim() || 'Background task',
          detail: String(record?.summary || record?.resultText || '').trim() || undefined,
          outputPath: String(record?.outputPath || '').trim() || undefined,
          threadId: String(record?.stableConversationId || '').trim() || undefined,
          reason: status === 'failed'
            ? 'BACKGROUND_TASK_COMPLETION_REASON_ERROR'
            : 'BACKGROUND_TASK_COMPLETION_REASON_TASK_FINISHED',
          subagentId: String(record?.agentId || taskId).trim() || undefined,
          toolCallId,
        }],
      },
    },
  });
}

function buildAgentTextDeltaFrame(text) {
  return buildAgentInteractionFrame(1, encodeMessage([{ field: 1, value: String(text || '') }]));
}

function buildAgentThinkingDeltaFrame(text) {
  const value = String(text || '');
  if (!value.length) return Buffer.alloc(0);
  return buildAgentInteractionFrame(4, concatBytes([
    encodeOptionalStringField(1, value),
    encodeInt32Field(2, 1),
  ]));
}

function buildAgentThinkingCompletedFrame(durationMs = 1) {
  return buildAgentInteractionFrame(5, encodeInt32Field(1, Math.max(1, Number(durationMs) || 1)));
}

function buildAgentTokenDeltaFrame(tokens = 1) {
  return buildAgentInteractionFrame(8, concatBytes([
    encodeVarint((1 << 3) | 0),
    encodeVarint(Number(tokens) || 1),
  ]));
}

function buildAgentStepStartedFrame(stepId = 1) {
  return buildAgentInteractionFrame(16, encodeInt32Field(1, Number(stepId) || 1));
}

function buildAgentStepCompletedFrame(stepId = 1, stepDurationMs = 0) {
  return buildAgentInteractionFrame(17, concatBytes([
    encodeInt32Field(1, Number(stepId) || 1),
    encodeInt32Field(2, Math.max(0, Number(stepDurationMs) || 0)),
  ]));
}

function buildAgentTurnEndedFrame() {
  return buildAgentInteractionFrame(14, encodeMessage([]));
}

function buildAgentHeartbeatFrame() {
  return buildAgentInteractionFrame(13, encodeMessage([]));
}

function buildAgentInteractionQueryFrame(queryField, queryPayload, queryId = 1) {
  const interactionQuery = concatBytes([
    encodeInt32Field(1, Math.max(1, Number(queryId) || 1)),
    encodeBytesField(queryField, queryPayload),
  ]);
  return buildAgentServerMessageField(7, interactionQuery);
}

function buildAgentAskQuestionQueryFrame(argumentsValue = {}, toolCallId = '', queryId = 1) {
  const argsPayload = encodeAgentToolArgsPayload('AskQuestion', argumentsValue, toolCallId);
  return buildAgentInteractionQueryFrame(
    3,
    concatBytes([
      argsPayload.length ? encodeBytesField(1, argsPayload) : Buffer.alloc(0),
      encodeOptionalStringField(2, toolCallId),
    ]),
    queryId,
  );
}

function buildAgentCreatePlanQueryFrame(argumentsValue = {}, toolCallId = '', queryId = 1) {
  const argsPayload = encodeAgentToolArgsPayload('CreatePlan', argumentsValue, toolCallId);
  return buildAgentInteractionQueryFrame(
    7,
    concatBytes([
      argsPayload.length ? encodeBytesField(1, argsPayload) : Buffer.alloc(0),
      encodeOptionalStringField(2, toolCallId),
    ]),
    queryId,
  );
}

function normalizeCheckpointPath(filePath) {
  const normalized = String(filePath || '').replace(/\//g, '\\');
  return normalized.replace(/^([A-Z]):\\/, (match, drive) => `${drive.toLowerCase()}:\\`);
}

function toWorkspaceUri(workspaceRoot) {
  const normalized = normalizeCheckpointPath(workspaceRoot);
  if (!/^[a-zA-Z]:\\/.test(normalized)) return '';
  return `file:///app/backend/server/${normalized[0].toLowerCase()}:${encodeURIComponent(normalized.slice(2)).replace(/%5C/gi, '%5C')}`;
}

function encodeFileStateStructure(state = {}) {
  const hasContent = Object.prototype.hasOwnProperty.call(state, 'content');
  const hasInitialContent = Object.prototype.hasOwnProperty.call(state, 'initialContent');
  return concatBytes([
    hasContent ? encodeOptionalBytesField(1, Buffer.isBuffer(state.content) ? state.content : Buffer.from(String(state.content || ''), 'utf8')) : Buffer.alloc(0),
    hasInitialContent ? encodeOptionalBytesField(2, Buffer.isBuffer(state.initialContent) ? state.initialContent : Buffer.from(String(state.initialContent || ''), 'utf8')) : Buffer.alloc(0),
  ]);
}

function encodeStringMapEntry(key, valuePayload) {
  return concatBytes([
    encodeBytesField(1, String(key || '')),
    encodeBytesField(2, valuePayload),
  ]);
}

function encodeConversationPlanStructure(planText = '') {
  const text = typeof planText === 'string' ? planText : '';
  return concatBytes([
    encodeOptionalStringField(1, text),
  ]);
}

function encodePromptTokenBreakdownCategory(category = {}) {
  return concatBytes([
    encodeOptionalStringField(1, category.id),
    encodeOptionalStringField(2, category.label),
    encodeOptionalIntField(3, category.estimatedTokens),
    encodeOptionalIntField(4, category.characterCount),
  ]);
}

function encodePromptTokenBreakdownSnapshot(snapshot = {}) {
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
  return concatBytes([
    encodeOptionalIntField(1, snapshot.totalUsedTokens),
    encodeOptionalIntField(2, snapshot.maxTokens),
    ...categories.map((category) => encodeBytesField(3, encodePromptTokenBreakdownCategory(category))),
  ]);
}

function encodePromptContextSourceRef(source = {}) {
  return concatBytes([
    encodeOptionalStringField(1, source.sourceType),
    encodeOptionalIntField(3, source.messageIndex),
    encodeOptionalStringField(4, source.contentPath),
    encodeOptionalIntField(5, source.startOffset),
    encodeOptionalIntField(6, source.endOffset),
  ]);
}

function encodePromptContextNode(node = {}) {
  return concatBytes([
    encodeOptionalStringField(1, node.id),
    encodeOptionalStringField(2, node.parentId),
    encodeOptionalStringField(3, node.kind),
    encodeOptionalStringField(4, node.label),
    encodeOptionalStringField(5, node.categoryId),
    encodeOptionalIntField(6, node.estimatedTokens),
    encodeOptionalIntField(7, node.characterCount),
    typeof node.contentAvailable === 'boolean' ? encodeBoolField(9, node.contentAvailable) : Buffer.alloc(0),
    node.source && typeof node.source === 'object'
      ? encodeBytesField(11, encodePromptContextSourceRef(node.source))
      : Buffer.alloc(0),
    encodeOptionalStringField(12, node.inlineContent),
  ]);
}

function encodePromptContextUsageTree(tree = {}) {
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  return concatBytes([
    encodeOptionalIntField(1, tree.schemaVersion),
    ...nodes.map((node) => encodeBytesField(2, encodePromptContextNode(node))),
  ]);
}

function buildAgentConversationCheckpointFrame(options = {}) {
  const workspaceRoot = normalizeCheckpointPath(options.workspaceRoot || '');
  const previousWorkspaceUri = options.previousWorkspaceUri || toWorkspaceUri(workspaceRoot);
  const rootPromptMessagesJson = Array.isArray(options.rootPromptMessagesJson) ? options.rootPromptMessagesJson : [];
  const todos = Array.isArray(options.todos) ? options.todos : [];
  const turns = Array.isArray(options.turns) ? options.turns : [];
  const pendingToolCalls = Array.isArray(options.pendingToolCalls) ? options.pendingToolCalls : [];
  const readPaths = Array.isArray(options.readPaths) ? options.readPaths.map(normalizeCheckpointPath).filter(Boolean) : [];
  const fileStates = options.fileStates && typeof options.fileStates === 'object' ? options.fileStates : {};
  const subagentStates = options.subagentStates && typeof options.subagentStates === 'object' ? options.subagentStates : {};
  const subagentThreads = options.subagentThreads && typeof options.subagentThreads === 'object' ? options.subagentThreads : {};
  const subagentRunsByParentToolCallId = options.subagentRunsByParentToolCallId && typeof options.subagentRunsByParentToolCallId === 'object'
    ? options.subagentRunsByParentToolCallId
    : {};
  const planText = typeof options.plan === 'string'
    ? options.plan
    : (typeof options.planText === 'string' ? options.planText : '');
  const fileStateEntries = Object.entries(fileStates)
    .filter(([key, state]) => key && state && typeof state === 'object')
    .map(([key, state]) => encodeBytesField(15, encodeStringMapEntry(
      normalizeCheckpointPath(key),
      encodeFileStateStructure(state),
    )));
  const subagentStateEntries = Object.entries(subagentStates)
    .filter(([key, value]) => key && value != null)
    .map(([key, value]) => encodeBytesField(16, encodeStringMapEntry(String(key), Buffer.from(String(value), 'utf8'))));
  const subagentThreadEntries = Object.entries(subagentThreads)
    .filter(([key, value]) => key && value != null)
    .map(([key, value]) => encodeBytesField(24, encodeStringMapEntry(String(key), Buffer.from(String(value), 'utf8'))));
  const subagentRunEntries = Object.entries(subagentRunsByParentToolCallId)
    .filter(([key, value]) => key && value != null)
    .map(([key, value]) => encodeBytesField(30, encodeStringMapEntry(String(key), Buffer.from(String(value), 'utf8'))));
  const promptTokenBreakdown = options.breakdown && typeof options.breakdown === 'object'
    ? options.breakdown
    : (options.promptTokenBreakdown && typeof options.promptTokenBreakdown === 'object'
      ? options.promptTokenBreakdown
      : null);
  const promptContextUsageTree = options.promptContextUsageTree && typeof options.promptContextUsageTree === 'object'
    ? options.promptContextUsageTree
    : null;
  const tokenDetails = concatBytes([
    encodeInt32Field(1, Number(options.usedTokens) || 1),
    encodeInt32Field(2, Number(options.maxTokens) || 200000),
    promptTokenBreakdown ? encodeBytesField(3, encodePromptTokenBreakdownSnapshot(promptTokenBreakdown)) : Buffer.alloc(0),
    promptContextUsageTree ? encodeBytesField(4, encodePromptContextUsageTree(promptContextUsageTree)) : Buffer.alloc(0),
  ]);
  const payload = concatBytes([
    ...rootPromptMessagesJson.map((item) => encodeBytesField(1, Buffer.isBuffer(item) ? item : Buffer.from(String(item || ''), 'base64'))),
    ...todos.map((item) => encodeBytesField(3, encodeAgentTodoItem(item))),
    ...pendingToolCalls.map((item) => encodeBytesField(4, String(item || ''))),
    encodeBytesField(5, tokenDetails),
    planText ? encodeBytesField(7, encodeConversationPlanStructure(planText)) : Buffer.alloc(0),
    ...turns.map((item) => encodeBytesField(8, Buffer.isBuffer(item) ? item : Buffer.from(String(item || ''), 'base64'))),
    previousWorkspaceUri ? encodeBytesField(9, previousWorkspaceUri) : Buffer.alloc(0),
    encodeInt32Field(10, 1),
    ...fileStateEntries,
    ...subagentStateEntries,
    ...readPaths.map((item) => encodeBytesField(18, item)),
    ...subagentThreadEntries,
    ...subagentRunEntries,
  ]);
  return buildAgentServerMessageField(3, payload);
}

function normalizeAgentToolArguments(argumentsValue = {}) {
  if (typeof argumentsValue === 'string') {
    try {
      return JSON.parse(argumentsValue);
    } catch {
      return { raw: argumentsValue };
    }
  }
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return { value: argumentsValue };
  }
  return argumentsValue;
}

function getAgentNativeToolSpec(toolName) {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (normalized === 'shell') return { field: 1, name: 'Shell' };
  if (normalized === 'delete') return { field: 3, name: 'Delete' };
  if (normalized === 'glob') return { field: 4, name: 'Glob' };
  if (normalized === 'grep') return { field: 5, name: 'Grep' };
  if (normalized === 'read') return { field: 8, name: 'Read' };
  if (normalized === 'todowrite' || normalized === 'todo_write' || normalized === 'updatetodo' || normalized === 'updatetodos') return { field: 9, name: 'TodoWrite' };
  if (normalized === 'strreplace') return { field: 12, name: 'StrReplace' };
  if (normalized === 'write' || normalized === 'edit' || normalized === 'patchedit') return { field: 12, name: 'Edit' };
  if (normalized === 'ls') return { field: 13, name: 'LS' };
  if (normalized === 'readlints' || normalized === 'diagnostics') return { field: 14, name: 'ReadLints' };
  if (normalized === 'semanticsearch' || normalized === 'semsearch' || normalized === 'semantic_search') return { field: 16, name: 'SemanticSearch' };
  if (normalized === 'createplan' || normalized === 'create_plan') return { field: 17, name: 'CreatePlan' };
  if (normalized === 'websearch' || normalized === 'web_search') return { field: 18, name: 'WebSearch' };
  if (normalized === 'task') return { field: 19, name: 'Task' };
  if (normalized === 'askquestion' || normalized === 'ask_question') return { field: 23, name: 'AskQuestion' };
  if (normalized === 'webfetch' || normalized === 'web_fetch' || normalized === 'fetch') return { field: 37, name: 'WebFetch' };
  if (normalized === 'reportbugfixresults' || normalized === 'report_bugfix_results' || normalized === 'debuglogs' || normalized === 'reproductionsteps') {
    return { field: 78, name: 'ReportBugfixResults' };
  }
  return null;
}

function normalizeTaskSubagentType(subagentTypeValue) {
  if (!subagentTypeValue) return '';
  if (typeof subagentTypeValue === 'string') return String(subagentTypeValue).trim();
  if (typeof subagentTypeValue !== 'object' || Array.isArray(subagentTypeValue)) return '';
  const keys = Object.keys(subagentTypeValue).filter(Boolean);
  if (!keys.length) return '';
  const firstKey = String(keys[0]).trim();
  const firstValue = String(subagentTypeValue[firstKey] || '').trim();
  return firstValue || firstKey;
}

function encodeTaskSubagentType(subagentTypeValue) {
  const normalized = normalizeTaskSubagentType(subagentTypeValue).trim().toLowerCase();
  if (!normalized) {
    return encodeBytesField(1, Buffer.alloc(0));
  }
  if (normalized.includes('debug')) {
    return encodeBytesField(10, Buffer.alloc(0));
  }
  if (normalized.includes('explore')) {
    return encodeBytesField(4, Buffer.alloc(0));
  }
  if (normalized.includes('shell')) {
    return encodeBytesField(8, Buffer.alloc(0));
  }
  if (normalized.includes('computer')) {
    return encodeBytesField(2, Buffer.alloc(0));
  }
  if (normalized.includes('browser')) {
    return encodeBytesField(7, Buffer.alloc(0));
  }
  if (normalized.includes('bash')) {
    return encodeBytesField(6, Buffer.alloc(0));
  }
  return encodeBytesField(3, concatBytes([
    encodeOptionalStringField(1, normalizeTaskSubagentType(subagentTypeValue)),
  ]));
}

function buildTaskSubagentTypeProto(subagentTypeValue) {
  const normalized = normalizeTaskSubagentType(subagentTypeValue).trim();
  const lower = normalized.toLowerCase();
  if (!lower) return { unspecified: {} };
  if (lower.includes('debug')) return { debug: {} };
  if (lower.includes('explore')) return { explore: {} };
  if (lower.includes('shell')) return { shell: {} };
  if (lower.includes('computer')) return { computerUse: {} };
  if (lower.includes('browser')) return { browserUse: {} };
  if (lower.includes('bash')) {
    return { bash: {} };
  }
  // general-purpose subagent maps to 'custom' (enum value 3) which Cursor UI
  // recognises as a valid real subagent rather than unspecified/placeholder.
  if (lower.includes('generalpurpose') || lower.includes('general-purpose') || lower.includes('general')) {
    return { custom: {} };
  }
  return { custom: { name: normalized } };
}

function normalizeAgentTodoStatus(status = '') {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'in_progress' || normalized === 'in-progress' || normalized === 'active') return 'in_progress';
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  return 'pending';
}

function encodeAgentTodoStatus(status = '') {
  switch (normalizeAgentTodoStatus(status)) {
    case 'in_progress':
      return 2;
    case 'completed':
      return 3;
    case 'cancelled':
      return 4;
    case 'pending':
    default:
      return 1;
  }
}

function normalizeAgentTodoItems(todos = []) {
  return (Array.isArray(todos) ? todos : [])
    .map((todo, index) => {
      const id = String(todo?.id || todo?.title || `todo_${index + 1}`).trim();
      const content = String(todo?.content || todo?.title || '').trim();
      if (!id || !content) return null;
      return {
        id,
        content,
        status: normalizeAgentTodoStatus(todo?.status),
      };
    })
    .filter(Boolean);
}

function encodeAgentTodoItem(todo = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  return concatBytes([
    encodeOptionalStringField(1, todo.id),
    encodeOptionalStringField(2, todo.content),
    encodeOptionalIntField(3, encodeAgentTodoStatus(todo.status)),
    encodeOptionalInt64Field(4, timestamp),
    encodeOptionalInt64Field(5, timestamp),
  ]);
}

function encodeAgentTodoListPayload(todos = [], merge = false) {
  const normalized = normalizeAgentTodoItems(todos);
  return concatBytes([
    ...normalized.map((todo) => encodeBytesField(1, encodeAgentTodoItem(todo))),
    merge ? encodeInt32Field(2, 1) : Buffer.alloc(0),
  ]);
}

function encodeLsDirectoryFileNode(file = {}) {
  return encodeMessage([
    { field: 1, value: encodeOptionalStringField(1, file.name) },
  ]);
}

function encodeLsDirectoryTreeNode(tree = {}) {
  const childrenDirs = Array.isArray(tree.childrenDirs) ? tree.childrenDirs : [];
  const childrenFiles = Array.isArray(tree.childrenFiles) ? tree.childrenFiles : [];
  return concatBytes([
    encodeOptionalStringField(1, tree.absPath || tree.abs_path || ''),
    ...childrenDirs.map((child) => encodeBytesField(2, encodeLsDirectoryTreeNode(child))),
    ...childrenFiles.map((file) => encodeBytesField(3, encodeLsDirectoryFileNode(file))),
    encodeOptionalBoolField(4, tree.childrenWereProcessed !== false),
    encodeOptionalIntField(6, Number(tree.numFiles) || 0),
  ]);
}

function encodeGrepContentMatch(match = {}) {
  return concatBytes([
    encodeOptionalIntField(1, Number(match.lineNumber ?? match.line_number) || 0),
    encodeOptionalStringField(2, match.content || ''),
    encodeOptionalBoolField(3, match.contentTruncated === true || match.content_truncated === true),
    encodeOptionalBoolField(4, match.isContextLine === true || match.is_context_line === true),
  ]);
}

function encodeGrepFileMatch(fileMatch = {}) {
  const matches = Array.isArray(fileMatch.matches) ? fileMatch.matches : [];
  return concatBytes([
    encodeOptionalStringField(1, fileMatch.file || ''),
    ...matches.map((match) => encodeBytesField(2, encodeGrepContentMatch(match))),
  ]);
}

function encodeGrepContentResult(contentResult = {}) {
  const matches = Array.isArray(contentResult.matches) ? contentResult.matches : [];
  return concatBytes([
    ...matches.map((match) => encodeBytesField(1, encodeGrepFileMatch(match))),
    encodeOptionalIntField(2, Number(contentResult.totalLines ?? contentResult.total_lines) || 0),
    encodeOptionalIntField(3, Number(contentResult.totalMatchedLines ?? contentResult.total_matched_lines) || 0),
    encodeOptionalBoolField(4, contentResult.clientTruncated === true || contentResult.client_truncated === true),
    encodeOptionalBoolField(5, contentResult.ripgrepTruncated === true || contentResult.ripgrep_truncated === true),
  ]);
}

function encodeGrepFilesResult(filesResult = {}) {
  const files = Array.isArray(filesResult.files) ? filesResult.files : [];
  return concatBytes([
    ...files.map((file) => encodeBytesField(1, String(file || ''))),
    encodeOptionalIntField(2, Number(filesResult.totalFiles ?? filesResult.total_files) || files.length),
    encodeOptionalBoolField(3, filesResult.clientTruncated === true || filesResult.client_truncated === true),
    encodeOptionalBoolField(4, filesResult.ripgrepTruncated === true || filesResult.ripgrep_truncated === true),
  ]);
}

function encodeGrepUnionResult(unionResult = {}) {
  if (Array.isArray(unionResult.files) || unionResult.outputMode === 'files_with_matches') {
    return encodeBytesField(2, encodeGrepFilesResult(unionResult));
  }
  return encodeBytesField(3, encodeGrepContentResult(unionResult));
}

function encodeGrepSuccessFromExecution(execution = {}, args = {}) {
  const structured = execution.grepResult || {};
  const outputMode = String(structured.outputMode || args.output_mode || args.outputMode || 'content').toLowerCase();
  const workspaceKey = String(structured.workspaceKey || execution.args?.workspaceRoot || args.path || '.').trim() || '.';
  const unionPayload = outputMode === 'files_with_matches'
    ? encodeGrepFilesResult(structured)
    : encodeGrepContentResult(structured);
  return concatBytes([
    encodeOptionalStringField(1, String(args.pattern || structured.pattern || '')),
    encodeOptionalStringField(2, String(args.path || execution.args?.path || structured.path || '')),
    encodeOptionalStringField(3, outputMode),
    encodeBytesField(4, encodeStringMapEntry(workspaceKey, encodeGrepUnionResult(structured))),
  ]);
}

function encodeReadToolSuccessFromExecution(execution = {}, args = {}) {
  const meta = execution.readMeta || {};
  const filePath = String(meta.path || execution.args?.path || args.path || '').trim();
  const content = String(meta.content || execution.resultText || '').trim();
  const totalLines = Number(meta.totalLines) || 0;
  const fileSize = Number(meta.fileSize) || 0;
  const offset = Math.max(1, Number(meta.offset ?? args.offset) || 1);
  const limit = Number(meta.limit ?? args.limit) > 0 ? Number(meta.limit ?? args.limit) : totalLines;
  const endLine = totalLines > 0 ? Math.min(totalLines, offset + Math.max(limit, 1) - 1) : 0;
  const readRange = endLine > 0
    ? concatBytes([
      encodeOptionalIntField(1, offset),
      encodeOptionalIntField(2, endLine),
    ])
    : Buffer.alloc(0);
  return concatBytes([
    encodeOptionalStringField(1, content),
    encodeOptionalBoolField(2, !content),
    encodeOptionalBoolField(3, execution.truncated === true),
    encodeOptionalIntField(4, totalLines),
    encodeOptionalIntField(5, fileSize),
    encodeOptionalStringField(7, filePath),
    readRange.length ? encodeBytesField(8, readRange) : Buffer.alloc(0),
    encodeOptionalBoolField(11, args.include_line_numbers === true || args.includeLineNumbers === true),
  ]);
}

function encodeUpdateTodosSuccessFromExecution(execution = {}, args = {}) {
  const todos = normalizeAgentTodoItems(execution.args?.todos || args.todos);
  const merge = args.merge === true || execution.args?.merge === true;
  return concatBytes([
    ...todos.map((todo) => encodeBytesField(1, encodeAgentTodoItem(todo))),
    encodeOptionalIntField(2, todos.length),
    encodeOptionalBoolField(3, merge),
  ]);
}

function buildStructuredToolCallSnapshot(toolName = '', args = {}, execution = {}, toolCallId = '') {
  const normalized = String(toolName || '').trim().toLowerCase();
  const safeArgs = normalizeAgentToolArguments(args);
  const callId = String(toolCallId || '').trim();
  if (normalized === 'read') {
    const meta = execution.readMeta || {};
    const filePath = String(meta.path || execution.args?.path || safeArgs.path || '').trim();
    const content = String(meta.rawContent || meta.content || execution.resultText || '').trim();
    const totalLines = Number(meta.totalLines) || 0;
    const fileSize = Number(meta.fileSize) || 0;
    const offset = Math.max(1, Number(meta.offset ?? safeArgs.offset) || 1);
    const limit = Number(meta.limit ?? safeArgs.limit) > 0 ? Number(meta.limit ?? safeArgs.limit) : totalLines;
    const endLine = totalLines > 0 ? Math.min(totalLines, offset + Math.max(limit, 1) - 1) : 0;
    return {
      readToolCall: {
        args: {
          path: filePath,
          offset,
          limit: limit > 0 ? limit : undefined,
          includeLineNumbers: safeArgs.include_line_numbers === true || safeArgs.includeLineNumbers === true,
        },
        result: execution.ok === false
          ? { error: { errorMessage: execution.resultText || 'Read failed' } }
          : {
            success: {
              path: filePath,
              totalLines,
              fileSize,
              content,
              readRange: endLine > 0 ? { startLine: offset, endLine } : undefined,
              isEmpty: !content,
              exceededLimit: execution.truncated === true,
            },
          },
      },
    };
  }
  if (normalized === 'grep') {
    const structured = execution.grepResult || {};
    const outputMode = String(structured.outputMode || safeArgs.output_mode || safeArgs.outputMode || 'content').toLowerCase();
    const workspaceKey = String(structured.workspaceKey || execution.args?.workspaceRoot || safeArgs.path || '.').trim() || '.';
    const unionResult = outputMode === 'files_with_matches'
      ? { files: structured.files || [] }
      : { matches: structured.matches || [] };
    return {
      grepToolCall: {
        args: {
          pattern: String(safeArgs.pattern || structured.pattern || ''),
          path: String(safeArgs.path || execution.args?.path || structured.path || ''),
          outputMode,
          glob: safeArgs.glob || undefined,
          headLimit: safeArgs.head_limit || safeArgs.headLimit || undefined,
          toolCallId: callId || undefined,
        },
        result: execution.ok === false
          ? { error: { error: execution.resultText || 'Grep failed' } }
          : {
            success: {
              pattern: String(safeArgs.pattern || structured.pattern || ''),
              path: String(safeArgs.path || execution.args?.path || structured.path || ''),
              outputMode,
              workspaceResults: {
                [workspaceKey]: unionResult,
              },
            },
          },
      },
    };
  }
  if (normalized === 'ls') {
    const tree = execution.directoryTree || null;
    const filePath = String(execution.args?.path || safeArgs.path || tree?.absPath || '').trim();
    return {
      lsToolCall: {
        args: {
          path: filePath,
          ignore: Array.isArray(safeArgs.ignore) ? safeArgs.ignore : undefined,
          toolCallId: callId || undefined,
        },
        result: execution.ok === false
          ? { error: { path: filePath, error: execution.resultText || 'LS failed' } }
          : {
            success: {
              directoryTreeRoot: tree || { absPath: filePath, childrenWereProcessed: true },
            },
          },
      },
    };
  }
  if (normalized === 'todowrite' || normalized === 'todo_write' || normalized === 'updatetodo' || normalized === 'updatetodos') {
    const todos = normalizeAgentTodoItems(execution.args?.todos || safeArgs.todos);
    const merge = safeArgs.merge === true || execution.args?.merge === true;
    return {
      updateTodosToolCall: {
        args: {
          todos,
          merge,
        },
        result: {
          success: {
            todos,
            totalCount: todos.length,
            wasMerge: merge,
          },
        },
      },
    };
  }
  if (normalized === 'glob') {
    const files = execution.noMatches === true ? [] : String(execution.resultText || '').split(/\r?\n/).filter(Boolean);
    return {
      globToolCall: {
        args: {
          targetDirectory: safeArgs.target_directory || safeArgs.path || execution.args?.path || '',
          globPattern: safeArgs.glob_pattern || safeArgs.pattern || '',
        },
        result: {
          success: {
            globPattern: safeArgs.glob_pattern || safeArgs.pattern || '',
            targetDirectory: safeArgs.target_directory || safeArgs.path || execution.args?.path || '',
            files,
            totalFiles: files.length,
          },
        },
      },
    };
  }
  if (normalized === 'websearch' || normalized === 'web_search') {
    const results = Array.isArray(execution.results) ? execution.results : [];
    const references = Array.isArray(execution.references) ? execution.references : [];
    const normalizedResults = results.length
      ? results
      : references
        .filter((reference) => String(reference?.url || '').trim())
        .map((reference, index) => ({
          id: String(index + 1),
          title: String(reference?.title || '').trim(),
          url: String(reference?.url || '').trim(),
          snippet: String(reference?.snippet || reference?.chunk || '').trim(),
          rank: index + 1,
        }));
    return {
      webSearchToolCall: {
        args: {
          searchTerm: String(safeArgs.search_term || safeArgs.searchTerm || safeArgs.query || execution.args?.search_term || '').trim(),
          toolCallId: callId || undefined,
        },
        result: execution.ok === false
          ? { error: { error: execution.resultText || 'Web search failed' } }
          : {
            success: {
              references: normalizedResults.map((item) => ({
                title: String(item?.title || '').trim(),
                url: String(item?.url || '').trim(),
                chunk: String(item?.snippet || '').trim(),
              })),
            },
        },
      },
    };
  }
  if (normalized === 'askquestion' || normalized === 'ask_question') {
    const questions = Array.isArray(safeArgs.questions) ? safeArgs.questions : [];
    const answers = Array.isArray(execution.answers) ? execution.answers : [];
    const errorText = String(execution.resultText || execution.error || 'AskQuestion failed').trim();
    return {
      askQuestionToolCall: {
        args: {
          title: String(safeArgs.title || '').trim(),
          questions,
        },
        result: execution.ok === false
          ? { error: { errorMessage: errorText } }
          : {
            success: {
              answers,
            },
          },
      },
    };
  }
  if (normalized === 'createplan' || normalized === 'create_plan') {
    const todos = Array.isArray(safeArgs.todos) ? safeArgs.todos : [];
    const errorText = String(execution.resultText || execution.error || 'CreatePlan failed').trim();
    return {
      createPlanToolCall: {
        args: {
          plan: String(safeArgs.plan || '').trim(),
          overview: String(safeArgs.overview || '').trim(),
          name: String(safeArgs.name || '').trim(),
          todos,
        },
        result: execution.ok === false
          ? { error: { errorMessage: errorText } }
          : {
            planUri: String(execution.planPath || execution.planUri || safeArgs.planUri || '').trim(),
            success: {},
          },
      },
    };
  }
  if (normalized === 'task') {
    const description = String(safeArgs.description || '').trim();
    const prompt = String(safeArgs.prompt || '').trim();
    const includeResult = execution.includeResult !== false;
    const taskToolCall = {
      args: {
        description,
        prompt,
        subagentType: buildTaskSubagentTypeProto(safeArgs.subagent_type || safeArgs.subagentType || ''),
        model: String(safeArgs.model || '').trim(),
        resume: String(safeArgs.resume || '').trim() || undefined,
        agentId: String(execution.agentId || '').trim() || undefined,
        attachments: Array.isArray(safeArgs.attachments) ? safeArgs.attachments : [],
      },
    };
    if (includeResult) {
      taskToolCall.result = execution.ok === false
        ? { error: { error: String(execution.resultText || 'Task failed').trim() } }
        : {
          success: {
            conversationSteps: Array.isArray(execution.conversationStepsJson) ? execution.conversationStepsJson : [],
            agentId: String(execution.agentId || '').trim(),
            isBackground: execution.isBackground === true,
            durationMs: Number(execution.durationMs) || 0,
            resultSuffix: String(execution.resultSuffix || '').trim() || undefined,
            transcriptPath: String(execution.transcriptPath || '').trim() || undefined,
          },
        };
    }
    return { taskToolCall };
  }
  if (
    normalized === 'reportbugfixresults'
    || normalized === 'report_bugfix_results'
    || normalized === 'debuglogs'
    || normalized === 'reproductionsteps'
  ) {
    const errorText = String(execution.resultText || execution.error || 'ReportBugfixResults failed').trim();
    return {
      reportBugfixResultsToolCall: {
        args: {
          summary: String(safeArgs.summary || '').trim(),
          results: Array.isArray(safeArgs.results) ? safeArgs.results : [],
        },
        result: execution.ok === false
          ? { error: { errorMessage: errorText } }
          : { success: {} },
      },
    };
  }
  return null;
}

function encodeAgentToolArgsPayload(toolName, args = {}, toolCallId = '') {
  const normalizedArgs = normalizeAgentToolArguments(args);
  const spec = getAgentNativeToolSpec(toolName);
  if (!spec) return Buffer.alloc(0);

  switch (spec.name) {
    case 'Shell':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.command),
        encodeOptionalStringField(2, normalizedArgs.working_directory || normalizedArgs.cwd),
        encodeOptionalIntField(3, normalizedArgs.timeout),
        encodeOptionalStringField(4, toolCallId),
        encodeRepeatedStringField(5, normalizedArgs.simple_commands),
        encodeOptionalBoolField(6, normalizedArgs.has_input_redirect),
        encodeOptionalBoolField(7, normalizedArgs.has_output_redirect),
        encodeOptionalBoolField(11, normalizedArgs.is_background),
        encodeOptionalBoolField(12, normalizedArgs.skip_approval),
        encodeOptionalIntField(14, normalizedArgs.hard_timeout),
        encodeOptionalStringField(15, normalizedArgs.description),
        encodeOptionalBoolField(17, normalizedArgs.close_stdin),
      ]);
    case 'Delete':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.path),
        encodeOptionalStringField(2, toolCallId),
      ]);
    case 'Glob':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.target_directory || normalizedArgs.path),
        encodeOptionalStringField(2, normalizedArgs.glob_pattern || normalizedArgs.pattern),
      ]);
    case 'Grep':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.pattern),
        encodeOptionalStringField(2, normalizedArgs.path),
        encodeOptionalStringField(3, normalizedArgs.glob),
        encodeOptionalStringField(4, normalizedArgs.output_mode),
        encodeOptionalIntField(5, normalizedArgs.context_before),
        encodeOptionalIntField(6, normalizedArgs.context_after),
        encodeOptionalIntField(7, normalizedArgs.context),
        encodeOptionalBoolField(8, normalizedArgs.case_insensitive),
        encodeOptionalStringField(9, normalizedArgs.type),
        encodeOptionalIntField(10, normalizedArgs.head_limit),
        encodeOptionalBoolField(11, normalizedArgs.multiline),
        encodeOptionalStringField(12, normalizedArgs.sort),
        encodeOptionalBoolField(13, normalizedArgs.sort_ascending),
        encodeOptionalStringField(14, toolCallId),
        encodeOptionalIntField(16, normalizedArgs.offset),
      ]);
    case 'Read':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.path),
        encodeOptionalIntField(2, normalizedArgs.offset),
        encodeOptionalIntField(3, normalizedArgs.limit),
        encodeOptionalBoolField(5, normalizedArgs.include_line_numbers || normalizedArgs.includeLineNumbers),
      ]);
    case 'TodoWrite':
      return encodeAgentTodoListPayload(normalizedArgs.todos, normalizedArgs.merge === true);
    case 'StrReplace':
    case 'Edit':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.path || normalizedArgs.target_file || normalizedArgs.targetFile),
        encodeOptionalStringField(2, normalizedArgs.old_string || normalizedArgs.oldStr),
        encodeOptionalStringField(6, normalizedArgs.stream_content || normalizedArgs.content || normalizedArgs.contents || normalizedArgs.new_string || normalizedArgs.newStr),
        encodeOptionalStringField(9, normalizedArgs.new_string || normalizedArgs.newStr),
      ]);
    case 'LS':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.path),
        encodeRepeatedStringField(2, normalizedArgs.ignore),
        encodeOptionalStringField(3, toolCallId),
        encodeOptionalIntField(5, normalizedArgs.timeout_ms || normalizedArgs.timeoutMs),
      ]);
    case 'ReadLints':
      return concatBytes([
        encodeRepeatedStringField(1, Array.isArray(normalizedArgs.paths)
          ? normalizedArgs.paths
          : [normalizedArgs.path].filter(Boolean)),
      ]);
    case 'WebSearch':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.search_term || normalizedArgs.searchTerm || normalizedArgs.query),
        encodeOptionalStringField(2, toolCallId),
      ]);
    case 'SemanticSearch':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.query),
        encodeRepeatedStringField(2, normalizedArgs.target_directories || normalizedArgs.targetDirectories),
        encodeOptionalStringField(3, normalizedArgs.explanation),
      ]);
    case 'CreatePlan':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.plan),
        ...(Array.isArray(normalizedArgs.todos) ? normalizedArgs.todos : []).map((todo) => encodeBytesField(2, encodeAgentTodoItem(todo))),
        encodeOptionalStringField(3, normalizedArgs.overview),
        encodeOptionalStringField(4, normalizedArgs.name),
      ]);
    case 'AskQuestion':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.title),
        ...(Array.isArray(normalizedArgs.questions) ? normalizedArgs.questions : []).map((question) => encodeBytesField(2, encodeAskQuestionQuestion(question))),
      ]);
    case 'WebFetch':
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.url),
        encodeOptionalStringField(2, toolCallId),
      ]);
    case 'Task': {
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.description),
        encodeOptionalStringField(2, normalizedArgs.prompt),
        encodeBytesField(3, encodeTaskSubagentType(normalizedArgs.subagent_type || normalizedArgs.subagentType || '')),
        encodeOptionalStringField(4, normalizedArgs.model),
        encodeOptionalStringField(5, normalizedArgs.resume),
        encodeOptionalStringField(6, normalizedArgs.agent_id || normalizedArgs.agentId),
        encodeRepeatedStringField(7, normalizedArgs.attachments),
      ]);
    }
    case 'ReportBugfixResults': {
      const results = Array.isArray(normalizedArgs.results) ? normalizedArgs.results : [];
      return concatBytes([
        encodeOptionalStringField(1, normalizedArgs.summary),
        ...results.map((item) => encodeBytesField(2, concatBytes([
          encodeOptionalStringField(1, item?.title),
          encodeOptionalStringField(2, item?.summary),
          encodeOptionalStringField(3, item?.status),
        ]))),
      ]);
    }
    default:
      return Buffer.alloc(0);
  }
}

function encodeWebSearchReference(reference = {}) {
  return concatBytes([
    encodeOptionalStringField(1, reference.title),
    encodeOptionalStringField(2, reference.url),
    encodeOptionalStringField(3, reference.chunk),
  ]);
}

function encodeAskQuestionOption(option = {}) {
  return concatBytes([
    encodeOptionalStringField(1, option.id),
    encodeOptionalStringField(2, option.label),
  ]);
}

function encodeAskQuestionQuestion(question = {}) {
  const options = Array.isArray(question.options) ? question.options : [];
  return concatBytes([
    encodeOptionalStringField(1, question.id),
    encodeOptionalStringField(2, question.prompt),
    ...options.map((option) => encodeBytesField(3, encodeAskQuestionOption(option))),
    encodeOptionalBoolField(4, question.allow_multiple === true || question.allowMultiple === true),
  ]);
}

function encodeSemSearchCodeResult(result = {}) {
  const codeBlock = result.codeBlock || {};
  const range = codeBlock.range && typeof codeBlock.range === 'object'
    ? concatBytes([
      encodeBytesField(1, concatBytes([
        encodeOptionalIntField(1, Number(codeBlock.range.startLine) || 0),
        encodeOptionalIntField(2, Number(codeBlock.range.startColumn) || 0),
      ])),
      encodeBytesField(2, concatBytes([
        encodeOptionalIntField(1, Number(codeBlock.range.endLine) || 0),
        encodeOptionalIntField(2, Number(codeBlock.range.endColumn) || 0),
      ])),
    ])
    : Buffer.alloc(0);
  return concatBytes([
    encodeBytesField(1, concatBytes([
      encodeOptionalStringField(1, codeBlock.relativeWorkspacePath),
      encodeOptionalStringField(4, codeBlock.contents),
      range.length ? encodeBytesField(3, range) : Buffer.alloc(0),
    ])),
    encodeOptionalIntField(2, Number(result.score) || 0),
  ]);
}

function encodeAgentToolResultPayload(toolName, args = {}, execution = null, toolCallId = '') {
  const spec = getAgentNativeToolSpec(toolName);
  if (!spec || !execution) return Buffer.alloc(0);

  const normalizedArgs = normalizeAgentToolArguments(args);
  const resultText = typeof execution.resultText === 'string' ? execution.resultText : '';

  switch (spec.name) {
    case 'Shell':
      return encodeMessage([{
        field: 1,
        value: concatBytes([
          encodeOptionalStringField(1, normalizedArgs.command),
          encodeOptionalStringField(2, normalizedArgs.working_directory || normalizedArgs.cwd),
          encodeOptionalIntField(3, 0),
          encodeOptionalStringField(5, resultText),
        ]),
      }]);
    case 'Delete':
      return encodeMessage([{
        field: 1,
        value: concatBytes([
          encodeOptionalStringField(1, normalizedArgs.path || execution.args?.path),
          encodeOptionalStringField(2, execution.deletedFile || normalizedArgs.path || execution.args?.path),
          encodeOptionalInt64Field(3, execution.fileSize),
          encodeOptionalStringField(4, execution.prevContent || execution.beforeContent || ''),
        ]),
      }]);
    case 'Glob': {
      const files = execution.noMatches === true ? [] : resultText.split(/\r?\n/).filter(Boolean).slice(0, 50);
      return encodeMessage([{
        field: 1,
        value: concatBytes([
          encodeOptionalStringField(1, normalizedArgs.glob_pattern || normalizedArgs.pattern),
          encodeOptionalStringField(2, normalizedArgs.target_directory || normalizedArgs.path || execution.workspaceRoot),
          encodeRepeatedStringField(3, files),
          encodeOptionalIntField(4, files.length),
        ]),
      }]);
    }
    case 'Read':
      return encodeMessage([{
        field: 1,
        value: encodeReadToolSuccessFromExecution(execution, normalizedArgs),
      }]);
    case 'Grep':
      return encodeMessage([{
        field: 1,
        value: encodeGrepSuccessFromExecution(execution, normalizedArgs),
      }]);
    case 'LS':
      return encodeMessage([{
        field: 1,
        value: concatBytes([
          encodeBytesField(1, encodeLsDirectoryTreeNode(
            execution.directoryTree || { absPath: normalizedArgs.path || execution.args?.path || '', childrenWereProcessed: true },
          )),
        ]),
      }]);
    case 'TodoWrite':
      return encodeMessage([{
        field: 1,
        value: encodeUpdateTodosSuccessFromExecution(execution, normalizedArgs),
      }]);
    case 'StrReplace':
    case 'Edit':
      return encodeMessage([{
        field: 1,
        value: concatBytes([
          encodeOptionalStringField(1, normalizedArgs.path || normalizedArgs.target_file || normalizedArgs.targetFile || execution.args?.path),
          encodeOptionalStringField(2, normalizedArgs.old_string || normalizedArgs.oldStr || execution.args?.oldStr || execution.args?.old_string || ''),
          encodeOptionalIntField(3, execution.linesAdded),
          encodeOptionalIntField(4, execution.linesRemoved),
          encodeOptionalStringField(5, execution.diffString || ''),
          encodeOptionalStringField(6, execution.beforeContent || ''),
          encodeOptionalStringField(7, execution.afterContent || normalizedArgs.stream_content || normalizedArgs.content || normalizedArgs.new_string || normalizedArgs.newStr || ''),
          encodeOptionalStringField(8, execution.message || execution.summary || ''),
          encodeOptionalStringField(9, normalizedArgs.new_string || normalizedArgs.newStr || execution.args?.newStr || execution.args?.new_string || ''),
        ]),
      }]);
    case 'ReadLints':
      return encodeMessage([{
        field: 1,
        value: concatBytes([
          encodeOptionalIntField(2, Array.isArray(execution.args?.paths) ? execution.args.paths.length : 1),
          encodeOptionalIntField(3, Number(execution.diagnosticCount) || 0),
        ]),
      }]);
    case 'SemanticSearch': {
      if (!execution.ok) {
        return encodeMessage([{
          field: 2,
          value: concatBytes([
            encodeOptionalStringField(1, execution.resultText || execution.error || 'Semantic search failed'),
          ]),
        }]);
      }
      const matches = Array.isArray(execution.matches) ? execution.matches : [];
      return encodeMessage([{
        field: 1,
        value: concatBytes([
          encodeOptionalStringField(1, resultText),
          ...matches.map((item) => encodeBytesField(2, encodeSemSearchCodeResult(item))),
        ]),
      }]);
    }
    case 'CreatePlan': {
      if (!execution.ok) {
        return encodeMessage([{
          field: 2,
          value: concatBytes([
            encodeOptionalStringField(1, execution.resultText || execution.error || 'CreatePlan failed'),
          ]),
        }]);
      }
      return concatBytes([
        encodeBytesField(1, Buffer.alloc(0)),
        encodeOptionalStringField(3, execution.planPath || execution.planUri || ''),
      ]);
    }
    case 'Task': {
      if (!execution.ok) {
        return encodeMessage([{
          field: 2,
          value: concatBytes([
            encodeOptionalStringField(1, execution.resultText || execution.error || 'Task failed'),
          ]),
        }]);
      }
      return encodeMessage([{
        field: 1,
        value: concatBytes([
          encodeOptionalStringField(1, execution.agentId || ''),
          encodeOptionalBoolField(2, execution.isBackground === true),
          encodeOptionalInt64Field(4, Number(execution.durationMs) || 0),
          encodeOptionalStringField(5, execution.resultSuffix || ''),
          encodeOptionalStringField(7, execution.transcriptPath || ''),
        ]),
      }]);
    }
    case 'ReportBugfixResults': {
      if (!execution.ok) {
        return encodeMessage([{
          field: 2,
          value: concatBytes([
            encodeOptionalStringField(1, execution.resultText || execution.error || 'ReportBugfixResults failed'),
          ]),
        }]);
      }
      return encodeMessage([{ field: 1, value: Buffer.alloc(0) }]);
    }
    case 'AskQuestion': {
      if (!execution.ok) {
        return encodeMessage([{
          field: 2,
          value: concatBytes([
            encodeOptionalStringField(1, execution.resultText || execution.error || 'AskQuestion failed'),
          ]),
        }]);
      }
      const answers = Array.isArray(execution.answers) ? execution.answers : [];
      return encodeMessage([{
        field: 1,
        value: concatBytes(answers.map((answer) => encodeBytesField(1, concatBytes([
          encodeOptionalStringField(1, answer.questionId || answer.question_id),
          encodeRepeatedStringField(2, answer.selectedOptionIds || answer.selected_option_ids),
          encodeOptionalStringField(3, answer.freeformText || answer.freeform_text),
        ])))),
      }]);
    }
    case 'WebSearch': {
      if (!execution.ok) {
        return encodeMessage([{
          field: 2,
          value: concatBytes([
            encodeOptionalStringField(1, execution.resultText || execution.error || 'Web search failed'),
          ]),
        }]);
      }
      const references = Array.isArray(execution.references) ? execution.references : [];
      const success = concatBytes(references.map((reference) => encodeBytesField(1, encodeWebSearchReference(reference))));
      return encodeMessage([{ field: 1, value: success }]);
    }
    case 'WebFetch': {
      if (!execution.ok) {
        return encodeMessage([{
          field: 2,
          value: concatBytes([
            encodeOptionalStringField(1, normalizedArgs.url || execution.args?.url),
            encodeOptionalStringField(2, execution.resultText || execution.error || 'Web fetch failed'),
          ]),
        }]);
      }
      return encodeMessage([{
        field: 1,
        value: concatBytes([
          encodeOptionalStringField(1, normalizedArgs.url || execution.args?.url),
          encodeOptionalStringField(2, resultText),
        ]),
      }]);
    }
    default:
      return Buffer.alloc(0);
  }
}

function encodeAgentToolCallPayload(toolName, args = {}, toolCallId = '', options = {}) {
  const spec = getAgentNativeToolSpec(toolName);
  if (!spec) return Buffer.alloc(0);
  const argsPayload = options.omitArgs ? Buffer.alloc(0) : encodeAgentToolArgsPayload(toolName, args, toolCallId);
  const resultPayload = options.omitResult ? Buffer.alloc(0) : encodeAgentToolResultPayload(toolName, args, options.execution || null, toolCallId);
  const toolMessage = concatBytes([
    argsPayload.length ? encodeBytesField(1, argsPayload) : Buffer.alloc(0),
    resultPayload.length ? encodeBytesField(2, resultPayload) : Buffer.alloc(0),
  ]);
  return concatBytes([
    encodeBytesField(spec.field, toolMessage),
    encodeBytesField(57, String(toolCallId || '')),
  ]);
}

function buildAgentPartialToolCallFrame(toolName, argumentsValue = {}, toolCallId = '', modelCallId = '') {
  const normalizedCallId = String(toolCallId || `tool_${Date.now().toString(36)}`);
  return buildAgentInteractionFrame(7, concatBytes([
    encodeBytesField(1, normalizedCallId),
    encodeBytesField(2, encodeAgentToolCallPayload(toolName, argumentsValue, normalizedCallId, { omitResult: true })),
    encodeBytesField(4, String(modelCallId || '')),
  ]));
}

function buildAgentToolCallStartedFrame(toolName, argumentsValue = {}, toolCallId = '', modelCallId = '') {
  const normalizedCallId = String(toolCallId || `tool_${Date.now().toString(36)}`);
  return buildAgentInteractionFrame(2, concatBytes([
    encodeBytesField(1, normalizedCallId),
    encodeBytesField(2, encodeAgentToolCallPayload(toolName, argumentsValue, normalizedCallId, { omitResult: true })),
    encodeBytesField(3, String(modelCallId || '')),
  ]));
}

function buildAgentToolCallCompletedFrame(toolName, argumentsValue = {}, toolCallId = '', modelCallId = '', options = {}) {
  const normalizedCallId = String(toolCallId || `tool_${Date.now().toString(36)}`);
  if (String(toolName || '').trim().toLowerCase() === 'task') {
    const structuredToolCall = buildStructuredToolCallSnapshot(toolName, argumentsValue, options.execution || {}, normalizedCallId);
    if (structuredToolCall) {
      return buildAgentInteractionUpdateProtoFrame({
        toolCallCompleted: {
          callId: normalizedCallId,
          toolCall: structuredToolCall,
          modelCallId: String(modelCallId || ''),
        },
      });
    }
  }
  return buildAgentInteractionFrame(3, concatBytes([
    encodeBytesField(1, normalizedCallId),
    encodeBytesField(2, encodeAgentToolCallPayload(toolName, argumentsValue, normalizedCallId, options)),
    encodeBytesField(3, String(modelCallId || '')),
  ]));
}

function buildAgentToolCallProgressFrame(toolName, argumentsValue = {}, toolCallId = '', modelCallId = '', options = {}) {
  const normalizedCallId = String(toolCallId || `tool_${Date.now().toString(36)}`);
  return buildAgentInteractionFrame(15, concatBytes([
    encodeBytesField(1, normalizedCallId),
    encodeBytesField(2, encodeAgentToolCallPayload(toolName, argumentsValue, normalizedCallId, options)),
    encodeBytesField(3, String(modelCallId || '')),
  ]));
}

function buildAgentTaskToolCallDeltaFrame(updateKind = 'partial', argumentsValue = {}, toolCallId = '', modelCallId = '', options = {}) {
  const normalizedCallId = String(toolCallId || `tool_${Date.now().toString(36)}`);
  const execution = options.execution || {};
  const structuredToolCall = buildStructuredToolCallSnapshot('Task', argumentsValue, execution, normalizedCallId);
  if (!structuredToolCall) return Buffer.alloc(0);
  // ToolCall message (agent.v1.ToolCall) carries metadata alongside the oneof tool:
  //   tool_call_id = 57, started_at_ms = 59, completed_at_ms = 60.
  // The UI uses tool_call_id to correlate the delta with TaskStreamLog requests, and
  // the timestamps to render duration. Without these the client may fall back to a
  // generic placeholder card.
  structuredToolCall.toolCallId = normalizedCallId;
  if (Number(execution.startedAtMs) > 0) {
    structuredToolCall.startedAtMs = String(execution.startedAtMs);
  }
  if (Number(execution.completedAtMs) > 0) {
    structuredToolCall.completedAtMs = String(execution.completedAtMs);
  }
  const nestedUpdate = {
    partial: {
      partialToolCall: {
        callId: normalizedCallId,
        toolCall: structuredToolCall,
        modelCallId: String(modelCallId || ''),
      },
    },
    started: {
      toolCallStarted: {
        callId: normalizedCallId,
        toolCall: structuredToolCall,
        modelCallId: String(modelCallId || ''),
      },
    },
    completed: {
      toolCallCompleted: {
        callId: normalizedCallId,
        toolCall: structuredToolCall,
        modelCallId: String(modelCallId || ''),
      },
    },
  }[String(updateKind || 'partial').trim().toLowerCase()] || {
    partialToolCall: {
      callId: normalizedCallId,
      toolCall: structuredToolCall,
      modelCallId: String(modelCallId || ''),
    },
  };
  return buildAgentInteractionUpdateProtoFrame({
    toolCallDelta: {
      callId: normalizedCallId,
      modelCallId: String(modelCallId || ''),
      toolCallDelta: {
        taskToolCallDelta: {
          interactionUpdate: nestedUpdate,
        },
      },
    },
  });
}

function buildAgentEditToolCallDeltaFrame(text, toolCallId = '', modelCallId = '') {
  const normalizedCallId = String(toolCallId || `tool_${Date.now().toString(36)}`);
  const editToolCallDelta = concatBytes([
    encodeOptionalStringField(1, String(text || '')),
  ]);
  const toolCallDelta = concatBytes([
    encodeBytesField(3, editToolCallDelta),
  ]);
  return buildAgentInteractionFrame(15, concatBytes([
    encodeBytesField(1, normalizedCallId),
    encodeBytesField(2, toolCallDelta),
    encodeBytesField(3, String(modelCallId || '')),
  ]));
}

function buildAgentToolCallFrame(toolName, argumentsValue = {}, toolCallId = '', options = {}) {
  const normalizedToolName = String(toolName || '').trim() || 'UnknownTool';
  const normalizedCallId = String(toolCallId || `tool_${Date.now().toString(36)}`);
  let normalizedArguments = argumentsValue;
  if (typeof normalizedArguments === 'string') {
    try {
      normalizedArguments = JSON.parse(normalizedArguments);
    } catch {
      normalizedArguments = { raw: argumentsValue };
    }
  }
  if (!normalizedArguments || typeof normalizedArguments !== 'object' || Array.isArray(normalizedArguments)) {
    normalizedArguments = { value: normalizedArguments };
  }
  const argsJson = JSON.stringify(normalizedArguments);
  const jsonPayload = JSON.stringify({
    id: normalizedCallId,
    tool: normalizedToolName,
    name: normalizedToolName,
    arguments: normalizedArguments,
    args: normalizedArguments,
  });
  const innerPayload = encodeMessage([
    { field: 1, value: normalizedToolName },
    { field: 2, value: argsJson },
    { field: 3, value: normalizedCallId },
    { field: 4, value: jsonPayload },
  ]);
  const innerField = Number(options.innerField || options.field) || 15;
  return buildAgentInteractionFrame(innerField, innerPayload);
}

function extractTextFromContentPart(part) {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (typeof part.text === 'string') return part.text;
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
  if (typeof part.input_text === 'string') return part.input_text;
  if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
  return '';
}

function extractOpenAiDelta(payload) {
  if (!payload || typeof payload !== 'object') {
    return { text: '', reasoning: '', done: false, error: '' };
  }
  const type = typeof payload.type === 'string' ? payload.type : '';
  if (payload.type === 'response.output_text.delta') {
    return { text: String(payload.delta || ''), reasoning: '', done: false, error: '' };
  }
  if (payload.type === 'response.output_text.done') {
    return { text: '', reasoning: '', done: false, error: '' };
  }
  if (payload.type === 'response.output_item.added' || payload.type === 'response.output_item.done') {
    return { text: '', reasoning: '', done: false, error: '' };
  }
  if (payload.type === 'response.content_part.added' || payload.type === 'response.content_part.done') {
    return { text: '', reasoning: '', done: false, error: '' };
  }
  if (payload.type === 'response.reasoning_summary_text.delta') {
    return { text: '', reasoning: String(payload.delta || ''), done: false, error: '' };
  }
  if (payload.type === 'response.reasoning_summary_text.done') {
    return { text: '', reasoning: '', done: false, error: '' };
  }
  if (payload.type === 'response.created' || payload.type === 'response.in_progress') {
    return { text: '', reasoning: '', done: false, error: '' };
  }
  if (payload.type === 'response.completed') {
    const output = Array.isArray(payload.response?.output) ? payload.response.output : [];
    let text = '';
    let reasoning = '';
    output.forEach((item) => {
      if (item?.type === 'reasoning') {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        reasoning += summary.map((part) => extractTextFromContentPart(part)).join('');
      }
      if (item?.type === 'message') {
        const content = Array.isArray(item.content) ? item.content : [];
        text += content.map((part) => extractTextFromContentPart(part)).join('');
      }
    });
    return { text, reasoning, done: true, error: '', usage: payload.response?.usage || payload.usage || null };
  }
  if (payload.type === 'response.failed' || payload.type === 'response.incomplete') {
    const message = payload.response?.error?.message
      || payload.error?.message
      || payload.response?.incomplete_details?.reason
      || payload.reason
      || '';
    return { text: '', reasoning: '', done: true, error: String(message || 'Responses API stream failed') };
  }
  if (payload.error?.message) {
    return { text: '', reasoning: '', done: true, error: String(payload.error.message) };
  }
  if (type.startsWith('response.')) {
    return { text: '', reasoning: '', done: false, error: '' };
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
  if (!choice && usage) {
    return {
      text: '',
      reasoning: '',
      done: true,
      error: '',
      usage,
    };
  }
  const delta = choice?.delta || {};
  const contentParts = Array.isArray(delta.content) ? delta.content : null;
  const text = typeof delta.content === 'string'
    ? delta.content
    : contentParts
      ? contentParts.map((part) => extractTextFromContentPart(part)).join('')
      : '';
  const reasoning = typeof delta.reasoning_content === 'string'
    ? delta.reasoning_content
    : typeof delta.reasoning === 'string'
      ? delta.reasoning
      : '';
  return {
    text,
    reasoning,
    done: choice?.finish_reason != null,
    error: '',
    usage: payload.usage || null,
  };
}

module.exports = {
  decodeCursorChatRequest,
  decodeRunSseRequestId,
  decodeBidiAppendRequest,
  extractAgentModeFromPayload,
  readConnectFrames,
  summarizeConnectFrames,
  summarizeAgentServerStream,
  summarizeAgentClientMessagePayload,
  summarizeAgentServerMessagePayload,
  buildCursorTextFrame,
  buildCursorReasoningFrame,
  buildAgentExecReadFrame,
  buildAgentExecWriteFrame,
  buildAgentExecDeleteFrame,
  buildAgentExecGrepFrame,
  buildAgentExecLsFrame,
  buildAgentExecShellStreamFrame,
  buildAgentExecDiagnosticsFrame,
  buildAgentKvSetBlobFrame,
  buildAgentTextDeltaFrame,
  buildAgentThinkingDeltaFrame,
  buildAgentThinkingCompletedFrame,
  buildAgentTokenDeltaFrame,
  buildAgentStepStartedFrame,
  buildAgentStepCompletedFrame,
  buildAgentPartialToolCallFrame,
  buildAgentToolCallStartedFrame,
  buildAgentToolCallCompletedFrame,
  buildAgentToolCallProgressFrame,
  buildAgentTaskToolCallDeltaFrame,
  buildAgentEditToolCallDeltaFrame,
  buildAgentTurnEndedFrame,
  buildAgentHeartbeatFrame,
  buildAgentInteractionQueryFrame,
  buildAgentAskQuestionQueryFrame,
  buildAgentCreatePlanQueryFrame,
  buildAgentConversationCheckpointFrame,
  buildAgentToolCallFrame,
  buildStructuredToolCallSnapshot,
  buildConnectEndFrame,
  buildConnectErrorFrame,
  extractOpenAiDelta,
};

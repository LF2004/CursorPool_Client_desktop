/**
 * cursor-relay-streamcpp.js
 *
 * StreamCpp 代码补全复刻（阶段七）
 *
 * 逆向文档已确认的流程：
 *   1. Cursor 客户端调用 AiService/StreamCpp 请求代码补全
 *      请求包含：current_file（当前文件内容+光标位置）、prefix/suffix（光标前后代码）、
 *      recently_edited_ranges、language_id 等
 *   2. 服务端返回 StreamCppResponse 流：
 *      - text: 补全文本
 *      - rangeToReplace: 要替换的行范围
 *      - bindingId: 绑定ID（用于后续 RecordCppFate 追踪）
 *      - shouldRemoveLeadingEol: 是否移除前导换行
 *      - doneStream: 流结束标志
 *   3. CppService/CppConfig 返回补全配置（防抖、启发式规则等）
 *   4. CppService/RecordCppFate 记录用户是否接受补全
 *
 * Relay 策略：
 *   - StreamCpp: 转发到上游模型（用补全模型），把请求转换为 OpenAI chat completions
 *   - CppConfig: 返回默认配置（或转发上游配置）
 *   - RecordCppFate: 直接返回空响应（不需要上报）
 */

const {
  loadCursorProtoRoot,
  getRootSync,
  decodeMessageSync,
  encodeMessageSync,
  readConnectFrames,
  buildConnectFrame,
  buildConnectEndFrame,
} = require('./cursor-relay-protobuf');

// ── 路径常量 ────────────────────────────────────────────────

const STREAM_CPP_PATH = '/aiserver.v1.AiService/StreamCpp';
const CPP_CONFIG_PATH = '/aiserver.v1.AiService/CppConfig';
const RECORD_CPP_FATE_PATH = '/aiserver.v1.CppService/RecordCppFate';

function isStreamCppPath(pathname) {
  return pathname === STREAM_CPP_PATH;
}

function isCppConfigPath(pathname) {
  return pathname === CPP_CONFIG_PATH;
}

function isRecordCppFatePath(pathname) {
  return pathname === RECORD_CPP_FATE_PATH;
}

function isCppRelatedPath(pathname) {
  return isStreamCppPath(pathname) || isCppConfigPath(pathname) || isRecordCppFatePath(pathname);
}

// ── StreamCpp 请求解码 ──────────────────────────────────────

/**
 * 解码 StreamCpp 请求
 *
 * @param {Buffer} rawBody 原始请求体（Connect 协议帧）
 * @returns {{currentFile, prefix, suffix, languageId, workspaceRoot, modelName, raw}|null}
 */
function decodeStreamCppRequest(rawBody) {
  try {
    getRootSync(); // 确保 proto 已加载
    const frames = readConnectFrames(rawBody);
    if (frames.length === 0) return null;

    const req = decodeMessageSync('aiserver.v1.StreamCppRequest', frames[0].payload);
    if (!req) return null;

    const currentFile = req.currentFile || {};
    const cursorPos = currentFile.cursorPosition || {};
    const fileContents = String(currentFile.contents || '');
    const lineNumber = Number(cursorPos.line) || 0;
    const column = Number(cursorPos.column) || 0;

    // 从文件内容中提取 prefix/suffix
    const lines = fileContents.split('\n');
    const beforeLines = lineNumber > 0 ? lines.slice(0, lineNumber - 1) : [];
    const currentLineBefore = (lines[lineNumber - 1] || '').substring(0, column);
    const currentLineAfter = (lines[lineNumber - 1] || '').substring(column);
    const afterLines = lineNumber < lines.length ? lines.slice(lineNumber) : [];

    const prefix = [...beforeLines, currentLineBefore].join('\n');
    const suffix = [currentLineAfter, ...afterLines].join('\n');

    return {
      currentFile: {
        relativeWorkspacePath: String(currentFile.relativeWorkspacePath || ''),
        contents: fileContents,
        languageId: String(currentFile.languageId || ''),
        totalNumberOfLines: Number(currentFile.totalNumberOfLines) || lines.length,
        workspaceRootPath: String(currentFile.workspaceRootPath || ''),
      },
      cursorPosition: { line: lineNumber, column },
      prefix,
      suffix,
      languageId: String(currentFile.languageId || ''),
      workspaceRoot: String(currentFile.workspaceRootPath || ''),
      modelName: String(req.modelName || ''),
      raw: req,
    };
  } catch (e) {
    return null;
  }
}

// ── 构建 OpenAI 补全请求 ────────────────────────────────────

/**
 * 把 StreamCpp 请求转换为 OpenAI chat completions 请求
 *
 * 策略：用 FIM (Fill-In-the-Middle) 格式发送给上游模型
 *
 * @param {object} decoded decodeStreamCppRequest 的返回值
 * @param {object} upstream 上游配置 { baseUrl, apiKey, model }
 * @returns {{url, options}} fetch 请求参数
 */
function buildStreamCppOpenAIRequest(decoded, upstream = {}) {
  const baseUrl = String(upstream.baseUrl || '').replace(/\/+$/, '');
  const model = upstream.model || upstream.codeModel || 'gpt-4o-mini';

  // FIM 格式提示词
  const prefix = decoded.prefix || '';
  const suffix = decoded.suffix || '';
  const languageId = decoded.languageId || '';

  // 构建消息：用 system 指示补全任务，user 提供上下文
  const systemPrompt = [
    'You are a code completion assistant. Complete the code at the cursor position.',
    languageId ? `Language: ${languageId}` : '',
    'Return ONLY the completion text that should be inserted at the cursor position.',
    'Do not include the code before or after the cursor. Do not use markdown formatting.',
  ].filter(Boolean).join('\n');

  const userPrompt = [
    'Complete the following code at the <CURSOR> position:',
    '```',
    prefix + '<CURSOR>' + suffix,
    '```',
  ].join('\n');

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: true,
    max_tokens: 256,
    temperature: 0.2,
    top_p: 0.9,
    stream_options: { include_usage: true },
  });

  return {
    url: `${baseUrl}/chat/completions`,
    options: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstream.apiKey || ''}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body,
    },
  };
}

// ── 构建 StreamCpp 响应帧 ───────────────────────────────────

/**
 * 构建 StreamCppResponse 的 Connect 协议帧
 *
 * @param {object} response StreamCppResponse 字段
 * @returns {Buffer} Connect 协议帧
 */
function buildStreamCppResponseFrame(response = {}) {
  const payload = encodeMessageSync('aiserver.v1.StreamCppResponse', response);
  return buildConnectFrame(payload);
}

/**
 * 构建流结束帧
 */
function buildStreamCppEndFrame() {
  return buildConnectEndFrame();
}

/**
 * 构建 bindingId
 */
function generateBindingId() {
  const crypto = require('crypto');
  return `${crypto.randomUUID()}:0`;
}

// ── 解析 OpenAI SSE 流为 StreamCpp 帧 ───────────────────────

/**
 * 从 OpenAI SSE 流的 delta 中提取文本，构建 StreamCpp 响应帧
 *
 * @param {string} textDelta 增量文本
 * @param {string} bindingId 绑定ID
 * @returns {Buffer} StreamCpp 响应帧
 */
function buildTextDeltaFrame(textDelta, bindingId) {
  return buildStreamCppResponseFrame({
    text: textDelta,
    bindingId,
  });
}

/**
 * 构建初始模型信息帧
 */
function buildModelInfoFrame() {
  return buildStreamCppResponseFrame({
    text: '',
  });
}

/**
 * 构建替换范围帧
 *
 * @param {number} startLine 开始行
 * @param {number} endLine 结束行（包含）
 * @param {string} bindingId 绑定ID
 * @param {boolean} shouldRemoveLeadingEol 是否移除前导换行
 * @returns {Buffer}
 */
function buildRangeToReplaceFrame(startLine, endLine, bindingId, shouldRemoveLeadingEol = true) {
  return buildStreamCppResponseFrame({
    rangeToReplace: {
      startLineNumber: startLine,
      endLineNumberInclusive: endLine,
    },
    shouldRemoveLeadingEol,
    bindingId,
  });
}

/**
 * 构建完成帧
 */
function buildDoneStreamFrame(bindingId) {
  return buildStreamCppResponseFrame({
    text: '',
    doneStream: true,
    bindingId,
  });
}

// ── CppConfig 默认配置 ──────────────────────────────────────

/**
 * 构建默认的 CppConfig 响应
 *
 * 从逆向文档还原的配置值
 *
 * @returns {Buffer} Connect 协议帧
 */
function buildDefaultCppConfigResponse() {
  const config = {
    aboveRadius: 1,
    belowRadius: 2,
    isOn: true,
    isGhostText: true,
    shouldLetUserEnableCppEvenIfNotPro: true,
    excludeRecentlyViewedFilesPatterns: [
      '.env', '.production', '.pem', '.cursor-retrieval.',
      '.cursor-always-local.', '.svg', '.lock', '.jsonl', '.csv', '.tsv', 'Copilot++',
    ],
    enableRvfTracking: true,
    globalDebounceDurationMillis: 70,
    clientDebounceDurationMillis: 50,
    cppUrl: 'https://api3.cursor.sh',
    useWhitespaceDiffHistory: true,
    checkFilesyncHashPercent: 0.005,
    isFusedCursorPredictionModel: true,
    maxNumberOfClearedSuggestionsSinceLastAccept: 20,
    allowsTabChunks: true,
    tabContextRefreshDebounceMs: 1000,
    tabContextRefreshEditorChangeDebounceMs: 1000,
  };
  const payload = encodeMessageSync('aiserver.v1.CppConfigResponse', config);
  return buildConnectFrame(payload);
}

// ── RecordCppFate 空响应 ────────────────────────────────────

/**
 * 构建 RecordCppFate 的空响应
 */
function buildRecordCppFateResponse() {
  const payload = encodeMessageSync('aiserver.v1.RecordCppFateResponse', {});
  return buildConnectFrame(payload);
}

// ── OpenAI SSE 解析 ─────────────────────────────────────────

/**
 * 解析 OpenAI SSE 流的一行，提取 delta 文本
 *
 * @param {string} line SSE 数据行
 * @returns {{text: string, done: boolean, usage: object|null}}
 */
function parseOpenAISSEDelta(line) {
  if (!line || !line.startsWith('data: ')) return { text: '', done: false, usage: null };
  const data = line.slice(6).trim();
  if (data === '[DONE]') return { text: '', done: true, usage: null };
  try {
    const parsed = JSON.parse(data);
    const text = parsed.choices?.[0]?.delta?.content || '';
    const usage = parsed.usage || null;
    return { text, done: false, usage };
  } catch {
    return { text: '', done: false, usage: null };
  }
}

module.exports = {
  // 路径检测
  isStreamCppPath,
  isCppConfigPath,
  isRecordCppFatePath,
  isCppRelatedPath,
  STREAM_CPP_PATH,
  CPP_CONFIG_PATH,
  RECORD_CPP_FATE_PATH,
  // 请求解码
  decodeStreamCppRequest,
  // OpenAI 请求构建
  buildStreamCppOpenAIRequest,
  // 响应帧构建
  buildStreamCppResponseFrame,
  buildStreamCppEndFrame,
  buildTextDeltaFrame,
  buildModelInfoFrame,
  buildRangeToReplaceFrame,
  buildDoneStreamFrame,
  generateBindingId,
  // CppConfig
  buildDefaultCppConfigResponse,
  // RecordCppFate
  buildRecordCppFateResponse,
  // SSE 解析
  parseOpenAISSEDelta,
};

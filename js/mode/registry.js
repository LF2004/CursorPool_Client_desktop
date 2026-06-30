const fs = require('fs');
const path = require('path');

const CURSOR_PROMPT_ROOT = path.join(process.cwd(), 'prompt');
const CURSOR_MODE_ROOT = path.join(process.cwd(), 'skills', 'cursor_modes');
const FAKE_MODEL_ID_PLACEHOLDER = '{{FAKE_MODEL_ID}}';

const MODE_DIRECTORY_BY_NAME = {
  AGENT_MODE_AGENT: 'agent',
  AGENT_MODE_ASK: 'ask',
  AGENT_MODE_PLAN: 'plan',
  AGENT_MODE_DEBUG: 'debug',
  AGENT_MODE_TRIAGE: 'triage',
  AGENT_MODE_PROJECT: 'project',
  AGENT_MODE_MULTITASK: 'multitask',
  AGENT_MODE_SUBAGENT: 'subagent',
};

function normalizeAgentModeName(value = '') {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'AGENT_MODE_ASK' || text === 'ASK') return 'AGENT_MODE_ASK';
  if (text === 'AGENT_MODE_PLAN' || text === 'PLAN') return 'AGENT_MODE_PLAN';
  if (text === 'AGENT_MODE_DEBUG' || text === 'DEBUG') return 'AGENT_MODE_DEBUG';
  if (text === 'AGENT_MODE_TRIAGE' || text === 'TRIAGE') return 'AGENT_MODE_TRIAGE';
  if (text === 'AGENT_MODE_PROJECT' || text === 'PROJECT') return 'AGENT_MODE_PROJECT';
  if (text === 'AGENT_MODE_MULTITASK' || text === 'MULTITASK' || text === 'TASK') return 'AGENT_MODE_MULTITASK';
  if (text === 'AGENT_MODE_SUBAGENT' || text === 'SUBAGENT') return 'AGENT_MODE_SUBAGENT';
  return 'AGENT_MODE_AGENT';
}

function getCursorModeDirectory(modeName = '') {
  return MODE_DIRECTORY_BY_NAME[normalizeAgentModeName(modeName)] || 'agent';
}

function getCursorModeFilePath(modeName = '', filename = '') {
  return path.join(CURSOR_MODE_ROOT, getCursorModeDirectory(modeName), filename);
}

function getCursorPromptFilePath(modeName = '', filename = '') {
  return path.join(CURSOR_PROMPT_ROOT, getCursorModeDirectory(modeName), filename);
}

function getSessionAgentMode(session = {}) {
  return normalizeAgentModeName(
    session.agentMode
    || session.lastUserMessageCapture?.mode
    || session.lastUserMessageCapture?.debug?.agentMode
    || session.lastUserMessageCapture?.debug?.agentClientMessage?.runRequest?.mode
    || 'AGENT_MODE_AGENT',
  );
}

function readTextFile(filePath = '') {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function renderPromptTemplate(text = '', modelName = '') {
  const replacement = String(modelName || '').trim() || 'current request model';
  return String(text || '').replaceAll(FAKE_MODEL_ID_PLACEHOLDER, replacement);
}

function readPromptAsset(modeName = '', options = {}) {
  const normalizedMode = normalizeAgentModeName(modeName);
  const directory = getCursorModeDirectory(normalizedMode);
  const promptText = readTextFile(path.join(CURSOR_PROMPT_ROOT, directory, 'prompt.md'));
  if (!promptText) {
    return renderPromptTemplate(readTextFile(getCursorModeFilePath(normalizedMode, 'system_prompt.txt')), options.modelName);
  }
  const shouldPrependCommonPrefix = directory !== 'debug' && directory !== 'subagent';
  const commonPrefix = shouldPrependCommonPrefix
    ? readTextFile(path.join(CURSOR_PROMPT_ROOT, 'common_prefix.md'))
    : '';
  return renderPromptTemplate([commonPrefix, promptText].filter(Boolean).join('\n\n'), options.modelName);
}

function readModeText(modeName = '', filename = '', options = {}) {
  const normalizedMode = normalizeAgentModeName(modeName);
  const promptFilenameMap = {
    'system_prompt.txt': 'prompt.md',
    'tools.json': 'tools.json',
  };
  if (filename === 'system_prompt.txt') {
    return readPromptAsset(normalizedMode, options);
  }
  const promptFilename = promptFilenameMap[filename] || filename;
  const promptText = readTextFile(getCursorPromptFilePath(normalizedMode, promptFilename));
  if (promptText) return renderPromptTemplate(promptText, options.modelName);
  return renderPromptTemplate(readTextFile(getCursorModeFilePath(normalizedMode, filename)), options.modelName);
}

module.exports = {
  CURSOR_PROMPT_ROOT,
  CURSOR_MODE_ROOT,
  MODE_DIRECTORY_BY_NAME,
  normalizeAgentModeName,
  getCursorModeDirectory,
  getCursorModeFilePath,
  getCursorPromptFilePath,
  getSessionAgentMode,
  readPromptAsset,
  readModeText,
  renderPromptTemplate,
};

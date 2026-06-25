const fs = require('fs');
const path = require('path');

const CURSOR_MODE_ROOT = path.join(process.cwd(), 'skills', 'cursor_modes');

const MODE_DIRECTORY_BY_NAME = {
  AGENT_MODE_AGENT: 'agent',
  AGENT_MODE_ASK: 'ask',
  AGENT_MODE_PLAN: 'plan',
  AGENT_MODE_MULTITASK: 'multitask',
};

function normalizeAgentModeName(value = '') {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'AGENT_MODE_ASK' || text === 'ASK') return 'AGENT_MODE_ASK';
  if (text === 'AGENT_MODE_PLAN' || text === 'PLAN') return 'AGENT_MODE_PLAN';
  if (text === 'AGENT_MODE_MULTITASK' || text === 'MULTITASK' || text === 'TASK') return 'AGENT_MODE_MULTITASK';
  return 'AGENT_MODE_AGENT';
}

function getCursorModeDirectory(modeName = '') {
  return MODE_DIRECTORY_BY_NAME[normalizeAgentModeName(modeName)] || 'agent';
}

function getCursorModeFilePath(modeName = '', filename = '') {
  return path.join(CURSOR_MODE_ROOT, getCursorModeDirectory(modeName), filename);
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

function readModeText(modeName = '', filename = '') {
  try {
    return fs.readFileSync(getCursorModeFilePath(modeName, filename), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

module.exports = {
  CURSOR_MODE_ROOT,
  MODE_DIRECTORY_BY_NAME,
  normalizeAgentModeName,
  getCursorModeDirectory,
  getCursorModeFilePath,
  getSessionAgentMode,
  readModeText,
};

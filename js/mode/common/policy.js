const { getSessionAgentMode } = require('../registry');

function isPlanLikeMode(modeName = '') {
  return String(modeName || '').trim().toUpperCase() === 'AGENT_MODE_PLAN';
}

function isTodoToolName(name = '') {
  const lower = String(name || '').trim().toLowerCase();
  return lower === 'todowrite' || lower === 'todo_write' || lower === 'updatetodo' || lower === 'updatetodos';
}

function shouldUseNativeExecForToolByMode(session, toolCall, helpers = {}) {
  const lower = String(toolCall?.name || '').trim().toLowerCase();
  const modeName = getSessionAgentMode(session);

  if (isTodoToolName(lower)) {
    return false;
  }
  if (lower === 'shell') {
    return false;
  }
  if (lower === 'patchedit' || lower === 'strreplace') {
    return typeof helpers.canUseNativePatchEditForTool === 'function'
      ? helpers.canUseNativePatchEditForTool(toolCall, session)
      : false;
  }
  if (session?.config?.emitAgentExecServerFrames === true) {
    return true;
  }
  if (session?.config?.nativeMutationTools === false) {
    return false;
  }

  const sharedNativeTools = new Set([
    'write',
    'edit',
    'delete',
    'read',
    'grep',
    'ls',
    'readlints',
    'diagnostics',
  ]);

  if (isPlanLikeMode(modeName)) {
    return sharedNativeTools.has(lower);
  }
  return sharedNativeTools.has(lower);
}

module.exports = {
  isPlanLikeMode,
  isTodoToolName,
  getSessionAgentMode,
  shouldUseNativeExecForToolByMode,
};

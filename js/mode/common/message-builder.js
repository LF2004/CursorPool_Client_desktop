function buildModeRelayMessages(input = {}) {
  const {
    userText = '',
    requestId = '',
    workspaceRoot = '',
    recentEditedFile = '',
    unfinishedContinuation = null,
    cursorAgentPrompt = '',
    cursorModeReminder = '',
    deepSeekGuidance = '',
    conversationMemory = '',
    imageParts = [],
    modeName = 'AGENT_MODE_AGENT',
    extraSystemLines = [],
    promptContextMessages = [],
  } = input;

  const user = String(userText || '');
  const userContent = Array.isArray(imageParts) && imageParts.length
    ? [{ type: 'input_text', text: user }, ...imageParts]
    : user;

  return [
    {
      role: 'system',
      content: [
        cursorAgentPrompt,
        cursorModeReminder,
        'You are powering a Cursor-style coding agent relay.',
        'Respond naturally and directly to the user.',
        'Do not claim local file edits or command execution unless a tool result was provided.',
        'For complex coding tasks with several dependent steps, use TodoWrite early to create a concise checklist, keep exactly one item in_progress, and update items as soon as they are completed.',
        'Prefer Grep, Glob, Read, LS, and Shell tools to inspect and verify the workspace instead of guessing from memory.',
        deepSeekGuidance,
        conversationMemory ? `<conversation_memory>\n${conversationMemory}\n</conversation_memory>` : '',
        recentEditedFile ? `Continuation context: the most recent successfully edited file in this conversation is "${recentEditedFile}". If the user's request omits a file path but asks to continue changing styling, colors, layout, copy, or the prior page, treat this as the target file.` : '',
        unfinishedContinuation ? [
          'Unfinished agent continuation context:',
          `Original user request: ${unfinishedContinuation.userText || ''}`,
          unfinishedContinuation.latestAssistantText ? `Latest assistant text before interruption: ${unfinishedContinuation.latestAssistantText}` : '',
          Array.isArray(unfinishedContinuation.toolResults) && unfinishedContinuation.toolResults.length ? `Recent tool results:\n${unfinishedContinuation.toolResults.map((line) => `- ${line}`).join('\n')}` : '',
          'Continue that unfinished task now. Do not ask the user to send another continue message.',
        ].filter(Boolean).join('\n') : '',
        workspaceRoot ? `Current workspace root: ${workspaceRoot}. Resolve relative file paths inside this directory.` : '',
        requestId ? `Relay request id: ${requestId}.` : '',
        `Current Cursor mode: ${modeName}.`,
        ...(Array.isArray(extraSystemLines) ? extraSystemLines : []),
      ].filter(Boolean).join('\n'),
    },
    ...(Array.isArray(promptContextMessages)
      ? promptContextMessages
        .filter((message) => message && typeof message === 'object' && String(message.content || '').trim())
        .map((message) => ({
          role: String(message.role || 'user'),
          content: String(message.content || ''),
        }))
      : []),
    { role: 'user', content: userContent },
  ];
}

module.exports = {
  buildModeRelayMessages,
};

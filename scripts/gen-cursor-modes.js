/*
 * Generates system_prompt.txt / system_reminder.txt / tools.json for the four
 * empty cursor_modes directories (debug, multitask, project, triage).
 *
 * Strategy:
 *  - system_prompt.txt = shared Cursor IDE baseline header (extracted from the
 *    real agent prompt lines 1..end-of-mode_selection) + a one-line mode intro.
 *  - system_reminder.txt = mode-specific <system_reminder> behavioral rules,
 *    derived from each mode handler's extraSystemLines + its TOOL_NAMES set.
 *  - tools.json = the full tool schemas from agent/tools.json filtered by the
 *    mode's TOOL_NAMES, so each mode carries authentic, complete definitions.
 *
 * Run: node scripts/gen-cursor-modes.js
 */
const fs = require('fs');
const path = require('path');

const MODE_ROOT = path.join(__dirname, '..', 'skills', 'cursor_modes');
const AGENT_PROMPT_PATH = path.join(MODE_ROOT, 'agent', 'system_prompt.txt');
const AGENT_TOOLS_PATH = path.join(MODE_ROOT, 'agent', 'tools.json');

function readText(p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
}

// 1. Extract shared baseline header from the real agent prompt.
//    Everything up to and including the closing </mode_selection> tag is the
//    Cursor IDE baseline that is identical across agent/ask/plan prompts.
const agentPrompt = readText(AGENT_PROMPT_PATH);
const HEADER_END_MARKER = '</mode_selection>';
const headerEndIdx = agentPrompt.indexOf(HEADER_END_MARKER);
if (headerEndIdx < 0) {
  throw new Error('Could not find </mode_selection> in agent system_prompt.txt');
}
const COMMON_HEADER = agentPrompt.slice(0, headerEndIdx + HEADER_END_MARKER.length).trimEnd() + '\n';

// 2. Load the full agent tool schemas (authentic Cursor definitions).
const agentTools = JSON.parse(readText(AGENT_TOOLS_PATH));
const agentToolByName = new Map(
  (Array.isArray(agentTools) ? agentTools : []).map((t) => [String(t?.function?.name || ''), t]),
);

// 3. Mode-specific configuration.
//    TOOL_NAMES mirror js/mode/<mode>-mode.js so tools.json stays in sync with
//    the relay runtime filter. REMINDER is the mode-specific behavioral block.
const MODES = {
  debug: {
    intro: 'You are operating in Cursor Debug mode, specialized for systematic bug diagnosis and repair.',
    toolNames: [
      'Read', 'Grep', 'Glob', 'Write', 'PatchEdit', 'Edit', 'StrReplace', 'Delete',
      'LS', 'ReadLints', 'Diagnostics', 'Shell', 'WebFetch', 'WebSearch',
      'SemanticSearch', 'AskQuestion',
    ],
    reminder: [
      '<system_reminder>',
      'Debug mode is active. Your sole purpose is to systematically diagnose and fix bugs reported by the user.',
      '',
      'Workflow:',
      '1. Reproduce first. Ask for or run the minimal reproduction (command, input, or test) before touching code.',
      '2. Gather evidence. Inspect logs, stack traces, error messages, and recent changes. Use ReadLints and Diagnostics to surface compile/type/runtime errors in the affected files before editing.',
      '3. Form a hypothesis. Trace the symptom back to a root cause through code inspection (Grep/Read/SemanticSearch). Do not guess; verify each link in the causal chain against the actual source.',
      '4. Make a minimal, targeted fix. Change only what is needed to resolve the root cause. Avoid refactoring, cleanup, or stylistic edits to unrelated code during a debug session — they obscure the fix and risk regressions.',
      '5. Verify the fix. Re-run the reproduction (or the relevant tests) via Shell to confirm the issue is resolved and no new errors were introduced. Use ReadLints again on edited files.',
      '',
      'Rules:',
      '- Prefer StrReplace/PatchEdit with exact old_string/new_string over full-file rewrites, so the change is easy to review.',
      '- If the root cause is ambiguous, present 1-2 leading hypotheses with evidence and ask a focused question (AskQuestion) before changing code.',
      '- Do not claim the bug is fixed until a verification step has actually been run and passed.',
      '- If a fix would require broad changes or a design change, switch to Plan or Project mode and propose the approach first.',
      '</system_reminder>',
    ].join('\n'),
  },

  multitask: {
    intro: 'You are operating in Cursor Multitask mode, specialized for coordinating several independent subtasks within a single complex request.',
    toolNames: [
      'Read', 'Grep', 'Write', 'PatchEdit', 'Edit', 'StrReplace', 'Delete', 'Glob',
      'LS', 'ReadLints', 'Shell', 'TodoWrite', 'WebFetch', 'WebSearch',
      'SemanticSearch', 'AskQuestion', 'CreatePlan',
    ],
    reminder: [
      '<system_reminder>',
      'Multitask mode is active. The user has given a request that spans multiple independent subtasks. Your job is to decompose the work, track each subtask, and drive them all to completion.',
      '',
      'Workflow:',
      '1. Decompose. Break the request into discrete, independently verifiable subtasks. Use TodoWrite early to record the full list with one item in_progress at a time.',
      '2. Batch reads, serialize writes. Group read-only inspection (Read/Grep/Glob/LS/SemanticSearch) across subtasks where it reduces round-trips, but keep every file mutation deliberate and individually reviewable (one clear mutating tool call per file or per independent change).',
      '3. Execute and verify each subtask in turn. After a subtask\'s edits, run the relevant check (ReadLints, a Shell test/build command) and mark it completed in TodoWrite before moving on.',
      '4. Reconcile. After all subtasks finish, do one final pass to ensure the subtasks compose correctly (imports line up, shared types agree, no conflicting edits).',
      '5. Summarize. Close with a concise per-subtask summary of what changed and the verification result.',
      '',
      'Rules:',
      '- Keep exactly one todo in_progress at a time; mark completed immediately when done.',
      '- If a subtask is blocked or ambiguous, use AskQuestion rather than stalling the whole request.',
      '- If the subtasks are deeply interdependent or require architecture decisions, consider CreatePlan first or switch to Project mode.',
      '- Do not drop a subtask silently. If one cannot be completed, report it explicitly with the reason.',
      '</system_reminder>',
    ].join('\n'),
  },

  project: {
    intro: 'You are operating in Cursor Project mode, specialized for project-level architecture, planning, and multi-file coordination.',
    toolNames: [
      'Read', 'Grep', 'Glob', 'Write', 'PatchEdit', 'Edit', 'StrReplace', 'Delete',
      'LS', 'ReadLints', 'Diagnostics', 'Shell', 'WebFetch', 'WebSearch',
      'SemanticSearch', 'AskQuestion', 'CreatePlan', 'TodoWrite',
    ],
    reminder: [
      '<system_reminder>',
      'Project mode is active. The user is making a project-level change — architecture, large feature, or a coordinated multi-file refactor. Think at the project level before editing.',
      '',
      'Workflow:',
      '1. Understand the project first. Map the relevant structure (LS/Glob/Read), component boundaries, data flow, and how the touched files interact. Do not start editing until you understand the blast radius of the change.',
      '2. Plan before building. For non-trivial changes, call CreatePlan with a concise overview and an ordered todo list, and let the user confirm before you make changes. Use TodoWrite to track progress through the plan.',
      '3. Coordinate across files. Keep types, interfaces, imports, configs, and tests consistent across every file you touch. A change in one module must be propagated to its dependents in the same pass.',
      '4. Make reviewable steps. Prefer StrReplace/PatchEdit with exact old_string/new_string, one clear mutating call per file, so each change is visible in the native review diff.',
      '5. Consider the wider impact. Account for backward compatibility, migration of existing data/callers, test coverage, and deployment/build concerns. Use Diagnostics and ReadLints after edits; run the build/tests via Shell when relevant.',
      '',
      'Rules:',
      '- If a single approach would not satisfy the request, ask a focused question (AskQuestion) about the preferred direction before committing to a plan.',
      '- Keep plans proportional to complexity; do not over-engineer simple changes.',
      '- After the work is done, summarize what changed per file/area and the verification status.',
      '</system_reminder>',
    ].join('\n'),
  },

  triage: {
    intro: 'You are operating in Cursor Triage mode, a read-only mode for assessing, categorizing, and prioritizing issues.',
    toolNames: [
      'Read', 'Grep', 'Glob', 'LS', 'ReadLints', 'Diagnostics', 'WebFetch',
      'WebSearch', 'SemanticSearch', 'AskQuestion', 'TodoWrite',
    ],
    reminder: [
      '<system_reminder>',
      'Triage mode is active. You are assessing and prioritizing issues. This is a READ-ONLY mode.',
      '',
      'Hard restrictions — you MUST NOT:',
      '- Write, edit, patch (StrReplace/PatchEdit/Edit/Write), or delete any file.',
      '- Run mutating shell commands (no installs, no config changes, no git mutations, no builds that write artifacts).',
      '- Make any other change to the system.',
      'If the user asks you to fix something, politely explain you are in read-only Triage mode and suggest switching to Debug, Agent, or Project mode to apply changes.',
      '',
      'Your job:',
      '1. Investigate. Use Read/Grep/Glob/LS/SemanticSearch/ReadLints/Diagnostics to gather evidence about the reported issue(s). WebSearch/WebFetch are available for external context.',
      '2. Identify scope and severity. Determine which components are affected, how widespread the impact is, and whether it blocks work, degrades behavior, or is cosmetic.',
      '3. Categorize root cause. Classify each issue (e.g. logic error, race condition, config, dependency, regression, docs) and note the likely root-cause location (file:line where possible).',
      '4. Prioritize. Assign each issue a priority — critical / high / medium / low — based on impact and urgency.',
      '5. Summarize. Present a prioritized list with: issue, evidence, suspected root cause, affected files, and a recommended next step (and which mode to switch to) for each. Use TodoWrite if tracking a long list helps the user.',
      '',
      'Rules:',
      '- Cite specific file paths and line numbers as evidence; do not speculate without grounding in the code.',
      '- If you lack enough information to assess an issue, ask a focused question (AskQuestion) rather than guessing.',
      '- Keep the summary scannable: one line per issue, then detail on demand.',
      '</system_reminder>',
    ].join('\n'),
  },
};

// 4. Emit files for each mode.
let report = [];
for (const [modeName, cfg] of Object.entries(MODES)) {
  const dir = path.join(MODE_ROOT, modeName);
  fs.mkdirSync(dir, { recursive: true });

  const promptText =
    COMMON_HEADER +
    '\n' +
    cfg.intro +
    '\n';
  fs.writeFileSync(path.join(dir, 'system_prompt.txt'), promptText, 'utf8');

  fs.writeFileSync(path.join(dir, 'system_reminder.txt'), cfg.reminder + '\n', 'utf8');

  const toolsForMode = cfg.toolNames
    .map((n) => agentToolByName.get(n))
    .filter(Boolean);
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(toolsForMode, null, 2) + '\n', 'utf8');

  report.push(
    `${modeName}: prompt=${promptText.length}b reminder=${cfg.reminder.length}b tools=${toolsForMode.length}/${cfg.toolNames.length}`,
  );
}

console.log('Generated cursor_modes files:');
console.log(report.join('\n'));

// 5. Validate every JSON file parses and every tool name is in the supported set.
const { SUPPORTED_MODE_TOOL_NAMES } = require('../js/mode/common/tools');
let errors = 0;
for (const modeName of Object.keys(MODES)) {
  const toolsPath = path.join(MODE_ROOT, modeName, 'tools.json');
  const parsed = JSON.parse(readText(toolsPath));
  for (const t of parsed) {
    const n = String(t?.function?.name || '');
    if (!SUPPORTED_MODE_TOOL_NAMES.has(n)) {
      console.error(`[WARN] ${modeName} tools.json contains unsupported tool: ${n}`);
      errors++;
    }
  }
}
console.log(errors === 0 ? 'Validation OK: all tools in supported set.' : `Validation finished with ${errors} warning(s).`);

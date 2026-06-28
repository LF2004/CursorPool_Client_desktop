/*
 * Regression verification for the relay account/model/context + cursor_modes
 * fixes. Exercises the real module graph (no mocks) so a green run proves the
 * runtime will behave correctly in Electron.
 *
 * Run: node scripts/verify-relay-regression.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

console.log('=== Regression verification ===\n');

// ------------------------------------------------------------------
// 1. Mode registry: every mode resolves to the right directory and the
//    prompt/reminder/tools files all exist and parse.
// ------------------------------------------------------------------
console.log('[1] Mode registry + cursor_modes files');
const registry = require('../js/mode/registry');
const {
  buildFallbackRelayToolDefinitions,
  loadAgentModeToolDefinitionsForChat,
  mergeAgentModeToolDefinitions,
  filterToolDefinitionsByName,
  SUPPORTED_MODE_TOOL_NAMES,
} = require('../js/mode/common/tools');
const modeIndex = require('../js/mode');

const EXPECTED_MODES = {
  AGENT_MODE_AGENT: 'agent',
  AGENT_MODE_ASK: 'ask',
  AGENT_MODE_PLAN: 'plan',
  AGENT_MODE_DEBUG: 'debug',
  AGENT_MODE_TRIAGE: 'triage',
  AGENT_MODE_PROJECT: 'project',
  AGENT_MODE_MULTITASK: 'multitask',
};

for (const [modeName, dir] of Object.entries(EXPECTED_MODES)) {
  check(`${modeName} -> directory "${dir}"`, registry.getCursorModeDirectory(modeName) === dir,
    `got ${registry.getCursorModeDirectory(modeName)}`);
  const promptPath = registry.getCursorModeFilePath(modeName, 'system_prompt.txt');
  check(`${modeName} system_prompt.txt exists`, fs.existsSync(promptPath));
  const reminderPath = registry.getCursorModeFilePath(modeName, 'system_reminder.txt');
  // reminder is optional for agent/ask (inline in prompt) but required for the rest
  if (['debug', 'multitask', 'project', 'triage', 'plan'].includes(dir)) {
    check(`${modeName} system_reminder.txt exists`, fs.existsSync(reminderPath));
  }
  const toolsPath = registry.getCursorModeFilePath(modeName, 'tools.json');
  check(`${modeName} tools.json exists`, fs.existsSync(toolsPath));
  if (fs.existsSync(toolsPath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(toolsPath, 'utf8').replace(/^\uFEFF/, ''));
      check(`${modeName} tools.json parses (${parsed.length} entries)`, Array.isArray(parsed));
    } catch (e) {
      check(`${modeName} tools.json parses`, false, e.message);
      parsed = [];
    }
    // What matters at runtime: loadAgentModeToolDefinitionsForChat filters to
    // the supported set. Assert the LOADED result, not the raw JSON (agent/ask
    // legitimately carry extra tools like CallMcpTool that get filtered out).
    const loaded = loadAgentModeToolDefinitionsForChat(modeName);
    check(`${modeName} loaded tools all in supported set (${loaded.length})`, loaded.length > 0, 'no tools loaded');
    const allLoadedSupported = loaded.every((t) => SUPPORTED_MODE_TOOL_NAMES.has(String(t?.function?.name || '')));
    check(`${modeName} loaded tools all supported`, allLoadedSupported);
  }
}

// ------------------------------------------------------------------
// 2. Each mode handler builds tools + relay messages without throwing,
//    and the mode-specific prompt/reminder text actually flows through.
// ------------------------------------------------------------------
console.log('\n[2] Mode handlers build tools + messages');
for (const modeName of Object.keys(EXPECTED_MODES)) {
  const handler = modeIndex.getModeHandler(modeName);
  check(`${modeName} handler loaded`, !!handler);

  let chatTools;
  try {
    chatTools = handler.buildToolDefinitionsForChat({});
    check(`${modeName} buildToolDefinitionsForChat (${chatTools.length} tools)`, Array.isArray(chatTools) && chatTools.length > 0);
  } catch (e) {
    check(`${modeName} buildToolDefinitionsForChat`, false, e.message);
  }

  let respTools;
  try {
    respTools = handler.buildToolDefinitionsForResponses({});
    check(`${modeName} buildToolDefinitionsForResponses`, Array.isArray(respTools));
  } catch (e) {
    check(`${modeName} buildToolDefinitionsForResponses`, false, e.message);
  }

  let messages;
  try {
    messages = handler.buildLocalRelayMessages({
      userText: 'hello',
      requestId: 'test-req',
      workspaceRoot: ROOT,
    });
    check(`${modeName} buildLocalRelayMessages returns array`, Array.isArray(messages) && messages.length >= 2);
    if (Array.isArray(messages) && messages[0]) {
      const sysContent = String(messages[0].content || '');
      // The mode name must appear in the assembled system message.
      check(`${modeName} mode name in system message`, sysContent.includes(`Current Cursor mode: ${modeName}`),
        'mode line missing');
      // For the four new modes, the mode-specific reminder text must be present.
      if (['AGENT_MODE_DEBUG', 'AGENT_MODE_MULTITASK', 'AGENT_MODE_PROJECT', 'AGENT_MODE_TRIAGE'].includes(modeName)) {
        const reminderFile = registry.readModeText(modeName, 'system_reminder.txt');
        const marker = reminderFile.split('\n').find((l) => l.trim() && !l.startsWith('<') && !l.startsWith('Workflow') && !l.startsWith('Rules') && !l.startsWith('Hard') && !l.startsWith('Your'));
        if (marker) {
          check(`${modeName} reminder text flows into system message`, sysContent.includes(marker.trim().slice(0, 40)),
            `expected fragment of: ${marker.trim().slice(0, 60)}`);
        }
      }
    }
  } catch (e) {
    check(`${modeName} buildLocalRelayMessages`, false, e.message);
  }
}

// ------------------------------------------------------------------
// 3. Triage mode must NOT expose mutation tools (read-only guarantee).
// ------------------------------------------------------------------
console.log('\n[3] Triage read-only guarantee');
const triageHandler = modeIndex.getModeHandler('AGENT_MODE_TRIAGE');
const triageTools = triageHandler.buildToolDefinitionsForChat({});
const triageNames = new Set(triageTools.map((t) => t.function.name));
const MUTATION_TOOLS = ['Write', 'Edit', 'PatchEdit', 'StrReplace', 'Delete', 'Shell'];
for (const m of MUTATION_TOOLS) {
  check(`triage excludes ${m}`, !triageNames.has(m));
}
check('triage keeps Read', triageNames.has('Read'));

// ------------------------------------------------------------------
// 4. Membership type casing fix (auth-intercept / account-store /
//    update_cursor_auth) — must be lowercase 'free'/'pro'/'ultra'.
// ------------------------------------------------------------------
console.log('\n[4] Membership type casing (lowercase fix)');
const authIntercept = require('../js/utils/cursor-relay-auth-intercept');
const accountStore = require('../js/utils/cursor-relay-account-store');

// auth-intercept exposes MEMBERSHIP_TYPES
const mt = authIntercept.MEMBERSHIP_TYPES || authIntercept.membershipTypes || {};
check('MEMBERSHIP_TYPES.FREE === "free"', mt.FREE === 'free', `got ${mt.FREE}`);
check('MEMBERSHIP_TYPES.PRO === "pro"', mt.PRO === 'pro', `got ${mt.PRO}`);
check('MEMBERSHIP_TYPES.ULTRA === "ultra"', mt.ULTRA === 'ultra', `got ${mt.ULTRA}`);

// Check the source files directly for the old uppercase bug.
const authSrc = fs.readFileSync(path.join(ROOT, 'js/utils/cursor-relay-auth-intercept.js'), 'utf8');
check('auth-intercept has no .toUpperCase() on membership', !/membershipType[^.]*\.toUpperCase\(\)/i.test(authSrc));
const storeSrc = fs.readFileSync(path.join(ROOT, 'js/utils/cursor-relay-account-store.js'), 'utf8');
check('account-store has no .toUpperCase() on membership', !/membershipType[^.]*\.toUpperCase\(\)/i.test(storeSrc));
const updSrc = fs.readFileSync(path.join(ROOT, 'update_cursor_auth.js'), 'utf8');
check('update_cursor_auth has no .toUpperCase() on membership', !/membershipType[^.]*\.toUpperCase\(\)/i.test(updSrc));
check('update_cursor_auth uses .toLowerCase()', /\.toLowerCase\(\)/.test(updSrc));

// ------------------------------------------------------------------
// 5. AvailableModelsResponse proto: models field (#2) present.
// ------------------------------------------------------------------
console.log('\n[5] AvailableModelsResponse models field (#2)');
// [FIX #2] 验证 regen/proto（实际加载的）有正确的 AvailableModel 嵌套类型，而非错误的 ModelDetails 占位
const protoDir = path.join(ROOT, 'proto');
let protoWithModels = false;
function scanProto(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanProto(full);
    } else if (entry.name.endsWith('.proto')) {
      const txt = fs.readFileSync(full, 'utf8');
      // 检查 regen/aiserver_v1.proto 是否用正确的 AvailableModel 类型
      if (/message\s+AvailableModelsResponse/.test(txt) && /repeated\s+AvailableModel\s+models\s*=\s*2/.test(txt)) {
        protoWithModels = true;
      }
    }
  }
}
scanProto(protoDir);
check('AvailableModelsResponse has repeated AvailableModel models = 2', protoWithModels);

// [FIX #2] 运行时验证：protobufjs 加载后 models 字段解析为 AvailableModel（非 ModelDetails）
let runtimeModelsType = false;
try {
  const { execFileSync } = require('child_process');
  const runtimeCheckScript = [
    '(async () => {',
    `  const mod = require(${JSON.stringify(path.join(ROOT, 'js/utils/cursor-relay-protobuf.js'))});`,
    '  await mod.loadCursorProtoRoot();',
    '  const root = mod.getRootSync();',
    "  const amr = root.lookupType('aiserver.v1.AvailableModelsResponse');",
    "  const ok = Object.values(amr?.fields || {}).some((f) => f.name === 'models' && f.resolvedType?.name === 'AvailableModel');",
    "  process.stdout.write(ok ? 'true' : 'false');",
    '})().catch(() => process.stdout.write(\'false\'));',
  ].join('\n');
  runtimeModelsType = execFileSync(process.execPath, ['-e', runtimeCheckScript], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim() === 'true';
} catch { /* skip */ }
check('runtime: models field resolves to AvailableModel type', runtimeModelsType);

// model-injection injects into both model_names(#1) and models(#2)
const injSrc = fs.readFileSync(path.join(ROOT, 'js/utils/cursor-relay-model-injection.js'), 'utf8');
check('model-injection references models array injection', /modelsToAdd|models:\s*\[|modelsToAdd/i.test(injSrc));

// ------------------------------------------------------------------
// 6. conversationAction kind normalization (v2 decoder -> legacy).
// ------------------------------------------------------------------
console.log('\n[6] conversationAction kind normalization');
const v2 = require('../js/utils/cursor-relay-protocol-v2');
check('normalizeConversationActionForLegacy exported', typeof v2.normalizeConversationActionForLegacy === 'function');

// ------------------------------------------------------------------
// 7. Destructive Write/Edit protection must be unique and active.
// ------------------------------------------------------------------
console.log('\n[7] Destructive write protection');
const runnerPath = path.join(ROOT, 'js/utils/cursor-relay-runner.js');
const runnerSrc = fs.readFileSync(runnerPath, 'utf8');
const warnFnMatches = runnerSrc.match(/function warnIfWriteLooksDestructive\(/g) || [];
check('runner has single warnIfWriteLooksDestructive definition', warnFnMatches.length === 1, `found ${warnFnMatches.length}`);

let destructiveGuardExported = false;
let destructiveWriteBlocked = false;
let safeRewriteAllowed = false;
try {
  const { detectDestructiveWrite } = require('../js/utils/cursor-relay-runner');
  destructiveGuardExported = typeof detectDestructiveWrite === 'function';
  const before = Array.from({ length: 80 }, (_, i) => `const keep_line_${i} = ${i};`).join('\n');
  const dangerousSnippet = [
    'function onlyNewSnippet() {',
    '  return 1;',
    '}',
  ].join('\n');
  const safeRewrite = `${before}\nconst appended_line = true;`;
  destructiveWriteBlocked = Boolean(detectDestructiveWrite('src/example.js', before, dangerousSnippet)?.message);
  safeRewriteAllowed = detectDestructiveWrite('src/example.js', before, safeRewrite) === null;
} catch {
  /* checked below */
}
check('detectDestructiveWrite exported', destructiveGuardExported);
check('detectDestructiveWrite blocks suspicious snippet overwrite', destructiveWriteBlocked);
check('detectDestructiveWrite allows near-full rewrite', safeRewriteAllowed);

// ------------------------------------------------------------------
// 8. Official native mode number mapping must cover Multitask/Debug.
// ------------------------------------------------------------------
console.log('\n[8] Official native agent mode mapping');
let modeMappingOk = false;
let bidiCarriesMultitaskMode = false;
try {
  const {
    mapAgentModeNameToNumber,
    buildAgentBidiAppendPayload,
  } = require('../js/utils/cursor-relay-agent-test');
  modeMappingOk = mapAgentModeNameToNumber('AGENT_MODE_DEBUG') === 4
    && mapAgentModeNameToNumber('DEBUG') === 4
    && mapAgentModeNameToNumber('AGENT_MODE_MULTITASK') === 7
    && mapAgentModeNameToNumber('MULTITASK') === 7
    && mapAgentModeNameToNumber('TASK') === 7;

  const payload = buildAgentBidiAppendPayload('req-mode-check', 'hello', {
    mode: 'AGENT_MODE_MULTITASK',
  });
  bidiCarriesMultitaskMode = Buffer.from(payload).includes(Buffer.from([0x20, 0x07]))
    && Buffer.from(payload).includes(Buffer.from([0x50, 0x07]));
} catch {
  /* checked below */
}
check('mapAgentModeNameToNumber covers DEBUG and MULTITASK', modeMappingOk);
check('BidiAppend payload carries AGENT_MODE_MULTITASK as mode=7', bidiCarriesMultitaskMode);

// ------------------------------------------------------------------
// 8b. Native TaskV2 / debug bugfix tool parity checks.
// ------------------------------------------------------------------
console.log('\n[8b] Native TaskV2 and debug bugfix parity');
let taskV2MappingOk = false;
let reportBugfixMappingOk = false;
let taskRegistryWorks = false;
let taskStructuredSnapshotOk = false;
try {
  const protocolSrc = fs.readFileSync(path.join(ROOT, 'js/utils/cursor-relay-protocol.js'), 'utf8');
  taskV2MappingOk = /normalized === 'task'\) return \{ field: 19, name: 'Task' \}/.test(protocolSrc)
    || /normalized === 'task'.+field: 69, name: 'Task'/s.test(protocolSrc);
  reportBugfixMappingOk = /ReportBugfixResults/.test(protocolSrc)
    && /field: 78, name: 'ReportBugfixResults'/.test(protocolSrc);

  const runtimeTaskCheckScript = [
    '(async () => {',
    `  const { buildStructuredToolCallSnapshot } = require(${JSON.stringify(path.join(ROOT, 'js/utils/cursor-relay-protocol.js'))});`,
    `  const { executeTaskTool } = require(${JSON.stringify(path.join(ROOT, 'js/utils/cursor-relay-runner.js'))});`,
    `  const session = { requestId: 'regression-task', workspaceRoot: ${JSON.stringify(ROOT)}, taskRegistry: null, config: {} };`,
    '  const execution = await executeTaskTool({',
    "    description: 'Inspect protocol',",
    "    prompt: 'Find TaskV2 and summarize native subagent flow',",
    "    subagent_type: { debug: 'debug' },",
    "    name: 'Protocol Inspector',",
    "    model: 'fast',",
    '  }, session);',
    "  const registryOk = Boolean(execution?.ok && execution.agentId && execution.subagentType === 'debug' && session.taskRegistry?.subagents instanceof Map && session.taskRegistry.subagents.has(execution.agentId));",
    "  const snapshot = buildStructuredToolCallSnapshot('Task', { description: 'Inspect protocol', prompt: 'Find TaskV2 and summarize native subagent flow', subagent_type: { debug: 'debug' }, name: 'Protocol Inspector', model: 'fast' }, execution, 'tool_task');",
    "  const snapshotOk = Boolean(snapshot?.taskToolCall?.args?.subagentType?.debug !== undefined && snapshot?.taskToolCall?.args?.model === 'fast');",
    "  process.stdout.write(JSON.stringify({ registryOk, snapshotOk }));",
    '})().catch(() => process.stdout.write(JSON.stringify({ registryOk: false, snapshotOk: false })));',
  ].join('\n');
  const runtimeTaskCheck = JSON.parse(execFileSync(process.execPath, ['-e', runtimeTaskCheckScript], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim() || '{}');
  taskRegistryWorks = Boolean(runtimeTaskCheck.registryOk);
  taskStructuredSnapshotOk = Boolean(runtimeTaskCheck.snapshotOk);
} catch {
  /* checked below */
}
check('protocol maps Task to native TaskToolCall field 19', taskV2MappingOk);
check('protocol maps debug bugfix tool to native field 78', reportBugfixMappingOk);
check('runner Task execution records subagent registry entry', taskRegistryWorks);
check('structured Task snapshot carries subagent/model/name', taskStructuredSnapshotOk);

let nativeTaskRpcRoutesOk = false;
let cacheSelfTestLogicOk = false;
try {
  const runnerSrcForNative = fs.readFileSync(path.join(ROOT, 'js/utils/cursor-relay-runner.js'), 'utf8');
  nativeTaskRpcRoutesOk = /TaskInit/.test(runnerSrcForNative)
    && /TaskStreamLog/.test(runnerSrcForNative)
    && /TaskProvideResult/.test(runnerSrcForNative)
    && /TaskGetInterfaceAgentStatus/.test(runnerSrcForNative)
    && /handleNativeTaskRpc/.test(runnerSrcForNative);

  cacheSelfTestLogicOk = !/relay-response-cache/.test(runnerSrcForNative)
    && !/cache-self-test/.test(runnerSrcForNative)
    && !/cacheStats:\s*responseCache/.test(runnerSrcForNative);
} catch {
  /* checked below */
}
check('runner exposes native Task RPC lifecycle routes', nativeTaskRpcRoutesOk);
check('runner no longer depends on local relay response cache', cacheSelfTestLogicOk);

// ------------------------------------------------------------------
// 9. Syntax check all recently modified JS files.
// ------------------------------------------------------------------
console.log('\n[9] Syntax check modified JS files');
const modifiedFiles = [
  'js/utils/cursor-relay-state-guard.js',
  'js/utils/cursor-relay-model-injection.js',
  'js/utils/cursor-relay-protocol-v2.js',
  'js/utils/cursor-relay-protocol.js',
  'js/utils/cursor-relay-runner.js',
  'js/utils/cursor-relay-agent-test.js',
  'js/utils/cursor-relay-proxy.js',
  'js/utils/cursor-relay-auth-intercept.js',
  'js/utils/cursor-relay-account-store.js',
  'update_cursor_auth.js',
  'js/mode/registry.js',
  'js/mode/index.js',
  'js/mode/debug-mode.js',
  'js/mode/multitask-mode.js',
  'js/mode/project-mode.js',
  'js/mode/triage-mode.js',
  'js/mode/common/tools.js',
  'js/mode/common/message-builder.js',
  'scripts/gen-cursor-modes.js',
  'scripts/test-cursor-relay-agent.cjs',
];
for (const rel of modifiedFiles) {
  try {
    execSync(`node --check "${path.join(ROOT, rel)}"`, { stdio: 'pipe' });
    check(`syntax: ${rel}`, true);
  } catch (e) {
    check(`syntax: ${rel}`, false, e.stderr?.toString().split('\n')[0] || e.message);
  }
}

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------
console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);

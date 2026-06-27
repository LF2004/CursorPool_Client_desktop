const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getStateVscdbPath, getCursorAppDataDir } = require('./cursor-local-state');

let BetterSqlite3 = null;

function getBetterSqlite3() {
  if (BetterSqlite3) return BetterSqlite3;
  BetterSqlite3 = require('better-sqlite3');
  return BetterSqlite3;
}

function openCursorStateDb(dbPath = '') {
  const resolved = String(dbPath || getStateVscdbPath() || '').trim();
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error('state.vscdb not found');
  }
  const Database = getBetterSqlite3();
  const db = new Database(resolved, { timeout: 5000 });
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    /* ignore */
  }
  return { db, dbPath: resolved };
}

function readComposerHeaders(db) {
  const raw = db
    .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1")
    .pluck()
    .get();
  if (!raw) return { allComposers: [] };
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : { allComposers: [] };
  } catch {
    return { allComposers: [] };
  }
}

function readComposerHeadersViaPython(dbPath) {
  const script = [
    'import sqlite3, json',
    `p = r'''${String(dbPath).replace(/\\/g, '\\\\')}'''`,
    'con = sqlite3.connect(p)',
    'cur = con.cursor()',
    'row = cur.execute("select value from ItemTable where key = \'composer.composerHeaders\' limit 1").fetchone()',
    'print((row[0] if row and row[0] else "{}"))',
    'con.close()',
  ].join('\n');
  const out = execFileSync('python', ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  try {
    const parsed = JSON.parse(String(out || '').trim() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : { allComposers: [] };
  } catch {
    return { allComposers: [] };
  }
}

function upsertItemTableValue(db, key, value) {
  const info = db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(value, key);
  if (info.changes === 0) {
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(key, value);
  }
}

function upsertItemTableValueViaPython(dbPath, key, value) {
  const payload = Buffer.from(String(value || ''), 'utf8').toString('base64');
  const script = [
    'import sqlite3, base64',
    `p = r'''${String(dbPath).replace(/\\/g, '\\\\')}'''`,
    `k = r'''${String(key).replace(/\\/g, '\\\\')}'''`,
    `v = base64.b64decode(r'''${payload}''').decode('utf-8')`,
    'con = sqlite3.connect(p, timeout=5)',
    'cur = con.cursor()',
    'cur.execute("update ItemTable set value = ? where key = ?", (v, k))',
    'if cur.rowcount == 0:',
    '    cur.execute("insert into ItemTable (key, value) values (?, ?)", (k, v))',
    'con.commit()',
    'con.close()',
  ].join('\n');
  execFileSync('python', ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function findComposerIdForRelayConversation(db, relayConversationId = '') {
  const wanted = String(relayConversationId || '').trim();
  if (!wanted) return '';
  const headers = readComposerHeaders(db);
  const list = Array.isArray(headers?.allComposers) ? headers.allComposers : [];
  const exact = list.find((item) => String(item?.composerId || '').trim() === wanted);
  return String(exact?.composerId || '').trim();
}

function findComposerIdForRelayConversationViaPython(dbPath, relayConversationId = '') {
  const wanted = String(relayConversationId || '').trim();
  if (!wanted) return '';
  const headers = readComposerHeadersViaPython(dbPath);
  const list = Array.isArray(headers?.allComposers) ? headers.allComposers : [];
  const exact = list.find((item) => String(item?.composerId || '').trim() === wanted);
  return String(exact?.composerId || '').trim();
}

function readComposerData(db, composerId = '') {
  const id = String(composerId || '').trim();
  if (!id) return null;
  const raw = db
    .prepare('SELECT value FROM cursorDiskKV WHERE key = ? LIMIT 1')
    .pluck()
    .get(`composerData:${id}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readComposerDataViaPython(dbPath, composerId = '') {
  const id = String(composerId || '').trim();
  if (!id) return null;
  const script = [
    'import sqlite3, json',
    `p = r'''${String(dbPath).replace(/\\/g, '\\\\')}'''`,
    `k = r'''composerData:${id}'''`,
    'con = sqlite3.connect(p)',
    'cur = con.cursor()',
    'row = cur.execute("select value from cursorDiskKV where key = ? limit 1", (k,)).fetchone()',
    'print((row[0] if row and row[0] else ""))',
    'con.close()',
  ].join('\n');
  const out = execFileSync('python', ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  try {
    const parsed = JSON.parse(String(out || '').trim() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function upsertCursorDiskKv(db, key, value) {
  const info = db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(value, key);
  if (info.changes === 0) {
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value);
  }
}

function upsertCursorDiskKvViaPython(dbPath, key, value) {
  const payload = Buffer.from(String(value || ''), 'utf8').toString('base64');
  const script = [
    'import sqlite3, base64',
    `p = r'''${String(dbPath).replace(/\\/g, '\\\\')}'''`,
    `k = r'''${String(key).replace(/\\/g, '\\\\')}'''`,
    `v = base64.b64decode(r'''${payload}''').decode('utf-8')`,
    'con = sqlite3.connect(p, timeout=5)',
    'cur = con.cursor()',
    'cur.execute("update cursorDiskKV set value = ? where key = ?", (v, k))',
    'if cur.rowcount == 0:',
    '    cur.execute("insert into cursorDiskKV (key, value) values (?, ?)", (k, v))',
    'con.commit()',
    'con.close()',
  ].join('\n');
  execFileSync('python', ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function clampPercent(usedTokens = 0, maxTokens = 0) {
  const used = Number(usedTokens) || 0;
  const max = Number(maxTokens) || 0;
  if (used <= 0 || max <= 0) return 0;
  return Math.max(0, Math.min(100, (used / max) * 100));
}

function buildPromptTokenBreakdown(snapshot = {}) {
  const breakdown = snapshot?.breakdown;
  if (!breakdown || typeof breakdown !== 'object') return null;
  const categories = Array.isArray(breakdown.categories)
    ? breakdown.categories.map((item) => ({
      id: String(item?.id || '').trim(),
      label: String(item?.label || '').trim(),
      estimatedTokens: Number(item?.estimatedTokens) || 0,
    })).filter((item) => item.id || item.label || item.estimatedTokens > 0)
    : [];
  return {
    totalUsedTokens: Number(snapshot.usedTokens ?? breakdown.totalUsedTokens) || 0,
    maxTokens: Number(snapshot.maxTokens ?? breakdown.maxTokens) || 0,
    categories,
  };
}

function buildPromptContextUsageTree(snapshot = {}) {
  const tree = snapshot?.promptContextUsageTree;
  if (!tree || typeof tree !== 'object') return null;
  const nodes = Array.isArray(tree.nodes)
    ? tree.nodes.map((node) => ({
      id: String(node?.id || '').trim(),
      parentId: String(node?.parentId || '').trim() || undefined,
      kind: String(node?.kind || '').trim(),
      label: String(node?.label || '').trim(),
      categoryId: String(node?.categoryId || '').trim() || undefined,
      estimatedTokens: Number(node?.estimatedTokens) || 0,
      characterCount: Number(node?.characterCount) || 0,
      lineCount: Number(node?.lineCount) || 0,
      contentAvailable: node?.contentAvailable === true,
      metadata: node?.metadata && typeof node.metadata === 'object' ? node.metadata : undefined,
    })).filter((node) => node.id)
    : [];
  return {
    schemaVersion: Number(tree.schemaVersion) || 1,
    nodes,
  };
}

function normalizeWorkspacePath(value = '') {
  let text = String(value || '').trim();
  if (!text) return '';
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURIComponent(text.replace(/^file:\/\/\/?/i, '')).replace(/^\/([a-zA-Z]:)/, '$1');
    } catch {
      text = text.replace(/^file:\/\/\/?/i, '').replace(/^\/([a-zA-Z]:)/, '$1');
    }
  }
  text = text.replace(/\//g, path.sep).replace(/[\\/\s]+$/g, '');
  if (process.platform === 'win32') return text.toLowerCase();
  return text;
}

function getWorkspaceStorageRoot() {
  return path.join(getCursorAppDataDir(), 'User', 'workspaceStorage');
}

function resolveWorkspaceStorageEntry(workspaceRoot = '') {
  const target = normalizeWorkspacePath(workspaceRoot);
  if (!target) return null;
  const root = getWorkspaceStorageRoot();
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const workspaceJsonPath = path.join(dir, 'workspace.json');
    if (!fs.existsSync(workspaceJsonPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8'));
      const folder = normalizeWorkspacePath(parsed?.folder || '');
      if (folder && folder === target) {
        return {
          id: entry.name,
          dir,
          workspaceJsonPath,
          stateDbPath: path.join(dir, 'state.vscdb'),
        };
      }
    } catch {
      /* ignore malformed workspace.json */
    }
  }
  return null;
}

function parseJsonObject(raw, fallback = {}) {
  if (raw == null || raw === '') return fallback;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function buildWorkspaceComposerSelectionState(current, composerId) {
  const next = current && typeof current === 'object' ? { ...current } : {};
  next.selectedComposerIds = [composerId];
  next.lastFocusedComposerIds = [composerId];
  if (typeof next.hasMigratedComposerData !== 'boolean') next.hasMigratedComposerData = true;
  if (typeof next.hasMigratedMultipleComposers !== 'boolean') next.hasMigratedMultipleComposers = true;
  return next;
}

function rewriteComposerInputEditorState(editor, composerId) {
  if (!editor || typeof editor !== 'object') return { editor, changed: false };
  if (String(editor.id || '').trim() !== 'workbench.editor.composer.input') {
    return { editor, changed: false };
  }
  const currentValue = parseJsonObject(editor.value, {});
  if (String(currentValue.composerId || '').trim() === composerId) {
    return { editor, changed: false };
  }
  return {
    changed: true,
    editor: {
      ...editor,
      value: JSON.stringify({
        ...currentValue,
        composerId,
        restoreInRegularEditorGroup: currentValue.restoreInRegularEditorGroup !== false,
      }),
    },
  };
}

function updateEmbeddedAuxBarEditorState(current, composerId) {
  const next = current && typeof current === 'object' ? { ...current } : {};
  let changed = false;
  function visit(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      return node.map((child) => visit(child));
    }
    const output = { ...node };
    if (output.data && Array.isArray(output.data)) {
      output.data = output.data.map((child) => visit(child));
    } else if (output.data && typeof output.data === 'object') {
      output.data = { ...output.data };
      if (Array.isArray(output.data.editors)) {
        output.data.editors = output.data.editors.map((editor) => {
          const result = rewriteComposerInputEditorState(editor, composerId);
          if (result.changed) changed = true;
          return result.editor;
        });
      }
    }
    return output;
  }
  if (next.serializedGrid && typeof next.serializedGrid === 'object') {
    next.serializedGrid = visit(next.serializedGrid);
  }
  return { next, changed };
}

function findWorkspacePaneBinding(db, composerId) {
  const rows = db
    .prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'")
    .all();
  return rows.find((row) => String(row?.value || '').includes(composerId)) || null;
}

function ensureWorkspacePaneBinding(db, composerId) {
  if (findWorkspacePaneBinding(db, composerId)) return false;
  const key = `workbench.panel.composerChatViewPane.${composerId}`;
  const value = JSON.stringify({
    [`workbench.panel.aichat.view.${composerId}`]: {
      collapsed: false,
      isHidden: false,
      size: 940,
    },
  });
  upsertItemTableValue(db, key, value);
  return true;
}

function syncRelayComposerWorkspaceBindingViaPython(stateDbPath, composerId) {
  const script = [
    'import sqlite3, json',
    `p = r'''${String(stateDbPath).replace(/\\/g, '\\\\')}'''`,
    `composer_id = r'''${String(composerId).replace(/\\/g, '\\\\')}'''`,
    'con = sqlite3.connect(p, timeout=5)',
    'cur = con.cursor()',
    '',
    'def load_json(key, fallback):',
    '    row = cur.execute("select value from ItemTable where key = ? limit 1", (key,)).fetchone()',
    '    if not row or not row[0]:',
    '        return fallback',
    '    try:',
    '        return json.loads(row[0])',
    '    except Exception:',
    '        return fallback',
    '',
    'def upsert_item(key, value):',
    '    cur.execute("update ItemTable set value = ? where key = ?", (value, key))',
    '    if cur.rowcount == 0:',
    '        cur.execute("insert into ItemTable (key, value) values (?, ?)", (key, value))',
    '',
    'selection = load_json("composer.composerData", {})',
    'selection["selectedComposerIds"] = [composer_id]',
    'selection["lastFocusedComposerIds"] = [composer_id]',
    'selection.setdefault("hasMigratedComposerData", True)',
    'selection.setdefault("hasMigratedMultipleComposers", True)',
    'upsert_item("composer.composerData", json.dumps(selection, ensure_ascii=False))',
    '',
    'aux = load_json("workbench.parts.embeddedAuxBarEditor.state", {})',
    'aux_changed = False',
    'def visit(node):',
    '    global aux_changed',
    '    if isinstance(node, list):',
    '        return [visit(item) for item in node]',
    '    if not isinstance(node, dict):',
    '        return node',
    '    next_node = dict(node)',
    '    data = next_node.get("data")',
    '    if isinstance(data, list):',
    '        next_node["data"] = [visit(item) for item in data]',
    '    elif isinstance(data, dict):',
    '        next_data = dict(data)',
    '        editors = next_data.get("editors")',
    '        if isinstance(editors, list):',
    '            updated = []',
    '            for editor in editors:',
    '                if isinstance(editor, dict) and str(editor.get("id", "")).strip() == "workbench.editor.composer.input":',
    '                    try:',
    '                        editor_value = json.loads(editor.get("value", "{}") or "{}")',
    '                    except Exception:',
    '                        editor_value = {}',
    '                    if str(editor_value.get("composerId", "")).strip() != composer_id:',
    '                        editor_value["composerId"] = composer_id',
    '                        editor_value["restoreInRegularEditorGroup"] = editor_value.get("restoreInRegularEditorGroup", True)',
    '                        aux_changed = True',
    '                    updated.append({**editor, "value": json.dumps(editor_value, ensure_ascii=False)})',
    '                else:',
    '                    updated.append(editor)',
    '            next_data["editors"] = updated',
    '        next_node["data"] = next_data',
    '    return next_node',
    'if isinstance(aux, dict) and isinstance(aux.get("serializedGrid"), dict):',
    '    aux["serializedGrid"] = visit(aux["serializedGrid"])',
    'if aux_changed:',
    '    upsert_item("workbench.parts.embeddedAuxBarEditor.state", json.dumps(aux, ensure_ascii=False))',
    '',
    'pane_rows = cur.execute("select key, value from ItemTable where key like ?", ("workbench.panel.composerChatViewPane.%",)).fetchall()',
    'has_pane = any(composer_id in str(row[1] or "") for row in pane_rows)',
    'if not has_pane:',
    '    pane_key = f"workbench.panel.composerChatViewPane.{composer_id}"',
    '    pane_value = json.dumps({f"workbench.panel.aichat.view.{composer_id}": {"collapsed": False, "isHidden": False, "size": 940}}, ensure_ascii=False)',
    '    upsert_item(pane_key, pane_value)',
    '',
    'con.commit()',
    'con.close()',
    'print(json.dumps({"ok": True, "embeddedAuxBarUpdated": aux_changed, "paneCreated": not has_pane}, ensure_ascii=False))',
  ].join('\n');
  const out = execFileSync('python', ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return parseJsonObject(String(out || '').trim(), { ok: true });
}

function syncRelayComposerWorkspaceBinding(options = {}) {
  const composerId = String(options.relayConversationId || options.composerId || '').trim();
  const workspaceRoot = String(options.workspaceRoot || '').trim();
  if (!composerId || !workspaceRoot) {
    return { ok: false, skipped: true, reason: 'missing_workspace_or_composer' };
  }
  const entry = resolveWorkspaceStorageEntry(workspaceRoot);
  if (!entry?.stateDbPath || !fs.existsSync(entry.stateDbPath)) {
    return { ok: false, skipped: true, reason: 'workspace_state_db_not_found', composerId, workspaceRoot };
  }

  try {
    const Database = getBetterSqlite3();
    const db = new Database(entry.stateDbPath, { timeout: 5000 });
    try {
      try {
        db.pragma('journal_mode = WAL');
      } catch {
        /* ignore */
      }
      const currentSelection = parseJsonObject(
        db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1").pluck().get(),
        {},
      );
      const nextSelection = buildWorkspaceComposerSelectionState(currentSelection, composerId);
      upsertItemTableValue(db, 'composer.composerData', JSON.stringify(nextSelection));

      const currentAux = parseJsonObject(
        db.prepare("SELECT value FROM ItemTable WHERE key = 'workbench.parts.embeddedAuxBarEditor.state' LIMIT 1").pluck().get(),
        {},
      );
      const updatedAux = updateEmbeddedAuxBarEditorState(currentAux, composerId);
      if (updatedAux.changed) {
        upsertItemTableValue(
          db,
          'workbench.parts.embeddedAuxBarEditor.state',
          JSON.stringify(updatedAux.next),
        );
      }

      const paneCreated = ensureWorkspacePaneBinding(db, composerId);
      return {
        ok: true,
        composerId,
        workspaceRoot,
        workspaceId: entry.id,
        stateDbPath: entry.stateDbPath,
        paneCreated,
        embeddedAuxBarUpdated: updatedAux.changed,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    const fallback = syncRelayComposerWorkspaceBindingViaPython(entry.stateDbPath, composerId);
    return {
      ok: true,
      composerId,
      workspaceRoot,
      workspaceId: entry.id,
      stateDbPath: entry.stateDbPath,
      paneCreated: Boolean(fallback?.paneCreated),
      embeddedAuxBarUpdated: Boolean(fallback?.embeddedAuxBarUpdated),
      fallback: 'python',
      error: error.message,
    };
  }
}

function updateComposerHeadersSnapshot(headers, composerId, snapshot = {}) {
  const wanted = String(composerId || '').trim();
  if (!wanted || !headers || typeof headers !== 'object') return null;
  const list = Array.isArray(headers.allComposers) ? headers.allComposers : [];
  const usedTokens = Number(snapshot.usedTokens) || 0;
  const maxTokens = Number(snapshot.maxTokens) || 0;
  const nextPercent = clampPercent(usedTokens, maxTokens);
  const updatedAt = Date.now();
  let changed = false;
  const nextList = list.map((item) => {
    if (String(item?.composerId || '').trim() !== wanted) return item;
    changed = true;
    return {
      ...item,
      contextUsagePercent: nextPercent,
      conversationCheckpointLastUpdatedAt: updatedAt,
      lastUpdatedAt: Math.max(Number(item?.lastUpdatedAt) || 0, updatedAt),
    };
  });
  if (!changed) return null;
  return {
    ...headers,
    allComposers: nextList,
  };
}

function syncRelayContextSnapshotToComposerData(options = {}) {
  const relayConversationId = String(options.relayConversationId || '').trim();
  const snapshot = options.snapshot && typeof options.snapshot === 'object' ? options.snapshot : null;
  if (!relayConversationId || !snapshot) {
    return { ok: false, skipped: true, reason: 'missing_snapshot_or_conversation_id' };
  }

  const dbPath = String(options.dbPath || getStateVscdbPath() || '').trim();
  const usedTokens = Number(snapshot.usedTokens) || 0;
  const maxTokens = Number(snapshot.maxTokens) || 0;

  const writeNext = (current, composerId, writer) => {
    const next = {
      ...current,
      contextTokensUsed: usedTokens > 0 ? usedTokens : current.contextTokensUsed ?? null,
      contextTokenLimit: maxTokens > 0 ? maxTokens : current.contextTokenLimit ?? null,
      contextUsagePercent: clampPercent(
        usedTokens > 0 ? usedTokens : current.contextTokensUsed,
        maxTokens > 0 ? maxTokens : current.contextTokenLimit,
      ),
      promptTokenBreakdown: buildPromptTokenBreakdown(snapshot),
      promptContextUsageTree: buildPromptContextUsageTree(snapshot),
      conversationCheckpointLastUpdatedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };
    writer.writeComposerData(`composerData:${composerId}`, JSON.stringify(next));
    const currentHeaders = writer.readComposerHeaders();
    const nextHeaders = updateComposerHeadersSnapshot(currentHeaders, composerId, {
      usedTokens: next.contextTokensUsed,
      maxTokens: next.contextTokenLimit,
    });
    if (nextHeaders) {
      writer.writeComposerHeaders('composer.composerHeaders', JSON.stringify(nextHeaders));
    }
    return next;
  };

  try {
    const { db } = openCursorStateDb(dbPath);
    try {
      const composerId = findComposerIdForRelayConversation(db, relayConversationId);
      if (!composerId) {
        return { ok: false, skipped: true, reason: 'composer_not_found', relayConversationId, dbPath };
      }
      const current = readComposerData(db, composerId);
      if (!current) {
        return { ok: false, skipped: true, reason: 'composer_data_missing', composerId, relayConversationId, dbPath };
      }
      const next = writeNext(current, composerId, {
        writeComposerData: (key, value) => upsertCursorDiskKv(db, key, value),
        readComposerHeaders: () => readComposerHeaders(db),
        writeComposerHeaders: (key, value) => upsertItemTableValue(db, key, value),
      });
      return {
        ok: true,
        relayConversationId,
        composerId,
        dbPath,
        usedTokens: next.contextTokensUsed,
        maxTokens: next.contextTokenLimit,
        hasPromptTokenBreakdown: Boolean(next.promptTokenBreakdown),
        hasPromptContextUsageTree: Boolean(next.promptContextUsageTree),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    const composerId = findComposerIdForRelayConversationViaPython(dbPath, relayConversationId);
    if (!composerId) {
      return { ok: false, skipped: true, reason: 'composer_not_found', relayConversationId, dbPath, fallback: 'python', error: error.message };
    }
    const current = readComposerDataViaPython(dbPath, composerId);
    if (!current) {
      return { ok: false, skipped: true, reason: 'composer_data_missing', composerId, relayConversationId, dbPath, fallback: 'python', error: error.message };
    }
    const next = writeNext(current, composerId, {
      writeComposerData: (key, value) => upsertCursorDiskKvViaPython(dbPath, key, value),
      readComposerHeaders: () => readComposerHeadersViaPython(dbPath),
      writeComposerHeaders: (key, value) => upsertItemTableValueViaPython(dbPath, key, value),
    });
    return {
      ok: true,
      relayConversationId,
      composerId,
      dbPath,
      usedTokens: next.contextTokensUsed,
      maxTokens: next.contextTokenLimit,
      hasPromptTokenBreakdown: Boolean(next.promptTokenBreakdown),
      hasPromptContextUsageTree: Boolean(next.promptContextUsageTree),
      fallback: 'python',
    };
  }
}

module.exports = {
  syncRelayComposerWorkspaceBinding,
  syncRelayContextSnapshotToComposerData,
};

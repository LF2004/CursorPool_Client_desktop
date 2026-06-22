#!/usr/bin/env node
const fs = require('fs');
const Database = require('better-sqlite3');
const { getStateVscdbPath, getGlobalStorageDir } = require('../js/utils/cursor-local-state');

const dbPath = getStateVscdbPath();
console.log('state.vscdb:', dbPath, fs.existsSync(dbPath) ? 'exists' : 'missing');
if (!fs.existsSync(dbPath)) process.exit(0);

const db = new Database(dbPath, { readonly: true });
const tableName = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('itemtable','item_table')")
  .pluck()
  .get() || 'ItemTable';

const patterns = ['%openAI%', '%OpenAI%', '%openai%', '%applicationUser%', '%cppConfig%', '%cursorCreds%', '%model%', '%composer%', '%azure%'];
const seen = new Set();
for (const p of patterns) {
  const rows = db.prepare(`SELECT key, value FROM "${tableName}" WHERE key LIKE ?`).all(p);
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    const v = row.value == null ? '' : String(row.value);
    console.log('\n===', row.key, `(len ${v.length}) ===`);
    if (v.length > 800) console.log(v.slice(0, 800), '...');
    else console.log(v);
  }
}
db.close();

const settingsPath = require('path').join(getGlobalStorageDir(), '..', 'settings.json');
if (fs.existsSync(settingsPath)) {
  console.log('\n=== settings.json (openai related) ===');
  const s = fs.readFileSync(settingsPath, 'utf8');
  const j = JSON.parse(s);
  for (const [k, v] of Object.entries(j)) {
    if (/openai|azure|model|composer|api/i.test(k)) console.log(k, ':', typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200));
  }
}

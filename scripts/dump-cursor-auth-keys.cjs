const fs = require('fs');
const path = require('path');
const os = require('os');

function getStateVscdbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

const dbPath = getStateVscdbPath();
console.log('dbPath:', dbPath);
console.log('exists:', fs.existsSync(dbPath));
if (!fs.existsSync(dbPath)) process.exit(0);

const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true });
const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('itemtable','item_table')").get();
const tableName = tableRow?.name || 'ItemTable';
console.log('table:', tableName);

const rows = db.prepare(`SELECT key, length(value) AS len FROM "${tableName}" WHERE key LIKE 'cursorAuth/%' OR key LIKE 'cursor.%' OR key LIKE 'cursorai/%' ORDER BY key`).all();
for (const row of rows) {
  const val = db.prepare(`SELECT value FROM "${tableName}" WHERE key = ?`).pluck().get(row.key);
  let preview = String(val ?? '');
  if (row.key.toLowerCase().includes('token') && preview.length > 40) {
    preview = `${preview.slice(0, 40)}…(${preview.length})`;
  } else if (preview.length > 100) {
    preview = `${preview.slice(0, 100)}…`;
  }
  console.log(`${row.key} | len=${row.len} | ${preview.replace(/\r?\n/g, ' ')}`);
}
db.close();

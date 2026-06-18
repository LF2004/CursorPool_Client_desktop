const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function usage() {
  console.error('Usage: node scripts\\compare-cursor-snapshots.cjs <before-dir> <after-dir>')
  process.exit(1)
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null
  const buf = fs.readFileSync(filePath)
  return {
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  }
}

function keyMap(rows) {
  const map = new Map()
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    if (row && typeof row.key === 'string') map.set(row.key, row.value)
  }
  return map
}

function shortValue(value) {
  if (value == null) return String(value)
  const s = String(value)
  if (s.length <= 90) return s
  return `${s.slice(0, 42)}...${s.slice(-18)}`
}

function compareSelectedKeys(beforeDir, afterDir) {
  const before = keyMap(readJson(path.join(beforeDir, 'itemtable-selected.json')))
  const after = keyMap(readJson(path.join(afterDir, 'itemtable-selected.json')))
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
  const changed = []
  for (const key of keys) {
    const a = before.has(key) ? before.get(key) : undefined
    const b = after.has(key) ? after.get(key) : undefined
    if (a !== b) changed.push({ key, before: shortValue(a), after: shortValue(b) })
  }
  return changed
}

function compareJsonFile(beforeDir, afterDir, name) {
  const before = readJson(path.join(beforeDir, name))
  const after = readJson(path.join(afterDir, name))
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const changed = []
  for (const key of keys) {
    const a = before[key]
    const b = after[key]
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push({ key, before: shortValue(JSON.stringify(a)), after: shortValue(JSON.stringify(b)) })
    }
  }
  return changed
}

function compareFiles(beforeDir, afterDir) {
  const names = ['state.vscdb', 'storage.json', 'cursor.auth.json', 'machineid', '.updaterId', 'home_.cursor_ids.json']
  return names.map((name) => {
    const before = hashFile(path.join(beforeDir, name))
    const after = hashFile(path.join(afterDir, name))
    return {
      name,
      before: before ? `${before.bytes} ${before.sha256.slice(0, 12)}` : 'missing',
      after: after ? `${after.bytes} ${after.sha256.slice(0, 12)}` : 'missing',
      changed: JSON.stringify(before) !== JSON.stringify(after),
    }
  })
}

function printTable(title, rows, columns) {
  console.log(`\n${title}`)
  if (!rows.length) {
    console.log('  no changes')
    return
  }
  for (const row of rows) {
    console.log(`- ${columns.map((col) => `${col}=${row[col]}`).join(' | ')}`)
  }
}

const beforeDir = process.argv[2]
const afterDir = process.argv[3]
if (!beforeDir || !afterDir) usage()
if (!fs.existsSync(beforeDir) || !fs.existsSync(afterDir)) usage()

printTable(
  'Selected ItemTable changes',
  compareSelectedKeys(beforeDir, afterDir),
  ['key', 'before', 'after'],
)

const storageChanges = compareJsonFile(beforeDir, afterDir, 'storage.json')
if (storageChanges) {
  printTable('storage.json changes', storageChanges, ['key', 'before', 'after'])
}

printTable(
  'Captured file changes',
  compareFiles(beforeDir, afterDir).filter((row) => row.changed),
  ['name', 'before', 'after'],
)

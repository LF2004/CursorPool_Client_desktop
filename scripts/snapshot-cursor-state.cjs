const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_')
}

function copyIfExists(source, targetDir, label) {
  if (!source || !fs.existsSync(source)) return null
  const target = path.join(targetDir, safeName(label || source))
  fs.copyFileSync(source, target)
  return target
}

function findSqlite3() {
  const candidates = [
    process.env.SQLITE3_EXE,
    'D:\\platform-tools-latest-windows\\platform-tools\\sqlite3.exe',
    'sqlite3.exe',
    'sqlite3',
  ].filter(Boolean)
  for (const exe of candidates) {
    const r = spawnSync(exe, ['-version'], { encoding: 'utf8', windowsHide: true })
    if (!r.error && r.status === 0) return exe
  }
  return null
}

function runSqliteJson(sqlite3, dbPath, sql) {
  if (!sqlite3 || !fs.existsSync(dbPath)) return ''
  const r = spawnSync(sqlite3, [dbPath, '.mode json', sql], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (r.error) return JSON.stringify({ error: r.error.message })
  if (r.status !== 0) return JSON.stringify({ error: r.stderr || r.stdout || `exit ${r.status}` })
  return r.stdout
}

function main() {
  const tag = process.argv[2] || 'snapshot'
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA is not set')

  const cursorRoot = path.join(appData, 'Cursor')
  const globalStorage = path.join(cursorRoot, 'User', 'globalStorage')
  const dbPath = path.join(globalStorage, 'state.vscdb')
  const outRoot = path.join(__dirname, '..', 'diagnostics', 'cursor-state')
  const stamp = `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const outDir = path.join(outRoot, stamp)
  fs.mkdirSync(outDir, { recursive: true })

  const files = [
    ['state.vscdb', dbPath],
    ['storage.json', path.join(globalStorage, 'storage.json')],
    ['cursor.auth.json', path.join(globalStorage, 'cursor.auth.json')],
    ['machineid', path.join(cursorRoot, 'machineid')],
    ['.updaterId', path.join(cursorRoot, '.updaterId')],
    ['home_.cursor_ids.json', path.join(process.env.USERPROFILE || '', '.cursor_ids.json')],
  ]
  for (const [label, source] of files) copyIfExists(source, outDir, label)

  const sqlite3 = findSqlite3()
  const selectedKeysSql = `
SELECT key,value FROM ItemTable
WHERE key IN (
  'cursor.email',
  'cursor.accessToken',
  'cursorAuth/refreshToken',
  'cursorAuth/accessToken',
  'cursorAuth/cachedEmail',
  'telemetry.devDeviceId',
  'telemetry.macMachineId',
  'telemetry.machineId',
  'telemetry.sqmId',
  'storage.serviceMachineId',
  'telemetry.firstSessionDate',
  'telemetry.sessionId',
  'cursorai/serverConfig',
  'applicationUserPersistentStorage'
)
ORDER BY key;`
  fs.writeFileSync(
    path.join(outDir, 'itemtable-selected.json'),
    runSqliteJson(sqlite3, dbPath, selectedKeysSql),
    'utf8',
  )
  fs.writeFileSync(
    path.join(outDir, 'quick-check.txt'),
    sqlite3 ? runSqliteJson(sqlite3, dbPath, 'PRAGMA quick_check;') : 'sqlite3 not found',
    'utf8',
  )

  const manifest = {
    tag,
    outDir,
    cursorRoot,
    globalStorage,
    dbPath,
    sqlite3,
    capturedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(outDir)
}

main()

/**
 * 复刻客户端读取「本地 Cursor 账户」与「本地 Cursor 状态」的逻辑（对齐 Dashboard / get_machine_ids / is_hook 所用数据源）。
 *
 * 导出：
 * - 路径解析（支持 CURSOR_STATE_DB、Windows CURSOR_PATH）
 * - readLocalCursorStateSync() 结构化读取
 * - printDiagnosticReport() 控制台打印（可选脱敏）
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')
const { resolveWorkbenchJsPath } = require('../../paths')

const LEGACY_WORKBENCH_MARKER = '/* __CURSORPOOL_SEAMLESS__ */'
const REACTIVE_APP_USER_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
const LEGACY_APP_USER_KEY = 'applicationUser'

const CURSOR_RUNNING_IMAGE_NAMES_WIN = [
  'Cursor.exe',
  'cursor.exe',
  'Cursor Helper.exe',
  'Cursor Helper (GPU).exe',
  'Cursor Helper (Plugin).exe',
  'Cursor Helper (Renderer).exe',
]

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getCursorAppDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) throw new Error('环境变量 APPDATA 未设置')
    if (process.env.CURSOR_PATH) {
      const alt = path.resolve(process.env.CURSOR_PATH)
      if (fs.existsSync(alt)) return alt
    }
    return path.join(appData, 'Cursor')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor')
  }
  return path.join(os.homedir(), '.config', 'Cursor')
}

function getMachineIdFilePath() {
  return path.join(getCursorAppDataDir(), 'machineid')
}

function getUpdaterIdFilePath() {
  return path.join(getCursorAppDataDir(), '.updaterId')
}

function getGlobalStorageDir() {
  if (process.env.CURSOR_STATE_DB) {
    return path.dirname(path.resolve(process.env.CURSOR_STATE_DB))
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) throw new Error('环境变量 APPDATA 未设置')
    const def = path.join(appData, 'Cursor', 'User', 'globalStorage')
    if (process.env.CURSOR_PATH) {
      const alt = path.join(process.env.CURSOR_PATH, 'User', 'globalStorage')
      if (fs.existsSync(alt)) return alt
    }
    return def
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
    )
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage')
}

function getStateVscdbPath() {
  if (process.env.CURSOR_STATE_DB) return path.resolve(process.env.CURSOR_STATE_DB)
  return path.join(getGlobalStorageDir(), 'state.vscdb')
}

function getCursorAuthJsonPath() {
  return path.join(getGlobalStorageDir(), 'cursor.auth.json')
}

function getStorageJsonPath() {
  return path.join(getGlobalStorageDir(), 'storage.json')
}

function getCursorPaths() {
  const globalStorageDir = getGlobalStorageDir()
  return {
    globalStorageDir,
    stateVscdbPath: getStateVscdbPath(),
    cursorAuthJsonPath: getCursorAuthJsonPath(),
    storageJsonPath: path.join(globalStorageDir, 'storage.json'),
  }
}

function maskSecret(s, headLen = 18) {
  if (s == null || s === '') return '(无)'
  if (typeof s !== 'string') return String(s)
  if (s.length <= 8) return `${s.slice(0, 2)}…(${s.length})`
  return `${s.slice(0, headLen)}…(总长 ${s.length})`
}

function isCursorRunningHeuristic() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      return CURSOR_RUNNING_IMAGE_NAMES_WIN.some((name) => {
        const re = new RegExp(`(^|\\r?\\n)"?${escapeRegex(name)}"?\\s*,`, 'im')
        return re.test(out)
      })
    } catch {
      return false
    }
  }
  if (process.platform === 'darwin') {
    try {
      execFileSync('pgrep', ['-x', 'Cursor'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  try {
    execFileSync('pgrep', ['-f', '/cursor'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function detectItemTableName(db) {
  try {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('itemtable','item_table')",
      )
      .all()
    return rows[0]?.name || null
  } catch {
    return null
  }
}

function readItemSafe(db, tableName, key) {
  if (!tableName) return null
  try {
    const v = db.prepare(`SELECT value FROM "${tableName}" WHERE key = ?`).pluck().get(key)
    return v === undefined ? null : v
  } catch {
    return null
  }
}

/** ItemTable 里 value 多为纯文本邮箱，少数为 JSON 字符串 */
function normalizeEmailFromItemValue(v) {
  if (v == null || v === '') return null
  const raw = typeof v === 'string' ? v : String(v)
  const t = raw.trim()
  if (!t) return null
  try {
    const j = JSON.parse(t)
    if (typeof j === 'string') {
      const u = j.trim()
      return u || null
    }
  } catch {
    /* 非 JSON，当普通字符串 */
  }
  return t
}

/**
 * 当前 Cursor 登录邮箱：仅来自 state.vscdb ItemTable（cursorAuth/cachedEmail → cursor.email）
 */
function resolveCursorDbEmail(acc) {
  if (!acc) return null
  const fromCached = normalizeEmailFromItemValue(acc.cursorAuthCachedEmail)
  const fromCursorKey = normalizeEmailFromItemValue(acc.cursorEmail)
  return fromCached || fromCursorKey || null
}

function normalizeItemScalar(v) {
  if (v == null || v === '') return null
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.toString('utf8').trim() || null
  const s = typeof v === 'string' ? v : String(v)
  return s.trim() || null
}

function looksLikeCursorAccessToken(token) {
  const value = normalizeItemScalar(token)
  if (!value) return false
  if (value.length < 80) return false
  if (!value.startsWith('eyJ')) return false
  return value.split('.').length === 3
}

function tryReadAccountFromItemTableWithNodeSqlite(dbPath) {
  const out = { account: null, moduleError: null, openError: null }
  if (!fs.existsSync(dbPath)) return out

  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch (e) {
    out.moduleError = e.message || String(e)
    return out
  }

  function buildAccount(db) {
    const tableRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('itemtable','item_table') LIMIT 1",
      )
      .get()
    const tableName = tableRow?.name || null
    if (!tableName) return null
    const stmt = db.prepare(`SELECT value FROM "${tableName}" WHERE key = ?`)
    const readValue = (key) => {
      try {
        const row = stmt.get(key)
        return row?.value === undefined ? null : row.value
      } catch {
        return null
      }
    }
    return {
      cursorAuthCachedEmail: readValue('cursorAuth/cachedEmail'),
      cursorEmail: readValue('cursor.email'),
      cursorAuthAccessToken: readValue('cursorAuth/accessToken'),
      cursorAuthRefreshToken: readValue('cursorAuth/refreshToken'),
      cursorAccessToken: readValue('cursor.accessToken'),
      telemetryDevDeviceId: readValue('telemetry.devDeviceId'),
      reactiveApplicationUser: readValue(REACTIVE_APP_USER_KEY),
      applicationUser: readValue(LEGACY_APP_USER_KEY),
    }
  }

  let db
  let tmpPath = null
  try {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 8000 })
    } catch (e1) {
      const msg = e1.message || String(e1)
      out.openError = msg
      const busy =
        e1.code === 'SQLITE_BUSY' ||
        (typeof msg === 'string' && /busy|locked|database is locked/i.test(msg))
      if (!busy) return out
      tmpPath = path.join(os.tmpdir(), `cpe-vscdb-${process.pid}-${Date.now()}.vscdb`)
      fs.copyFileSync(dbPath, tmpPath)
      db = new DatabaseSync(tmpPath, { readOnly: true, timeout: 8000 })
      out.openError = null
    }
    out.account = buildAccount(db)
    if (!out.account && !out.openError) out.openError = '未找到 ItemTable'
  } catch (e2) {
    out.openError = out.openError || e2.message || String(e2)
  } finally {
    if (db) {
      try {
        db.close()
      } catch (_) {
        /* ignore */
      }
    }
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath)
      } catch (_) {
        /* ignore */
      }
    }
  }
  return out
}

/**
 * 判断 Cursor 是否已有可用登录态（邮箱 + JWT accessToken 均存在）。
 */
function readCursorLoginState(opts = {}) {
  const paths = getCursorPaths()
  const dbPath = paths.stateVscdbPath
  const accountRead = opts.accountRead || readAccountFromItemTableWithFallback(dbPath)
  const acc = accountRead.account
  const authJson = readCursorAuthJsonFile(paths.cursorAuthJsonPath)
  const email = resolveCursorDbEmail(acc)
    || (authJson?.email != null ? String(authJson.email).trim() : '')
    || null
  const accessToken = normalizeItemScalar(acc?.cursorAuthAccessToken)
    || normalizeItemScalar(acc?.cursorAccessToken)
    || (authJson?.access_token != null ? String(authJson.access_token).trim() : '')
    || null
  const refreshToken = normalizeItemScalar(acc?.cursorAuthRefreshToken) || accessToken
  const loggedIn = Boolean(email) && looksLikeCursorAccessToken(accessToken)
  return {
    loggedIn,
    email,
    accessToken,
    refreshToken,
    hasEmail: Boolean(email),
    hasValidAccessToken: looksLikeCursorAccessToken(accessToken),
    dbExists: fs.existsSync(dbPath),
    dbError: accountRead.openError || accountRead.moduleError || null,
    authJsonEmail: authJson?.email != null ? String(authJson.email).trim() : null,
  }
}

/**
 * 读取 cursor.auth.json（仅文件，不经过 DB）
 * @returns {{ email?: string, access_token?: string } | null}
 */
function readCursorAuthJsonFile(authPath) {
  if (!fs.existsSync(authPath)) return null
  try {
    return JSON.parse(fs.readFileSync(authPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 从 state.vscdb 读取 ItemTable 键（对齐 get_machine_ids / switch_account）。
 * @returns {{ account: object | null, moduleError: string | null, openError: string | null }}
 */
function readAccountFromItemTable(dbPath) {
  const out = { account: null, moduleError: null, openError: null }
  if (!fs.existsSync(dbPath)) return out

  let Database
  try {
    Database = require('better-sqlite3')
  } catch (e) {
    out.moduleError = e.message || String(e)
    return out
  }

  function buildAccount(db) {
    const tableName = detectItemTableName(db)
    if (!tableName) return null
    return {
      cursorAuthCachedEmail: readItemSafe(db, tableName, 'cursorAuth/cachedEmail'),
      cursorEmail: readItemSafe(db, tableName, 'cursor.email'),
      cursorAuthAccessToken: readItemSafe(db, tableName, 'cursorAuth/accessToken'),
      cursorAuthRefreshToken: readItemSafe(db, tableName, 'cursorAuth/refreshToken'),
      cursorAccessToken: readItemSafe(db, tableName, 'cursor.accessToken'),
      telemetryDevDeviceId: readItemSafe(db, tableName, 'telemetry.devDeviceId'),
      reactiveApplicationUser: readItemSafe(db, tableName, REACTIVE_APP_USER_KEY),
      applicationUser: readItemSafe(db, tableName, LEGACY_APP_USER_KEY),
    }
  }

  let db
  let tmpPath = null
  try {
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 8000 })
    } catch (e1) {
      const msg = e1.message || String(e1)
      out.openError = msg
      const busy =
        e1.code === 'SQLITE_BUSY' ||
        (typeof msg === 'string' && /busy|locked|database is locked/i.test(msg))
      if (!busy) return out
      tmpPath = path.join(os.tmpdir(), `cpe-vscdb-${process.pid}-${Date.now()}.vscdb`)
      fs.copyFileSync(dbPath, tmpPath)
      db = new Database(tmpPath, { readonly: true, fileMustExist: true, timeout: 8000 })
      out.openError = null
    }
    out.account = buildAccount(db)
    if (!out.account && !out.openError) out.openError = '未找到 ItemTable'
  } catch (e2) {
    out.openError = out.openError || e2.message || String(e2)
  } finally {
    if (db) {
      try {
        db.close()
      } catch (_) {
        /* ignore */
      }
    }
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath)
      } catch (_) {
        /* ignore */
      }
    }
  }
  return out
}

function readAccountFromItemTableWithFallback(dbPath) {
  const primary = readAccountFromItemTable(dbPath)
  if (primary.account) return primary
  if (!primary.moduleError) return primary

  const fallback = tryReadAccountFromItemTableWithNodeSqlite(dbPath)
  if (fallback.account) {
    return {
      account: fallback.account,
      moduleError: primary.moduleError,
      openError: fallback.openError || null,
      fallbackReader: 'node:sqlite',
      primaryModuleError: primary.moduleError,
    }
  }
  return {
    ...primary,
    fallbackOpenError: fallback.openError || null,
    fallbackModuleError: fallback.moduleError || null,
  }
}

/**
 * 读取 main.js 注入启发式状态（对齐 Tauri is_hook）
 */
function readHookStatus(opts = {}) {
  try {
    const { hookStatus } = require('../../hook')
    const status = hookStatus({ mainJsPath: opts.mainJsPath ?? process.env.CURSOR_MAIN_JS })
    const workbenchPath = resolveWorkbenchJsPath(undefined, opts.mainJsPath ?? process.env.CURSOR_MAIN_JS)
    let injected = false
    if (workbenchPath) {
      try {
        injected = fs.readFileSync(workbenchPath, 'utf8').includes(LEGACY_WORKBENCH_MARKER)
      } catch {
        injected = false
      }
    }
    if (injected) {
      return {
        found: true,
        path: workbenchPath,
        hooked: true,
        backupExists: fs.existsSync(workbenchPath.replace(/\.js$/, '.js.seamless-backup')),
        legacyWorkbenchInjected: true,
        message: '检测到旧版 Switch Account 注入，请在偏好设置中还原客户端清理。',
      }
    }
    if (status?.found && status.hooked) {
      return {
        ...status,
        legacyMainInjected: true,
        legacyWorkbenchInjected: true,
        message: '检测到旧版 main.js 注入，请在偏好设置中还原客户端清理。',
      }
    }
    if (status?.found) return status
    if (!workbenchPath) return status
    return {
      ...status,
      path: workbenchPath,
      newCursorNoMain: true,
      message: '新版 Cursor 未提供 main.js，无需客户端注入。',
    }
  } catch (e) {
    return { found: false, error: e.message || String(e) }
  }
}

/**
 * 一次读取：路径 + auth.json + DB 账户字段 + 进程 + 注入状态
 */
function readLocalCursorStateSync(opts = {}) {
  const paths = getCursorPaths()
  const authJson = readCursorAuthJsonFile(paths.cursorAuthJsonPath)
  const accountRead = readAccountFromItemTableWithFallback(paths.stateVscdbPath)
  const cursorExeRunning = opts.skipRuntimeChecks ? null : isCursorRunningHeuristic()
  const hook = opts.skipRuntimeChecks ? null : readHookStatus(opts)

  return {
    paths,
    authJson,
    accountFromDb: accountRead.account,
    accountRead,
    status: {
      cursorExeRunning,
      hook,
    },
  }
}

/**
 * 供 Electron IPC / 主页使用的扁平快照（与 preload getLocalCursorState 字段对齐）。
 * `cursorDbEmail`：仅 ItemTable 中 cursorAuth/cachedEmail、cursor.email，即本机 Cursor 当前使用的账号。
 */
function buildLocalCursorSnapshot(opts = {}) {
  const raw = readLocalCursorStateSync({
    ...opts,
    skipRuntimeChecks: Boolean(opts.fast),
  })
  const paths = raw.paths
  const dbPath = paths.stateVscdbPath
  const stateVscdbExists = fs.existsSync(dbPath)
  const acc = raw.accountFromDb
  const ar = raw.accountRead || {}
  const auth = raw.authJson
  const loginState = readCursorLoginState({ accountRead: ar })
  let dbError = null
  /** 仅 state.vscdb ItemTable，用于「当前 Cursor 账号」展示 */
  let cursorDbEmail = null
  /** 兼容旧字段：优先库内邮箱，否则 cursor.auth.json（仅供辅助/旧逻辑） */
  let localEmail = null

  if (stateVscdbExists) {
    if (acc == null) {
      if (ar.moduleError) {
        dbError =
          'better-sqlite3 未适配当前 Electron/Node ABI。请在 desktop 目录执行 npm run rebuild:native 后重启应用。原始错误: ' +
          ar.moduleError
      } else {
        dbError = ar.openError || '无法只读打开 state.vscdb（可能被 Cursor 占用或缺少 ItemTable）'
      }
    } else {
      cursorDbEmail = resolveCursorDbEmail(acc)
    }
    localEmail = cursorDbEmail || (auth && auth.email != null ? String(auth.email).trim() : null) || null
  } else {
    localEmail = auth && auth.email != null ? String(auth.email).trim() : null
  }

  const hs = raw.status.hook
  const injection = {
    found: hs ? Boolean(hs.found) : null,
    hooked: hs && typeof hs.hooked === 'boolean' ? hs.hooked : null,
    path: hs?.path || null,
    message: hs?.message || hs?.error || null,
    machineMatches: hs?.machineMatches ?? null,
    macMatches: hs?.macMatches ?? null,
    backupExists: hs?.backupExists ?? null,
    legacyMainInjected: hs ? Boolean(hs.legacyMainInjected) : null,
    legacyWorkbenchInjected: hs ? Boolean(hs.legacyWorkbenchInjected) : null,
    newCursorNoMain: hs ? Boolean(hs.newCursorNoMain) : null,
  }

  return {
    globalStorageDir: paths.globalStorageDir,
    stateVscdbPath: dbPath,
    stateVscdbExists,
    authJsonEmail: auth && auth.email != null ? String(auth.email).trim() : null,
    cursorDbEmail,
    localEmail,
    cursorLoggedIn: loginState.loggedIn,
    machineId: acc ? normalizeItemScalar(acc.telemetryDevDeviceId) : null,
    dbError,
    injection,
    cursorExeRunning: raw.status.cursorExeRunning,
  }
}

/**
 * 打印诊断报告（与原先 switch-account printLocalCursorReport 格式一致）
 * @param {string} tag
 * @param {{ maskTokens?: boolean }} options
 */
function printDiagnosticReport(tag, options = {}) {
  const maskTokens = options.maskTokens !== false
  const fmt = (v, headLen) => {
    if (!maskTokens) return v == null || v === '' ? '(无)' : v
    return maskSecret(v || '', headLen)
  }

  const paths = getCursorPaths()
  const dbPath = paths.stateVscdbPath
  const authPath = paths.cursorAuthJsonPath

  console.log('')
  console.log('========', tag, '========')
  console.log('[路径] globalStorage =', paths.globalStorageDir)
  console.log('[路径] state.vscdb   =', dbPath, fs.existsSync(dbPath) ? '(存在)' : '(不存在)')

  if (fs.existsSync(authPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      console.log('[文件] cursor.auth.json')
      console.log('       email         =', j.email ?? '(无)')
      console.log('       access_token  =', fmt(j.access_token))
    } catch (e) {
      console.log('[文件] cursor.auth.json 解析失败:', e.message)
    }
  } else {
    console.log('[文件] cursor.auth.json = (不存在)')
  }

  if (!fs.existsSync(dbPath)) {
    console.log('[库] 无法读取 ItemTable（无 state.vscdb）')
    console.log('[进程] Cursor.exe     =', isCursorRunningHeuristic() ? '运行中' : '未运行')
    printHookBlock()
    console.log('========================================')
    console.log('')
    return
  }

  let db
  try {
    const Database = require('better-sqlite3')
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 8000 })
  } catch (e) {
    console.log('[库] 只读打开 state.vscdb 失败:', e.message)
    console.log('[进程] Cursor.exe     =', isCursorRunningHeuristic() ? '运行中' : '未运行')
    printHookBlock()
    console.log('========================================')
    console.log('')
    return
  }

  try {
    const tableName = detectItemTableName(db)
    if (!tableName) {
      console.log('[库] 未找到 ItemTable / itemTable')
    } else {
      console.log('[库] ItemTable（本地 Cursor 账户相关）表名:', tableName)
      console.log('     cursorAuth/cachedEmail  =', readItemSafe(db, tableName, 'cursorAuth/cachedEmail') ?? '(无)')
      console.log('     cursor.email            =', readItemSafe(db, tableName, 'cursor.email') ?? '(无)')
      console.log('     cursorAuth/accessToken  =', fmt(readItemSafe(db, tableName, 'cursorAuth/accessToken') || ''))
      console.log('     cursorAuth/refreshToken =', fmt(readItemSafe(db, tableName, 'cursorAuth/refreshToken') || ''))
      console.log('     cursor.accessToken      =', fmt(readItemSafe(db, tableName, 'cursor.accessToken') || ''))
      console.log('     telemetry.devDeviceId   =', fmt(readItemSafe(db, tableName, 'telemetry.devDeviceId') || '', 24))
    }
  } finally {
    db.close()
  }

  console.log('[进程] Cursor.exe     =', isCursorRunningHeuristic() ? '运行中' : '未运行')
  printHookBlock()
  console.log('========================================')
  console.log('')
}

function printHookBlock() {
  try {
    const hs = readHookStatus({})
    console.log('[注入] 对应客户端「CC 注入」检测（main.js 正则启发式）')
    if (hs.found) {
      console.log('     main.js        =', hs.path)
      console.log('     是否像已注入   =', hs.hooked ? '是 (原 machineId/mac 模式无匹配)' : '否 (仍可替换)')
      console.log('     可替换匹配数   = machineId:', hs.machineMatches, ', macMachineId:', hs.macMatches)
      console.log('     main.js.backup =', hs.backupExists ? '存在' : '无')
    } else {
      console.log('     ', hs.message || hs.error || '未找到 main.js')
    }
  } catch (e) {
    console.log('[注入] 检测异常:', e.message)
  }
}

module.exports = {
  getCursorAppDataDir,
  getMachineIdFilePath,
  getUpdaterIdFilePath,
  getGlobalStorageDir,
  getStateVscdbPath,
  getCursorAuthJsonPath,
  getStorageJsonPath,
  getCursorPaths,
  maskSecret,
  isCursorRunningHeuristic,
  readCursorAuthJsonFile,
  readAccountFromItemTable,
  readAccountFromItemTableWithFallback,
  readCursorLoginState,
  looksLikeCursorAccessToken,
  readHookStatus,
  readLocalCursorStateSync,
  buildLocalCursorSnapshot,
  printDiagnosticReport,
  resolveCursorDbEmail,
  normalizeEmailFromItemValue,
}

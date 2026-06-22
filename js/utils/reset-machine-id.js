#!/usr/bin/env node
/**
 * 复刻 DashboardView「更换机器码」→ Tauri reset_machine_id（commands.rs）
 * 并补充 go-cursor-help 脚本中有效的附加项：machineid / .updaterId / firstSessionDate /
 * storage.serviceMachineId / ~/.cursor_ids.json
 *
 * 步骤：可选结束 Cursor → 删除 cursorai/serverConfig → 生成新 telemetry.* →
 *       写 storage.json + machineid + .updaterId → 更新 state.vscdb
 *
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const {
  getGlobalStorageDir,
  getStateVscdbPath,
  getStorageJsonPath,
  getMachineIdFilePath,
  getUpdaterIdFilePath,
  isCursorRunningHeuristic,
} = require('./cursor-local-state')
const {
  quitCursorAndWait,
  launchCursorApp,
} = require('./cursor-process')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 对齐 id_generator.rs generate_new_ids */
function generateNewIds() {
  const devDeviceId = crypto.randomUUID()
  const macMachineId = crypto.createHash('sha512').update(crypto.randomBytes(64)).digest('hex')
  const machineId = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex')
  const sqmId = `{${crypto.randomUUID().toUpperCase()}}`
  const serviceMachineId = crypto.randomUUID()
  const firstSessionDate = new Date().toISOString()
  const sessionId = crypto.randomUUID()
  return {
    'telemetry.devDeviceId': devDeviceId,
    'telemetry.macMachineId': macMachineId,
    'telemetry.machineId': machineId,
    'telemetry.sqmId': sqmId,
    'storage.serviceMachineId': serviceMachineId,
    'telemetry.firstSessionDate': firstSessionDate,
    'telemetry.sessionId': sessionId,
  }
}

function tryClearReadonly(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o666)
    }
  } catch {
    /* ignore */
  }
}

function writeTextAtomic(filePath, content) {
  const parent = path.dirname(filePath)
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true })
  }
  tryClearReadonly(filePath)
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
  fs.renameSync(tmp, filePath)
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

function cleanupServerConfig(db, tableName) {
  const r = db.prepare(`DELETE FROM "${tableName}" WHERE key = ?`).run('cursorai/serverConfig')
  return r.changes
}

function mapResetKey(short) {
  const m = {
    device_id: 'telemetry.devDeviceId',
    mac_id: 'telemetry.macMachineId',
    machineId: 'telemetry.machineId',
    sqm_id: 'telemetry.sqmId',
  }
  return m[short] || short
}

function upsertItem(db, tableName, key, value) {
  const info = db.prepare(`UPDATE "${tableName}" SET value = ? WHERE key = ?`).run(value, key)
  if (info.changes === 0) {
    db.prepare(`INSERT INTO "${tableName}" (key, value) VALUES (?, ?)`).run(key, value)
  }
}

function applyDbMachineUpdates(db, newIds, tableName) {
  const dev = newIds['telemetry.devDeviceId']
  const updates = [
    ['device_id', dev],
    ['mac_id', newIds['telemetry.macMachineId']],
    ['machineId', newIds['telemetry.machineId']],
    ['sqm_id', newIds['telemetry.sqmId']],
    ['storage.serviceMachineId', newIds['storage.serviceMachineId']],
    ['telemetry.firstSessionDate', newIds['telemetry.firstSessionDate']],
    ['telemetry.sessionId', newIds['telemetry.sessionId']],
  ]
  for (const [short, val] of updates) {
    upsertItem(db, tableName, mapResetKey(short), val)
  }
}

function applyDbMachineUpdatesTauriCompat(db, newIds, tableName) {
  const dev = newIds['telemetry.devDeviceId']
  const updates = [
    ['device_id', dev],
    ['mac_id', newIds['telemetry.macMachineId']],
    ['machineId', newIds['telemetry.machineId']],
    ['sqm_id', newIds['telemetry.sqmId']],
    ['storage.serviceMachineId', dev],
  ]
  for (const [short, val] of updates) {
    upsertItem(db, tableName, mapResetKey(short), val)
  }
}

async function openDbWithRetry(dbPath, tries = 25, delayMs = 500) {
  const Database = require('better-sqlite3')
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const db = new Database(dbPath, { timeout: 5000 })
      try {
        db.pragma('journal_mode = WAL')
      } catch {
        /* ignore */
      }
      return db
    } catch (e) {
      lastErr = e
      const msg = e && e.message ? String(e.message) : ''
      if (msg.includes('locked') || msg.includes('busy')) {
        await sleep(delayMs)
        continue
      }
      throw e
    }
  }
  throw lastErr || new Error('无法打开 state.vscdb')
}

function rotateSingleBackup(filePath, backupPath) {
  if (!fs.existsSync(filePath)) return
  try {
    fs.copyFileSync(filePath, backupPath)
  } catch {
    /* ignore */
  }
}

function writeCursorIdsJson(newIds) {
  const configPath = path.join(os.homedir(), '.cursor_ids.json')
  const payload = {
    machineId: newIds['telemetry.machineId'],
    machineGuid: crypto.randomUUID(),
    macMachineId: newIds['telemetry.macMachineId'],
    devDeviceId: newIds['telemetry.devDeviceId'],
    sqmId: newIds['telemetry.sqmId'],
    macAddress: '00:11:22:33:44:55',
    sessionId: newIds['telemetry.sessionId'],
    firstSessionDate: newIds['telemetry.firstSessionDate'],
    createdAt: newIds['telemetry.firstSessionDate'],
  }
  writeTextAtomic(configPath, `${JSON.stringify(payload, null, 2)}\n`)
  return configPath
}

function updateAuxiliaryIdFiles(newIds, opts = {}) {
  const serviceMachineId = newIds['storage.serviceMachineId']
  const machineIdPath = getMachineIdFilePath()
  const updaterIdPath = getUpdaterIdFilePath()
  const backupDir = path.join(getGlobalStorageDir(), 'backups')

  rotateSingleBackup(machineIdPath, path.join(backupDir, 'machineid.bak'))
  rotateSingleBackup(updaterIdPath, path.join(backupDir, '.updaterId.bak'))

  writeTextAtomic(machineIdPath, serviceMachineId)
  try {
    fs.chmodSync(machineIdPath, 0o666)
  } catch {
    /* ignore */
  }

  const newUpdaterId = crypto.randomUUID()
  writeTextAtomic(updaterIdPath, newUpdaterId)

  if (!opts.quiet) {
    console.log('[写入] machineid / .updaterId 完成（覆盖写入，单份 .bak 备份）')
  }
}

/**
 * 更换机器码。供 Electron 调用。
 * @param {{ noKill?: boolean, quiet?: boolean }} opts
 */
async function runResetMachineId(opts = {}) {
  const NO_KILL = opts.noKill === true || process.env.CURSOR_NO_KILL === '1'
  const tauriCompat = opts.tauriCompat === true || process.env.CURSORPOOL_TAURI_COMPAT_RESET === '1'
  const dbPath = getStateVscdbPath()
  const storagePath = getStorageJsonPath()
  const globalDir = getGlobalStorageDir()

  if (!opts.quiet) {
    console.log('[路径] globalStorage =', globalDir)
    console.log('[路径] state.vscdb   =', dbPath)
    console.log('[路径] storage.json  =', storagePath)
  }

  if (!fs.existsSync(dbPath)) {
    throw new Error('state.vscdb 不存在，请先启动过 Cursor 或设置 CURSOR_STATE_DB')
  }

  if (!NO_KILL) {
    opts.onStep?.('closing')
    if (!opts.quiet) console.log('正在优雅关闭 Cursor…')
    const closed = await quitCursorAndWait({
      profile: opts.closeProfile || 'gentle',
      throwOnTimeout: false,
      maxWaitMs: opts.closeProfile === 'switch' ? 6500 : 55000,
      gracefulMs: opts.closeProfile === 'switch' ? 900 : undefined,
      gentleMs: opts.closeProfile === 'switch' ? 1800 : undefined,
      closeRetryMs: opts.closeProfile === 'switch' ? 600 : undefined,
      pollMs: opts.closeProfile === 'switch' ? 160 : undefined,
      allowForceKill: opts.closeProfile === 'switch',
      includeCliQuit: true,
    })
    if (!closed || isCursorRunningHeuristic()) {
      let detail = ''
      try {
        const { getCursorProcessSnapshot } = require('./cursor-process')
        const snapshot = getCursorProcessSnapshot()
        const titles = (snapshot.processes || [])
          .filter((item) => item.title)
          .map((item) => item.title)
          .slice(0, 3)
          .join('；')
        detail = ` 剩余进程：${snapshot.count || 0}${titles ? `；窗口：${titles}` : ''}`
      } catch {
        /* ignore */
      }
      throw new Error(
        `无法关闭 Cursor。请先手动保存工作并完全退出 Cursor 后重试。${detail}`,
      )
    }
  } else if (isCursorRunningHeuristic()) {
    throw new Error('Cursor 仍在运行，无法安全重置机器码')
  }

  let newIds = generateNewIds()
  const fixedDev = process.env.CURSOR_MACHINE_ID || process.env.MACHINE_ID
  if (fixedDev) {
    newIds = { ...newIds, 'telemetry.devDeviceId': fixedDev }
    if (!opts.quiet) console.log('[参数] 使用指定 devDeviceId:', fixedDev)
  }

  if (!opts.quiet) {
    console.log('[生成] 新 telemetry 标识:')
    console.log('  telemetry.devDeviceId   =', newIds['telemetry.devDeviceId'])
    console.log('  telemetry.macMachineId  =', newIds['telemetry.macMachineId'].slice(0, 32) + '…')
    console.log('  telemetry.machineId     =', newIds['telemetry.machineId'].slice(0, 32) + '…')
    console.log('  telemetry.sqmId         =', newIds['telemetry.sqmId'])
  }

  opts.onStep?.('writing')
  const db = await openDbWithRetry(dbPath)
  let tableName
  try {
    tableName = detectItemTableName(db)
    if (!tableName) throw new Error('state.vscdb 中未找到 ItemTable')
    cleanupServerConfig(db, tableName)
    if (!opts.quiet) console.log('[清理] DELETE cursorai/serverConfig 完成')
  } catch (e) {
    db.close()
    throw new Error(`[清理] 失败: ${e.message}`)
  }
  db.close()

  let storageObj = {}
  if (fs.existsSync(storagePath)) {
    try {
      const raw = fs.readFileSync(storagePath, 'utf8')
      storageObj = JSON.parse(raw)
      if (typeof storageObj !== 'object' || storageObj === null || Array.isArray(storageObj)) {
        throw new Error('storage.json 不是 JSON 对象')
      }
    } catch (e) {
      throw new Error(`读取/解析 storage.json 失败: ${e.message}`)
    }
  } else if (!opts.quiet) {
    console.log('[storage.json] 不存在，将创建新对象')
  }

  const storageKeys = tauriCompat
    ? ['telemetry.devDeviceId', 'telemetry.macMachineId', 'telemetry.machineId', 'telemetry.sqmId']
    : Object.keys(newIds)
  for (const k of storageKeys) {
    storageObj[k] = newIds[k]
  }

  const backupDir = path.join(globalDir, 'backups')
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true })
  }
  rotateSingleBackup(storagePath, path.join(backupDir, 'storage.json.bak'))

  writeTextAtomic(storagePath, `${JSON.stringify(storageObj, null, 2)}\n`)
  if (!opts.quiet) console.log('[写入] storage.json 完成')

  if (!tauriCompat) {
    updateAuxiliaryIdFiles(newIds, opts)
    writeCursorIdsJson(newIds)
  }

  const db2 = await openDbWithRetry(dbPath)
  try {
    const t2 = detectItemTableName(db2)
    if (!t2) throw new Error('state.vscdb 中未找到 ItemTable')
    if (tauriCompat) applyDbMachineUpdatesTauriCompat(db2, newIds, t2)
    else applyDbMachineUpdates(db2, newIds, t2)
    if (!opts.quiet) {
      console.log('[写入] state.vscdb telemetry.* / storage.serviceMachineId 完成')
    }
  } finally {
    db2.close()
  }

  if (!opts.quiet) {
    console.log('\n机器码重置完成。')
  }

  return { seamless: false, newIds }
}

async function killCursorAndWait(opts = {}) {
  return quitCursorAndWait(opts)
}

/** 仅 CLI：node reset-machine-id.js */
async function mainCli() {
  try {
    await runResetMachineId({ noKill: process.env.CURSOR_NO_KILL === '1' })
    console.log('请启动 Cursor 验证。')
    process.exit(0)
  } catch (e) {
    console.error(e.message || e)
    process.exit(1)
  }
}

if (require.main === module) {
  mainCli()
}

module.exports = {
  runResetMachineId,
  killCursorAndWait,
  launchCursorApp,
  generateNewIds,
  getStateVscdbPath,
  getGlobalStorageDir,
}

/**
 * Cursor main.js hook helpers.
 *
 * The hook replaces the machine id getters in Cursor's bundled main.js so our
 * generated IDs from state.vscdb/storage.json are used. This module intentionally
 * keeps the public API used by Electron IPC and hook-cli.js.
 */

const fs = require('fs')
const { resolveMainJsPath } = require('./paths')

const MACHINE_ID_SOURCE =
  String.raw`async\s+(\w+)\s*\(\)\s*\{\s*return\s+this\.[\w.]+(?:\?\?|\?)\s*this\.([\w.]+)\.machineId\s*\}`
const MAC_MACHINE_ID_SOURCE =
  String.raw`async\s+(\w+)\s*\(\)\s*\{\s*return\s+this\.[\w.]+(?:\?\?|\?)\s*this\.([\w.]+)\.macMachineId\s*\}`

function machineIdRegex() {
  return new RegExp(MACHINE_ID_SOURCE, 'g')
}

function macMachineIdRegex() {
  return new RegExp(MAC_MACHINE_ID_SOURCE, 'g')
}

function countMatchesGlobal(re, text) {
  const r = new RegExp(re.source, 'g')
  let n = 0
  let m
  while ((m = r.exec(text)) !== null) {
    n += 1
    if (m.index === r.lastIndex) r.lastIndex += 1
  }
  return n
}

function isHookedByHeuristic(content) {
  const machineMatches = countMatchesGlobal(machineIdRegex(), content)
  const macMatches = countMatchesGlobal(macMachineIdRegex(), content)
  return machineMatches === 0 || macMatches === 0
}

function resolveMainPathOrThrow(mainJsPath) {
  const mainPath = mainJsPath ? resolveMainJsPath(mainJsPath) : resolveMainJsPath()
  if (!mainPath) {
    throw new Error('MAIN_JS_NOT_FOUND: 未找到 Cursor main.js，请安装 Cursor 或配置正确路径。')
  }
  return mainPath
}

function readTextFile(filePath, action) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`${action}失败：${filePath}\n${error.message || error}`)
  }
}

function formatFileWriteError(filePath, error, action) {
  const code = error?.code ? ` (${error.code})` : ''
  const message = error?.message || String(error || 'unknown error')
  if (error?.code === 'EPERM' || error?.code === 'EACCES') {
    return new Error(
      `${action}失败${code}：当前用户没有写入权限。\n` +
        `文件：${filePath}\n` +
        '请以管理员身份运行本程序，或把 Cursor 安装到当前用户可写目录后重试。\n' +
        `原始错误：${message}`,
    )
  }
  return new Error(`${action}失败${code}：${filePath}\n${message}`)
}

function writeTextFile(filePath, content, action) {
  try {
    fs.writeFileSync(filePath, content, 'utf8')
  } catch (error) {
    throw formatFileWriteError(filePath, error, action)
  }
}

function unlinkFileBestEffort(filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch {
    /* Deleting the backup is cleanup only; restore has already succeeded. */
  }
}

function getHookMatchCounts(content) {
  return {
    machineMatches: countMatchesGlobal(machineIdRegex(), content),
    macMatches: countMatchesGlobal(macMachineIdRegex(), content),
  }
}

function isHook(opts = {}) {
  const mainPath = resolveMainPathOrThrow(opts.mainJsPath)
  const content = readTextFile(mainPath, '读取 main.js')
  return isHookedByHeuristic(content)
}

function applyHook(opts = {}) {
  const mainPath = resolveMainPathOrThrow(opts.mainJsPath)
  const content = readTextFile(mainPath, '读取 main.js')
  const { machineMatches, macMatches } = getHookMatchCounts(content)

  if (machineMatches === 0 || macMatches === 0) {
    if (machineMatches === 0 && macMatches === 0) {
      return {
        ok: true,
        path: mainPath,
        skipped: true,
        message: '已检测到 Cursor 客户端已经注入，跳过重复写入。',
      }
    }
    throw new Error('machineId 与 macMachineId 可替换片段数量不一致，请检查 Cursor 版本或手动确认 main.js。')
  }

  const backupPath = mainPath.replace(/\.js$/, '.js.backup')
  if (!fs.existsSync(backupPath)) {
    writeTextFile(backupPath, content, '创建 main.js.backup')
  }

  let modified = content.replace(
    machineIdRegex(),
    (_, fnName, objName) => `async ${fnName}() { return this.${objName}.machineId }`,
  )
  modified = modified.replace(
    macMachineIdRegex(),
    (_, fnName, objName) => `async ${fnName}() { return this.${objName}.macMachineId }`,
  )

  writeTextFile(mainPath, modified, '写入 main.js')
  return {
    ok: true,
    path: mainPath,
    skipped: false,
    message: '注入完成，已写入 main.js；首次注入时会保留 main.js.backup。',
  }
}

function restoreHook(opts = {}) {
  const mainPath = resolveMainPathOrThrow(opts.mainJsPath)
  const backupPath = mainPath.replace(/\.js$/, '.js.backup')
  if (!fs.existsSync(backupPath)) {
    throw new Error(`备份文件不存在：${backupPath}。还原前需要曾经成功执行过注入。`)
  }

  const backupContent = readTextFile(backupPath, '读取 main.js.backup')
  writeTextFile(mainPath, backupContent, '还原 main.js')
  unlinkFileBestEffort(backupPath)
  return { ok: true, path: mainPath, message: '已从备份还原 main.js' }
}

function hookStatus(opts = {}) {
  const mainPath = opts.mainJsPath ? resolveMainJsPath(opts.mainJsPath) : resolveMainJsPath()
  if (!mainPath) {
    return {
      found: false,
      path: null,
      machineMatches: 0,
      macMatches: 0,
      hooked: null,
      message: '未找到 main.js',
    }
  }

  const content = readTextFile(mainPath, '读取 main.js')
  const { machineMatches, macMatches } = getHookMatchCounts(content)
  return {
    found: true,
    path: mainPath,
    machineMatches,
    macMatches,
    hooked: machineMatches === 0 || macMatches === 0,
    backupExists: fs.existsSync(mainPath.replace(/\.js$/, '.js.backup')),
  }
}

module.exports = {
  applyHook,
  restoreHook,
  hookStatus,
  isHook,
  resolveMainJsPath,
  isHookedByHeuristic,
  machineIdRegex,
  macMachineIdRegex,
}

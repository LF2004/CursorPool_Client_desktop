/**
 * 解析 Cursor main.js / workbench.js 路径（对齐 src-tauri/src/utils/paths.rs 常见安装位置）。
 * 可通过环境变量 CURSOR_MAIN_JS / CURSOR_WORKBENCH_JS 或参数显式指定。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

function pushUnique(list, value) {
  if (!value) return
  const normalized = path.resolve(value)
  if (!list.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
    list.push(normalized)
  }
}

function parseRegSzValues(output) {
  const values = []
  String(output || '').split(/\r?\n/).forEach((line) => {
    const m = line.match(/\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i)
    if (m?.[1]) values.push(m[1].trim().replace(/^"|"$/g, ''))
  })
  return values
}

function queryRegistryValues(key, valueName) {
  if (process.platform !== 'win32') return []
  try {
    const args = ['query', key]
    if (valueName) args.push('/v', valueName)
    else args.push('/ve')
    const out = execFileSync('reg.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
    return parseRegSzValues(out)
  } catch {
    return []
  }
}

function stripExeArgs(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const quoted = raw.match(/^"([^"]+\.exe)"/i)
  if (quoted) return quoted[1]
  const unquoted = raw.match(/^(.+?\.exe)(?:\s|$)/i)
  return unquoted ? unquoted[1] : raw
}

function candidateCursorDirsFromRegistry() {
  const dirs = []
  const appPathKeys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe',
  ]
  for (const key of appPathKeys) {
    for (const value of queryRegistryValues(key, null)) {
      const exe = stripExeArgs(value)
      if (exe && fs.existsSync(exe)) pushUnique(dirs, path.dirname(exe))
    }
    for (const value of queryRegistryValues(key, 'Path')) {
      if (value && fs.existsSync(value)) pushUnique(dirs, value)
    }
  }
  return dirs
}

function candidateCursorDirsFromCommonWindowsLocations() {
  const dirs = []
  const envDirs = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'cursor'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Cursor'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Cursor'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Cursor'),
  ]
  envDirs.forEach((dir) => {
    if (dir && fs.existsSync(dir)) pushUnique(dirs, dir)
  })

  for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${drive}:\\`
    if (!fs.existsSync(root)) continue
    for (const name of ['cursor', 'Cursor']) {
      const dir = path.join(root, name)
      if (fs.existsSync(dir)) pushUnique(dirs, dir)
    }
  }
  return dirs
}

function candidateCursorDirsFromPath() {
  const dirs = []
  const PATH = process.env.PATH || ''
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir || !dir.toLowerCase().includes('cursor')) continue
    pushUnique(dirs, dir)
    pushUnique(dirs, path.dirname(dir))
  }
  return dirs
}

function candidateCursorDirsWindows() {
  const dirs = []
  candidateCursorDirsFromCommonWindowsLocations().forEach((dir) => pushUnique(dirs, dir))
  candidateCursorDirsFromRegistry().forEach((dir) => pushUnique(dirs, dir))
  candidateCursorDirsFromPath().forEach((dir) => pushUnique(dirs, dir))
  return dirs
}

/**
 * 在给定目录及其子目录中查找目标文件
 * @param {string} searchDir - 要搜索的目录
 * @param {string} targetFileName - 目标文件名
 * @param {number} maxDepth - 最大搜索深度
 * @param {number} currentDepth - 当前深度（内部使用）
 * @returns {string|null} 找到的文件路径
 */
function findFileInDirectory(searchDir, targetFileName, maxDepth = 4, currentDepth = 0) {
  if (currentDepth > maxDepth || !fs.existsSync(searchDir)) return null
  
  const st = fs.statSync(searchDir)
  
  if (st.isFile()) {
    if (path.basename(searchDir) === targetFileName) {
      return searchDir
    }
    return null
  }
  
  if (st.isDirectory()) {
    // 先检查是否有 out 目录，重点搜索 out
    const outDir = path.join(searchDir, 'out')
    if (fs.existsSync(outDir)) {
      const result = findFileInDirectory(outDir, targetFileName, maxDepth, currentDepth + 1)
      if (result) return result
    }
    
    // 搜索常见的 Cursor workbench 位置
    const vsWorkbenchDir = path.join(searchDir, 'vs', 'code', 'electron-sandbox', 'workbench')
    const vsWorkbenchFile = path.join(vsWorkbenchDir, targetFileName)
    if (fs.existsSync(vsWorkbenchFile)) {
      return vsWorkbenchFile
    }
    
    // 检查同一级目录
    const sameLevelFile = path.join(searchDir, targetFileName)
    if (fs.existsSync(sameLevelFile)) {
      return sameLevelFile
    }
    
    // 递归搜索其他子目录
    try {
      const children = fs.readdirSync(searchDir)
      for (const child of children) {
        const childPath = path.join(searchDir, child)
        if (child === 'node_modules' || child === '.git') continue
        const result = findFileInDirectory(childPath, targetFileName, maxDepth, currentDepth + 1)
        if (result) return result
      }
    } catch (e) {
      // 忽略读不到的目录
    }
  }
  
  return null
}

/**
 * 从 Cursor 安装根目录解析路径
 * @param {string} cursorDir - Cursor 安装根目录
 * @param {string} targetFileName - 目标文件名
 * @returns {string|null}
 */
function resolveFromCursorDir(cursorDir, targetFileName) {
  if (!cursorDir) return null
  
  const resolvedPath = path.resolve(cursorDir)
  if (!fs.existsSync(resolvedPath)) return null
  
  const st = fs.statSync(resolvedPath)
  if (st.isFile()) {
    // 如果是文件，可能是 exe、main.js 或其他文件，尝试多种方式：
    const attempts = []
    
    // 1. 如果是 exe，从父目录找 resources/app/out 目录搜索
    const parent = path.dirname(resolvedPath)
    
    // 先尝试新的 Cursor 路径结构
    const vsWorkbenchPath = path.join(parent, 'resources', 'app', 'out', 'vs', 'code', 'electron-sandbox', 'workbench', targetFileName)
    attempts.push(vsWorkbenchPath)
    
    // 2. 尝试原来的路径结构
    const oldStructurePath = path.join(parent, 'resources', 'app', 'out', targetFileName)
    attempts.push(oldStructurePath)
    
    // 3. 在 resources/app/out 目录下搜索
    const appOutDir = path.join(parent, 'resources', 'app', 'out')
    if (fs.existsSync(appOutDir)) {
      const found = findFileInDirectory(appOutDir, targetFileName)
      if (found) return found
    }
    
    // 4. 尝试从目录往上找 resources 所在目录
    let upDir = parent
    for (let i = 0; i < 5; i++) {
      const resourcesPath = path.join(upDir, 'resources', 'app', 'out')
      if (fs.existsSync(resourcesPath)) {
        const found = findFileInDirectory(resourcesPath, targetFileName)
        if (found) return found
      }
      upDir = path.dirname(upDir)
      if (upDir === path.dirname(upDir)) break // 到达根目录
    }
    
    for (const guess of attempts) {
      if (fs.existsSync(guess)) return guess
    }
    return null
  }
  
  // 目录，尝试多种方式
  const candidates = [
    // 新的 Cursor 路径结构
    path.join(resolvedPath, 'resources', 'app', 'out', 'vs', 'code', 'electron-sandbox', 'workbench', targetFileName),
    // 原来的路径结构
    path.join(resolvedPath, 'resources', 'app', 'out', targetFileName),
    path.join(resolvedPath, 'out', targetFileName),
    // macOS
    path.join(resolvedPath, 'Contents', 'Resources', 'app', 'out', targetFileName)
  ]
  
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  
  // 在 resources/app/out 目录下搜索
  const appOutDir = path.join(resolvedPath, 'resources', 'app', 'out')
  if (fs.existsSync(appOutDir)) {
    const found = findFileInDirectory(appOutDir, targetFileName)
    if (found) return found
  }
  
  return null
}

/**
 * @param {string} [explicit] 绝对或相对路径；某目录时尝试拼 resources/app/out/main.js
 * @returns {string|null}
 */
function resolveMainJsPath(explicit) {
  if (explicit) {
    const p = path.resolve(explicit)
    if (fs.existsSync(p)) {
      const st = fs.statSync(p)
      if (st.isFile() && path.basename(p) === 'main.js') return p
      if (st.isDirectory()) {
        const guess = path.join(p, 'resources', 'app', 'out', 'main.js')
        if (fs.existsSync(guess)) return guess
      }
      const fromCursorPath = resolveFromCursorDir(p, 'main.js')
      if (fromCursorPath) return fromCursorPath
    }
    return null
  }

  const env = process.env.CURSOR_MAIN_JS
  if (env) {
    const r = resolveMainJsPath(env)
    if (r) return r
  }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) {
      const candidates = [
        path.join(local, 'Programs', 'cursor', 'resources', 'app', 'out', 'main.js'),
        path.join(local, 'Programs', 'cursor', 'resources', 'app', 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'main.js'),
        path.join(local, 'Programs', 'Cursor', 'resources', 'app', 'out', 'main.js'),
      ]
      for (const c of candidates) {
        if (fs.existsSync(c)) return c
      }
    }
    // PATH 推断（与 Rust find_cursor_from_env_path 简化一致）
    for (const dir of candidateCursorDirsWindows()) {
      const mainJsPath = resolveFromCursorDir(dir, 'main.js')
      if (mainJsPath) return mainJsPath
    }
    const PATH = process.env.PATH || ''
    for (const dir of PATH.split(path.delimiter)) {
      const low = dir.toLowerCase()
      if (!low.includes('cursor')) continue
      const mainJsPath = path.join(dir, 'resources', 'app', 'out', 'main.js')
      if (fs.existsSync(mainJsPath)) return mainJsPath
      if (
        low.includes('resources') &&
        low.includes('app') &&
        (low.endsWith('bin') || low.includes(path.sep + 'bin'))
      ) {
        const parent = path.dirname(dir)
        const alt = path.join(parent, 'out', 'main.js')
        if (fs.existsSync(alt)) return alt
      }
    }
    return null
  }

  if (process.platform === 'darwin') {
    const c = '/Applications/Cursor.app/Contents/Resources/app/out/main.js'
    return fs.existsSync(c) ? c : null
  }

  const linuxCandidates = [
    '/usr/lib/cursor/resources/app/out/main.js',
    '/usr/share/cursor/resources/app/out/main.js',
    '/opt/cursor/resources/app/out/main.js',
  ]
  for (const c of linuxCandidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

/**
 * 从 main.js 路径推断 workbench.js 路径
 * @param {string} mainJsPath - main.js 的路径
 * @returns {string|null}
 */
function resolveWorkbenchFromMainJs(mainJsPath) {
  if (!mainJsPath) return null
  
  const resolvedMainJsPath = path.resolve(mainJsPath)
  
  // 如果已经是 workbench.js，直接返回
  if (path.basename(resolvedMainJsPath) === 'workbench.js') {
    if (fs.existsSync(resolvedMainJsPath)) return resolvedMainJsPath
  }
  
  // 如果是 main.js，尝试在同一目录找 workbench.js
  if (path.basename(resolvedMainJsPath) === 'main.js') {
    const workbenchPath = path.join(path.dirname(resolvedMainJsPath), 'workbench.js')
    if (fs.existsSync(workbenchPath)) return workbenchPath
  }
  
  // 如果是其他文件或目录，尝试多种方式解析
  return resolveFromCursorDir(resolvedMainJsPath, 'workbench.js')
}

/**
 * 解析 Cursor workbench.js 路径
 * @param {string} [explicit] 绝对或相对路径
 * @param {string} [mainJsPathHint] main.js 路径作为提示
 * @returns {string|null}
 */
function resolveWorkbenchJsPath(explicit, mainJsPathHint) {
  if (explicit) {
    const p = path.resolve(explicit)
    if (fs.existsSync(p)) {
      const st = fs.statSync(p)
      if (st.isFile() && path.basename(p) === 'workbench.js') return p
      if (st.isDirectory()) {
        const guess = path.join(p, 'resources', 'app', 'out', 'workbench.js')
        if (fs.existsSync(guess)) return guess
      }
      const fromCursorPath = resolveFromCursorDir(p, 'workbench.js')
      if (fromCursorPath) return fromCursorPath
    }
    return null
  }

  // 优先从 main.js 路径推断
  if (mainJsPathHint) {
    const fromMain = resolveWorkbenchFromMainJs(mainJsPathHint)
    if (fromMain) return fromMain
  }

  const env = process.env.CURSOR_WORKBENCH_JS
  if (env) {
    const r = resolveWorkbenchJsPath(env)
    if (r) return r
  }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) {
      const candidates = [
        path.join(local, 'Programs', 'cursor', 'resources', 'app', 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.js'),
        path.join(local, 'Programs', 'cursor', 'resources', 'app', 'out', 'workbench.js'),
        path.join(local, 'Programs', 'Cursor', 'resources', 'app', 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.js'),
        path.join(local, 'Programs', 'Cursor', 'resources', 'app', 'out', 'workbench.js'),
      ]
      for (const c of candidates) {
        if (fs.existsSync(c)) return c
      }
    }
    // PATH 推断
    for (const dir of candidateCursorDirsWindows()) {
      const wbPath = resolveFromCursorDir(dir, 'workbench.js')
      if (wbPath) return wbPath
    }
    const PATH = process.env.PATH || ''
    for (const dir of PATH.split(path.delimiter)) {
      const low = dir.toLowerCase()
      if (!low.includes('cursor')) continue
      const wbPath = resolveFromCursorDir(dir, 'workbench.js')
      if (wbPath) return wbPath
    }
    return null
  }

  if (process.platform === 'darwin') {
    const c = '/Applications/Cursor.app/Contents/Resources/app/out/workbench.js'
    return fs.existsSync(c) ? c : null
  }

  const linuxCandidates = [
    '/usr/lib/cursor/resources/app/out/workbench.js',
    '/usr/share/cursor/resources/app/out/workbench.js',
    '/opt/cursor/resources/app/out/workbench.js',
  ]
  for (const c of linuxCandidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

module.exports = { resolveMainJsPath, resolveWorkbenchJsPath, resolveFromCursorDir, resolveWorkbenchFromMainJs }

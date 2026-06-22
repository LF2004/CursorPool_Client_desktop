/**
 * Workbench.js 注入/恢复模块
 * 参考 MyCursor-main 的 seamless_service.rs 实现
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { resolveWorkbenchJsPath, resolveMainJsPath, resolveWorkbenchFromMainJs, resolveFromCursorDir } = require('../../paths')
const { SEAMLESS_MARKER, buildInjectionScript } = require('./seamless-inject')

/**
 * 获取 workbench.js 的备份路径
 * @param {string} workbenchPath - workbench.js 路径
 * @returns {string} 备份路径
 */
function getBackupPath(workbenchPath) {
  return workbenchPath.replace(/\.js$/, '.js.seamless-backup')
}

/**
 * Validate JavaScript syntax before writing to Cursor files.
 * @param {string} source
 * @param {string} fileName
 */
function validateJavaScript(source, fileName) {
  try {
    new vm.Script(source, { filename: fileName })
  } catch (error) {
    const detail = error && error.message ? error.message : String(error)
    throw new Error(`生成的注入脚本语法无效，已停止写入：${detail}`)
  }
}

/**
 * Return whether file content already carries the seamless marker.
 * @param {string} source
 * @returns {boolean}
 */
function formatWorkbenchWriteError(filePath, error, action) {
  const code = error?.code ? ` (${error.code})` : ''
  const message = error?.message || String(error || 'unknown error')
  if (error?.code === 'EPERM' || error?.code === 'EACCES') {
    return new Error(
      `${action}失败${code}：当前用户没有写入 Cursor 安装目录的权限。\n` +
        `文件：${filePath}\n` +
        '请以管理员身份运行本程序后重试，或把 Cursor 安装到当前用户可写目录。\n' +
        `原始错误：${message}`,
    )
  }
  return new Error(`${action}失败${code}：${filePath}\n${message}`)
}

function writeTextFileSafe(filePath, content, action) {
  try {
    fs.writeFileSync(filePath, content, 'utf8')
  } catch (error) {
    throw formatWorkbenchWriteError(filePath, error, action)
  }
}

function copyFileSafe(source, target, action) {
  try {
    fs.copyFileSync(source, target)
  } catch (error) {
    throw formatWorkbenchWriteError(target, error, action)
  }
}

function hasSeamlessMarker(source) {
  return String(source || '').includes(SEAMLESS_MARKER)
}

/**
 * 尝试多种方式查找 workbench.js，返回找到的路径和尝试过的路径列表
 * @param {object} opts - 选项
 * @param {string} [opts.workbenchPath] - workbench.js 路径（可选）
 * @param {string} [opts.mainJsPath] - main.js 路径提示（可选）
 * @returns {{foundPath: string|null, attempts: string[]}}
 */
function findWorkbenchWithDebug(opts = {}) {
  const { workbenchPath, mainJsPath } = opts
  const attempts = []
  
  // 尝试直接 workbenchPath
  if (workbenchPath) {
    const resolved = path.resolve(workbenchPath)
    attempts.push(resolved)
    if (fs.existsSync(resolved) && path.basename(resolved) === 'workbench.js') {
      return { foundPath: resolved, attempts }
    }
  }
  
  // 尝试从 mainJsPath 推导
  if (mainJsPath) {
    attempts.push(`从 mainJsPath 推导: ${mainJsPath}`)
    const fromMain = resolveWorkbenchFromMainJs(mainJsPath)
    if (fromMain) {
      return { foundPath: fromMain, attempts }
    }
    
    // 如果直接推导失败，尝试更多方式
    const resolvedMainJsPath = path.resolve(mainJsPath)
    if (fs.existsSync(resolvedMainJsPath)) {
      // 如果是文件或目录，尝试多种方式
      const moreAttempts = []
      const parent = path.dirname(resolvedMainJsPath)
      moreAttempts.push(path.join(parent, 'resources', 'app', 'out', 'workbench.js'))
      moreAttempts.push(path.join(parent, 'out', 'workbench.js'))
      
      // 从目录往上找
      let upDir = parent
      for (let i = 0; i < 5; i++) {
        moreAttempts.push(path.join(upDir, 'resources', 'app', 'out', 'workbench.js'))
        upDir = path.dirname(upDir)
        if (upDir === path.dirname(upDir)) break
      }
      
      for (const guess of moreAttempts) {
        attempts.push(guess)
        if (fs.existsSync(guess)) {
          return { foundPath: guess, attempts }
        }
      }
    }
  }
  
  // 尝试默认位置
  const defaultPath = resolveWorkbenchJsPath()
  if (defaultPath) {
    return { foundPath: defaultPath, attempts: [...attempts, defaultPath] }
  }
  
  return { foundPath: null, attempts }
}

/**
 * 检查 workbench.js 是否已注入
 * @param {string} workbenchPath - workbench.js 路径
 * @param {string} [mainJsPathHint] - main.js 路径提示
 * @returns {{ injected: boolean, backupExists: boolean, path?: string, attempts?: string[] }}
 */
function checkInjectionStatus(workbenchPath, mainJsPathHint) {
  const { foundPath, attempts } = findWorkbenchWithDebug({ workbenchPath, mainJsPath: mainJsPathHint })
  if (!foundPath) {
    return { injected: false, backupExists: false, attempts }
  }

  const content = fs.readFileSync(foundPath, 'utf8')
  const backupPath = getBackupPath(foundPath)

  return {
    injected: hasSeamlessMarker(content),
    backupExists: fs.existsSync(backupPath),
    path: foundPath
  }
}

/**
 * 注入 workbench.js
 * @param {number} port - HTTP 服务器端口
 * @param {object} [opts] - 选项
 * @param {string} [opts.workbenchPath] - workbench.js 路径（可选）
 * @param {string} [opts.mainJsPath] - main.js 路径提示（可选）
 * @returns {{ success: boolean, path: string, message: string, details: string[] }}
 */
function injectWorkbench(port, opts = {}) {
  const { workbenchPath, mainJsPath } = opts
  const { foundPath, attempts } = findWorkbenchWithDebug({ workbenchPath, mainJsPath })
  
  if (!foundPath) {
    const details = [
      '未找到 workbench.js，请在高级设置中配置正确的路径。',
      '尝试过的路径：'
    ].concat(attempts.map(a => `  - ${a}`))
    throw new Error(details.join('\n'))
  }

  const details = [`找到 workbench.js: ${foundPath}`]
  const backupPath = getBackupPath(foundPath)

  let cleanContent = fs.readFileSync(foundPath, 'utf8')
  if (hasSeamlessMarker(cleanContent)) {
    if (!fs.existsSync(backupPath)) {
      throw new Error('当前 workbench.js 已注入，但缺少 .seamless-backup，已停止以避免进一步损坏')
    }
    const backupContent = fs.readFileSync(backupPath, 'utf8')
    if (hasSeamlessMarker(backupContent)) {
      throw new Error('当前文件和备份文件都带有注入标记，无法安全恢复，请先手动替换干净 workbench.js')
    }
    cleanContent = backupContent
    details.push('检测到当前文件已注入，已回退到备份内容后重新生成')
  } else if (fs.existsSync(backupPath)) {
    const backupContent = fs.readFileSync(backupPath, 'utf8')
    if (hasSeamlessMarker(backupContent)) {
      writeTextFileSafe(backupPath, cleanContent, '重建 workbench.js 备份')
      details.push('检测到备份被污染，已用当前干净文件重建备份')
    } else {
      details.push('已复用现有干净备份')
    }
  } else {
    writeTextFileSafe(backupPath, cleanContent, '创建 workbench.js 备份')
    details.push(`已创建备份: ${backupPath}`)
  }

  const injectionScript = buildInjectionScript(port)
  validateJavaScript(injectionScript, 'cursorpool-seamless-inject.js')

  const nextContent = `${cleanContent}\n${injectionScript}`
  validateJavaScript(nextContent, foundPath)

  try {
    writeTextFileSafe(foundPath, nextContent, '写入 workbench.js')
  } catch (error) {
    if (fs.existsSync(backupPath)) {
      copyFileSafe(backupPath, foundPath, '恢复 workbench.js')
    }
    throw error
  }

  details.push('已采用尾部追加方式注入，并通过语法校验')
  details.push('不再修改 workbench.js 内部函数，避免版本变动导致白屏')

  return {
    success: true,
    path: foundPath,
    message: `注入成功（端口 ${port}）`,
    details
  }
}

/**
 * 从备份恢复 workbench.js
 * @param {object} [opts] - 选项
 * @param {string} [opts.workbenchPath] - workbench.js 路径（可选）
 * @param {string} [opts.mainJsPath] - main.js 路径提示（可选）
 * @returns {{ success: boolean, path: string, message: string }}
 */
function restoreWorkbench(opts = {}) {
  const { workbenchPath, mainJsPath } = opts
  const { foundPath, attempts } = findWorkbenchWithDebug({ workbenchPath, mainJsPath })
  
  if (!foundPath) {
    const details = [
      '未找到 workbench.js，请在高级设置中配置正确的路径。',
      '尝试过的路径：'
    ].concat(attempts.map(a => `  - ${a}`))
    throw new Error(details.join('\n'))
  }

  const backupPath = getBackupPath(foundPath)
  if (!fs.existsSync(backupPath)) {
    return { success: false, path: foundPath, message: '无备份' }
  }

  copyFileSafe(backupPath, foundPath, '还原 workbench.js')
  try {
    fs.unlinkSync(backupPath)
  } catch (_error) {
    // ignore cleanup failure
  }

  return {
    success: true,
    path: foundPath,
    message: '已从备份恢复，并清理注入备份；请重启 Cursor'
  }
}

/**
 * 获取 workbench 注入状态
 * @param {object} [opts] - 选项
 * @param {string} [opts.workbenchPath] - workbench.js 路径（可选）
 * @param {string} [opts.mainJsPath] - main.js 路径提示（可选）
 * @returns {{ injected: boolean, backupExists: boolean, path: string|null, attempts?: string[] }}
 */
function getWorkbenchStatus(opts = {}) {
  const { workbenchPath, mainJsPath } = opts
  return checkInjectionStatus(workbenchPath, mainJsPath)
}

module.exports = {
  injectWorkbench,
  restoreWorkbench,
  getWorkbenchStatus,
  checkInjectionStatus,
  getBackupPath
}

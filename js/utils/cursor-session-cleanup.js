/**
 * 切换账号时清理 Chromium 会话缓存（Cursor 已完全退出后调用）。
 * 对齐 chechout.txt：避免旧 Cookies / Local Storage 污染新账号。
 */

const fs = require('fs')
const path = require('path')
const { getCursorAppDataDir } = require('./cursor-local-state')

function rmPathSafe(target) {
  if (!target || !fs.existsSync(target)) return false
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    return true
  } catch {
    try {
      fs.unlinkSync(target)
      return true
    } catch {
      return false
    }
  }
}

/** @returns {{ cleared: string[], skipped: string[] }} */
function cleanupChromiumSessionCaches(opts = {}) {
  const root = getCursorAppDataDir()
  const relPaths = [
    path.join('Network', 'Cookies'),
    path.join('Network', 'Cookies-journal'),
    path.join('Local Storage'),
    path.join('Session Storage'),
    path.join('Partitions', 'cursor-browser', 'Network', 'Cookies'),
    path.join('Partitions', 'cursor-browser', 'Network', 'Cookies-journal'),
    path.join('Partitions', 'cursor-browser', 'Local Storage'),
    path.join('Partitions', 'cursor-browser', 'Session Storage'),
  ]

  const cleared = []
  const skipped = []
  for (const rel of relPaths) {
    const full = path.join(root, rel)
    if (rmPathSafe(full)) cleared.push(rel)
    else skipped.push(rel)
  }

  if (!opts.quiet) {
    console.log('[会话清理] 已清除:', cleared.length ? cleared.join(', ') : '(无)')
    if (skipped.length && cleared.length === 0) {
      console.log('[会话清理] 跳过/不存在:', skipped.join(', '))
    }
  }

  return { cleared, skipped, root }
}

module.exports = { cleanupChromiumSessionCaches, rmPathSafe }

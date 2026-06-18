/**
 * 与 src-tauri/src/cursor_reset/commands.rs 中 switch_account 一致：
 * 更新 Cursor globalStorage/state.vscdb 里 ItemTable 的账号相关键。
 *
 * 使用前：关闭 Cursor，再运行 node switch-account.js
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

// ========== 在这里改 ==========
const EMAIL = '6jvvcu23@exjqxm.xiaofanya.top'
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdXRoMHx1c2VyXzAxS05KWUcxQlIzMUFaRTlSRE5YUEg0ODdKIiwidGltZSI6IjE3NzU1MzEyMjgiLCJyYW5kb21uZXNzIjoiZWE3NmMzMTctMDcxNS00ZjNiIiwiZXhwIjoxNzgwNzE1MjI4LCJpc3MiOiJodHRwczovL2F1dGhlbnRpY2F0aW9uLmN1cnNvci5zaCIsInNjb3BlIjoib3BlbmlkIHByb2ZpbGUgZW1haWwgb2ZmbGluZV9hY2Nlc3MiLCJhdWQiOiJodHRwczovL2N1cnNvci5jb20iLCJ0eXBlIjoid2ViIiwid29ya29zU2Vzc2lvbklkIjoic2Vzc2lvbl8wMUtOSllHWTE5UkNBSEVIWVo0MEFXRzlINiJ9.bOXpg4AfpAA3KIfb2_dAMiNQwpptQ4HcxTMEj21HHkc'
// ==============================

function getStateVscdbPath() {
  const platform = process.platform
  if (platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) throw new Error('环境变量 APPDATA 未设置')
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    )
  }
  // linux and others
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

/** 与 Rust: token.contains("%3A%3A") 时取第二部分 */
function processToken(token) {
  if (typeof token !== 'string') throw new Error('TOKEN 必须是字符串')
  if (token.includes('%3A%3A')) {
    const parts = token.split('%3A%3A')
    return parts.length > 1 ? parts[1] : token
  }
  return token
}

function upsertItem(db, key, value) {
  const info = db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(value, key)
  if (info.changes === 0) {
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(key, value)
  }
}

function main() {
  if (TOKEN === 'REPLACE_ME_WITH_YOUR_TOKEN' || !EMAIL || EMAIL === 'you@example.com') {
    console.error('请先在 switch-account.js 顶部填写 EMAIL 和 TOKEN')
    process.exit(1)
  }

  const dbPath = getStateVscdbPath()
  if (!fs.existsSync(dbPath)) {
    console.error('找不到数据库文件:', dbPath)
    process.exit(1)
  }

  const processed = processToken(TOKEN)

  const Database = require('better-sqlite3')
  const db = new Database(dbPath)

  try {
    const updates = [
      ['cursor.email', EMAIL],
      ['cursor.accessToken', processed],
      ['cursorAuth/refreshToken', processed],
      ['cursorAuth/accessToken', processed],
      ['cursorAuth/cachedEmail', EMAIL],
    ]

    for (const [k, v] of updates) {
      upsertItem(db, k, v)
    }

    console.log('已写入', dbPath)
    console.log('键:', updates.map(([k]) => k).join(', '))
  } finally {
    db.close()
  }
}

main()

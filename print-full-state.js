#!/usr/bin/env node
/**
 * 打印本地 Cursor 完整状态（只读）：CLI 入口，数据来自 js/utils/cursor-local-state。
 */
const { buildLocalCursorSnapshot } = require('./js/utils/cursor-local-state')

function main() {
  const s = buildLocalCursorSnapshot()

  console.log('======== 本地 Cursor 完整状态（只读） ========')
  console.log('[路径] globalStorage =', s.globalStorageDir)
  console.log(
    '[路径] state.vscdb   =',
    s.stateVscdbPath,
    s.stateVscdbExists ? '(存在)' : '(不存在)',
  )
  if (s.dbError) console.log('[库] 读取异常:', s.dbError)
  console.log('[进程] Cursor.exe     =', s.cursorExeRunning ? '运行中' : '未运行')

  console.log('')
  console.log('[解析] 当前账号（仅 state.vscdb ItemTable） =', s.cursorDbEmail ?? '(无)')
  console.log('[解析] 本地邮箱（合并，兼容） =', s.localEmail ?? '(无)')
  console.log('[解析] cursor.auth.json email =', s.authJsonEmail ?? '(无)')
  console.log('[解析] 机器码 telemetry.devDeviceId =', s.machineId ?? '(无)')

  const inj = s.injection
  console.log('')
  console.log('[注入] main.js:', inj.path || inj.message || '(未知)')
  if (inj.found) {
    console.log('  machineId 可替换匹配数:', inj.machineMatches)
    console.log('  macMachineId 可替换匹配数:', inj.macMatches)
    console.log('  启发式「已注入」:', inj.hooked, '（任一类匹配为 0 则视为已注入）')
    console.log('  存在 .js.backup:', inj.backupExists)
  }

  console.log('============================================')
}

main()

#!/usr/bin/env node
/** 只打印本地 Cursor 账户与状态（token 脱敏），不写库。用法: node diag.js */
const { printDiagnosticReport } = require('./js/utils/cursor-local-state')

printDiagnosticReport('诊断（仅查看，未修改）', { maskTokens: true })
console.log(
  '提示: 完整 token 请用 node print-full-state.js；Electron 内若读库失败请在 desktop 目录执行 npm run rebuild:native',
)

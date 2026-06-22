#!/usr/bin/env node
/**
 * 热切换：不关闭 Cursor、不自动重启；尽力注入 + 写 state.vscdb / cursor.auth.json
 * 等价于: set CURSOR_HOT_SWAP=1 && node switch-account.js
 */
process.env.CURSOR_HOT_SWAP = '1'
require('./switch-account.js')

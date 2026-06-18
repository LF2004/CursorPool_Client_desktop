#!/usr/bin/env node
/**
 * 对齐 SettingsView「高级设置 → 偏好设置」中的客户端注入状态与注入/还原（Tauri: is_hook / hook_main_js / restore_hook）。
 * 实现模块见 hook.js；本文件为命令行入口。
 *
 * 用法:
 *   node hook-cli.js status [--main <路径>]
 *   node hook-cli.js check   （同上，布尔退出码：已注入=0，未注入=1，失败=2）
 *   node hook-cli.js apply [--main ...] [--force-kill]
 *   node hook-cli.js restore [--main ...] [--force-kill]
 *
 * 环境变量: CURSOR_MAIN_JS
 * --force-kill 对齐桌面端 force_kill：先结束 Cursor 再改文件。
 */

const { applyHook, restoreHook, hookStatus, isHook } = require('./hook')
const { isCursorRunningHeuristic, killCursorQuiet } = require('./cursor-process')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function argMain() {
  const idx = process.argv.indexOf('--main')
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return undefined
}

function hasFlag(name) {
  return process.argv.includes(name)
}

const cmd = (process.argv[2] || '').toLowerCase()
const mainExplicit = argMain()
const forceKill = hasFlag('--force-kill') || hasFlag('-k')

async function ensureCanModifyFiles(operationLabel) {
  if (forceKill) {
    killCursorQuiet()
    await sleep(1200)
    return
  }
  if (isCursorRunningHeuristic()) {
    console.error(`与客户端一致: ${operationLabel} 前需关闭 Cursor，或使用 --force-kill`)
    process.exit(1)
  }
}

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(`对齐桌面端「注入客户端 / 还原客户端」与 is_hook 检测（模块: hook.js）

命令:
  status       打印 main.js 路径、匹配数、是否已注入、是否有 .backup
  check        仅布尔结果（已注入 exit 0，未注入 exit 1，找不到/读失败 exit 2）
  apply        注入（行为与 Settings 注入一致：已注入会报错「无法找到匹配…」）
  restore      从 main.js.backup 还原并删除备份

选项:
  --main <路径>    main.js 或 Cursor 安装目录；也可设环境变量 CURSOR_MAIN_JS
  --force-kill -k  先强制结束 Cursor 再执行 apply/restore（对应 Tauri force_kill）`)
    process.exit(0)
  }

  try {
    if (cmd === 'status') {
      const s = hookStatus({ mainJsPath: mainExplicit })
      if (!s.found) {
        console.log(s.message)
        process.exit(2)
      }
      console.log('main.js:', s.path)
      console.log('machineId 可替换匹配数:', s.machineMatches)
      console.log('macMachineId 可替换匹配数:', s.macMatches)
      console.log('与 is_hook 一致（已注入）:', s.hooked, '（任一类匹配为 0 则为 true）')
      console.log('存在 main.js.backup:', s.backupExists)
      process.exit(0)
    }

    if (cmd === 'check') {
      try {
        const hooked = isHook({ mainJsPath: mainExplicit })
        console.log(hooked ? '已注入 (is_hook=true)' : '未注入 (is_hook=false)')
        process.exit(hooked ? 0 : 1)
      } catch (e) {
        console.error(e.message || e)
        process.exit(2)
      }
    }

    if (cmd === 'apply') {
      await ensureCanModifyFiles('注入')
      const r = applyHook({ mainJsPath: mainExplicit, skipIfAlreadyHooked: false })
      console.log(r.message || (r.skipped ? '已跳过' : '完成'), '\n文件:', r.path)
      process.exit(0)
    }

    if (cmd === 'restore') {
      await ensureCanModifyFiles('还原')
      const r = restoreHook({ mainJsPath: mainExplicit })
      console.log(r.message, '\n文件:', r.path)
      process.exit(0)
    }

    console.error('未知命令:', cmd)
    process.exit(1)
  } catch (e) {
    console.error(e.message || e)
    process.exit(1)
  }
}

main()

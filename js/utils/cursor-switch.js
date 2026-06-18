/**
 * Full account switch: stop Cursor -> reset machine id -> write auth -> launch Cursor.
 * Match the reference client: force-kill Cursor first, then write local state and relaunch.
 */

const { applyCursorAuth } = require('../../update_cursor_auth')
const { runResetMachineId } = require('./reset-machine-id')
const {
  isCursorRunningHeuristic,
  killCursorForce,
  launchCursorApp,
} = require('./cursor-process')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function normalizeCursorSessionToken(token) {
  const raw = String(token || '').trim().replace(/;+\s*$/, '')
  if (!raw) return ''
  const decoded = raw.includes('%3A%3A') ? decodeURIComponent(raw) : raw
  const parts = decoded.split('::')
  return parts.length > 1 ? parts[parts.length - 1] : decoded
}

function decodeJwtPayload(token) {
  const sessionToken = normalizeCursorSessionToken(token)
  const parts = sessionToken.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function assertCursorTokenUsable(token) {
  const payload = decodeJwtPayload(token)
  const exp = Number(payload?.exp || 0)
  if (exp && exp * 1000 <= Date.now() + 120000) {
    const expiredAt = new Date(exp * 1000).toLocaleString()
    throw new Error(`账号登录态已过期（${expiredAt}），请换一个账号或重新导入有效 token`)
  }
}

async function waitForCursorStopped(maxWaitMs = 5000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    if (!isCursorRunningHeuristic()) return true
    await sleep(180)
  }
  return !isCursorRunningHeuristic()
}

async function stopCursorForSwitch() {
  if (!isCursorRunningHeuristic()) return true

  killCursorForce()
  if (await waitForCursorStopped(5000)) return true

  killCursorForce()
  return waitForCursorStopped(5000)
}

/**
 * @param {{ email: string, accessToken: string, refreshToken?: string, resetMachineId?: boolean, onStep?: (step: string) => void }} payload
 */
async function runFullAccountSwitch(payload) {
  const email = payload?.email
  const accessToken = payload?.accessToken
  const refreshToken = payload?.refreshToken || accessToken
  const doResetMachine = payload?.resetMachineId !== false
  const onStep = typeof payload?.onStep === 'function' ? payload.onStep : () => {}

  if (!email || !accessToken) {
    throw new Error('缺少 email 或 accessToken')
  }
  assertCursorTokenUsable(accessToken)

  onStep('closing')
  const exited = await stopCursorForSwitch()
  if (!exited) {
    throw new Error('无法关闭 Cursor。请先手动完全退出 Cursor 后重试。')
  }
  await sleep(250)

  if (doResetMachine) {
    onStep('machine')
    await runResetMachineId({
      noKill: true,
      quiet: true,
      seamless: false,
      tauriCompat: true,
    })
  }

  onStep('auth')
  await applyCursorAuth({
    email,
    accessToken,
    refreshToken,
    clearServerConfig: false,
    dbRetries: 10,
    dbRetryDelayMs: 200,
  })

  onStep('launch')
  await sleep(150)
  const launch = launchCursorApp()
  if (!launch?.ok) {
    throw new Error(launch?.message || 'Cursor 启动失败，请稍后手动打开 Cursor')
  }

  return {
    ok: true,
    launch,
    exited,
    mode: 'full_restart',
  }
}

module.exports = {
  runFullAccountSwitch,
  stopCursorForSwitch,
}

/**
 * Cursor 进程检测、优雅退出与重启（避免 taskkill /F 导致「窗口意外终止 killed」弹窗）。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile, execFileSync, spawn, spawnSync } = require('child_process')
const { isCursorRunningHeuristic } = require('./cursor-local-state')
const { resolveMainJsPath } = require('../../paths')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const CURSOR_PROCESS_NAMES_WIN = [
  'Cursor',
  'Cursor Helper',
  'Cursor Helper (GPU)',
  'Cursor Helper (Plugin)',
  'Cursor Helper (Renderer)',
  'CursorUpdater',
]

function execFileQuiet(file, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: opts.timeout || 5000,
        encoding: opts.encoding || 'utf8',
        maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error,
          stdout: stdout || '',
          stderr: stderr || '',
        })
      },
    )
  })
}

function tasklistShowsCursor(output) {
  return CURSOR_PROCESS_NAMES_WIN.some((name) => {
    const imageName = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`
    const re = new RegExp(`(^|\\r?\\n)"?${escapeRegex(imageName)}"?\\s*,`, 'im')
    return re.test(String(output || ''))
  })
}

async function isCursorRunningAsync() {
  if (process.platform !== 'win32') return isCursorRunningHeuristic()
  const r = await execFileQuiet('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 3500 })
  if (!r.ok) return isCursorRunningHeuristic()
  return tasklistShowsCursor(r.stdout)
}

function resolveCursorExePath() {
  const mainJs = resolveMainJsPath()
  if (mainJs) {
    const installRoot = path.join(path.dirname(mainJs), '..', '..', '..')
    for (const name of ['Cursor.exe', 'cursor.exe']) {
      const exe = path.join(installRoot, name)
      if (fs.existsSync(exe)) return exe
    }
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) {
      for (const seg of ['Programs\\cursor', 'Programs\\Cursor']) {
        for (const name of ['Cursor.exe', 'cursor.exe']) {
          const exe = path.join(local, seg, name)
          if (fs.existsSync(exe)) return exe
        }
      }
    }
  }
  if (process.platform === 'darwin') {
    const exe = '/Applications/Cursor.app/Contents/MacOS/Cursor'
    return fs.existsSync(exe) ? exe : null
  }
  return null
}

function runCursorCommand(commandId, timeoutMs = 12000) {
  if (!isCursorRunningHeuristic()) return false
  const exe = resolveCursorExePath()
  if (!exe) return false
  try {
    const r = spawnSync(exe, ['--reuse-window', '--command', commandId], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: timeoutMs,
    })
    return !r.error
  } catch {
    return false
  }
}

function startNewCursorAgentConversation(options = {}) {
  if (!isCursorRunningHeuristic()) {
    return { ok: false, skipped: true, message: 'Cursor 未运行' }
  }

  const timeoutMs = Number(options.timeoutMs || 4000)
  const commands = [
    'glass.newAgentFromKeyboard',
    'aichat.newchataction',
    'workbench.action.chat.openAgent',
    'composerMode.agent',
    'composer.focusComposer',
  ]

  const attempted = []
  let succeeded = false
  for (const commandId of commands) {
    let ok = false
    try {
      ok = runCursorCommand(commandId, timeoutMs)
    } catch {
      ok = false
    }
    attempted.push({ commandId, ok })
    if (ok) succeeded = true
  }

  return {
    ok: succeeded,
    attempted,
    message: succeeded
      ? '已尝试切到新的 Cursor Agent 对话'
      : '未能触发新的 Cursor Agent 对话',
  }
}

/** 向已运行的 Cursor 发送重载命令（不 launch 新窗口；异步触发，不阻塞主进程） */
function reloadRunningCursorWindow() {
  if (!isCursorRunningHeuristic()) return false
  const exe = resolveCursorExePath()
  if (!exe) return false
  try {
    spawn(exe, ['--reuse-window', '--command', 'workbench.action.reloadWindow'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return true
  } catch {
    return false
  }
}

const WIN_CLOSE_MAIN_WINDOW_SCRIPT = `
$names = @('Cursor','Cursor Helper','Cursor Helper (GPU)','Cursor Helper (Plugin)','Cursor Helper (Renderer)','CursorUpdater')
foreach ($name in $names) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.MainWindowHandle -ne 0) { [void]$_.CloseMainWindow() }
  }
}
`

function closeCursorMainWindows() {
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WIN_CLOSE_MAIN_WINDOW_SCRIPT],
        { stdio: 'ignore', windowsHide: true, timeout: 12000 },
      )
    } catch {
      /* ignore */
    }
    return
  }
  if (process.platform === 'darwin') {
    try {
      execFileSync('osascript', ['-e', 'tell application "Cursor" to quit'], {
        stdio: 'ignore',
        timeout: 6000,
      })
    } catch {
      /* ignore */
    }
  }
}

async function closeCursorMainWindowsAsync() {
  if (process.platform === 'win32') {
    await execFileQuiet(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WIN_CLOSE_MAIN_WINDOW_SCRIPT],
      { timeout: 4500 },
    )
    return
  }
  if (process.platform === 'darwin') {
    await execFileQuiet('osascript', ['-e', 'tell application "Cursor" to quit'], { timeout: 4500 })
    return
  }
  closeCursorMainWindows()
}

function requestCursorQuitViaCli() {
  if (!isCursorRunningHeuristic()) return false
  return runCursorCommand('workbench.action.quit', 8000)
}

async function requestCursorQuitViaCliAsync() {
  if (!(await isCursorRunningAsync())) return false
  const exe = resolveCursorExePath()
  if (!exe) return false
  const r = await execFileQuiet(exe, ['--reuse-window', '--command', 'workbench.action.quit'], {
    timeout: 4500,
  })
  return r.ok
}

/** 先尝试 CloseMainWindow / CLI quit，最后再强杀 */
function gracefulQuitCursor(opts = {}) {
  const includeCliQuit = opts.includeCliQuit !== false
  if (includeCliQuit) {
    requestCursorQuitViaCli()
    return
  }
  closeCursorMainWindows()
  if (process.platform === 'win32' || process.platform === 'darwin') return
  try {
    execFileSync('pkill', ['-TERM', '-x', 'cursor'], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

async function gracefulQuitCursorAsync(opts = {}) {
  const includeCliQuit = opts.includeCliQuit !== false
  if (includeCliQuit) {
    await requestCursorQuitViaCliAsync()
    return
  }
  await closeCursorMainWindowsAsync()
}

/** taskkill /T（无 /F）会向进程树发送关闭请求，比 /F 更不易触发「窗口意外终止 killed」 */
function terminateCursorTreeGentle() {
  if (process.platform === 'win32') {
    for (const name of CURSOR_PROCESS_NAMES_WIN) {
      try {
        execFileSync('taskkill', ['/IM', `${name}.exe`, '/T'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        /* 未运行 */
      }
    }
    return
  }
  if (process.platform === 'darwin') {
    try {
      execFileSync('pkill', ['-TERM', '-x', 'Cursor'], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
    return
  }
  try {
    execFileSync('pkill', ['-TERM', '-f', 'cursor'], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

async function terminateCursorTreeGentleAsync() {
  if (process.platform === 'win32') {
    await Promise.all(
      CURSOR_PROCESS_NAMES_WIN.map((name) =>
        execFileQuiet('taskkill', ['/IM', `${name}.exe`, '/T'], { timeout: 3500 }),
      ),
    )
    return
  }
  terminateCursorTreeGentle()
}

function killCursorForce() {
  if (process.platform === 'win32') {
    for (const name of CURSOR_PROCESS_NAMES_WIN) {
      try {
        execFileSync('taskkill', ['/IM', `${name}.exe`, '/F', '/T'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        /* 未运行 */
      }
    }
    return
  }
  if (process.platform === 'darwin') {
    try {
      execFileSync('killall', ['Cursor'], { stdio: 'ignore' })
    } catch {
      try {
        execFileSync('pkill', ['-x', 'Cursor'], { stdio: 'ignore' })
      } catch {
        /* ignore */
      }
    }
    return
  }
  try {
    execFileSync('pkill', ['-f', 'cursor'], { stdio: 'ignore' })
  } catch {
    try {
      execFileSync('killall', ['cursor'], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
  }
}

async function killCursorForceAsync() {
  if (process.platform === 'win32') {
    await Promise.all(
      CURSOR_PROCESS_NAMES_WIN.map((name) =>
        execFileQuiet('taskkill', ['/IM', `${name}.exe`, '/F', '/T'], { timeout: 3500 }),
      ),
    )
    return
  }
  killCursorForce()
}

/** @deprecated 兼容旧名，内部改为优雅退出 + 必要时强杀 */
function killCursorQuiet() {
  gracefulQuitCursor()
}

const QUIT_PROFILES = {
  switch: {
    maxWaitMs: 10000,
    gracefulMs: 3500,
    gentleMs: 7000,
    closeRetryMs: 900,
    pollMs: 220,
    postKillMs: 150,
    settleMs: 150,
  },
  fast: {
    maxWaitMs: 24000,
    gracefulMs: 14000,
    gentleMs: 18000,
    closeRetryMs: 2200,
    pollMs: 350,
    postKillMs: 500,
    settleMs: 400,
  },
  gentle: {
    maxWaitMs: 50000,
    gracefulMs: 28000,
    gentleMs: 38000,
    closeRetryMs: 4500,
    pollMs: 450,
    postKillMs: 1500,
    settleMs: 800,
  },
}

function resolveQuitProfile(opts = {}) {
  const name = String(opts.profile || process.env.CURSOR_QUIT_PROFILE || 'gentle').toLowerCase()
  const base = QUIT_PROFILES[name] || QUIT_PROFILES.gentle
  return {
    ...base,
    maxWaitMs: opts.maxWaitMs ?? base.maxWaitMs,
    gracefulMs: opts.gracefulMs ?? base.gracefulMs,
    gentleMs: opts.gentleMs ?? base.gentleMs,
    closeRetryMs: opts.closeRetryMs ?? base.closeRetryMs,
    pollMs: opts.pollMs ?? base.pollMs,
    postKillMs: opts.postKillMs ?? base.postKillMs,
    settleMs: opts.settleMs ?? base.settleMs,
  }
}

async function waitForCursorExit(maxWaitMs = 45000, opts = {}) {
  const throwOnTimeout = opts.throwOnTimeout !== false
  const allowForceKill = opts.allowForceKill !== false
  const gracefulMs = Number(opts.gracefulMs ?? process.env.CURSOR_GRACEFUL_MS ?? 28000)
  const gentleMs = Number(opts.gentleMs ?? process.env.CURSOR_GENTLE_MS ?? 38000)
  const closeRetryMs = Number(opts.closeRetryMs ?? 4500)
  const pollMs = Number(opts.pollMs ?? 450)
  const start = Date.now()
  let lastCloseAt = 0
  let gentleTried = false
  let forced = false

  while (Date.now() - start < maxWaitMs) {
    if (!(await isCursorRunningAsync())) {
      await sleep(Number(opts.settleMs || 400))
      if (!(await isCursorRunningAsync())) return true
    }

    const elapsed = Date.now() - start
    if (allowForceKill && !forced && elapsed >= gentleMs) {
      forced = true
      await killCursorForceAsync()
    } else if (!gentleTried && elapsed >= gracefulMs) {
      gentleTried = true
      await terminateCursorTreeGentleAsync()
    } else if (elapsed - lastCloseAt >= closeRetryMs) {
      lastCloseAt = elapsed
      if (elapsed < gracefulMs) {
        await requestCursorQuitViaCliAsync()
      } else {
        await closeCursorMainWindowsAsync()
        if (await isCursorRunningAsync()) {
          await requestCursorQuitViaCliAsync()
        }
      }
    }

    await sleep(pollMs)
  }

  if (throwOnTimeout) {
    throw new Error('等待 Cursor 退出超时，请手动关闭 Cursor 后重试')
  }
  return false
}

async function quitCursorAndWait(opts = {}) {
  const profile = resolveQuitProfile(opts)
  const maxWaitMs = profile.maxWaitMs
  if (!(await isCursorRunningAsync())) {
    await sleep(profile.postKillMs)
    return true
  }
  await gracefulQuitCursorAsync({ includeCliQuit: opts.includeCliQuit !== false })
  const exited = await waitForCursorExit(maxWaitMs, {
    throwOnTimeout: opts.throwOnTimeout !== false,
    allowForceKill: opts.allowForceKill !== false,
    gracefulMs: profile.gracefulMs,
    gentleMs: profile.gentleMs,
    closeRetryMs: profile.closeRetryMs,
    pollMs: profile.pollMs,
    settleMs: profile.settleMs,
  })
  await sleep(profile.postKillMs)
  return exited
}

/** @deprecated 兼容旧名 */
async function killCursorAndWait(opts = {}) {
  return quitCursorAndWait(opts)
}

/** 与切换账号一致：直接强杀 Cursor，不做逐窗口优雅关闭。 */
async function forceQuitCursorForRestart(opts = {}) {
  const maxWaitMs = Number(opts.maxWaitMs || 5000)
  const postKillMs = Number(opts.postKillMs || 250)
  if (!(await isCursorRunningAsync())) {
    await sleep(postKillMs)
    return { ok: true, forced: false }
  }

  killCursorForce()
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    if (!(await isCursorRunningAsync())) {
      await sleep(postKillMs)
      return { ok: true, forced: true }
    }
    await sleep(180)
  }

  killCursorForce()
  await sleep(postKillMs)
  return { ok: !(await isCursorRunningAsync()), forced: true }
}

async function waitForCursorWindowReady(maxWaitMs = 45000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const snapshot = getCursorProcessSnapshot()
    if (snapshot.windowStartTimeMs > 0) {
      await sleep(1200)
      return {
        ok: true,
        waitedMs: Date.now() - start,
        snapshot,
      }
    }
    await sleep(500)
  }
  return {
    ok: false,
    waitedMs: Date.now() - start,
    snapshot: getCursorProcessSnapshot(),
  }
}

function reloadCursorWindow() {
  return reloadRunningCursorWindow()
}

function getCursorProcessSnapshot() {
  if (process.platform !== 'win32') {
    return {
      running: isCursorRunningHeuristic(),
      count: 0,
      newestStartTimeMs: 0,
      oldestStartTimeMs: 0,
      windowStartTimeMs: 0,
      processes: [],
    }
  }

  const script = `
$rows = @(Get-Process Cursor -ErrorAction SilentlyContinue | ForEach-Object {
  $startMs = 0
  try { $startMs = [Int64]([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch { $startMs = 0 }
  [PSCustomObject]@{
    id = $_.Id
    startTimeMs = $startMs
    hasWindow = ($_.MainWindowHandle -ne 0)
    title = [string]$_.MainWindowTitle
  }
})
$rows | ConvertTo-Json -Compress
`

  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10000, encoding: 'utf8', windowsHide: true },
    )
    if (result.error) throw result.error

    const raw = String(result.stdout || '').trim()
    if (!raw) {
      return {
        running: false,
        count: 0,
        newestStartTimeMs: 0,
        oldestStartTimeMs: 0,
        windowStartTimeMs: 0,
        processes: [],
      }
    }

    const parsed = JSON.parse(raw)
    const processes = (Array.isArray(parsed) ? parsed : [parsed])
      .filter(Boolean)
      .map((item) => ({
        id: Number(item.id) || 0,
        startTimeMs: Number(item.startTimeMs) || 0,
        hasWindow: Boolean(item.hasWindow),
        title: String(item.title || ''),
      }))
      .filter((item) => item.id > 0)

    const startTimes = processes.map((item) => item.startTimeMs).filter((item) => item > 0)
    const windowStartTimes = processes
      .filter((item) => item.hasWindow)
      .map((item) => item.startTimeMs)
      .filter((item) => item > 0)

    return {
      running: processes.length > 0,
      count: processes.length,
      newestStartTimeMs: startTimes.length ? Math.max(...startTimes) : 0,
      oldestStartTimeMs: startTimes.length ? Math.min(...startTimes) : 0,
      windowStartTimeMs: windowStartTimes.length ? Math.max(...windowStartTimes) : 0,
      processes,
    }
  } catch {
    return {
      running: isCursorRunningHeuristic(),
      count: 0,
      newestStartTimeMs: 0,
      oldestStartTimeMs: 0,
      windowStartTimeMs: 0,
      processes: [],
    }
  }
}

function launchCursorApp(options = {}) {
  if (isCursorRunningHeuristic()) {
    return { ok: false, message: 'Cursor 仍在退出中，请稍后重试' }
  }

  const extraArgs = []
  const proxyServer = String(options.proxyServer || '').trim()
  if (proxyServer) extraArgs.push(`--proxy-server=${proxyServer}`)
  const proxyBypassList = String(options.proxyBypassList || '').trim()
  if (proxyBypassList) extraArgs.push(`--proxy-bypass-list=${proxyBypassList}`)
  if (proxyServer) {
    extraArgs.push('--disable-quic')
    extraArgs.push('--disable-features=UseDnsHttpsSvcb,UseDnsHttpsSvcbAlpn')
  }

  const spawnEnv = { ...process.env }
  const extraCaCertPath = String(
    options.extraCaCertPath
    || path.join(os.homedir(), '.cursorpool', 'relay', 'ca.crt'),
  ).trim()
  if (proxyServer) {
    spawnEnv.HTTP_PROXY = proxyServer
    spawnEnv.HTTPS_PROXY = proxyServer
    spawnEnv.ALL_PROXY = proxyServer
    spawnEnv.http_proxy = proxyServer
    spawnEnv.https_proxy = proxyServer
    spawnEnv.all_proxy = proxyServer
    spawnEnv.NO_PROXY = 'localhost,127.0.0.1,::1'
    spawnEnv.no_proxy = 'localhost,127.0.0.1,::1'
    if (extraCaCertPath && fs.existsSync(extraCaCertPath)) {
      spawnEnv.NODE_EXTRA_CA_CERTS = extraCaCertPath
      spawnEnv.SSL_CERT_FILE = extraCaCertPath
    }
  }

  const spawnOptions = { detached: true, stdio: 'ignore', env: spawnEnv }

  if (process.platform === 'win32') {
    const exe = resolveCursorExePath()
    if (exe) {
      spawn(exe, extraArgs, spawnOptions).unref()
      return { ok: true, path: exe, args: extraArgs }
    }
    return { ok: false, message: '未找到 Cursor.exe' }
  }
  if (process.platform === 'darwin') {
    const openArgs = ['-a', 'Cursor']
    if (extraArgs.length) openArgs.push('--args', ...extraArgs)
    spawn('open', openArgs, spawnOptions).unref()
    return { ok: true, args: extraArgs }
  }
  spawn('cursor', extraArgs, spawnOptions).unref()
  return { ok: true, args: extraArgs }
}

/** 聚焦 Cursor 主窗口并粘贴发送消息（Windows，需 Agent 输入框已可见） */
function focusCursorAndSendChatMessageLegacy(message) {
  const text = String(message || '').trim()
  if (!text) return { ok: false, message: '消息为空' }
  if (process.platform !== 'win32') {
    return { ok: false, message: '自动发送到 Cursor 当前仅支持 Windows' }
  }
  if (!isCursorRunningHeuristic()) {
    return { ok: false, message: 'Cursor 未运行' }
  }

  const focusAttempts = [
    'glass.newAgentFromKeyboard',
    'composerMode.agent',
    'aichat.newchataction',
    'composer.focusComposer',
    'workbench.action.chat.openAgent',
    'workbench.action.chat.open',
  ]
  for (const commandId of focusAttempts) {
    try {
      runCursorCommand(commandId, 4000)
    } catch {
      /* ignore */
    }
  }

  const b64 = Buffer.from(text, 'utf8').toString('base64')
  const script = `
$msg = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const byte VK_CONTROL = 0x11;
  public const byte VK_I = 0x49;
  public const byte VK_N = 0x4E;
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
$p = Get-Process Cursor -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error 'Cursor 窗口未找到'; exit 2 }
[void][Win32]::ShowWindowAsync($p.MainWindowHandle, 9)
[void][Win32]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 900

function Send-CtrlI() {
  [Win32]::keybd_event([Win32]::VK_CONTROL, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32]::keybd_event([Win32]::VK_I, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32]::keybd_event([Win32]::VK_I, 0, [Win32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32]::keybd_event([Win32]::VK_CONTROL, 0, [Win32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
}

function Send-CtrlN() {
  [Win32]::keybd_event([Win32]::VK_CONTROL, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32]::keybd_event([Win32]::VK_N, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32]::keybd_event([Win32]::VK_N, 0, [Win32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32]::keybd_event([Win32]::VK_CONTROL, 0, [Win32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
}

Send-CtrlN
Start-Sleep -Milliseconds 900
Send-CtrlI
Start-Sleep -Milliseconds 900

function Click-Point([int]$x, [int]$y) {
  [void][Win32]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 80
  [Win32]::mouse_event([Win32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32]::mouse_event([Win32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

$rect = New-Object Win32+RECT
[void][Win32]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)

# 先尽量通过 UI Automation 找到右侧聊天输入，再回退到坐标点击。
$root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$chosen = $null
$chosenRect = $null
$chosenName = ''
$chosenType = ''
$bestScore = -9999
$controlTypes = @(
  [System.Windows.Automation.ControlType]::Edit,
  [System.Windows.Automation.ControlType]::Document,
  [System.Windows.Automation.ControlType]::Pane,
  [System.Windows.Automation.ControlType]::Custom
)

foreach ($controlType in $controlTypes) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    $controlType
  )
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  for ($i = 0; $i -lt $found.Count; $i++) {
    $element = $found.Item($i)
    if (-not $element) { continue }
    $current = $element.Current
    if ($current.IsOffscreen) { continue }
    $box = $current.BoundingRectangle
    if ($box.Width -le 40 -or $box.Height -le 18) { continue }
    $centerX = $box.Left + ($box.Width / 2)
    $centerY = $box.Top + ($box.Height / 2)
    $controlTypeName = [string]$current.ControlType.ProgrammaticName
    $name = [string]$current.Name
    $automationId = [string]$current.AutomationId
    $className = [string]$current.ClassName
    $haystack = "$name $automationId $className"
    $looksNamedLikeChatInput = $haystack -match 'chat|composer|message|prompt|agent|input|aichat|输入|对话|消息'
    $looksLikeCompactEdit = ($controlTypeName -match 'Edit') -and
      ($box.Width -ge 80) -and
      ($box.Width -le ($width * 0.72)) -and
      ($box.Height -ge 24) -and
      ($box.Height -le 220) -and
      ($centerY -ge ($rect.Top + ($height * 0.42)))

    # 大面积 Document/Panes 往往是主编辑器，不应被误判为聊天输入框。
    if (
      ($controlTypeName -match 'Document|Pane|Custom') -and
      $box.Width -ge ($width * 0.58) -and
      $box.Height -ge ($height * 0.42)
    ) {
      continue
    }
    if (-not $looksNamedLikeChatInput -and -not $looksLikeCompactEdit) {
      continue
    }

    $score = 0
    if ($centerX -ge ($rect.Left + ($width * 0.62))) { $score += 8 }
    if ($centerX -ge ($rect.Left + ($width * 0.78))) { $score += 7 }
    if ($centerY -ge ($rect.Top + ($height * 0.58))) { $score += 5 }
    if ($centerY -ge ($rect.Top + ($height * 0.76))) { $score += 8 }
    if ($current.IsKeyboardFocusable) { $score += 2 }
    if ($name -match 'chat|composer|message|prompt|agent|input|输入|对话|消息') { $score += 8 }
    if ($name -match 'index\.html|Cursor$') { $score -= 18 }
    if ($box.Width -le ($width * 0.40)) { $score += 3 }
    if ($box.Height -ge 24 -and $box.Height -le 220) { $score += 2 }
    if ($score -gt $bestScore) {
      $bestScore = $score
      $chosen = $element
      $chosenRect = $box
      $chosenName = $name
      $chosenType = $controlTypeName
    }
  }
}

if ($chosen) {
  try { $chosen.SetFocus() } catch { }
  Start-Sleep -Milliseconds 120
  if ($chosenRect) {
    $focusX = [int][Math]::Floor($chosenRect.Left + ($chosenRect.Width / 2))
    $focusY = [int][Math]::Floor($chosenRect.Top + [Math]::Min($chosenRect.Height / 2, 18))
    Click-Point $focusX $focusY
    Start-Sleep -Milliseconds 160
  }
} else {
  Write-Error 'Cursor Agent/Composer input was not found after focus commands; refusing to paste into an unknown editor pane.'
  exit 3
}

[System.Windows.Forms.Clipboard]::SetText($msg)
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 60
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 180
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output ("target=" + ($(if ($chosenName) { $chosenName } else { 'fallback-click' })) + " type=" + ($(if ($chosenType) { $chosenType } else { 'none' })) + " score=" + $bestScore)
exit 0
`

  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000, encoding: 'utf8', windowsHide: true },
    )
    if (result.status === 0) {
      const detail = String(result.stdout || '').trim()
      return { ok: true, message: detail ? `已发送到 Cursor (${detail})` : '已发送到 Cursor' }
    }
    const err = String(result.stderr || result.stdout || '').trim()
    return { ok: false, message: err || `PowerShell 退出码 ${result.status}` }
  } catch (error) {
    return { ok: false, message: error.message || String(error) }
  }
}

/** Focus the real standalone Cursor Agents window and submit a prompt through its UI. */
function focusCursorAndSendChatMessage(message) {
  const text = String(message || '').trim()
  if (!text) return { ok: false, message: '消息为空' }
  if (process.platform !== 'win32') {
    return { ok: false, message: '自动发送到 Cursor 当前仅支持 Windows' }
  }
  if (!isCursorRunningHeuristic()) {
    return { ok: false, message: 'Cursor 未运行' }
  }

  const b64 = Buffer.from(text, 'utf8').toString('base64')
  let workspaceName = ''
  try {
    const storagePath = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'storage.json')
    const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8').replace(/^\uFEFF/, ''))
    const folderUri = String(storage?.backupWorkspaces?.folders?.[0]?.folderUri || '')
    const decoded = decodeURIComponent(folderUri.replace(/^file:\/\//i, '')).replace(/^\/([a-zA-Z]:)/, '$1')
    workspaceName = path.basename(decoded)
  } catch {
    workspaceName = ''
  }
  const workspaceNameB64 = Buffer.from(workspaceName, 'utf8').toString('base64')
  const script = `
$msg = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$workspaceName = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${workspaceNameB64}'))
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CursorAgentUi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const byte VK_MENU = 0x12;
  public const byte VK_F = 0x46;
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient

function Get-AgentWindow() {
  Get-Process Cursor -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Cursor Agents' } |
    Select-Object -First 1
}

function Get-AnyCursorWindow() {
  Get-Process Cursor -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object { if ($_.MainWindowTitle -match 'Cursor Agents') { 0 } else { 1 } }, StartTime |
    Select-Object -First 1
}

function Click-Point([int]$x, [int]$y) {
  [void][CursorAgentUi]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 80
  [CursorAgentUi]::mouse_event([CursorAgentUi]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [CursorAgentUi]::mouse_event([CursorAgentUi]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-AltF() {
  [CursorAgentUi]::keybd_event([CursorAgentUi]::VK_MENU, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [CursorAgentUi]::keybd_event([CursorAgentUi]::VK_F, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [CursorAgentUi]::keybd_event([CursorAgentUi]::VK_F, 0, [CursorAgentUi]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [CursorAgentUi]::keybd_event([CursorAgentUi]::VK_MENU, 0, [CursorAgentUi]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
}

function Get-ForegroundTitle() {
  $h = [CursorAgentUi]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][CursorAgentUi]::GetWindowText($h, $sb, $sb.Capacity)
  $sb.ToString()
}

function Focus-AgentWindow($agentProcess) {
  [void][CursorAgentUi]::ShowWindowAsync($agentProcess.MainWindowHandle, 9)
  Start-Sleep -Milliseconds 180
  [void][CursorAgentUi]::SetForegroundWindow($agentProcess.MainWindowHandle)
  Start-Sleep -Milliseconds 450
  if ((Get-ForegroundTitle) -match 'Cursor Agents') { return $true }

  $front = [CursorAgentUi]::GetForegroundWindow()
  if ($front -ne [IntPtr]::Zero -and $front -ne $agentProcess.MainWindowHandle) {
    [void][CursorAgentUi]::ShowWindowAsync($front, 6)
    Start-Sleep -Milliseconds 220
  }
  [void][CursorAgentUi]::ShowWindowAsync($agentProcess.MainWindowHandle, 9)
  Start-Sleep -Milliseconds 120
  [void][CursorAgentUi]::SetForegroundWindow($agentProcess.MainWindowHandle)
  Start-Sleep -Milliseconds 550
  (Get-ForegroundTitle) -match 'Cursor Agents'
}

function Click-WorkspaceNewAgent($workspaceName) {
  if (-not $workspaceName) { return $false }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $groupRect = $null
  $newAgentRects = @()
  for ($i = 0; $i -lt $found.Count; $i++) {
    $element = $found.Item($i)
    if (-not $element) { continue }
    $current = $element.Current
    if ($current.IsOffscreen) { continue }
    $box = $current.BoundingRectangle
    $name = [string]$current.Name
    $className = [string]$current.ClassName
    if ($name -match [regex]::Escape($workspaceName) -and $name -match 'New Agent') {
      $groupRect = $box
    }
    if ($name -eq 'New Agent' -and $className -match 'new-agent') {
      $newAgentRects += $box
    }
  }
  if (-not $groupRect) { return $false }
  $best = $null
  $bestDistance = 999999
  foreach ($box in $newAgentRects) {
    $distance = [Math]::Abs(($box.Top + ($box.Height / 2)) - ($groupRect.Top + ($groupRect.Height / 2)))
    if ($distance -lt $bestDistance) {
      $bestDistance = $distance
      $best = $box
    }
  }
  if (-not $best -or $bestDistance -gt 80) { return $false }
  Click-Point ([int][Math]::Floor($best.Left + ($best.Width / 2))) ([int][Math]::Floor($best.Top + ($best.Height / 2)))
  Start-Sleep -Milliseconds 800
  return $true
}

$p = Get-AgentWindow
if (-not $p) {
  $editor = Get-AnyCursorWindow
  if (-not $editor) { Write-Error 'Cursor window was not found'; exit 2 }
  [void][CursorAgentUi]::ShowWindowAsync($editor.MainWindowHandle, 9)
  [void][CursorAgentUi]::SetForegroundWindow($editor.MainWindowHandle)
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 120
  Send-AltF
  Start-Sleep -Milliseconds 260
  [System.Windows.Forms.SendKeys]::SendWait('{DOWN}{DOWN}{ENTER}')

  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 350
    $p = Get-AgentWindow
    if ($p) { break }
  }
}

if (-not $p) { Write-Error 'Cursor Agents window was not opened'; exit 3 }
if (-not (Focus-AgentWindow $p)) {
  Write-Error ("Cursor Agents window could not become foreground; foreground=" + (Get-ForegroundTitle))
  exit 4
}
Start-Sleep -Milliseconds 350
[void](Click-WorkspaceNewAgent $workspaceName)

$rect = New-Object CursorAgentUi+RECT
[void][CursorAgentUi]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
$promptRect = $null
$promptName = ''
$deadline = (Get-Date).AddSeconds(12)

while ((Get-Date) -lt $deadline -and -not $promptRect) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text
  )
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  for ($i = 0; $i -lt $found.Count; $i++) {
    $element = $found.Item($i)
    if (-not $element) { continue }
    $current = $element.Current
    if ($current.IsOffscreen) { continue }
    $box = $current.BoundingRectangle
    $name = [string]$current.Name
    if ($name -match 'Plan, Build|commands|context|输入|消息|提问') {
      $promptRect = $box
      $promptName = $name
      break
    }
  }
  if (-not $promptRect) { Start-Sleep -Milliseconds 350 }
}

$target = ''
if ($promptRect) {
  $focusX = [int][Math]::Floor($promptRect.Left + [Math]::Min(36, [Math]::Max(8, $promptRect.Width / 4)))
  $focusY = [int][Math]::Floor($promptRect.Top + ($promptRect.Height / 2))
  Click-Point $focusX $focusY
  $target = "placeholder=$promptName"
} else {
  $focusX = [int][Math]::Floor($rect.Left + ($width * 0.62))
  $focusY = [int][Math]::Floor($rect.Top + ($height * 0.83))
  Click-Point $focusX $focusY
  $target = 'fallback=agent-window-bottom-prompt'
}

Start-Sleep -Milliseconds 180
[System.Windows.Forms.Clipboard]::SetText($msg)
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 60
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 180
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output ("target=Cursor Agents " + $target)
exit 0
`

  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 25000, encoding: 'utf8', windowsHide: true },
    )
    if (result.status === 0) {
      const detail = String(result.stdout || '').trim()
      return { ok: true, message: detail ? `已发送到 Cursor (${detail})` : '已发送到 Cursor' }
    }
    const err = String(result.stderr || result.stdout || '').trim()
    return { ok: false, message: err || `PowerShell 退出码 ${result.status}` }
  } catch (error) {
    return { ok: false, message: error.message || String(error) }
  }
}

module.exports = {
  isCursorRunningHeuristic,
  getCursorProcessSnapshot,
  resolveCursorExePath,
  startNewCursorAgentConversation,
  closeCursorMainWindows,
  requestCursorQuitViaCli,
  gracefulQuitCursor,
  terminateCursorTreeGentle,
  killCursorForce,
  killCursorQuiet,
  waitForCursorExit,
  waitForCursorWindowReady,
  quitCursorAndWait,
  killCursorAndWait,
  forceQuitCursorForRestart,
  reloadRunningCursorWindow,
  reloadCursorWindow,
  launchCursorApp,
  focusCursorAndSendChatMessage,
}

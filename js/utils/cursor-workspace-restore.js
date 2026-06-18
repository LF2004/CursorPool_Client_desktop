/**
 * 切换前快照 / 切换后恢复 Cursor 多窗口。
 * 优先读取 storage.json 的 windowsState.openedWindows，并结合 workspaceStorage 最近活跃时间排序。
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { getStorageJsonPath, getCursorAppDataDir } = require('./cursor-local-state')
const { getCursorProcessSnapshot, isCursorRunningHeuristic, resolveCursorExePath } = require('./cursor-process')

function decodeFolderUri(folderUri) {
  const raw = String(folderUri || '').trim()
  if (!raw) return null
  if (!/^file:/i.test(raw)) return raw
  let decoded = decodeURIComponent(raw.replace(/^file:\/\//i, ''))
  if (/^\/[a-zA-Z]:/.test(decoded)) decoded = decoded.slice(1)
  return decoded.replace(/\//g, path.sep) || null
}

function encodeFolderUri(folderPath) {
  const normalized = path.resolve(String(folderPath || ''))
  const posix = normalized.replace(/\\/g, '/')
  return `file:///${encodeURIComponent(posix).replace(/%2F/g, '/')}`
}

function normalizeFolderUri(folderUri = '') {
  const decoded = decodeFolderUri(folderUri)
  return decoded ? encodeFolderUri(decoded) : String(folderUri || '').trim()
}

function extractBackupFolderId(backupPath = '') {
  const base = path.basename(String(backupPath || '').trim())
  return base || ''
}

function getWorkspaceStorageRoot() {
  return path.join(getCursorAppDataDir(), 'User', 'workspaceStorage')
}

function readWorkspaceStorageRecency() {
  const root = getWorkspaceStorageRoot()
  const recency = new Map()
  if (!fs.existsSync(root)) return recency

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const workspaceJsonPath = path.join(root, entry.name, 'workspace.json')
    if (!fs.existsSync(workspaceJsonPath)) continue
    try {
      const workspace = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8').replace(/^\uFEFF/, ''))
      const folderUri = normalizeFolderUri(workspace?.folder || '')
      if (!folderUri) continue
      const mtimeMs = Math.max(
        fs.statSync(workspaceJsonPath).mtimeMs,
        fs.statSync(path.join(root, entry.name)).mtimeMs,
      )
      const prev = recency.get(folderUri) || 0
      if (mtimeMs > prev) recency.set(folderUri, mtimeMs)
    } catch {
      /* ignore broken workspace entries */
    }
  }
  return recency
}

function sortFolderEntries(entries = [], options = {}) {
  const recency = options.recency instanceof Map ? options.recency : readWorkspaceStorageRecency()
  const lastActiveUri = options.lastActiveUri ? normalizeFolderUri(options.lastActiveUri) : ''
  return [...entries].sort((a, b) => {
    const aUri = normalizeFolderUri(a?.folderUri || a?.folder || '')
    const bUri = normalizeFolderUri(b?.folderUri || b?.folder || '')
    if (lastActiveUri) {
      if (aUri === lastActiveUri && bUri !== lastActiveUri) return -1
      if (bUri === lastActiveUri && aUri !== lastActiveUri) return 1
    }
    const aTime = recency.get(aUri) || 0
    const bTime = recency.get(bUri) || 0
    if (aTime !== bTime) return bTime - aTime
    return aUri.localeCompare(bUri)
  })
}

function buildFolderEntryFromWindow(windowState = {}) {
  const folderUri = normalizeFolderUri(windowState?.folder || windowState?.folderUri || '')
  if (!folderUri) return null
  const backupFolder = extractBackupFolderId(windowState?.backupPath || windowState?.backupFolder || '')
  return backupFolder ? { folderUri, backupFolder } : { folderUri }
}

function readWindowsStatePlan(storage = {}) {
  const windowsState = storage?.windowsState
  if (!windowsState || typeof windowsState !== 'object') return null

  const openedWindows = Array.isArray(windowsState.openedWindows)
    ? windowsState.openedWindows.filter(Boolean)
    : []
  const lastActiveUri = normalizeFolderUri(windowsState?.lastActiveWindow?.folder || '')

  if (openedWindows.length) {
    const folders = sortFolderEntries(
      openedWindows.map(buildFolderEntryFromWindow).filter(Boolean),
      { lastActiveUri },
    )
    return {
      folders,
      workspaces: [],
      emptyWindows: [],
      source: 'windowsState',
      lastActiveFolderUri: lastActiveUri || folders[0]?.folderUri || '',
    }
  }

  if (windowsState.lastActiveWindow?.folder) {
    const folder = buildFolderEntryFromWindow(windowsState.lastActiveWindow)
    if (folder) {
      return {
        folders: [folder],
        workspaces: [],
        emptyWindows: [],
        source: 'windowsState.lastActive',
        lastActiveFolderUri: folder.folderUri,
      }
    }
  }

  return null
}

function readStorageJson() {
  const storagePath = getStorageJsonPath()
  if (!storagePath || !fs.existsSync(storagePath)) return { storage: {}, storagePath }
  try {
    const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8').replace(/^\uFEFF/, ''))
    return { storage, storagePath }
  } catch {
    return { storage: {}, storagePath }
  }
}

function readWorkspaceRestorePlan() {
  const { storage } = readStorageJson()
  const windowsPlan = readWindowsStatePlan(storage)
  if (windowsPlan && windowsPlan.folders.length) return windowsPlan

  const bw = storage?.backupWorkspaces && typeof storage.backupWorkspaces === 'object'
    ? storage.backupWorkspaces
    : {}
  const recency = readWorkspaceStorageRecency()
  const folders = sortFolderEntries(
    (Array.isArray(bw.folders) ? bw.folders.filter(Boolean) : []),
    { recency },
  )
  return {
    folders,
    workspaces: Array.isArray(bw.workspaces) ? bw.workspaces.filter(Boolean) : [],
    emptyWindows: Array.isArray(bw.emptyWindows) ? bw.emptyWindows.filter(Boolean) : [],
    source: folders.length ? 'backupWorkspaces' : 'missing',
    lastActiveFolderUri: folders[0]?.folderUri || '',
  }
}

function countOpenCursorWindows() {
  const snap = getCursorProcessSnapshot()
  const withWindow = (snap.processes || []).filter((item) => item.hasWindow)
  return withWindow.length || 0
}

function planWindowTotal(plan) {
  return (plan?.folders?.length || 0) + (plan?.workspaces?.length || 0) + (plan?.emptyWindows?.length || 0)
}

function dedupeFolderEntries(entries = []) {
  const seen = new Set()
  const next = []
  for (const item of entries) {
    const folderUri = normalizeFolderUri(item?.folderUri || item?.folder || '')
    if (!folderUri || seen.has(folderUri)) continue
    seen.add(folderUri)
    next.push({
      folderUri,
      ...(item?.backupFolder ? { backupFolder: String(item.backupFolder) } : {}),
    })
  }
  return next
}

function mergeWorkspaceRestorePlan(prePlan, postPlan, openWindowCount) {
  const pre = prePlan || { folders: [], workspaces: [], emptyWindows: [] }
  const post = postPlan || { folders: [], workspaces: [], emptyWindows: [] }
  const preTotal = planWindowTotal(pre)
  const postTotal = planWindowTotal(post)
  const target = Math.max(openWindowCount || 0, preTotal, postTotal, 1)

  let base = postTotal >= preTotal ? post : pre
  if (postTotal >= openWindowCount && postTotal > 0) base = post
  else if (preTotal >= openWindowCount && preTotal > 0) base = pre
  else if (postTotal > 0) base = post
  else base = pre

  const recency = readWorkspaceStorageRecency()
  const lastActiveUri = post?.lastActiveFolderUri || pre?.lastActiveFolderUri || ''
  const folders = sortFolderEntries(
    dedupeFolderEntries([
      ...(Array.isArray(base.folders) ? base.folders : []),
      ...(Array.isArray(pre.folders) ? pre.folders : []),
      ...(Array.isArray(post.folders) ? post.folders : []),
    ]),
    { recency, lastActiveUri },
  )
  const workspaces = Array.isArray(base.workspaces) ? [...base.workspaces] : []
  let emptyWindows = Array.isArray(base.emptyWindows) ? [...base.emptyWindows] : []

  // 空窗口通常不是用户真正想恢复的工作区，优先恢复有 folder 的窗口
  if (folders.length >= target) {
    emptyWindows = []
  } else {
    while (folders.length + workspaces.length + emptyWindows.length < target) {
      emptyWindows.push({ backupFolder: '' })
    }
  }

  return {
    folders,
    workspaces,
    emptyWindows,
    openWindowCount: Math.max(openWindowCount || 0, folders.length + workspaces.length + emptyWindows.length, 1),
    lastActiveFolderUri: lastActiveUri || folders[0]?.folderUri || '',
    source: base?.source || pre?.source || post?.source || 'merged',
  }
}

function writeWorkspaceRestorePlan(plan) {
  const { storage, storagePath } = readStorageJson()
  if (!storagePath) return { ok: false, path: storagePath }

  let nextStorage = storage
  if (typeof nextStorage !== 'object' || nextStorage === null || Array.isArray(nextStorage)) nextStorage = {}

  nextStorage.backupWorkspaces = {
    folders: plan.folders || [],
    workspaces: plan.workspaces || [],
    emptyWindows: plan.emptyWindows || [],
  }

  if (Array.isArray(plan.folders) && plan.folders.length) {
    const openedWindows = (plan.folders || []).map((item) => {
      const folderUri = normalizeFolderUri(item?.folderUri || '')
      const backupPath = item?.backupFolder
        ? path.join(getCursorAppDataDir(), 'Backups', String(item.backupFolder))
        : undefined
      return backupPath ? { folder: folderUri, backupPath } : { folder: folderUri }
    })
    const lastActiveFolderUri = normalizeFolderUri(plan.lastActiveFolderUri || plan.folders[0]?.folderUri || '')
    const lastActiveWindow = openedWindows.find((item) => normalizeFolderUri(item.folder) === lastActiveFolderUri)
      || openedWindows[0]
      || null
    nextStorage.windowsState = {
      ...(nextStorage.windowsState && typeof nextStorage.windowsState === 'object' ? nextStorage.windowsState : {}),
      openedWindows,
      ...(lastActiveWindow ? { lastActiveWindow } : {}),
    }
  }

  fs.writeFileSync(storagePath, `${JSON.stringify(nextStorage, null, 2)}\n`, 'utf8')
  return { ok: true, path: storagePath, total: planWindowTotal(plan) }
}

function captureWorkspaceRestoreSnapshot() {
  const plan = readWorkspaceRestorePlan()
  const openWindowCount = Math.max(countOpenCursorWindows(), planWindowTotal(plan))
  return {
    plan: {
      ...plan,
      openWindowCount,
    },
    openWindowCount,
    capturedAt: Date.now(),
  }
}

function finalizeWorkspaceRestorePlan(snapshot) {
  const postPlan = readWorkspaceRestorePlan()
  const openWindowCount = Math.max(snapshot?.openWindowCount || 0, countOpenCursorWindows())
  return mergeWorkspaceRestorePlan(snapshot?.plan, postPlan, openWindowCount)
}

function launchCursorWithWorkspaceRestore(plan, options = {}) {
  const { launchCursorApp } = require('./cursor-process')
  const exe = resolveCursorExePath()
  if (!exe) return { ok: false, message: '未找到 Cursor.exe' }
  if (isCursorRunningHeuristic()) {
    return { ok: false, message: 'Cursor 仍在退出中，请稍后重试' }
  }

  const folderPaths = (plan?.folders || [])
    .map((item) => decodeFolderUri(item?.folderUri))
    .filter(Boolean)
  const extraEmpty = Math.max(0, plan?.emptyWindows?.length || 0)
  const workspaceCount = plan?.workspaces?.length || 0
  const plannedTotal = planWindowTotal(plan)
  const expectedWindows = Math.max(plan?.openWindowCount || 0, plannedTotal, folderPaths.length + workspaceCount + extraEmpty, 1)

  writeWorkspaceRestorePlan(plan)

  const spawnOptions = {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  }
  const gapMs = Number(options.windowGapMs || 700)

  // 多窗口时显式逐个拉起更可靠；最近活跃的工作区作为首个窗口
  if (folderPaths.length >= 2 || expectedWindows >= 2) {
    const firstFolder = folderPaths[0]
    const firstArgs = firstFolder ? [firstFolder] : []
    spawn(exe, firstArgs, spawnOptions).unref()

    let delayStep = 1
    const spawnLater = (args) => {
      setTimeout(() => {
        try {
          spawn(exe, args, spawnOptions).unref()
        } catch {
          /* ignore */
        }
      }, gapMs * delayStep)
      delayStep += 1
    }

    for (const folderPath of folderPaths.slice(1)) {
      spawnLater(['--new-window', folderPath])
    }
    for (let i = 0; i < extraEmpty; i += 1) {
      spawnLater(['--new-window'])
    }
    const remaining = Math.max(0, expectedWindows - Math.max(folderPaths.length + workspaceCount + extraEmpty, 1))
    for (let i = 0; i < remaining; i += 1) {
      spawnLater(['--new-window'])
    }

    return {
      ok: true,
      path: exe,
      expectedWindows,
      folderPaths,
      extraEmpty,
      mode: 'explicit_windows',
    }
  }

  return { ...launchCursorApp(options), expectedWindows, mode: 'single_launch' }
}

module.exports = {
  decodeFolderUri,
  encodeFolderUri,
  readWorkspaceRestorePlan,
  countOpenCursorWindows,
  mergeWorkspaceRestorePlan,
  writeWorkspaceRestorePlan,
  captureWorkspaceRestoreSnapshot,
  finalizeWorkspaceRestorePlan,
  launchCursorWithWorkspaceRestore,
  planWindowTotal,
}

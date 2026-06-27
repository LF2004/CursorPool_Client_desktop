const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fssync = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { applyCursorAuth } = require('./update_cursor_auth');
const { buildLocalCursorSnapshot } = require('./js/utils/cursor-local-state');
const { isCursorRunningHeuristic } = require('./js/utils/cursor-process');
const {
  runResetMachineId,
  killCursorAndWait,
  launchCursorApp,
} = require('./js/utils/reset-machine-id');
const { runFullAccountSwitch, stopCursorForSwitch } = require('./js/utils/cursor-switch');
const {
  readModelProxyConfig,
  writeModelProxyConfig,
  disableModelProxy,
  testModelProxyConnection,
  PROVIDER_PRESETS,
} = require('./js/utils/cursor-model-proxy');
const {
  readCursorRelayProxyConfig,
  applyCursorRelayProxyConfig,
  ensureCursorRelayRunner,
  quickSwitchRelayModel,
  disableCursorRelayProxyConfig,
  stopLocalRelayRunner,
  installRelayCaCertificateFull,
  checkRelayCertificates,
  repairRelayCertificatesFull,
  getRunnerLogPaths,
  readRunnerLogTail,
  buildRelayDiagnostics,
  disableByokForRelay,
  runRelayAgentDialogTest,
  startRelayPlanUiMock,
} = require('./js/utils/cursor-relay-proxy');
const { clearRunnerLogs, initRunnerLogs } = require('./js/utils/cursor-relay-log');
const {
  listRelayUsage,
  clearRelayUsage,
  closeUsageDbs,
} = require('./js/utils/cursor-relay-usage-store');
const {
  loadRelayProfileStore,
  saveRelayProfileStore,
  closeProfileDbs,
} = require('./js/utils/cursor-relay-profile-store');
const {
  createTray,
  updateSession,
  refreshQuota,
  refreshTrayMenu,
  setCloseMode,
  attachWindowCloseHandler,
  showMainWindow,
  setMainWindow,
  destroyTray,
  setQuitting,
  hasTray,
  isQuitting,
} = require('./js/utils/tray');
const { fetchCursorDashboardSnapshot } = require('./js/utils/cursor-dashboard');
const {
  readCursorAutoUpdateStatus,
  disableCursorAutoUpdate,
  restoreCursorAutoUpdate,
} = require('./js/utils/cursor-auto-update');

// GPU-related crashes/hangs can happen on some machines when using CSS filters.
// Disable hardware acceleration as a safe default for this app.
app.disableHardwareAcceleration();
try {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
} catch {
  /* ignore */
}

function logMainError(label, error) {
  const detail = error && error.stack ? error.stack : String(error || 'unknown error');
  console.error(`[main] ${label}:`, detail);
}


function runReviewBridgeWorker(action, cursorExePath = '') {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'scripts', 'review-bridge-worker.cjs');
    execFile(
      process.execPath,
      [workerPath, String(action || '').trim(), String(cursorExePath || '').trim()],
      {
        cwd: __dirname,
        windowsHide: true,
        timeout: 180000,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || stdout || error.message || error)));
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || '').trim() || '{}');
          if (!parsed || parsed.ok !== true) {
            reject(new Error(String(stderr || '实验注入任务执行失败')));
            return;
          }
          resolve(parsed.result || null);
        } catch (parseError) {
          reject(new Error(`实验注入结果解析失败：${parseError.message || parseError}\n${String(stdout || stderr || '').trim()}`));
        }
      },
    );
  });
}

function readBuildSettings() {
  try {
    const p = path.join(__dirname, 'build-settings.json');
    if (!fssync.existsSync(p)) return {};
    return JSON.parse(fssync.readFileSync(p, 'utf8')) || {};
  } catch {
    return {};
  }
}

function readDotEnvObject() {
  const out = {};
  try {
    const byFile = String(process.env.CURSORPOOL_ENV_FILE || '').trim();
    const byName = String(process.env.CURSORPOOL_ENV || '').trim();
    const p = byFile
      ? path.isAbsolute(byFile) ? byFile : path.join(__dirname, byFile)
      : byName
        ? path.join(__dirname, `.env.${byName}`)
        : path.join(__dirname, '.env');
    if (!fssync.existsSync(p)) return out;
    const raw = fssync.readFileSync(p, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const t = String(line || '').trim();
      if (!t || t.startsWith('#')) return;
      const i = t.indexOf('=');
      if (i <= 0) return;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (k) out[k] = v;
    });
  } catch {
    /* ignore */
  }
  return out;
}

function attachWindowDebugging(win) {
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details);
  });

  win.webContents.on('unresponsive', () => {
    console.error('[renderer] window unresponsive');
  });

  win.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    console.error('[renderer] did-fail-load:', { code, desc, url, isMainFrame });
  });

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[renderer] preload-error:', preloadPath, error);
  });

  win.webContents.on('dom-ready', () => {
    console.log('[renderer] dom-ready');
  });

  win.webContents.on('did-finish-load', () => {
    console.log('[renderer] did-finish-load');
  });
}

let mainWindow = null;

function createWindow() {
  const iconIco = path.join(__dirname, 'assets', 'icon.ico');
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const iconPath = fssync.existsSync(iconIco) ? iconIco : iconPng;
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    autoHideMenuBar: true,
    frame: false,
    show: false,
    ...(process.platform === 'win32' && fssync.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  attachWindowCloseHandler(win);
  attachWindowDebugging(win);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.loadFile(path.join(__dirname, 'index.html')).catch((error) => logMainError('loadFile failed', error));
  mainWindow = win;
  setMainWindow(win);
  return win;
}

function ensureMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return createWindow();
}

process.on('uncaughtException', (error) => {
  logMainError('uncaughtException', error);
});

process.on('unhandledRejection', (error) => {
  logMainError('unhandledRejection', error);
});

app.whenReady().then(() => {
  try {
    clearRunnerLogs();
  } catch (error) {
    logMainError('clearRunnerLogs', error);
  }
  try {
    // Windows taskbar grouping + notifications
    if (process.platform === 'win32') app.setAppUserModelId(app.name);
  } catch {
    /* ignore */
  }
  const win = createWindow();
  try {
    createTray({
      mainWindow: win,
      appName: __settings.productName || app.getName(),
      ensureMainWindow,
    });
  } catch (error) {
    logMainError('createTray', error);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (hasTray() && !isQuitting()) return;
  app.quit();
});

app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('[app] render-process-gone:', details);
});

app.on('child-process-gone', (_event, details) => {
  console.error('[app] child-process-gone:', details);
});

ipcMain.handle('theme:toggle', (_event, nextTheme) => {
  nativeTheme.themeSource = nextTheme === 'dark' ? 'dark' : 'light';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

ipcMain.handle('cursor:applyAuth', async (_event, payload) => {
  await applyCursorAuth({
    email: payload.email,
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
  });
  return { ok: true };
});

ipcMain.handle('cursor:getLocalState', (_event, options = {}) => buildLocalCursorSnapshot(options));
ipcMain.handle('cursor:getDashboardUsage', async () => fetchCursorDashboardSnapshot());
ipcMain.handle('cursor:isRunning', () => ({ running: isCursorRunningHeuristic() }));
ipcMain.handle('cursor:killProcess', async () => {
  await killCursorAndWait({ throwOnTimeout: false });
  return { ok: true };
});

ipcMain.handle('cursor:resetMachineId', async (event) => {
  const sendStep = (step) => {
    try {
      event.sender.send('cursor:resetMachineProgress', { step });
    } catch {
      /* ignore */
    }
  };
  sendStep('closing');
  const exited = await stopCursorForSwitch();
  if (!exited) {
    throw new Error('无法关闭 Cursor。请先手动完全退出 Cursor 后重试。');
  }
  const resetResult = await runResetMachineId({
    noKill: true,
    quiet: true,
    seamless: false,
    onStep: sendStep,
  });
  sendStep('launch');
  const launch = launchCursorApp();
  if (!launch?.ok) {
    throw new Error(launch?.message || 'Cursor 启动失败，请稍后手动打开 Cursor');
  }
  return { ok: true, launch, exited, seamless: false, newIds: resetResult.newIds };
});

ipcMain.handle('proxyModel:getConfig', async () => {
  const r = await readModelProxyConfig();
  return { ...r, presets: PROVIDER_PRESETS };
});

ipcMain.handle('proxyModel:apply', async (_event, payload = {}) => {
  return writeModelProxyConfig(payload);
});

ipcMain.handle('proxyModel:disable', async () => disableModelProxy());

ipcMain.handle('proxyModel:test', async (_event, payload = {}) => testModelProxyConnection(payload));

ipcMain.handle('cursorRelay:getConfig', async (_event, options = {}) => readCursorRelayProxyConfig(options));
ipcMain.handle('cursorRelay:apply', async (_event, payload = {}) => applyCursorRelayProxyConfig(payload));
ipcMain.handle('cursorRelay:ensureRunner', async (_event, payload = {}) => ensureCursorRelayRunner(payload));
ipcMain.handle('cursorRelay:quickSwitchModel', async (_event, payload = {}) => quickSwitchRelayModel(payload));
ipcMain.handle('cursorRelay:disable', async (_event, payload = {}) => disableCursorRelayProxyConfig(payload));
ipcMain.handle('cursorRelay:reviewBridgeStatus', async (_event, payload = {}) => (
  runReviewBridgeWorker('status', payload?.cursorExePath || '')
));
ipcMain.handle('cursorRelay:reviewBridgeApply', async (_event, payload = {}) => (
  runReviewBridgeWorker('apply', payload?.cursorExePath || '')
));
ipcMain.handle('cursorRelay:reviewBridgeRestore', async (_event, payload = {}) => (
  runReviewBridgeWorker('restore', payload?.cursorExePath || '')
));
ipcMain.handle('cursorRelay:installCert', async (_event, payload = {}) => installRelayCaCertificateFull(payload));
ipcMain.handle('cursorRelay:checkCert', async () => checkRelayCertificates());
ipcMain.handle('cursorRelay:repairCert', async (_event, payload = {}) => repairRelayCertificatesFull(payload));

ipcMain.handle('cursorRelay:readLog', async () => readRunnerLogTail());

ipcMain.handle('cursorRelay:diagnose', async () => buildRelayDiagnostics());

ipcMain.handle('cursorRelay:testAgent', async (_event, payload = {}) => runRelayAgentDialogTest(payload));
ipcMain.handle('cursorRelay:startPlanUiMock', async (_event, payload = {}) => startRelayPlanUiMock(payload));

async function openRelayTextFile(target, missingMessage) {
  if (!fssync.existsSync(target)) {
    throw new Error(missingMessage);
  }
  if (process.platform === 'win32') {
    spawn('notepad.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, logPath: target, openedWith: 'notepad' };
  }
  const openError = await shell.openPath(target);
  if (openError) throw new Error(openError);
  return { ok: true, logPath: target, openedWith: 'shell' };
}

ipcMain.handle('cursorRelay:openLog', async () => {
  const paths = initRunnerLogs();
  const target = paths.all.find((logPath) => {
    try {
      return fssync.existsSync(logPath);
    } catch {
      return false;
    }
  }) || paths.displayPath;
  return openRelayTextFile(target, '日志文件尚未生成。请先启用 Relay。');
});

ipcMain.handle('cursorRelay:openDiagnose', async () => {
  const paths = initRunnerLogs();
  const dir = paths.mirror
    ? path.dirname(paths.mirror)
    : path.dirname(paths.primary);
  const target = path.join(dir, 'diagnose.txt');
  return openRelayTextFile(target, '诊断文件尚未生成。请先点「一键诊断」。');
});

ipcMain.handle('cursorRelay:disableByok', async (_event, payload = {}) => disableByokForRelay(payload));

ipcMain.handle('cursorRelay:openLogDir', async () => {
  const paths = initRunnerLogs();
  const dir = paths.mirror
    ? path.dirname(paths.mirror)
    : path.dirname(paths.primary);
  fssync.mkdirSync(dir, { recursive: true });
  const openError = await shell.openPath(dir);
  if (openError) throw new Error(openError);
  return { ok: true, dir, displayPath: paths.displayPath };
});

ipcMain.handle('cursorRelayUsage:list', async (_event, payload = {}) => {
  return listRelayUsage('', payload);
});
ipcMain.handle('cursorRelayUsage:clear', async () => clearRelayUsage(''));
ipcMain.handle('cursorRelayProfiles:load', async () => loadRelayProfileStore(''));
ipcMain.handle('cursorRelayProfiles:save', async (_event, payload = {}) => saveRelayProfileStore(payload, ''));

let relayQuitCleanupStarted = false;
let relayQuitCleanupDone = false;

async function cleanupRelayBeforeQuit() {
  if (relayQuitCleanupDone) return;
  try {
    await disableCursorRelayProxyConfig({
      restartCursor: false,
      reloadCursor: false,
      clearSystemProxy: false,
      stopRunner: true,
      fast: false,
      resetActiveAgentConversation: true,
    });
  } catch (error) {
    logMainError('relay quit cleanup', error);
    try {
      await stopLocalRelayRunner({ fast: true });
    } catch {
      /* ignore */
    }
  }
  try {
    closeUsageDbs();
  } catch {
    /* ignore */
  }
  try {
    closeProfileDbs();
  } catch {
    /* ignore */
  }
  relayQuitCleanupDone = true;
}

app.on('before-quit', (event) => {
  setQuitting(true);
  try {
    destroyTray();
  } catch {
    /* ignore */
  }
  if (relayQuitCleanupDone) return;
  event.preventDefault();
  if (relayQuitCleanupStarted) return;
  relayQuitCleanupStarted = true;
  cleanupRelayBeforeQuit()
    .finally(() => {
      relayQuitCleanupDone = true;
      app.quit();
    });
});

ipcMain.handle('cursor:oneClickSwitch', async (event, payload) => {
  const email = payload?.email;
  const accessToken = payload?.accessToken;
  const refreshToken = payload?.refreshToken || accessToken;
  if (!email || !accessToken) {
    throw new Error('缺少 email 或 accessToken');
  }
  const sendStep = (step) => {
    try {
      event.sender.send('cursor:switchProgress', { step });
    } catch {
      /* ignore */
    }
  };
  return runFullAccountSwitch({
    email,
    accessToken,
    refreshToken,
    resetMachineId: true,
    onStep: sendStep,
  });
});

ipcMain.handle('views:read', async (_event, relativePath) => {
  const safePath = String(relativePath || '').replace(/\\/g, '/');
  if (!safePath.startsWith('html/')) {
    throw new Error('Invalid view path');
  }
  const full = path.join(__dirname, safePath);
  return fs.readFile(full, 'utf8');
});

ipcMain.handle('dialog:pickExeFile', async () => {
  const wins = BrowserWindow.getAllWindows();
  const owner = wins.length ? wins[0] : null;
  const r = await dialog.showOpenDialog(owner, {
    title: '选择 Cursor.exe',
    properties: ['openFile'],
    filters: [
      { name: 'Executable', extensions: ['exe'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths?.length) return '';
  return r.filePaths[0];
});

ipcMain.handle('app:getVersion', () => ({ ok: true, version: app.getVersion() }));

ipcMain.handle('app:getRuntimeConfig', () => ({
  serverBase: '',
  apiBase: '',
}));

// Window controls (custom titlebar)
ipcMain.handle('win:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  return { ok: true };
});

ipcMain.handle('win:toggleMaximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { ok: true, maximized: mainWindow.isMaximized() };
});

ipcMain.handle('win:close', (_event, payload = {}) => {
  if (hasTray() && !isQuitting()) {
    const win = ensureMainWindow();
    if (win && !win.isDestroyed()) {
      win.hide();
      return { ok: true, action: 'hide' };
    }
    return { ok: true, action: 'noop' };
  }
  const mode = String(payload?.mode || 'exit');
  if (mode === 'tray' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    return { ok: true, action: 'hide' };
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  return { ok: true, action: 'close' };
});

ipcMain.handle('tray:syncSession', (_event, payload = {}) => {
  updateSession(payload);
  return { ok: true };
});

ipcMain.handle('tray:refreshQuota', async () => {
  await refreshQuota({ notifyMainWindow: true });
  return { ok: true };
});

ipcMain.handle('tray:refreshMenu', () => {
  refreshTrayMenu();
  return { ok: true };
});

ipcMain.handle('app:syncPreferences', (_event, payload = {}) => {
  setCloseMode(payload?.closeMode);
  return { ok: true };
});

ipcMain.handle('cursorAutoUpdate:getStatus', (_event, payload = {}) => {
  return readCursorAutoUpdateStatus(payload?.cursorExePath || '');
});

ipcMain.handle('cursorAutoUpdate:disable', (_event, payload = {}) => {
  return disableCursorAutoUpdate(payload?.cursorExePath || '');
});

ipcMain.handle('cursorAutoUpdate:restore', (_event, payload = {}) => {
  return restoreCursorAutoUpdate(payload?.cursorExePath || '');
});

ipcMain.handle('win:isMaximized', () => {
  return { ok: true, maximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()) };
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('Invalid URL');
  await shell.openExternal(u);
  return { ok: true };
});

const __settings = readBuildSettings();
let lastCheckedUpdate = null;
let downloadedUpdate = null; // { version, filePath, sha256 }

ipcMain.on('app:getRuntimeConfigSync', (event) => {
  event.returnValue = {
    serverBase: '',
    apiBase: '',
  };
});

function compareSemver(a, b) {
  const pa = String(a || '').split('.').map((x) => Number.parseInt(x, 10));
  const pb = String(b || '').split('.').map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i += 1) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function fetchLatestUpdate() {
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDownloadError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('terminated')
    || msg.includes('fetch failed')
    || msg.includes('network')
    || msg.includes('econnreset')
    || msg.includes('socket')
    || msg.includes('timed out')
    || msg.includes('timeout')
    || msg.includes('aborted')
  );
}

async function sha256OfFile(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fssync.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', resolve);
    input.on('error', reject);
  });
  return hash.digest('hex');
}

async function downloadToFileWithSha256(url, filePath, onProgress) {
  const maxRetries = Math.max(3, Number.parseInt(process.env.CURSORPOOL_UPDATE_DOWNLOAD_RETRIES || '8', 10) || 8);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    let out = null;
    let reader = null;
    try {
      let existed = 0;
      try {
        const st = await fs.stat(filePath);
        existed = Number(st.size || 0);
      } catch {
        existed = 0;
      }

      const headers = existed > 0 ? { Range: `bytes=${existed}-` } : {};
      const resp = await fetch(url, { headers });
      if (!(resp.ok || resp.status === 206)) throw new Error(`download failed: ${resp.status}`);

      const canResume = existed > 0 && resp.status === 206;
      if (!canResume && existed > 0) {
        await fs.truncate(filePath, 0);
        existed = 0;
      }

      const partialSize = Number(resp.headers.get('content-length') || 0);
      const total = canResume ? existed + partialSize : partialSize;
      let received = existed;

      out = fssync.createWriteStream(filePath, { flags: canResume ? 'a' : 'w' });
      reader = resp.body?.getReader?.();
      if (!reader) throw new Error('download stream not supported');

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (!out.write(Buffer.from(value))) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => out.once('drain', resolve));
        }
        onProgress?.({ received, total, attempt });
      }

      await new Promise((resolve, reject) => {
        out.end(() => resolve());
        out.on('error', reject);
      });
      out = null;
      reader.releaseLock?.();
      reader = null;

      const sha256 = await sha256OfFile(filePath);
      return { total: total || received, received, sha256 };
    } catch (e) {
      lastErr = e;
      try {
        reader?.releaseLock?.();
      } catch {
        /* ignore */
      }
      try {
        out?.destroy?.();
      } catch {
        /* ignore */
      }
      if (!isRetryableDownloadError(e)) break;
      if (attempt >= maxRetries) break;
      // 轻微退避后重试；若已写入部分文件，下轮将尝试断点续传
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(6000, 900 * attempt));
    }
  }
  throw new Error(`下载失败（已重试 ${maxRetries} 次）：${lastErr?.message || lastErr || 'unknown error'}`);
}

ipcMain.handle('update:check', async () => {
  const current = app.getVersion();
  const latest = await fetchLatestUpdate();
  if (!latest?.version) {
    lastCheckedUpdate = null;
    return { ok: true, available: false, currentVersion: current, update: null };
  }
  const available = compareSemver(latest.version, current) > 0;
  lastCheckedUpdate = latest;
  return { ok: true, available, currentVersion: current, update: latest };
});

ipcMain.handle('update:download', async () => {
  if (!lastCheckedUpdate?.version || !lastCheckedUpdate?.downloadUrl) {
    throw new Error('no update info, call update:check first');
  }
  const version = lastCheckedUpdate.version;
  const dl = String(lastCheckedUpdate.downloadUrl);
  const url = dl.startsWith('http') ? dl : '';
  if (!url) throw new Error('本地版未配置远程更新源');
  const filePath = path.join(app.getPath('temp'), 'cursorpool-update', `${version}.exe`);

  let sha256 = '';
  try {
    const r = await downloadToFileWithSha256(url, filePath, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:progress', { ...p, version });
      }
    });
    sha256 = r.sha256;
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (isRetryableDownloadError(e) || msg.toLowerCase().includes('terminated')) {
      throw new Error(`下载连接中断（${msg}）。已自动重试多次仍失败，请稍后重试或切换网络。`);
    }
    throw e;
  }

  if (String(lastCheckedUpdate.sha256 || '').toLowerCase() && sha256.toLowerCase() !== String(lastCheckedUpdate.sha256).toLowerCase()) {
    throw new Error('sha256 校验失败，下载文件可能已损坏');
  }

  downloadedUpdate = { version, filePath, sha256 };
  let size = 0;
  try {
    const st = await fs.stat(filePath);
    size = st.size || 0;
  } catch {
    /* ignore */
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:progress', { received: size, total: size || Number(lastCheckedUpdate?.size || 0), version });
  }
  return { ok: true, version, filePath, size };
});

function escapeCmdDoubleQuotes(p) {
  return String(p).replace(/"/g, '""');
}

/** 优先后台「更新包类型」，其次环境变量，最后文件名 portable 启发式（Windows）。 */
function resolveWindowsUpdateMode() {
  const server = String(lastCheckedUpdate?.artifactType || lastCheckedUpdate?.artifact_type || '').toLowerCase();
  if (server === 'portable') return 'portable';
  if (server === 'nsis') return 'nsis';
  const env = String(process.env.CURSORPOOL_UPDATE_MODE || '').toLowerCase();
  if (env === 'portable' || env === 'replace') return 'portable';
  if (env === 'nsis' || env === 'installer') return 'nsis';
  const url = String(lastCheckedUpdate?.downloadUrl || lastCheckedUpdate?.file_path || '');
  const base = path.basename(url.split('?')[0] || '').toLowerCase();
  if (base.includes('portable')) return 'portable';
  return 'nsis';
}

function runDetachedWindowsCmdScript(lines) {
  const batPath = path.join(app.getPath('temp'), `cursorpool-upd-${Date.now()}.cmd`);
  fssync.writeFileSync(batPath, lines.join('\r\n'), 'utf8');
  // CREATE_NO_WINDOW：尽量避免后台更新时弹出控制台
  const CREATE_NO_WINDOW = 0x08000000;
  const child = spawn('cmd.exe', ['/c', batPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    creationFlags: CREATE_NO_WINDOW,
  });
  child.unref();
}

function runDetachedWindowsVbsScript(lines) {
  const vbsPath = path.join(app.getPath('temp'), `cursorpool-upd-${Date.now()}.vbs`);
  fssync.writeFileSync(vbsPath, lines.join('\r\n'), 'utf8');
  const child = spawn('wscript.exe', ['//B', '//Nologo', vbsPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    creationFlags: 0x08000000,
  });
  child.unref();
}

ipcMain.handle('update:install', async () => {
  if (!downloadedUpdate?.filePath) throw new Error('no downloaded update');
  if (!app.isPackaged) {
    throw new Error('未打包的开发模式下无法应用更新，请使用安装版或便携版客户端测试');
  }

  const newFile = downloadedUpdate.filePath;

  if (process.platform !== 'win32') {
    try {
      spawn(newFile, [], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      throw new Error(e?.message || 'failed to launch installer');
    }
    app.quit();
    return { ok: true, mode: 'spawn' };
  }

  const mode = resolveWindowsUpdateMode();
  const qNew = escapeCmdDoubleQuotes(newFile);
  const targetExe = escapeCmdDoubleQuotes(process.execPath);
  const installDir = path.dirname(process.execPath);

  if (mode === 'portable') {
    // 便携版 / 单 exe：退出后覆盖当前主程序再拉起（后台「更新包类型」选便携，或环境变量/文件名启发式）
    runDetachedWindowsCmdScript([
      '@echo off',
      'ping 127.0.0.1 -n 4 >nul',
      `copy /Y "${qNew}" "${targetExe}"`,
      'if errorlevel 1 exit /b 1',
      `start "" "${targetExe}"`,
      // 兜底：首次启动异常时再尝试一次
      'ping 127.0.0.1 -n 4 >nul',
      `start "" "${targetExe}"`,
      'del "%~f0"',
    ]);
  } else {
    // NSIS：静默升级。与 electron-builder 默认 per-user 安装一致，需带 /currentuser，否则可能再次弹出安装选项页。
    // 若用户首次安装时选了「为所有用户安装」，可设置环境变量 CURSORPOOL_NSIS_SILENT_ARGS=/S /allusers
    const extraSilent = String(process.env.CURSORPOOL_NSIS_SILENT_ARGS || '/S /currentuser').trim();
    // NSIS 静默安装后“自动重启”需要我们自己拉起当前安装目录的 exe
    // 同时传 /D=installDir 以确保覆盖到当前目录（避免装到默认目录导致找不到路径）
    const extraArgs = extraSilent.split(/\s+/).filter(Boolean);
    const dArg = `/D=${installDir}`;
    const argString = [...extraArgs, dArg].join(' ');
    // 使用 wscript 执行，避免 cmd 控制台窗口闪出
    runDetachedWindowsVbsScript([
      `installer = "${newFile.replace(/"/g, '""')}"`,
      `args = "${argString.replace(/"/g, '""')}"`,
      `target = "${process.execPath.replace(/"/g, '""')}"`,
      'Set sh = CreateObject("WScript.Shell")',
      'sh.Run Chr(34) & installer & Chr(34) & " " & args, 0, True',
      'WScript.Sleep 2000',
      // 1=正常窗口，避免“启动了但看起来没打开”
      'sh.Run Chr(34) & target & Chr(34), 1, False',
      // 兜底：再等待后重试一次拉起，降低偶发启动失败概率
      'WScript.Sleep 4000',
      'sh.Run Chr(34) & target & Chr(34), 1, False',
    ]);
  }

  app.quit();
  return { ok: true, mode };
});

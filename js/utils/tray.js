const { Tray, Menu, nativeImage, Notification, app, BrowserWindow } = require('electron');
const path = require('path');
const fssync = require('fs');
const { loadRelayProfileStore } = require('./cursor-relay-profile-store');
const { quickSwitchRelayModel } = require('./cursor-relay-proxy');

let tray = null;
let mainWindowRef = null;
let ensureMainWindowFn = null;
let apiBase = '';
let appDisplayName = 'CursorPool';
let closeMode = 'tray';
let isQuitting = false;
let relayModelSwitchInProgress = false;
let quotaRefreshTimer = null;

const session = {
  token: '',
  userEmail: '',
  remainQuota: null,
  isUnlimitedQuota: false,
};

function getTrayIconPath() {
  const iconIco = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
  const iconPng = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  return fssync.existsSync(iconIco) ? iconIco : iconPng;
}

function showTrayNotification(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: String(title || appDisplayName), body: String(body || '') });
    n.show();
  } catch {
    /* ignore */
  }
}

function formatTooltip() {
  const user = String(session.userEmail || '').trim();
  return user ? `${appDisplayName}\n${user}` : appDisplayName;
}

function setMainWindow(win) {
  mainWindowRef = win || null;
}

function showMainWindow() {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    if (typeof ensureMainWindowFn === 'function') {
      try {
        mainWindowRef = ensureMainWindowFn();
      } catch {
        /* ignore */
      }
    }
  }
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  if (mainWindowRef.isMinimized()) mainWindowRef.restore();
  if (!mainWindowRef.isVisible()) mainWindowRef.show();
  mainWindowRef.focus();
}

function buildMenu() {
  const relayProfiles = (() => {
    try {
      return loadRelayProfileStore('');
    } catch {
      return { activeId: '', configs: [] };
    }
  })();
  const items = [
    { label: '打开主界面', click: showMainWindow },
    { type: 'separator' },
  ];
  const localModelItems = Array.isArray(relayProfiles.configs) && relayProfiles.configs.length
    ? relayProfiles.configs
      .filter((item) => item?.modelName)
      .map((item) => ({
        label: `${String(item.name || item.modelName)} · ${String(item.modelName || '')}`,
        type: 'radio',
        checked: String(relayProfiles.activeId || '') === String(item.id || ''),
        enabled: !relayModelSwitchInProgress,
        click: () => {
          trayQuickSwitchRelayModel(item.id).catch(() => {});
        },
      }))
    : [{ label: '暂无本地模型配置', enabled: false }];
  items.push({
    label: relayModelSwitchInProgress ? '切换本地模型（进行中…）' : '切换本地模型',
    submenu: localModelItems,
  });
  items.push(
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  );
  return Menu.buildFromTemplate(items);
}

function rebuildMenu() {
  if (!tray) return;
  tray.setContextMenu(buildMenu());
  tray.setToolTip(formatTooltip());
}

async function fetchDashboard() {
  if (!session.token || !apiBase) return null;
  const resp = await fetch(`${apiBase}/dashboard`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.message || '获取额度失败');
  return data;
}

async function refreshQuota({ notifyMainWindow = false } = {}) {
  if (!session.token) {
    session.remainQuota = null;
    session.isUnlimitedQuota = false;
    rebuildMenu();
    return;
  }
  try {
    const d = await fetchDashboard();
    if (d) {
      session.remainQuota = d.remainQuota;
      session.isUnlimitedQuota = Boolean(d.isUnlimitedQuota);
      if (notifyMainWindow && mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send('tray:quotaUpdated', {
          remainQuota: session.remainQuota,
          isUnlimitedQuota: session.isUnlimitedQuota,
        });
      }
    }
  } catch {
    /* keep previous values */
  }
  rebuildMenu();
}

async function trayQuickSwitchRelayModel(profileId) {
  if (relayModelSwitchInProgress) return;
  relayModelSwitchInProgress = true;
  rebuildMenu();
  try {
    const result = await quickSwitchRelayModel({ profileId });
    const profile = result?.profile || {};
    const label = String(profile.name || profile.modelName || '本地模型');
    showTrayNotification('本地模型已切换', `${label}${result?.hotSwitched ? '（热切换）' : ''}`);
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('tray:relayModelSwitched', {
        profile,
        hotSwitched: Boolean(result?.hotSwitched),
        enabledFromOff: Boolean(result?.enabledFromOff),
      });
    }
  } catch (error) {
    showTrayNotification('切换本地模型失败', error?.message || String(error));
  } finally {
    relayModelSwitchInProgress = false;
    rebuildMenu();
  }
}

function updateSession(payload = {}) {
  if (payload.token !== undefined) session.token = String(payload.token || '');
  if (payload.userEmail !== undefined) session.userEmail = String(payload.userEmail || '');
  if (payload.remainQuota !== undefined) session.remainQuota = payload.remainQuota;
  if (payload.isUnlimitedQuota !== undefined) session.isUnlimitedQuota = Boolean(payload.isUnlimitedQuota);
  rebuildMenu();
}

function setCloseMode(mode) {
  closeMode = mode === 'tray' ? 'tray' : 'exit';
}

function shouldHideOnClose() {
  if (isQuitting) return false;
  if (tray) return true;
  return closeMode === 'tray';
}

function attachWindowCloseHandler(win) {
  win.on('close', (e) => {
    if (shouldHideOnClose()) {
      e.preventDefault();
      win.hide();
    }
  });
}

function startQuotaRefreshTimer() {
  if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
  quotaRefreshTimer = setInterval(() => {
    if (!session.token) return;
    refreshQuota().catch(() => {});
  }, 60 * 1000);
}

function createTray({ mainWindow, apiBase: api, appName, ensureMainWindow } = {}) {
  if (tray) return tray;
  mainWindowRef = mainWindow;
  ensureMainWindowFn = typeof ensureMainWindow === 'function' ? ensureMainWindow : null;
  apiBase = String(api || '').replace(/\/+$/, '');
  appDisplayName = String(appName || app.getName() || 'CursorPool');

  const iconPath = getTrayIconPath();
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createEmpty();
  } else if (process.platform === 'win32') {
    icon = icon.resize({ width: 16, height: 16 });
  }

  tray = new Tray(icon);
  tray.setToolTip(appDisplayName);
  tray.on('double-click', showMainWindow);
  rebuildMenu();
  startQuotaRefreshTimer();
  return tray;
}

function destroyTray() {
  if (quotaRefreshTimer) {
    clearInterval(quotaRefreshTimer);
    quotaRefreshTimer = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = {
  createTray,
  updateSession,
  refreshQuota,
  refreshTrayMenu: rebuildMenu,
  setCloseMode,
  setMainWindow,
  shouldHideOnClose,
  attachWindowCloseHandler,
  showMainWindow,
  destroyTray,
  setQuitting: (value) => {
    isQuitting = Boolean(value);
  },
  isQuitting: () => isQuitting,
  hasTray: () => Boolean(tray),
};

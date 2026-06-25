const { contextBridge, ipcRenderer } = require('electron');

let runtimeCfgPromise = null;
let bridgeEnv = {
  serverBase: '',
  apiBase: '',
};

function readRuntimeConfig() {
  if (!runtimeCfgPromise) {
    runtimeCfgPromise = ipcRenderer.invoke('app:getRuntimeConfig')
      .then((config) => {
        bridgeEnv = config || {};
        return bridgeEnv;
      })
      .catch(() => {
        bridgeEnv = {};
        return bridgeEnv;
      });
  }
  return runtimeCfgPromise;
}

contextBridge.exposeInMainWorld('electronBridge', {
  env: {
    get serverBase() {
      return bridgeEnv.serverBase || '';
    },
    get apiBase() {
      return bridgeEnv.apiBase || '';
    },
    load: () => readRuntimeConfig(),
  },
  toggleTheme: (theme) => ipcRenderer.invoke('theme:toggle', theme),
  applyCursorAuth: (payload) => ipcRenderer.invoke('cursor:applyAuth', payload),
  getLocalCursorState: (options) => ipcRenderer.invoke('cursor:getLocalState', options),
  getCursorDashboardUsage: () => ipcRenderer.invoke('cursor:getDashboardUsage'),
  resetMachineIdAndRestart: () => ipcRenderer.invoke('cursor:resetMachineId'),
  onResetMachineProgress: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('cursor:resetMachineProgress', listener);
    return () => ipcRenderer.removeListener('cursor:resetMachineProgress', listener);
  },
  oneClickSwitch: (payload) => ipcRenderer.invoke('cursor:oneClickSwitch', payload),
  onSwitchProgress: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('cursor:switchProgress', listener);
    return () => ipcRenderer.removeListener('cursor:switchProgress', listener);
  },
  isCursorRunning: () => ipcRenderer.invoke('cursor:isRunning'),
  killCursorProcess: () => ipcRenderer.invoke('cursor:killProcess'),
  readView: (relativePath) => ipcRenderer.invoke('views:read', relativePath),
  pickExeFile: () => ipcRenderer.invoke('dialog:pickExeFile'),
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
  winClose: (payload) => ipcRenderer.invoke('win:close', payload),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  proxyModelGetConfig: () => ipcRenderer.invoke('proxyModel:getConfig'),
  proxyModelApply: (payload) => ipcRenderer.invoke('proxyModel:apply', payload),
  proxyModelDisable: () => ipcRenderer.invoke('proxyModel:disable'),
  proxyModelTest: (payload) => ipcRenderer.invoke('proxyModel:test', payload),
  cursorRelayGetConfig: (options) => ipcRenderer.invoke('cursorRelay:getConfig', options),
  cursorRelayApply: (payload) => ipcRenderer.invoke('cursorRelay:apply', payload),
  cursorRelayEnsureRunner: (payload) => ipcRenderer.invoke('cursorRelay:ensureRunner', payload),
  cursorRelayQuickSwitchModel: (payload) => ipcRenderer.invoke('cursorRelay:quickSwitchModel', payload),
  cursorRelayDisable: (payload) => ipcRenderer.invoke('cursorRelay:disable', payload),
  cursorRelayInstallCert: (payload) => ipcRenderer.invoke('cursorRelay:installCert', payload),
  cursorRelayCheckCert: () => ipcRenderer.invoke('cursorRelay:checkCert'),
  cursorRelayRepairCert: (payload) => ipcRenderer.invoke('cursorRelay:repairCert', payload),
  cursorRelayReadLog: () => ipcRenderer.invoke('cursorRelay:readLog'),
  cursorRelayDiagnose: () => ipcRenderer.invoke('cursorRelay:diagnose'),
  cursorRelayTestAgent: (payload) => ipcRenderer.invoke('cursorRelay:testAgent', payload),
  cursorRelayStartPlanUiMock: (payload) => ipcRenderer.invoke('cursorRelay:startPlanUiMock', payload),
  cursorRelayOpenLog: () => ipcRenderer.invoke('cursorRelay:openLog'),
  cursorRelayOpenDiagnose: () => ipcRenderer.invoke('cursorRelay:openDiagnose'),
  cursorRelayOpenLogDir: () => ipcRenderer.invoke('cursorRelay:openLogDir'),
  cursorRelayDisableByok: (payload) => ipcRenderer.invoke('cursorRelay:disableByok', payload),
  cursorRelayUsageList: (payload) => ipcRenderer.invoke('cursorRelayUsage:list', payload),
  cursorRelayUsageClear: () => ipcRenderer.invoke('cursorRelayUsage:clear'),
  cursorRelayProfilesLoad: () => ipcRenderer.invoke('cursorRelayProfiles:load'),
  cursorRelayProfilesSave: (payload) => ipcRenderer.invoke('cursorRelayProfiles:save', payload),
  syncTraySession: (payload) => ipcRenderer.invoke('tray:syncSession', payload),
  refreshTrayQuota: () => ipcRenderer.invoke('tray:refreshQuota'),
  refreshTrayMenu: () => ipcRenderer.invoke('tray:refreshMenu'),
  syncAppPreferences: (payload) => ipcRenderer.invoke('app:syncPreferences', payload),
  onTrayQuotaUpdated: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('tray:quotaUpdated', listener);
    return () => ipcRenderer.removeListener('tray:quotaUpdated', listener);
  },
  onTraySwitchCompleted: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('tray:switchCompleted', listener);
    return () => ipcRenderer.removeListener('tray:switchCompleted', listener);
  },
  onTrayRelayModelSwitched: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('tray:relayModelSwitched', listener);
    return () => ipcRenderer.removeListener('tray:relayModelSwitched', listener);
  },
});

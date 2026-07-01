const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { getCursorAppDataDir } = require('./cursor-local-state');

const BACKUP_PATH = path.join(os.homedir(), '.cursorpool', 'relay', 'proxy-backup.json');
const RUNNER_CONFIG_PATH = path.join(os.homedir(), '.cursorpool', 'relay', 'runner-config.json');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const CURSOR_PROXY_KEYS = [
  'http.proxy',
  'http.proxyKerberosServicePrincipal',
  'http.proxySupport',
  'http.proxyStrictSSL',
  'http.experimental.systemCertificatesV2',
  'cursor.general.disableHttp2',
];

function ensureBackupDir() {
  fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
}

function readBackup() {
  try {
    if (!fs.existsSync(BACKUP_PATH)) return null;
    return JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeBackup(data) {
  ensureBackupDir();
  fs.writeFileSync(BACKUP_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readKnownRelayProxyServer() {
  try {
    if (!fs.existsSync(RUNNER_CONFIG_PATH)) return '';
    const parsed = JSON.parse(fs.readFileSync(RUNNER_CONFIG_PATH, 'utf8'));
    const port = Number(parsed?.port) || 0;
    if (port <= 0) return '';
    return `http://127.0.0.1:${port}`;
  } catch {
    return '';
  }
}

function normalizeProxyUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname || !parsed.port) return '';
    if (!['http:', 'https:', 'socks:', 'socks5:', 'socks4:'].includes(parsed.protocol)) return '';
    return parsed.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function getProxyHostPort(proxyUrl = '') {
  try {
    const parsed = new URL(normalizeProxyUrl(proxyUrl));
    return `${parsed.hostname.toLowerCase()}:${parsed.port}`;
  } catch {
    return '';
  }
}

function isLocalRelayProxyUrl(proxyUrl = '', options = {}) {
  const hostPort = getProxyHostPort(proxyUrl);
  if (!hostPort) return false;
  const knownRelay = getProxyHostPort(readKnownRelayProxyServer());
  if (knownRelay && hostPort === knownRelay) return true;
  const ports = new Set(
    []
      .concat(options.localProxyPorts || [])
      .map((item) => Number(item) || 0)
      .filter(Boolean),
  );
  if (!ports.size) return false;
  try {
    const parsed = new URL(normalizeProxyUrl(proxyUrl));
    return LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) && ports.has(Number(parsed.port));
  } catch {
    return false;
  }
}

function parseWindowsProxyServer(proxyServer = '') {
  const raw = String(proxyServer || '').trim();
  if (!raw) return {};
  if (!raw.includes('=')) {
    const single = normalizeProxyUrl(raw);
    return single ? { http: single, https: single, all: single } : {};
  }

  const out = {};
  raw.split(';').forEach((part) => {
    const text = String(part || '').trim();
    if (!text) return;
    const index = text.indexOf('=');
    if (index <= 0) return;
    const key = text.slice(0, index).trim().toLowerCase();
    const value = normalizeProxyUrl(text.slice(index + 1).trim());
    if (key && value) out[key] = value;
  });
  if (!out.https && out.http) out.https = out.http;
  if (!out.http && out.https) out.http = out.https;
  return out;
}

function readEnvProxyUrl(env = process.env) {
  return normalizeProxyUrl(
    env.CURSOR_RELAY_OUTBOUND_PROXY
    || env.HTTPS_PROXY
    || env.https_proxy
    || env.HTTP_PROXY
    || env.http_proxy
    || env.ALL_PROXY
    || env.all_proxy
    || '',
  );
}

function resolveRelayOutboundProxy(options = {}) {
  if (String(process.env.CURSOR_RELAY_OUTBOUND_PROXY || '').trim().toLowerCase() === 'direct') {
    return { enabled: false, url: '', source: 'disabled_env', noProxy: '', supported: true };
  }

  const envUrl = readEnvProxyUrl(process.env);
  if (envUrl && !isLocalRelayProxyUrl(envUrl, options)) {
    return {
      enabled: true,
      url: envUrl,
      source: 'env',
      noProxy: String(process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1,::1').trim(),
      supported: true,
    };
  }

  const windows = readWindowsSystemProxy();
  if (windows.supported && windows.enabled && windows.server) {
    const parsed = parseWindowsProxyServer(windows.server);
    const url = parsed.https || parsed.http || parsed.all || '';
    if (url && !isLocalRelayProxyUrl(url, options)) {
      return {
        enabled: true,
        url,
        source: 'windows_system',
        noProxy: String(windows.override || 'localhost;127.0.0.1;::1').trim(),
        supported: true,
        windows,
      };
    }
  }

  return {
    enabled: false,
    url: '',
    source: windows.supported ? 'none' : 'unsupported',
    noProxy: '',
    supported: windows.supported,
    windows,
  };
}

function getCursorSettingsPath() {
  return path.join(getCursorAppDataDir(), 'User', 'settings.json');
}

function readCursorSettings() {
  const settingsPath = getCursorSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { settingsPath, exists: false, data: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return { settingsPath, exists: true, data: data && typeof data === 'object' ? data : {} };
  } catch (error) {
    return { settingsPath, exists: true, data: {}, parseError: error.message };
  }
}

function writeCursorSettings(data) {
  const settingsPath = getCursorSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(data || {}, null, 2)}\n`, 'utf8');
  return settingsPath;
}

function readWindowsSystemProxy() {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, server: '', override: '' };
  }
  try {
    const raw = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$p=Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";'
        + '[PSCustomObject]@{Enabled=[bool]$p.ProxyEnable;Server=[string]$p.ProxyServer;Override=[string]$p.ProxyOverride}|ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ).trim();
    const parsed = JSON.parse(raw || '{}');
    return {
      supported: true,
      enabled: Boolean(parsed.Enabled),
      server: String(parsed.Server || '').trim(),
      override: String(parsed.Override || '').trim(),
    };
  } catch {
    return { supported: true, enabled: false, server: '', override: '', readError: true };
  }
}

function setWindowsSystemProxy(proxyServer, proxyOverride = '<-loopback>') {
  if (process.platform !== 'win32') {
    return { ok: false, supported: false, message: 'System proxy is only supported on Windows' };
  }
  const hostPort = String(proxyServer || '').replace(/^https?:\/\//i, '').trim();
  if (!hostPort) {
    return { ok: false, supported: true, message: 'Missing proxy server' };
  }

  const current = readWindowsSystemProxy();
  const backup = readBackup() || {};
  if (!backup.windows) {
    backup.windows = {
      enabled: current.enabled,
      server: current.server,
      override: current.override,
    };
    writeBackup(backup);
  }

  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';`
        + `Set-ItemProperty -Path $p -Name ProxyEnable -Value 1;`
        + `Set-ItemProperty -Path $p -Name ProxyServer -Value '${hostPort.replace(/'/g, "''")}';`
        + `Set-ItemProperty -Path $p -Name ProxyOverride -Value '${String(proxyOverride).replace(/'/g, "''")}';`,
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 10000 },
    );
    return { ok: true, supported: true, server: hostPort, override: proxyOverride };
  } catch (error) {
    return { ok: false, supported: true, message: error.message || String(error) };
  }
}

function clearWindowsSystemProxy() {
  if (process.platform !== 'win32') {
    return { ok: false, supported: false };
  }
  const backup = readBackup();
  if (!backup || !Object.prototype.hasOwnProperty.call(backup, 'windows')) {
    return { ok: true, supported: true, skipped: true, reason: 'no_backup' };
  }
  const restore = backup?.windows || { enabled: false, server: '', override: '' };
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';`
        + `Set-ItemProperty -Path $p -Name ProxyEnable -Value ${restore.enabled ? 1 : 0};`
        + `Set-ItemProperty -Path $p -Name ProxyServer -Value '${String(restore.server || '').replace(/'/g, "''")}';`
        + `Set-ItemProperty -Path $p -Name ProxyOverride -Value '${String(restore.override || '').replace(/'/g, "''")}';`,
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 10000 },
    );
    if (backup) {
      delete backup.windows;
      if (Object.keys(backup).length) writeBackup(backup);
      else if (fs.existsSync(BACKUP_PATH)) fs.unlinkSync(BACKUP_PATH);
    }
    return { ok: true, supported: true, restored: restore };
  } catch (error) {
    return { ok: false, supported: true, message: error.message || String(error) };
  }
}

function applyCursorHttpProxySettings(proxyServer, options = {}) {
  const proxyUrl = String(proxyServer || '').trim();
  if (!proxyUrl) {
    return { ok: false, message: 'Missing proxy server' };
  }
  const proxySupport = String(options.proxySupport || 'on').trim() || 'on';
  const proxyStrictSSL = options.proxyStrictSSL === true;
  const disableHttp2 = options.disableHttp2 !== false;
  const systemCertificatesV2 = options.systemCertificatesV2 !== false;

  const { settingsPath, exists, data, parseError } = readCursorSettings();
  const backup = readBackup() || {};
  if (!backup.cursorSettings) {
    backup.cursorSettings = {};
    CURSOR_PROXY_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        backup.cursorSettings[key] = data[key];
      }
    });
    writeBackup(backup);
  }

  const next = { ...data };
  next['http.proxy'] = proxyUrl;
  next['http.proxyKerberosServicePrincipal'] = proxyUrl;
  next['http.proxySupport'] = proxySupport;
  next['http.proxyStrictSSL'] = proxyStrictSSL;
  next['http.experimental.systemCertificatesV2'] = systemCertificatesV2;
  next['cursor.general.disableHttp2'] = disableHttp2;
  writeCursorSettings(next);

  return {
    ok: true,
    settingsPath,
    existed: exists,
    parseError: parseError || '',
    httpProxy: proxyUrl,
    proxySupport,
    proxyStrictSSL,
    systemCertificatesV2,
    disableHttp2,
  };
}

function clearCursorHttpProxySettings() {
  const { data } = readCursorSettings();
  const backup = readBackup();
  const currentHttpProxy = String(data['http.proxy'] || '').trim();
  const currentProxySupport = String(data['http.proxySupport'] || '').trim();
  const knownRelayProxy = readKnownRelayProxyServer();
  const looksLikeLocalRelayProxy = Boolean(
    knownRelayProxy
    && currentHttpProxy
    && currentHttpProxy.toLowerCase() === knownRelayProxy.toLowerCase(),
  );
  if (!backup || !Object.prototype.hasOwnProperty.call(backup, 'cursorSettings')) {
    if (!looksLikeLocalRelayProxy && !currentProxySupport) {
      return { ok: true, skipped: true, reason: 'no_backup', restoredKeys: [] };
    }
    const nextWithoutBackup = { ...data };
    CURSOR_PROXY_KEYS.forEach((key) => {
      delete nextWithoutBackup[key];
    });
    writeCursorSettings(nextWithoutBackup);
    return {
      ok: true,
      skipped: false,
      reason: 'no_backup_but_local_relay_proxy_detected',
      restoredKeys: [],
      clearedFallback: true,
      clearedProxy: currentHttpProxy,
    };
  }
  const next = { ...data };
  const restored = backup?.cursorSettings || {};

  CURSOR_PROXY_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(restored, key)) next[key] = restored[key];
    else delete next[key];
  });

  writeCursorSettings(next);

  if (backup) {
    delete backup.cursorSettings;
    if (Object.keys(backup).length) writeBackup(backup);
    else if (fs.existsSync(BACKUP_PATH)) fs.unlinkSync(BACKUP_PATH);
  }

  return { ok: true, restoredKeys: Object.keys(restored) };
}

function applyRelaySystemProxy(proxyServer, proxyOverride, options = {}) {
  const settings = applyCursorHttpProxySettings(proxyServer, options);
  const windows = setWindowsSystemProxy(proxyServer, proxyOverride);
  return { settings, windows };
}

function clearRelaySystemProxy() {
  const settings = clearCursorHttpProxySettings();
  const windows = clearWindowsSystemProxy();
  return { settings, windows };
}

function readRelayProxyState(options = {}) {
  const cursorSettings = readCursorSettings();
  const windows = options.skipWindows === true
    ? { supported: process.platform === 'win32', enabled: false, server: '', override: '', skipped: true }
    : readWindowsSystemProxy();
  return {
    cursorSettings: {
      path: cursorSettings.settingsPath,
      httpProxy: String(cursorSettings.data['http.proxy'] || '').trim(),
      proxySupport: String(cursorSettings.data['http.proxySupport'] || '').trim(),
      proxyKerberosServicePrincipal: String(cursorSettings.data['http.proxyKerberosServicePrincipal'] || '').trim(),
      proxyStrictSSL: cursorSettings.data['http.proxyStrictSSL'],
      systemCertificatesV2: cursorSettings.data['http.experimental.systemCertificatesV2'],
      disableHttp2: cursorSettings.data['cursor.general.disableHttp2'],
    },
    windows,
    backupPath: BACKUP_PATH,
    backupExists: fs.existsSync(BACKUP_PATH),
  };
}

module.exports = {
  applyRelaySystemProxy,
  clearRelaySystemProxy,
  readRelayProxyState,
  readWindowsSystemProxy,
  normalizeProxyUrl,
  parseWindowsProxyServer,
  resolveRelayOutboundProxy,
  readCursorSettings,
  applyCursorHttpProxySettings,
  clearCursorHttpProxySettings,
};

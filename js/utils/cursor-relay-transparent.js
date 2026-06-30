const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');

const HOSTS_BEGIN = '# BEGIN CURSORPOOL RELAY';
const HOSTS_END = '# END CURSORPOOL RELAY';
const DEFAULT_DIRECT_MITM_PORT = 443;

const TRANSPARENT_HOSTS = [
  'api2.cursor.sh',
  'api3.cursor.sh',
  'api4.cursor.sh',
  'api5.cursor.sh',
  'agent.api5.cursor.sh',
  'agentn.api5.cursor.sh',
  'metrics.cursor.sh',
  'prod.authentication.cursor.sh',
  'marketplace.cursorapi.com',
  'downloads.cursor.com',
  'cursor-cdn.com',
  'cursor.sh',
  'www.cursor.sh',
];

function getHostsPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

function isProcessElevated() {
  if (process.platform !== 'win32') return process.getuid && process.getuid() === 0;
  try {
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    ).trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

function buildHostsBlock(hosts = TRANSPARENT_HOSTS) {
  return [
    HOSTS_BEGIN,
    `127.0.0.1 ${hosts.join(' ')}`,
    HOSTS_END,
    '',
  ].join(os.EOL);
}

function stripHostsBlock(content) {
  const lines = String(content || '').split(/\r?\n/);
  const out = [];
  let skipping = false;
  lines.forEach((line) => {
    if (line.trim() === HOSTS_BEGIN) {
      skipping = true;
      return;
    }
    if (line.trim() === HOSTS_END) {
      skipping = false;
      return;
    }
    if (!skipping) out.push(line);
  });
  return out.join(os.EOL).replace(/\s+$/g, '');
}

function readHostsFile() {
  const hostsPath = getHostsPath();
  if (!fs.existsSync(hostsPath)) {
    return { hostsPath, exists: false, content: '', hasBlock: false };
  }
  const content = fs.readFileSync(hostsPath, 'utf8');
  return {
    hostsPath,
    exists: true,
    content,
    hasBlock: content.includes(HOSTS_BEGIN),
  };
}

function applyTransparentHosts(hosts = TRANSPARENT_HOSTS) {
  const hostsPath = getHostsPath();
  const current = readHostsFile();
  const desiredBlock = buildHostsBlock(hosts).trim();
  const existingBlockMatch = String(current.content || '').match(
    new RegExp(`${HOSTS_BEGIN}[\\s\\S]*?${HOSTS_END}`, 'm'),
  );
  const existingBlock = existingBlockMatch ? existingBlockMatch[0].trim() : '';
  if (current.hasBlock && existingBlock === desiredBlock) {
    return { ok: true, hostsPath, alreadyApplied: true, hosts };
  }

  const next = `${stripHostsBlock(current.content)}${os.EOL}${os.EOL}${buildHostsBlock(hosts)}`;
  try {
    fs.writeFileSync(hostsPath, next, 'utf8');
    return {
      ok: true,
      hostsPath,
      alreadyApplied: false,
      updatedExistingBlock: Boolean(current.hasBlock),
      hosts,
    };
  } catch (error) {
    return {
      ok: false,
      hostsPath,
      needsAdmin: !isProcessElevated(),
      message: error.message || String(error),
      hosts,
    };
  }
}

function clearTransparentHosts() {
  const hostsPath = getHostsPath();
  const current = readHostsFile();
  if (!current.hasBlock) {
    return { ok: true, hostsPath, removed: false };
  }
  const next = `${stripHostsBlock(current.content)}${os.EOL}`;
  try {
    fs.writeFileSync(hostsPath, next, 'utf8');
    return { ok: true, hostsPath, removed: true };
  } catch (error) {
    return {
      ok: false,
      hostsPath,
      needsAdmin: !isProcessElevated(),
      message: error.message || String(error),
    };
  }
}

function readTransparentHostsStatus(options = {}) {
  const current = readHostsFile();
  return {
    hostsPath: current.hostsPath,
    hasBlock: current.hasBlock,
    elevated: options.skipElevation === true ? null : isProcessElevated(),
    directMitmPort: DEFAULT_DIRECT_MITM_PORT,
    hosts: TRANSPARENT_HOSTS,
  };
}

function snapshotCursorTcpConnections() {
  if (process.platform !== 'win32') {
    return { supported: false, lines: [], text: 'TCP 归属快照仅支持 Windows' };
  }
  try {
    const script = [
      '$pids = @(Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id);',
      'if (-not $pids.Count) { Write-Output "NO_CURSOR_PROCESS"; exit 0 };',
      '$rows = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess -and $_.RemotePort -eq 443 } | Select-Object -First 40 OwningProcess, LocalAddress, LocalPort, RemoteAddress, RemotePort);',
      'if (-not $rows.Count) { Write-Output "NO_CURSOR_443"; exit 0 };',
      '$rows | ForEach-Object { "{0}`t{1}:{2}`t->`t{3}:{4}" -f $_.OwningProcess, $_.LocalAddress, $_.LocalPort, $_.RemoteAddress, $_.RemotePort }',
    ].join(' ');
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    ).trim();
    const lines = raw ? raw.split(/\r?\n/).filter(Boolean) : [];
    return {
      supported: true,
      lines,
      text: lines.length ? lines.join('\n') : raw || '（无 Cursor :443 连接）',
      cursorRunning: !lines.includes('NO_CURSOR_PROCESS') && raw !== 'NO_CURSOR_PROCESS',
    };
  } catch (error) {
    return {
      supported: true,
      lines: [],
      text: `TCP 快照失败: ${error.message || String(error)}`,
      error: error.message || String(error),
    };
  }
}

// 异步版本：避免 execFileSync 阻塞 main 进程事件循环导致 IPC 超时
function snapshotCursorTcpConnectionsAsync(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ supported: false, lines: [], text: 'TCP 归属快照仅支持 Windows' });
      return;
    }
    const script = [
      '$pids = @(Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id);',
      'if (-not $pids.Count) { Write-Output "NO_CURSOR_PROCESS"; exit 0 };',
      '$rows = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess -and $_.RemotePort -eq 443 } | Select-Object -First 40 OwningProcess, LocalAddress, LocalPort, RemoteAddress, RemotePort);',
      'if (-not $rows.Count) { Write-Output "NO_CURSOR_443"; exit 0 };',
      '$rows | ForEach-Object { "{0}`t{1}:{2}`t->`t{3}:{4}" -f $_.OwningProcess, $_.LocalAddress, $_.LocalPort, $_.RemoteAddress, $_.RemotePort }',
    ].join(' ');
    let settled = false;
    const done = (val) => {
      if (!settled) { settled = true; resolve(val); }
    };
    const timer = setTimeout(() => {
      done({ supported: true, lines: [], text: 'TCP 快照超时跳过', error: 'timeout' });
    }, timeoutMs);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs },
      (error, stdout) => {
        clearTimeout(timer);
        if (error) {
          done({ supported: true, lines: [], text: `TCP 快照失败: ${error.message || String(error)}`, error: error.message || String(error) });
          return;
        }
        const raw = String(stdout || '').trim();
        const lines = raw ? raw.split(/\r?\n/).filter(Boolean) : [];
        done({
          supported: true,
          lines,
          text: lines.length ? lines.join('\n') : raw || '（无 Cursor :443 连接）',
          cursorRunning: !lines.includes('NO_CURSOR_PROCESS') && raw !== 'NO_CURSOR_PROCESS',
        });
      },
    );
  });
}

module.exports = {
  DEFAULT_DIRECT_MITM_PORT,
  TRANSPARENT_HOSTS,
  applyTransparentHosts,
  clearTransparentHosts,
  readTransparentHostsStatus,
  snapshotCursorTcpConnections,
  snapshotCursorTcpConnectionsAsync,
  isProcessElevated,
};

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { getRelayDataDir } = require('./cursor-relay-cert');

const DEFAULT_RUNNER_PORT = Number(process.env.CURSOR_RELAY_PORT || 17789);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function stripUtf8Bom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function writeUtf8FileWithBom(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = Buffer.from(String(content), 'utf8');
  fs.writeFileSync(filePath, Buffer.concat([UTF8_BOM, body]));
}

function readUtf8File(filePath) {
  const raw = fs.readFileSync(filePath);
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  return stripUtf8Bom(raw.toString('utf8'));
}

function fetchRunnerStats(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: DEFAULT_RUNNER_PORT,
      path: '/__cursorpool__/health',
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(payload?.stats || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function getMirrorLogDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'CursorPool', 'relay');
  }
  return '';
}

function getRunnerLogPaths(customRoot) {
  const dataDir = getRelayDataDir(customRoot);
  const primary = path.join(dataDir, 'runner.log');
  const mirrorDir = getMirrorLogDir();
  const mirror = mirrorDir ? path.join(mirrorDir, 'runner.log') : '';
  return {
    dataDir,
    primary,
    mirror,
    displayPath: mirror || primary,
    all: [primary, mirror].filter(Boolean),
  };
}

function buildRunnerLogHeader() {
  return [
    '# CursorPool Relay Runner Log',
    `# Created: ${new Date().toISOString()}`,
    '# 可用记事本打开；若无法打开请使用客户端「打开日志」按钮。',
    '',
  ].join('\r\n');
}

function clearRunnerLogs(customRoot) {
  const paths = getRunnerLogPaths(customRoot);
  const header = buildRunnerLogHeader();
  paths.all.forEach((logPath) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      writeUtf8FileWithBom(logPath, header);
    } catch {
      /* ignore */
    }
  });
  return paths;
}

function ensureRunnerLogFile(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!fs.existsSync(logPath)) {
    writeUtf8FileWithBom(logPath, buildRunnerLogHeader());
  }
}

function initRunnerLogs(customRoot, { reset = false } = {}) {
  const paths = reset ? clearRunnerLogs(customRoot) : getRunnerLogPaths(customRoot);
  paths.all.forEach((logPath) => {
    if (!reset) ensureRunnerLogFile(logPath);
    try {
      fs.appendFileSync(
        logPath,
        `\r\n--- runner started ${new Date().toISOString()} ---\r\n`,
        'utf8',
      );
    } catch {
      /* ignore */
    }
  });
  return paths;
}

function appendRunnerLogLine(logPath, line) {
  try {
    ensureRunnerLogFile(logPath);
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\r\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function appendRunnerLog(line, customRoot) {
  const paths = getRunnerLogPaths(customRoot);
  let wrote = false;
  paths.all.forEach((logPath) => {
    if (appendRunnerLogLine(logPath, line)) wrote = true;
  });
  return wrote;
}

async function readRunnerLogTail(customRoot, maxLines = 40, options = {}) {
  const lightweight = options.lightweight === true;
  const paths = getRunnerLogPaths(customRoot);
  const target = paths.all.find((logPath) => {
    try {
      return fs.existsSync(logPath) && fs.statSync(logPath).size > 0;
    } catch {
      return false;
    }
  });

  if (!target) {
    const stats = lightweight ? await fetchRunnerStats(500) : null;
    return {
      ok: false,
      exists: false,
      logPath: paths.displayPath,
      mirrorPath: paths.mirror,
      primaryPath: paths.primary,
      lines: [],
      text: '',
      hasChatIntercept: Number(stats?.chatTotal) > 0,
      stats,
      message: '日志文件尚未生成。请先启用 Relay，再在 Cursor 里用 Auto 发一条消息。',
    };
  }

  let raw = '';
  try {
    const size = fs.statSync(target).size;
    const readBytes = Math.min(size, 256 * 1024);
    const fd = fs.openSync(target, 'r');
    try {
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(fd, buffer, 0, readBytes, Math.max(0, size - readBytes));
      raw = stripUtf8Bom(buffer.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    raw = readUtf8File(target);
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const tail = lines.slice(-maxLines);
  const tailText = tail.join('\n');
  const hasChatIntercept = tailText.includes('chat intercept');
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    /* ignore */
  }

  const stats = await fetchRunnerStats(lightweight ? 500 : 800);

  return {
    ok: true,
    exists: true,
    logPath: target,
    displayPath: paths.displayPath,
    mirrorPath: paths.mirror,
    primaryPath: paths.primary,
    size,
    lines: tail,
    text: tailText,
    hasChatIntercept: hasChatIntercept || Number(stats?.chatTotal) > 0,
    stats,
    message: hasChatIntercept || Number(stats?.chatTotal) > 0
      ? '已检测到聊天拦截日志，Relay 正在处理 Auto 请求。'
      : 'Runner 已启动，但尚未看到 chat intercept。请在 Cursor 用 Auto 发消息后刷新。',
  };
}

module.exports = {
  getRunnerLogPaths,
  clearRunnerLogs,
  initRunnerLogs,
  appendRunnerLog,
  readRunnerLogTail,
  writeUtf8FileWithBom,
  readUtf8File,
  stripUtf8Bom,
};

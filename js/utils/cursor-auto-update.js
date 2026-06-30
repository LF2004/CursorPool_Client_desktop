const fs = require('fs');
const path = require('path');

const { resolveMainJsPath, resolveFromCursorDir } = require('../../paths');

const DISABLED_SUFFIX = '.cursorpool-disabled';

function resolveCursorExePath(explicitPath) {
  const raw = String(explicitPath || '').trim();
  if (raw) {
    const resolved = path.resolve(raw);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isFile() && /^cursor\.exe$/i.test(path.basename(resolved))) return resolved;
      if (stat.isDirectory()) {
        for (const name of ['Cursor.exe', 'cursor.exe']) {
          const exe = path.join(resolved, name);
          if (fs.existsSync(exe)) return exe;
        }
      }
    }
  }

  const mainJsPath = resolveMainJsPath(raw || undefined);
  if (mainJsPath) {
    const guessed = path.join(path.dirname(mainJsPath), '..', '..', '..', 'Cursor.exe');
    const alt = path.join(path.dirname(mainJsPath), '..', '..', '..', 'cursor.exe');
    for (const candidate of [guessed, alt]) {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
  }

  return null;
}

function resolveInstallRoot(explicitPath) {
  const exePath = resolveCursorExePath(explicitPath);
  if (exePath) return path.dirname(exePath);

  const mainJsPath = resolveMainJsPath(explicitPath || undefined);
  if (mainJsPath) return path.resolve(path.dirname(mainJsPath), '..', '..', '..');

  if (explicitPath) {
    const raw = path.resolve(explicitPath);
    if (fs.existsSync(raw)) {
      const fromDir = resolveFromCursorDir(raw, 'main.js');
      if (fromDir) return path.resolve(path.dirname(fromDir), '..', '..', '..');
    }
  }

  return null;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function tryReadCursorVersionFromDb() {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return null;
  }

  const dbCandidates = [];
  if (process.env.APPDATA) {
    dbCandidates.push(path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  }

  for (const dbPath of dbCandidates) {
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const tableRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('itemtable','item_table') LIMIT 1")
        .get();
      const tableName = tableRow?.name;
      if (!tableName) continue;
      const row = db.prepare(`SELECT value FROM ${tableName} WHERE key = ? LIMIT 1`).get('lastVersion');
      const version = String(row?.value || '').trim();
      if (version) return version;
    } catch {
      // ignore
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  return null;
}

function resolveVersionInfo(installRoot) {
  const packageJsonPath = installRoot ? path.join(installRoot, 'resources', 'app', 'package.json') : '';
  const packageJson = readJsonIfExists(packageJsonPath);
  const packageVersion = String(packageJson?.version || '').trim();
  const dbVersion = tryReadCursorVersionFromDb();
  return {
    version: packageVersion || dbVersion || 'Unknown',
    source: packageVersion ? 'package.json' : dbVersion ? 'state.vscdb' : 'unknown',
    packageJsonPath: packageJson ? packageJsonPath : '',
  };
}

function resolveUpdateFiles(installRoot) {
  if (!installRoot) return [];
  const appUpdate = path.join(installRoot, 'resources', 'app-update.yml');
  const appUpdateDisabled = `${appUpdate}${DISABLED_SUFFIX}`;
  const updaterExe = path.join(installRoot, 'Update.exe');
  const updaterExeDisabled = `${updaterExe}${DISABLED_SUFFIX}`;
  const innoUpdaterExe = path.join(installRoot, 'tools', 'inno_updater.exe');
  const innoUpdaterExeDisabled = `${innoUpdaterExe}${DISABLED_SUFFIX}`;
  return [
    {
      key: 'appUpdateYaml',
      path: appUpdate,
      disabledPath: appUpdateDisabled,
      exists: fs.existsSync(appUpdate),
      disabledExists: fs.existsSync(appUpdateDisabled),
    },
    {
      key: 'updateExe',
      path: updaterExe,
      disabledPath: updaterExeDisabled,
      exists: fs.existsSync(updaterExe),
      disabledExists: fs.existsSync(updaterExeDisabled),
    },
    {
      key: 'innoUpdaterExe',
      path: innoUpdaterExe,
      disabledPath: innoUpdaterExeDisabled,
      exists: fs.existsSync(innoUpdaterExe),
      disabledExists: fs.existsSync(innoUpdaterExeDisabled),
    },
  ];
}

function summarizeDisableState(files) {
  const hasEnabled = files.some((item) => item.exists);
  const hasDisabled = files.some((item) => item.disabledExists);
  const allMissing = files.every((item) => !item.exists && !item.disabledExists);
  const disabled = !hasEnabled && hasDisabled;
  return {
    disabled,
    hasEnabled,
    hasDisabled,
    allMissing,
  };
}

function readCursorAutoUpdateStatus(explicitPath) {
  const installRoot = resolveInstallRoot(explicitPath);
  const exePath = resolveCursorExePath(explicitPath);
  const versionInfo = resolveVersionInfo(installRoot);
  const files = resolveUpdateFiles(installRoot);
  const summary = summarizeDisableState(files);

  return {
    ok: true,
    installRoot: installRoot || '',
    exePath: exePath || '',
    version: versionInfo.version,
    versionSource: versionInfo.source,
    packageJsonPath: versionInfo.packageJsonPath,
    disabled: summary.disabled,
    hasEnabledFiles: summary.hasEnabled,
    hasDisabledFiles: summary.hasDisabled,
    allUpdateFilesMissing: summary.allMissing,
    files,
  };
}

function renameIfExists(fromPath, toPath) {
  if (!fs.existsSync(fromPath)) return false;
  fs.renameSync(fromPath, toPath);
  return true;
}

function ensureCanToggle(status) {
  if (!status.installRoot) {
    throw new Error('未找到 Cursor 安装目录，请先在偏好设置中选择正确的 Cursor.exe。');
  }
  if (status.allUpdateFilesMissing) {
    throw new Error('未找到可操作的更新组件文件，当前 Cursor 安装结构可能与预期不同。');
  }
}

function disableCursorAutoUpdate(explicitPath) {
  const status = readCursorAutoUpdateStatus(explicitPath);
  ensureCanToggle(status);
  const changed = [];
  for (const file of status.files) {
    if (renameIfExists(file.path, file.disabledPath)) {
      changed.push({ from: file.path, to: file.disabledPath });
    }
  }
  const next = readCursorAutoUpdateStatus(explicitPath);
  return {
    ok: true,
    changed,
    ...next,
  };
}

function restoreCursorAutoUpdate(explicitPath) {
  const status = readCursorAutoUpdateStatus(explicitPath);
  ensureCanToggle(status);
  const changed = [];
  for (const file of status.files) {
    if (renameIfExists(file.disabledPath, file.path)) {
      changed.push({ from: file.disabledPath, to: file.path });
    }
  }
  const next = readCursorAutoUpdateStatus(explicitPath);
  return {
    ok: true,
    changed,
    ...next,
  };
}

module.exports = {
  readCursorAutoUpdateStatus,
  disableCursorAutoUpdate,
  restoreCursorAutoUpdate,
  resolveCursorExePath,
  resolveInstallRoot,
};

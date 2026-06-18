import { $ } from '../core/dom.js';
import { showAlert, showConfirm } from '../core/dialog.js';
import { animateSubpanel, applyAnimationPreference } from '../core/motion.js';
import { refreshProxyStatus } from './proxy.js';

const CURSOR_EXE_STORAGE = 'cursor_exe_path';
const PREF_LANG = 'pref_lang';
const PREF_CLOSE = 'pref_close';
const PREF_MODE = 'pref_mode';
const PREF_FONT_SCALE = 'pref_font_scale';
const PREF_ANIMATION = 'pref_animation';
const PREF_GLASS = 'pref_glass';
const PREF_ACCENT_COLOR = 'pref_accent_color';
const PREF_ACCENT_MODE = 'pref_accent_mode';
const PREF_WALLPAPER = 'pref_wallpaper';
const PREF_WALLPAPER_CUSTOM = 'pref_wallpaper_custom';
const BUILTIN_WALLPAPERS = [
  './assets/images/bg/bg1.jpg',
  './assets/images/bg/bg2.jpg',
  './assets/images/bg/bg3.png',
  './assets/images/bg/bg4.png',
  './assets/images/bg/bg5.png'
];
const DEFAULT_WALLPAPER = 'none';
const DEFAULT_GLASS = 'off';
const DEFAULT_ANIMATION = 'off';
const DEFAULT_ACCENT = '#3b82f6';

const PREF_APPEARANCE_DEFAULTS_V2 = 'pref_appearance_defaults_v2';

/** 首次或未设置时写入默认外观偏好 */
function ensureDefaultAppearancePrefs() {
  try {
    if (!localStorage.getItem(PREF_APPEARANCE_DEFAULTS_V2)) {
      const wp = localStorage.getItem(PREF_WALLPAPER);
      if (wp == null || wp === '' || wp === './assets/images/bg/bg1.jpg') {
        localStorage.setItem(PREF_WALLPAPER, DEFAULT_WALLPAPER);
      }
      const glass = localStorage.getItem(PREF_GLASS);
      if (glass == null || glass === '') {
        localStorage.setItem(PREF_GLASS, DEFAULT_GLASS);
      }
      localStorage.setItem(PREF_APPEARANCE_DEFAULTS_V2, '1');
      return;
    }
    if (localStorage.getItem(PREF_WALLPAPER) == null || localStorage.getItem(PREF_WALLPAPER) === '') {
      localStorage.setItem(PREF_WALLPAPER, DEFAULT_WALLPAPER);
    }
    if (localStorage.getItem(PREF_GLASS) == null || localStorage.getItem(PREF_GLASS) === '') {
      localStorage.setItem(PREF_GLASS, DEFAULT_GLASS);
    }
  } catch {
    /* ignore */
  }
}

function getStoredWallpaper() {
  try {
    const v = localStorage.getItem(PREF_WALLPAPER);
    if (!v || v === 'none') return 'none';
    return v;
  } catch {
    return 'none';
  }
}

function applyWallpaper(value) {
  const wallpaper = value || 'none';
  if (wallpaper === 'none') {
    document.documentElement.style.setProperty('--app-bg-image', 'none');
    document.body.classList.add('no-wallpaper');
    document.body.classList.remove('has-wallpaper');
    return;
  }
  document.documentElement.style.setProperty('--app-bg-image', `url("${wallpaper}")`);
  document.body.classList.remove('no-wallpaper');
  document.body.classList.add('has-wallpaper');
}

function applyGlassPreference() {
  let stored = DEFAULT_GLASS;
  try {
    stored = localStorage.getItem(PREF_GLASS) || DEFAULT_GLASS;
  } catch {
    /* ignore */
  }
  const enabled = stored === 'on';
  document.body.classList.toggle('glass-on', enabled);
  document.body.classList.toggle('glass-off', !enabled);
}

function hexToRgb(hex) {
  const v = String(hex || '').trim();
  const m = v.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const raw = m[1];
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b };
}

function applyAccentColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  const { r, g, b } = rgb;
  document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);

  // Contrast for text on accent buttons
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const contrast = luminance > 0.62 ? '#0b1120' : '#ffffff';
  document.documentElement.style.setProperty('--accent-contrast-color', contrast);
}

function getAccentMode() {
  try {
    return localStorage.getItem(PREF_ACCENT_MODE) || 'custom';
  } catch {
    return 'custom';
  }
}

function setAccentColorPickerValue(hex) {
  const el = $('advPrefAccentColor');
  if (!el) return;
  el.value = hex;
}

let updateProgressUnsub = null;
let pendingUpdateInfo = null;

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 MB';
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function setUpdateStatus(text) {
  const el = $('advUpdateStatus');
  if (el) el.textContent = text;
}

function setUpdateButtonsBusy(busy) {
  const checkBtn = $('advCheckUpdateBtn');
  const installBtn = $('advInstallUpdateBtn');
  if (checkBtn) checkBtn.disabled = Boolean(busy);
  if (installBtn) installBtn.disabled = Boolean(busy);
}

function ensureUpdateProgressListener() {
  if (updateProgressUnsub || !window.electronBridge?.onUpdateProgress) return;
  updateProgressUnsub = window.electronBridge.onUpdateProgress((p = {}) => {
    const received = Number(p.received) || 0;
    const total = Number(p.total) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    const attempt = Number(p.attempt) > 1 ? `，第 ${p.attempt} 次尝试` : '';
    setUpdateStatus(`正在下载 ${p.version || ''}：${pct}%（${formatBytes(received)} / ${formatBytes(total)}${attempt}）`);
  });
}

const wallpaperAccentCache = new Map();
const wallpaperAccentPromiseCache = new Map();
let wallpaperAccentScheduleTimer = null;
let wallpaperAccentIdleHandle = null;
let wallpaperAccentRunId = 0;

function scheduleAutoAccentFromWallpaper(wallpaperSrc) {
  // Avoid decoding/heavy canvas work during startup UI sync.
  if (wallpaperAccentScheduleTimer) {
    clearTimeout(wallpaperAccentScheduleTimer);
    wallpaperAccentScheduleTimer = null;
  }
  if (wallpaperAccentIdleHandle && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
    try {
      window.cancelIdleCallback(wallpaperAccentIdleHandle);
    } catch {
      /* ignore */
    }
    wallpaperAccentIdleHandle = null;
  }

  const runId = ++wallpaperAccentRunId;
  const run = () => {
    wallpaperAccentIdleHandle = null;
    wallpaperAccentScheduleTimer = null;
    void tryAutoAccentFromWallpaper(wallpaperSrc, runId);
  };

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    wallpaperAccentIdleHandle = window.requestIdleCallback(
      () => run(),
      { timeout: 2500 },
    );
    return;
  }

  // Fallback: schedule slightly later
  wallpaperAccentScheduleTimer = setTimeout(run, 600);
}

async function tryAutoAccentFromWallpaper(wallpaperSrc, runId) {
  if (getAccentMode() !== 'auto') return;
  const key = String(wallpaperSrc || '');
  if (!key) return;

  // Cached final color
  if (wallpaperAccentCache.has(key)) {
    if (runId !== wallpaperAccentRunId) return;
    applyAccentColor(wallpaperAccentCache.get(key));
    return;
  }

  // Share in-flight extraction work
  if (wallpaperAccentPromiseCache.has(key)) {
    try {
      const hex = await wallpaperAccentPromiseCache.get(key);
      if (!hex) return;
      if (runId !== wallpaperAccentRunId) return;
      applyAccentColor(hex);
    } catch {
      /* ignore */
    }
    return;
  }

  const promise = extractDominantColorHex(wallpaperSrc)
    .then((hex) => {
      if (hex) wallpaperAccentCache.set(key, hex);
      return hex;
    })
    .catch(() => null)
    .finally(() => {
      wallpaperAccentPromiseCache.delete(key);
    });

  wallpaperAccentPromiseCache.set(key, promise);

  const hex = await promise;
  if (!hex) return;
  if (runId !== wallpaperAccentRunId) return;
  applyAccentColor(hex);
  // Do NOT set input value here to avoid any unexpected event loops.
}

function extractDominantColorHex(imageSrc) {
  return new Promise((resolve) => {
    const src = String(imageSrc || '');
    if (!src) return resolve(null);

    const img = new Image();
    img.decoding = 'async';

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };

    // Safety timeout: avoid any hanging image decode.
    const timer = setTimeout(() => finish(null), 1500);

    img.onload = () => {
      clearTimeout(timer);
      try {
        const w = 48;
        const h = 48;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return finish(null);
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 30) continue;

          const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          if (lum < 0.06 || lum > 0.96) continue;

          rSum += r;
          gSum += g;
          bSum += b;
          count += 1;
        }

        if (!count) return finish(null);
        const r = Math.round(rSum / count);
        const g = Math.round(gSum / count);
        const b = Math.round(bSum / count);

        const toHex = (n) => n.toString(16).padStart(2, '0');
        finish(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
      } catch {
        finish(null);
      }
    };

    img.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };

    // Make relative paths resolve correctly in Electron
    img.src = new URL(src, document.baseURI).toString();
  });
}

function populateWallpaperOptions() {
  const select = $('advPrefWallpaper');
  if (!select) return;
  const current = getStoredWallpaper();
  const options = [`<option value="none">无</option>`]
    .concat(BUILTIN_WALLPAPERS.map((item, index) => {
      const label = item.split('/').pop() || `壁纸 ${index + 1}`;
      return `<option value="${item}">${label}</option>`;
    }))
    .join('');
  select.innerHTML = `${options}<option value="custom">自定义上传</option>`;
  const customStored = localStorage.getItem(PREF_WALLPAPER_CUSTOM) || '';
  if (current === 'none') select.value = 'none';
  else if (BUILTIN_WALLPAPERS.includes(current)) select.value = current;
  else select.value = customStored ? 'custom' : 'none';
  const customHint = $('advWallpaperCurrent');
  if (customHint) {
    customHint.textContent = current === 'none' ? '无' : (current.split('/').pop() || '当前背景');
  }
}

/** 启动时应用外观偏好（默认：无背景、无毛玻璃、#3b82f6） */
export function initAppearancePreferences() {
  ensureDefaultAppearancePrefs();
  const accentMode = getAccentMode();
  const accentHex = localStorage.getItem(PREF_ACCENT_COLOR) || DEFAULT_ACCENT;
  applyAccentColor(accentMode === 'custom' ? accentHex : DEFAULT_ACCENT);
  applyWallpaper(getStoredWallpaper());
  applyGlassPreference();
  applyFontScaleFromPrefs();
  applyAnimationPreference();
}

function loadPrefs() {
  try {
    const lang = localStorage.getItem(PREF_LANG);
    const close = localStorage.getItem(PREF_CLOSE);
    const mode = localStorage.getItem(PREF_MODE);
    const fontScale = localStorage.getItem(PREF_FONT_SCALE);
    const glass = localStorage.getItem(PREF_GLASS) || DEFAULT_GLASS;
    const animation = localStorage.getItem(PREF_ANIMATION) || DEFAULT_ANIMATION;
    const exe = localStorage.getItem(CURSOR_EXE_STORAGE);
    const l = $('advPrefLang');
    const c = $('advPrefClose');
    const m = $('advPrefMode');
    const f = $('advPrefFontScale');
    const g = $('advPrefGlass');
    const anim = $('advPrefAnimation');
    const accent = $('advPrefAccentColor');
    const accentModeEl = $('advPrefAccentMode');
    const x = $('advCursorExePath');
    if (l && lang) l.value = lang;
    if (c && close) c.value = close;
    window.electronBridge?.syncAppPreferences?.({
      closeMode: close === 'tray' ? 'tray' : 'exit',
    }).catch?.(() => {});
    if (m && mode) m.value = mode;
    if (f && fontScale) f.value = fontScale;
    if (g) g.value = glass === 'on' ? 'on' : DEFAULT_GLASS;
    if (anim) anim.value = animation === 'on' ? 'on' : DEFAULT_ANIMATION;
    if (x && exe) x.value = exe;
    const accentMode = getAccentMode();
    if (accentModeEl) accentModeEl.value = accentMode;
    const isCustom = accentMode === 'custom';
    if (accent) accent.disabled = !isCustom;
    const resetAccent = $('advResetAccentColor');
    if (resetAccent) resetAccent.disabled = !isCustom;

    const accentHex = localStorage.getItem(PREF_ACCENT_COLOR) || DEFAULT_ACCENT;
    if (accent) setAccentColorPickerValue(accentHex);
    if (isCustom) applyAccentColor(accentHex);
    else applyAccentColor(DEFAULT_ACCENT);

    const wallpaper = getStoredWallpaper();
    applyWallpaper(wallpaper);
    if (accentMode === 'auto') {
      scheduleAutoAccentFromWallpaper(wallpaper);
    }
    applyGlassPreference();
    applyAnimationPreference();
    populateWallpaperOptions();
  } catch {
    /* ignore */
  }
}

function applyFontScaleFromPrefs() {
  let scale = 1;
  try {
    const v = localStorage.getItem(PREF_FONT_SCALE);
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0.8 && n <= 1.4) scale = n;
  } catch {
    /* ignore */
  }
  document.documentElement.style.setProperty('--app-font-scale', String(scale));
}

function savePrefs() {
  try {
    const l = $('advPrefLang');
    const c = $('advPrefClose');
    const m = $('advPrefMode');
    const f = $('advPrefFontScale');
    const g = $('advPrefGlass');
    const anim = $('advPrefAnimation');
    const accentModeEl = $('advPrefAccentMode');
    const accent = $('advPrefAccentColor');
    const w = $('advPrefWallpaper');
    if (l) localStorage.setItem(PREF_LANG, l.value);
    if (c) {
      localStorage.setItem(PREF_CLOSE, c.value);
      window.electronBridge?.syncAppPreferences?.({
        closeMode: c.value === 'tray' ? 'tray' : 'exit',
      }).catch?.(() => {});
    }
    if (m) localStorage.setItem(PREF_MODE, m.value);
    if (f) localStorage.setItem(PREF_FONT_SCALE, f.value);
    if (g) localStorage.setItem(PREF_GLASS, g.value === 'on' ? 'on' : DEFAULT_GLASS);
    if (anim) localStorage.setItem(PREF_ANIMATION, anim.value === 'on' ? 'on' : DEFAULT_ANIMATION);
    if (accentModeEl) localStorage.setItem(PREF_ACCENT_MODE, accentModeEl.value);
    if (accent) localStorage.setItem(PREF_ACCENT_COLOR, accent.value);
    if (w) {
      const custom = localStorage.getItem(PREF_WALLPAPER_CUSTOM) || '';
      const nextWallpaper = w.value === 'custom' ? (custom || DEFAULT_WALLPAPER) : w.value;
      localStorage.setItem(PREF_WALLPAPER, nextWallpaper || 'none');
      applyWallpaper(nextWallpaper || 'none');
      if (getAccentMode() === 'auto') {
        scheduleAutoAccentFromWallpaper(nextWallpaper);
      }
      const customHint = $('advWallpaperCurrent');
      if (customHint) customHint.textContent = nextWallpaper.split('/').pop() || '当前背景';
    }
  } catch {
    /* ignore */
  }
}

async function confirmCloseCursorBeforeProceed(actionText) {
  if (!window.electronBridge?.isCursorRunning) return true;
  const status = await window.electronBridge.isCursorRunning();
  if (!status?.running) return true;
  return showConfirm(
    '检测到 Cursor 正在运行, 请保存尚未更改的项目再继续操作!\n不保存会导致Cursor报错! 报错了请别联系客服!',
    {
      title: 'Cursor 正在运行',
      tone: 'danger',
      confirmText: actionText || '我已知晓，继续',
      cancelText: '取消',
    },
  );
}

/**
 * @param {{ onLogout?: () => void, refreshAll?: () => Promise<void> }} [opts]
 */
export function bindAdvancedEvents(_opts = {}) {
  document.querySelectorAll('.adv-subtab').forEach((btn) => {
    btn.onclick = () => {
      const tab = btn.getAttribute('data-adv-tab');
      document.querySelectorAll('.adv-subtab').forEach((b) => b.classList.toggle('active', b === btn));
      const pref = $('advPanelPrefs');
      const proxy = $('advPanelProxy');
      const ab = $('advPanelAbout');
      if (pref) pref.classList.toggle('hidden', tab !== 'prefs');
      if (proxy) proxy.classList.toggle('hidden', tab !== 'proxy');
      if (ab) ab.classList.toggle('hidden', tab !== 'about');
      const activePanel =
        tab === 'prefs' ? pref :
        tab === 'proxy' ? proxy :
        ab;
      if (activePanel) {
        animateSubpanel(activePanel);
      }
      if (tab === 'prefs') {
        populateWallpaperOptions();
        const wallpaper = getStoredWallpaper();
        applyWallpaper(wallpaper);
        if (getAccentMode() === 'auto') {
          scheduleAutoAccentFromWallpaper(wallpaper);
        }
      }
      if (tab === 'proxy') {
        refreshProxyStatus().catch(() => {});
      }
    };
  });

  loadPrefs();
  applyFontScaleFromPrefs();

  [
    'advPrefAnimation',
    'advPrefGlass',
    'advPrefAccentMode',
    'advPrefAccentColor',
    'advPrefFontScale',
    'advPrefLang',
    'advPrefClose',
    'advPrefMode',
    'advPrefWallpaper',
  ].forEach((id) => {
    const el = $(id);
    if (el) {
      el.onchange = () => {
        savePrefs();
        if (id === 'advPrefAnimation') applyAnimationPreference();
        if (id === 'advPrefFontScale') applyFontScaleFromPrefs();
        if (id === 'advPrefGlass') applyGlassPreference();
        if (id === 'advPrefAccentColor') applyAccentColor(el.value);
        if (id === 'advPrefAccentMode') {
          const mode = el.value;
          const isCustom = mode === 'custom';
          const accentEl = $('advPrefAccentColor');
          if (accentEl) accentEl.disabled = !isCustom;
          const resetAccent = $('advResetAccentColor');
          if (resetAccent) resetAccent.disabled = !isCustom;
          if (isCustom) {
            const color = $('advPrefAccentColor')?.value || '#3b82f6';
            applyAccentColor(color);
          } else {
            // Recompute from current wallpaper
            void tryAutoAccentFromWallpaper(getStoredWallpaper());
          }
        }
      };
    }
  });

  const resetAccent = $('advResetAccentColor');
  if (resetAccent) {
    resetAccent.onclick = () => {
      const modeEl = $('advPrefAccentMode');
      const mode = modeEl?.value || 'custom';
      if (mode !== 'custom' && modeEl) {
        modeEl.value = 'custom';
      }

      const next = '#3b82f6';
      try {
        localStorage.setItem(PREF_ACCENT_COLOR, next);
      } catch {
        /* ignore */
      }
      const accentEl = $('advPrefAccentColor');
      if (accentEl) accentEl.value = next;
      applyAccentColor(next);
      // 同步一遍 UI 存储
      savePrefs();
    };
  }

  const pickExe = $('advPickCursorExe');
  const wallpaperUpload = $('advWallpaperUpload');
  if (wallpaperUpload) {
    wallpaperUpload.onchange = async () => {
      const file = wallpaperUpload.files?.[0];
      if (!file) return;
      try {
        // Reduce memory usage: downscale large images before storing as dataURL.
        const dataUrl = await compressImageFileToDataUrl(file, {
          maxSize: 1920,
          quality: 0.86,
        });
        localStorage.setItem(PREF_WALLPAPER_CUSTOM, dataUrl);
        localStorage.setItem(PREF_WALLPAPER, dataUrl);
        const select = $('advPrefWallpaper');
        if (select) select.value = 'custom';
        applyWallpaper(dataUrl);
        if (getAccentMode() === 'auto') {
          scheduleAutoAccentFromWallpaper(dataUrl);
        }
        const customHint = $('advWallpaperCurrent');
        if (customHint) customHint.textContent = file.name;
        await showAlert('背景图已更新', { title: '操作完成', tone: 'success' });
      } catch (e) {
        await showAlert(e.message || String(e), { title: '上传失败', tone: 'danger' });
      } finally {
        // allow re-uploading same file triggers onchange next time
        wallpaperUpload.value = '';
      }
    };
  }

function compressImageFileToDataUrl(file, opts = {}) {
  const maxSize = Number(opts.maxSize) || 1920;
  const quality = Number.isFinite(Number(opts.quality)) ? Number(opts.quality) : 0.86;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const src = String(reader.result || '');
      if (!src) return reject(new Error('图片内容为空'));

      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        try {
          const w0 = img.naturalWidth || img.width || 0;
          const h0 = img.naturalHeight || img.height || 0;
          if (!w0 || !h0) return reject(new Error('无法解析图片尺寸'));

          const scale = Math.min(1, maxSize / Math.max(w0, h0));
          const w = Math.max(1, Math.round(w0 * scale));
          const h = Math.max(1, Math.round(h0 * scale));

          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { alpha: true });
          if (!ctx) return reject(new Error('无法创建画布'));
          ctx.drawImage(img, 0, 0, w, h);

          // Use JPEG to reduce size dramatically; PNG will often be too large.
          const out = canvas.toDataURL('image/jpeg', quality);
          resolve(out);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

  if (pickExe && window.electronBridge?.pickExeFile) {
    pickExe.onclick = async () => {
      try {
        const p = await window.electronBridge.pickExeFile();
        if (!p) return;
        const inp = $('advCursorExePath');
        if (inp) inp.value = p;
        localStorage.setItem(CURSOR_EXE_STORAGE, p);
        await showAlert('已保存 Cursor 路径（本机设置）', { tone: 'success' });
      } catch (e) {
        await showAlert(e.message || String(e), { title: '保存失败', tone: 'danger' });
      }
    };
  }

  const checkUpdateBtn = $('advCheckUpdateBtn');
  const installUpdateBtn = $('advInstallUpdateBtn');
  if (checkUpdateBtn) {
    checkUpdateBtn.onclick = async () => {
      try {
        if (!window.electronBridge?.checkUpdate) throw new Error('当前运行环境不支持自动更新检查');
        setUpdateButtonsBusy(true);
        setUpdateStatus('正在检查更新...');
        const r = await window.electronBridge.checkUpdate();
        pendingUpdateInfo = r?.update || null;
        if (!r?.available || !pendingUpdateInfo) {
          if (installUpdateBtn) installUpdateBtn.classList.add('hidden');
          setUpdateStatus(`当前已是最新版本（${r?.currentVersion || '-'}）`);
          return;
        }
        if (installUpdateBtn) installUpdateBtn.classList.remove('hidden');
        setUpdateStatus(`发现新版本 ${pendingUpdateInfo.version || ''}，点击“下载并安装”开始更新。`);
      } catch (e) {
        if (installUpdateBtn) installUpdateBtn.classList.add('hidden');
        pendingUpdateInfo = null;
        setUpdateStatus(e.message || String(e));
        await showAlert(e.message || String(e), { title: '检查更新失败', tone: 'danger' });
      } finally {
        setUpdateButtonsBusy(false);
      }
    };
  }

  if (installUpdateBtn) {
    installUpdateBtn.onclick = async () => {
      try {
        if (!window.electronBridge?.downloadUpdate || !window.electronBridge?.installUpdate) {
          throw new Error('当前运行环境不支持自动下载安装');
        }
        if (!pendingUpdateInfo) {
          await checkUpdateBtn?.onclick?.();
          if (!pendingUpdateInfo) return;
        }
        const ok = await showConfirm(
          `将下载并安装 ${pendingUpdateInfo.version || '新版本'}。安装时应用会自动退出并重启，是否继续？`,
          {
            title: '安装更新',
            tone: 'info',
            confirmText: '下载并安装',
            cancelText: '取消',
          },
        );
        if (!ok) return;
        ensureUpdateProgressListener();
        setUpdateButtonsBusy(true);
        setUpdateStatus('正在准备下载...');
        const downloaded = await window.electronBridge.downloadUpdate();
        setUpdateStatus(`下载完成：${formatBytes(downloaded?.size)}，正在启动安装...`);
        await window.electronBridge.installUpdate();
      } catch (e) {
        setUpdateStatus(e.message || String(e));
        await showAlert(e.message || String(e), { title: '安装更新失败', tone: 'danger' });
      } finally {
        setUpdateButtonsBusy(false);
      }
    };
  }

  document.querySelectorAll('[data-toggle-pass]').forEach((btn) => {
    btn.onclick = () => {
      const targetId = btn.getAttribute('data-toggle-pass');
      if (!targetId) return;
      const input = $(targetId);
      if (!input) return;
      const isPwd = String(input.getAttribute('type') || '').toLowerCase() === 'password';
      input.setAttribute('type', isPwd ? 'text' : 'password');
      const icon = btn.querySelector('i');
      if (icon) {
        icon.className = `fa ${isPwd ? 'fa-eye-slash' : 'fa-eye'}`;
      }
    };
  });
}

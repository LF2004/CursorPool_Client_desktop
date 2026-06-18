import { $ } from './js/core/dom.js';
import { loadViews } from './js/core/views.js';
import { state, setTheme } from './js/core/state.js';
import { bindNav, showPage } from './js/modules/navigation.js';
import { bindAdvancedEvents, initAppearancePreferences } from './js/modules/advanced.js';
import { bindProxyEvents, refreshProxyStatus } from './js/modules/proxy.js';
import { bindUsageEvents, refreshUsage, startUsagePolling, stopUsagePolling } from './js/modules/usage.js';
import { showAlert, showConfirm, openProgressDialog } from './js/core/dialog.js';
import { loadClientBranding } from './js/core/branding.js';

let currentPageId = '';

function getCloseMode() {
  try {
    const mode = localStorage.getItem('pref_close');
    return mode === 'exit' ? 'exit' : 'tray';
  } catch {
    return 'tray';
  }
}

async function syncAppPreferences() {
  try {
    await window.electronBridge?.syncAppPreferences?.({ closeMode: getCloseMode() });
  } catch {
    /* ignore */
  }
}

function applyTheme() {
  document.body.classList.remove('theme-dark', 'theme-light');
  document.body.classList.add(state.theme === 'light' ? 'theme-light' : 'theme-dark');
}

function applyFontScale() {
  let scale = 1;
  try {
    const v = localStorage.getItem('pref_font_scale');
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0.8 && n <= 1.4) scale = n;
  } catch {
    /* ignore */
  }
  document.documentElement.style.setProperty('--app-font-scale', String(scale));
}

async function checkOnlineUpdate() {
  if (!window.electronBridge?.checkUpdate) return;
  let unsub = null;
  let prog = null;
  try {
    const r = await window.electronBridge.checkUpdate();
    if (!r?.available || !r.update) return;

    const notes = (r.update.releaseNotes || '').trim();
    const ok = await showConfirm(
      `发现新版本：${r.update.version}\n\n${notes || '是否现在下载并安装更新？'}`,
      { title: '在线更新', tone: 'info', confirmText: '下载并安装', cancelText: '稍后' },
    );
    if (!ok) return;

    prog = openProgressDialog({
      title: '正在下载更新包',
      subtitle: `版本 ${r.update.version} · 校验完成后将提示安装`,
    });
    unsub = window.electronBridge.onUpdateProgress?.((p) => {
      prog?.update?.(p);
    });

    const dl = await window.electronBridge.downloadUpdate();
    const size = Number(dl?.size || r.update?.size || 0);
    if (size > 0) {
      prog.update({ received: size, total: size });
    }
    prog.close();
    prog = null;

    const installOk = await showConfirm(
      '更新包已下载并校验通过。退出后将自动安装并重启。',
      {
        title: '在线更新',
        tone: 'success',
        confirmText: '立即更新',
        cancelText: '稍后',
      },
    );
    if (installOk) await window.electronBridge.installUpdate();
  } catch (e) {
    console.error('update flow failed:', e);
    try {
      prog?.close?.();
    } catch {
      /* ignore */
    }
    await showAlert(e?.message || String(e), { title: '在线更新失败', tone: 'danger' });
  } finally {
    try {
      unsub?.();
    } catch {
      /* ignore */
    }
  }
}

function runCurrentPageRefresh(page) {
  if (page === currentPageId) return;
  currentPageId = page;

  if (page === 'usage') {
    startUsagePolling();
    refreshUsage().catch(() => {});
    return;
  }

  stopUsagePolling();

  if (page === 'advanced') {
    requestAnimationFrame(() => {
      const proxyPanel = $('advPanelProxy');
      if (proxyPanel && !proxyPanel.classList.contains('hidden')) {
        refreshProxyStatus().catch(() => {});
      }
    });
  }
}

function bindGlobal() {
  const syncTitle = () => {
    const t = document.getElementById('brandTitle')?.textContent?.trim();
    const el = document.getElementById('windowTitleText');
    if (el) el.textContent = t || document.title || 'Cursor Relay';
  };
  syncTitle();

  (async () => {
    try {
      const r = await window.electronBridge?.getAppVersion?.();
      const localV = r?.version ? String(r.version) : '';
      const sub = $('brandSub');
      if (!sub) return;
      if (localV) {
        sub.textContent = `Local Agent Proxy v${localV}`;
      } else {
        sub.textContent = 'Local Agent Proxy';
      }
    } catch {
      /* ignore */
    }
  })();

  const minBtn = $('winMinBtn');
  if (minBtn) {
    minBtn.onclick = () => window.electronBridge?.winMinimize?.().catch?.(() => {});
  }
  const maxBtn = $('winMaxBtn');
  if (maxBtn) {
    maxBtn.onclick = async () => {
      try {
        const r = await window.electronBridge?.winToggleMaximize?.();
        if (r && typeof r.maximized === 'boolean') {
          maxBtn.classList.toggle('is-max', r.maximized);
        }
      } catch {
        /* ignore */
      }
    };
  }
  const closeBtn = $('winCloseBtn');
  if (closeBtn) {
    closeBtn.onclick = () => window.electronBridge?.winClose?.({ mode: getCloseMode() }).catch?.(() => {});
  }

  window.electronBridge?.onTrayRelayModelSwitched?.(() => {
    refreshProxyStatus().catch(() => {});
  });

  const titlebar = $('windowTitlebar');
  if (titlebar) {
    titlebar.ondblclick = () => window.electronBridge?.winToggleMaximize?.().catch?.(() => {});
  }

  $('themeToggle').onclick = async () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme();
    await window.electronBridge.toggleTheme(next);
    syncTitle();
  };
}

async function init() {
  console.log('[init] start');
  initAppearancePreferences();
  try {
    await loadViews();
    await loadClientBranding();
  } catch (error) {
    console.error('load views failed:', error);
    $('panelSection').innerHTML = '<div class="auth-card"><h2>页面加载失败</h2><p>请重启客户端后重试。</p></div>';
    return;
  }

  applyTheme();
  applyFontScale();

  bindNav(state.pages, (page) => {
    runCurrentPageRefresh(page);
  });
  bindAdvancedEvents();
  bindProxyEvents().catch((error) => {
    console.error('bindProxyEvents failed:', error);
  });
  bindUsageEvents();
  bindGlobal();

  syncAppPreferences().catch(() => {});

  currentPageId = '';
  showPage(state.pages, 'advanced');
  runCurrentPageRefresh('advanced');
  refreshProxyStatus().catch(() => {});

  setTimeout(() => {
    checkOnlineUpdate().catch(() => {});
  }, 1200);

  console.log('[init] done');
}

init();

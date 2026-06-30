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

  // ── [DIAG] Relay 运行时缓存状态诊断 ──
  setTimeout(() => {
    fetchRelayDiagnostics().catch((e) => console.warn('[relay-diagnostics] init 触发失败:', e.message));
  }, 2000);

  setTimeout(() => {
    checkOnlineUpdate().catch(() => {});
  }, 1200);

  console.log('[init] done');
}

/**
 * [DIAG] 查询 relay runner 的完整运行时缓存状态并打印到控制台
 * 通过 IPC cursorRelay:diagnose 调用 main 进程，main 代为请求 runner 的
 * /__cursorpool__/diagnostics 端点并合并到 runnerInternals 字段。
 * renderer 不再需要 require('fs'/'path'/'os') 或自己探测端口。
 * 手动触发：在 DevTools Console 输入 __relayDiag()
 */
async function fetchRelayDiagnostics() {
  console.log('%c[relay-diagnostics] 正在通过 IPC 查询 relay 运行时状态...', 'color:#2196F3;font-weight:bold');
  let diag;
  try {
    if (!window.electronBridge?.cursorRelayDiagnose) {
      console.warn('[relay-diagnostics] electronBridge.cursorRelayDiagnose 不可用');
      return;
    }
    diag = await Promise.race([
      window.electronBridge.cursorRelayDiagnose(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('IPC cursorRelay:diagnose 超时 (8s) — main 进程可能卡在 readCursorRelayProxyConfig')),
        8000,
      )),
    ]);
  } catch (e) {
    console.warn('[relay-diagnostics] IPC 查询失败:', e.message);
    return;
  }
  if (!diag) {
    console.warn('[relay-diagnostics] IPC 返回 null/undefined');
    return;
  }

  const runnerUp = diag.runnerRunning;
  const port = diag.runnerPort;
  console.log(
    `%c[relay-diagnostics] runner: ${runnerUp ? '✓ 运行中' : '✗ 未运行'} | port=${port || '-'} | verdict=${diag.verdict || '?'}`,
    runnerUp ? 'color:#4CAF50;font-weight:bold' : 'color:#f44336;font-weight:bold',
  );

  // 打印 main 视角的问题清单
  if (Array.isArray(diag.issues) && diag.issues.length > 0) {
    console.groupCollapsed('%c[relay-diagnostics] main 视角问题 (' + diag.issues.length + ')', 'color:#ff9800');
    diag.issues.forEach((issue) => console.warn('  -', issue));
    console.groupEnd();
  }

  const ri = diag.runnerInternals;
  if (!ri) {
    console.warn('[relay-diagnostics] 无 runnerInternals（main 未返回 runner 内部状态）');
    console.log('  summary:', diag.summary || '(无)');
    return;
  }
  if (ri.error) {
    console.warn('[relay-diagnostics] runner 内部状态获取失败:', ri.error);
    console.log('  summary:', diag.summary || '(无)');
    return;
  }

  // ── 格式化打印 runner 内部状态 ──
  console.groupCollapsed('%c[relay-diagnostics] runner 内部缓存状态', 'color:#4CAF50;font-weight:bold;font-size:13px');
  console.log('%c时间: ' + (ri.timestamp || '-') + ' | uptime: ' + (ri.uptimeSec || 0) + 's | pid: ' + (ri.pid || '-'), 'color:#888');

  // 1. Proto root
  console.group('%c1. Protobuf Root', 'color:#2196F3');
  if (ri.proto?.loaded) {
    console.log('%c  ✓ 已加载', 'color:#4CAF50');
    console.log('  AvailableModelsResponse:', ri.proto.availableModelsResponse ? '✓ 可解析' : '✗ 不可解析');
    console.log('  models 字段类型:', ri.proto.modelsFieldType || '(未解析)');
    if (ri.proto.typeLookupError) console.warn('  类型查找错误:', ri.proto.typeLookupError);
  } else {
    console.log('%c  ✗ 未加载! 原因:', 'color:#f44336', ri.proto?.error || '(未知)');
  }
  console.groupEnd();

  // 2. Auth intercept
  console.group('%c2. Auth 拦截', 'color:#2196F3');
  console.log('  拦截次数:', ri.authIntercept?.interceptedCount || 0);
  console.log('  注册端点:', (ri.authIntercept?.endpoints || []).join(', ') || '(无)');
  if (!ri.authIntercept?.interceptedCount) {
    console.log('%c  ⚠ 未拦截到任何请求 — Cursor 可能绕过了代理或路径不匹配', 'color:#ff9800');
  } else {
    console.log('%c  ✓ 已拦截 auth 请求', 'color:#4CAF50');
  }
  if (ri.authIntercept?.error) console.warn('  模块错误:', ri.authIntercept.error);
  console.groupEnd();

  // 3. Model injection
  console.group('%c3. 模型注入', 'color:#2196F3');
  const localModels = ri.modelInjection?.localModels || [];
  console.log('  collectLocalModels():', localModels.length, '个');
  localModels.forEach((m) => console.log('   -', m.modelName || m, '| display:', m.displayName || '-'));
  console.log('  配置的 modelRoutes:', (ri.modelInjection?.configuredModelNames || []).join(', ') || '(无)');
  console.log('  upstream availableModels:', (ri.modelInjection?.upstreamAvailableModels || []).join(', ') || '(无)');
  if (localModels.length === 0 && !ri.modelInjection?.collectError) {
    console.log('%c  ⚠ 无本地模型! profile store 可能没有配置模型', 'color:#ff9800');
  } else if (ri.modelInjection?.collectError) {
    console.log('%c  ✗ 收集失败:', 'color:#f44336', ri.modelInjection.collectError);
  } else {
    console.log('%c  ✓ 有本地模型可注入', 'color:#4CAF50');
  }
  console.groupEnd();

  // 4. State Guard / DB membership
  console.group('%c4. State Guard / DB 账号状态', 'color:#2196F3');
  console.log('  守护运行中:', ri.stateGuard?.guardRunning ? '是' : '否');
  const dbMembership = ri.stateGuard?.dbMembershipType;
  console.log('  DB membershipType:', dbMembership || '(未读取)');
  console.log('  DB email:', ri.stateGuard?.dbEmail || '(未读取)');
  const dbMemLower = String(dbMembership || '').toLowerCase();
  if (dbMemLower === 'free') {
    console.log('%c  ✗ DB 中是 FREE! state-guard 应该已重写为 ultra', 'color:#f44336');
  } else if (dbMemLower === 'ultra' || dbMemLower === 'pro') {
    console.log('%c  ✓ DB 中是 ' + dbMembership.toUpperCase(), 'color:#4CAF50');
  } else if (dbMembership) {
    console.log('  DB 中是:', dbMembership);
  }
  console.log('  模板 email:', ri.accountStore?.templateEmail || '(未读取)');
  console.log('  模板 membership:', ri.accountStore?.templateMembership || '(未读取)');
  console.groupEnd();

  // 5. Profile Store
  console.group('%c5. Relay Profile Store', 'color:#2196F3');
  console.log('  激活 profile ID:', ri.profileStore?.activeId || '(无)');
  console.log('  总配置数:', ri.profileStore?.configCount || 0);
  (ri.profileStore?.configs || []).forEach((c) => {
    console.log('  -', c.name, '| model:', c.modelName || '-', '| upstream:', c.baseUrl || '-', '| enabled:', c.enabled);
  });
  console.groupEnd();

  // 6. Mode Registry
  console.group('%c6. Mode Registry (cursor_modes)', 'color:#2196F3');
  const registeredModes = ri.modeRegistry?.registered || ri.modeRegistry || {};
  const modeEntries = Object.entries(registeredModes);
  if (modeEntries.length === 0) {
    console.log('  (无已注册模式)');
  } else {
    for (const [mode, info] of modeEntries) {
      const parts = [mode];
      if (!info.hasPrompt) parts.push('⚠无system_prompt.txt');
      if (!info.hasTools) parts.push('⚠无tools.json');
      console.log(' ', parts.join(' | '), info.dir ? '(' + info.dir + ')' : '');
    }
  }
  console.groupEnd();

  console.groupEnd(); // diagnostics

  // 一行摘要
  const summaryParts = [
    `proto=${ri.proto?.loaded ? '✓' : '✗'}`,
    `auth=${ri.authIntercept?.interceptedCount || 0}次`,
    `models=${localModels.length}个`,
    `membership=${dbMembership || '?'}`,
    `profiles=${ri.profileStore?.configCount || 0}`,
    `modes=${modeEntries.length}个`,
  ];
  console.log('%c[relay-diag] ' + summaryParts.join(' | '), 'background:#222;color:#4CAF50;padding:2px 8px;border-radius:4px;font-family:monospace;font-size:12px');
}

// 暴露全局函数，用户可在 DevTools Console 手动输入 __relayDiag() 触发
if (typeof window !== 'undefined') {
  window.__relayDiag = fetchRelayDiagnostics;
}

init();

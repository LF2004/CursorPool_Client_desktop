import { $ } from './dom.js';
import { animateDialogHide, animateDialogShow } from './motion.js';
import { showGlobalLoading, updateGlobalLoading, hideGlobalLoading } from './loading.js';

function ensureDialogRoot() {
  const root = $('appDialogRoot');
  if (!root) throw new Error('dialog root not found');
  return root;
}

function isFocusable(el) {
  if (!el || typeof el.focus !== 'function') return false;
  if (!(el instanceof HTMLElement)) return false;
  if (el.hasAttribute('disabled')) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  // Prefer explicit tab order or native focusables
  const focusables = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
  if (focusables.has(el.tagName)) return true;
  const tabIndex = el.getAttribute('tabindex');
  return tabIndex != null && Number(tabIndex) >= 0;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function closeDialog(result = false, opts = { animate: true }) {
  const root = $('appDialogRoot');
  if (!root) return;

  // 处理上一次关闭动画的定时器，避免和后续打开弹窗互相清空 DOM
  if (root.__closingTimer) {
    clearTimeout(root.__closingTimer);
    root.__closingTimer = null;
  }

  const restoreEl = root.__restoreFocusEl && document.contains(root.__restoreFocusEl) ? root.__restoreFocusEl : null;
  root.__restoreFocusEl = null;

  if (!opts?.animate || !root.classList.contains('dialog-root-active')) {
    root.innerHTML = '';
    root.classList.remove('dialog-root-active');
    root.classList.remove('dialog-closing');
    document.body.classList.remove('dialog-open');
    if (root.__cleanup) {
      try {
        root.__cleanup();
      } catch {
        /* ignore */
      }
      root.__cleanup = null;
    }
    if (restoreEl && isFocusable(restoreEl)) {
      // Ensure any layout/paint finishes before focusing.
      setTimeout(() => {
        try {
          restoreEl.focus();
        } catch {
          /* ignore */
        }
      }, 0);
    }
    return result;
  }

  root.classList.remove('dialog-root-active');
  root.classList.add('dialog-closing');
  document.body.classList.remove('dialog-open');

  if (root.__cleanup) {
    try {
      root.__cleanup();
    } catch {
      /* ignore */
    }
    root.__cleanup = null;
  }

  const backdrop = root.querySelector('.dialog-backdrop');
  const card = root.querySelector('.dialog-card');
  const finishClose = () => {
    if (!root) return;
    root.innerHTML = '';
    root.classList.remove('dialog-closing');
    root.__closingTimer = null;
    if (restoreEl && isFocusable(restoreEl)) {
      try {
        restoreEl.focus();
      } catch {
        /* ignore */
      }
    }
  };

  animateDialogHide(backdrop, card).finally(() => {
    finishClose();
  });

  return result;
}

export function openDialog(options = {}) {
  const root = ensureDialogRoot();
  closeDialog(false, { animate: false });

  // Save focus before showing modal so we can restore it on close.
  try {
    const active = document.activeElement;
    root.__restoreFocusEl = active && active !== document.body ? active : null;
  } catch {
    root.__restoreFocusEl = null;
  }

  const {
    title = '提示',
    message = '',
    htmlMessage = '',
    tone = 'info',
    confirmText = '确定',
    cancelText = '取消',
    showCancel = false,
    dialogClass = '',
  } = options;

  const messageMarkup = htmlMessage
    ? `<div class="dialog-message dialog-message-html">${htmlMessage}</div>`
    : `<p class="dialog-message">${escapeHtml(message).replaceAll('\n', '<br />')}</p>`;
  const extraDialogClass = dialogClass ? ` ${escapeHtml(dialogClass)}` : '';

  root.classList.add('dialog-root-active');
  root.classList.remove('dialog-closing');
  document.body.classList.add('dialog-open');
  root.innerHTML = `
    <div class="dialog-backdrop" data-dialog-close="backdrop">
      <div class="dialog-card dialog-tone-${escapeHtml(tone)}${extraDialogClass}" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle">
        <div class="dialog-glow"></div>
        <div class="dialog-head">
          <div class="dialog-icon"><i class="fa ${tone === 'danger' ? 'fa-warning' : tone === 'success' ? 'fa-check' : 'fa-bell'}" aria-hidden="true"></i></div>
          <div>
            <h3 id="appDialogTitle" class="dialog-title">${escapeHtml(title)}</h3>
            ${messageMarkup}
          </div>
        </div>
        <div class="dialog-actions">
          ${showCancel ? `<button type="button" class="dialog-btn dialog-btn-secondary" data-dialog-action="cancel">${escapeHtml(cancelText)}</button>` : ''}
          <button type="button" class="dialog-btn dialog-btn-primary" data-dialog-action="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    const finish = (result) => {
      closeDialog(result);
      resolve(result);
    };

    const onClick = (event) => {
      const action = event.target.closest('[data-dialog-action]')?.getAttribute('data-dialog-action');
      if (action === 'confirm') finish(true);
      if (action === 'cancel') finish(false);
      if (!showCancel && event.target.getAttribute('data-dialog-close') === 'backdrop') finish(true);
    };

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      }
    };

    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown);
    root.__cleanup = () => {
      root.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeydown);
    };

    const primary = root.querySelector('[data-dialog-action="confirm"]');
    if (primary) primary.focus();

    const backdrop = root.querySelector('.dialog-backdrop');
    const card = root.querySelector('.dialog-card');
    animateDialogShow(backdrop, card);
  });
}

export function showAlert(message, options = {}) {
  return openDialog({
    title: options.title || '提示',
    message: options.htmlMessage ? '' : message,
    htmlMessage: options.htmlMessage || '',
    tone: options.tone || 'info',
    confirmText: options.confirmText || '确定',
    showCancel: false,
    dialogClass: options.dialogClass || '',
  });
}

export function showConfirm(message, options = {}) {
  return openDialog({
    title: options.title || '请确认',
    message,
    tone: options.tone || 'danger',
    confirmText: options.confirmText || '继续',
    cancelText: options.cancelText || '取消',
    showCancel: true,
  });
}

function formatDownloadBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 不可通过点击遮罩关闭；用于长时间任务（如更新包下载）展示进度。
 * @returns {{ update: (p: { received?: number, total?: number }) => void, close: () => void }}
 */
export function openProgressDialog(options = {}) {
  const title = options.title || '正在处理';
  const subtitle = options.subtitle || '';

  const root = ensureDialogRoot();
  closeDialog(false, { animate: false });

  root.classList.add('dialog-root-active');
  root.classList.remove('dialog-closing');
  document.body.classList.add('dialog-open');
  root.innerHTML = `
    <div class="dialog-backdrop">
      <div class="dialog-card dialog-tone-info" role="dialog" aria-modal="true" aria-labelledby="appDialogProgressTitle">
        <div class="dialog-glow"></div>
        <div class="dialog-head">
          <div class="dialog-icon"><i class="fa fa-download" aria-hidden="true"></i></div>
          <div>
            <h3 id="appDialogProgressTitle" class="dialog-title">${escapeHtml(title)}</h3>
            ${subtitle ? `<p class="dialog-message">${escapeHtml(subtitle)}</p>` : ''}
            <div class="dialog-progress-track" aria-hidden="true">
              <div class="dialog-progress-fill" data-progress-fill style="width:0%"></div>
            </div>
            <p class="dialog-progress-label" data-progress-label>准备下载…</p>
            <p class="dialog-progress-hint">切换完成前请勿关闭本窗口</p>
          </div>
        </div>
      </div>
    </div>
  `;

  const fill = root.querySelector('[data-progress-fill]');
  const label = root.querySelector('[data-progress-label]');
  animateDialogShow(root.querySelector('.dialog-backdrop'), root.querySelector('.dialog-card'));

  function update(p = {}) {
    const received = Number(p.received) || 0;
    const total = Number(p.total) || 0;
    if (!fill || !label) return;
    if (typeof p.message === 'string' && p.message.trim()) {
      label.textContent = p.message.trim();
      if (p.indeterminate) {
        fill.classList.add('dialog-progress-indeterminate');
        fill.style.width = '40%';
      }
      return;
    }
    if (total > 0) {
      fill.classList.remove('dialog-progress-indeterminate');
      const pct = Math.min(100, (received / total) * 100);
      fill.style.width = `${pct}%`;
      label.textContent = `${Math.floor(pct)}% · ${formatDownloadBytes(received)} / ${formatDownloadBytes(total)}`;
    } else {
      fill.classList.add('dialog-progress-indeterminate');
      fill.style.width = '40%';
      label.textContent = `已下载 ${formatDownloadBytes(received)}（未返回文件总大小，无法显示百分比）`;
    }
  }

  function close() {
    closeDialog(false);
  }

  return { update, close };
}

/** 账号切换等任务进度（顶部状态栏，不阻塞界面操作） */
export function openSwitchProgressDialog(options = {}) {
  showGlobalLoading({
    title: options.title || '正在处理',
    message: options.subtitle || '准备中…',
  });
  return {
    update: (patch = {}) => {
      updateGlobalLoading({
        title: patch.title,
        message: patch.message || patch.subtitle,
      });
    },
    close: () => hideGlobalLoading(),
  };
}
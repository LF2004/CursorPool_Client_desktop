import { $ } from './dom.js';

let loadingDepth = 0;

function paintSoon() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function formatLoadingText(title, message) {
  const text = (message || title || '处理中').trim();
  if (/[.…]$/.test(text)) return text;
  return `${text}…`;
}

function applyLoadingUi(title, message) {
  const root = $('appGlobalLoading');
  if (!root) return;
  const textEl = $('appGlobalLoadingText');
  if (textEl) textEl.textContent = formatLoadingText(title, message);
  root.classList.remove('hidden');
  root.setAttribute('aria-busy', 'true');
}

export function showGlobalLoading(options = {}) {
  const opts = typeof options === 'string' ? { title: options } : options;
  loadingDepth += 1;
  applyLoadingUi(opts.title || '处理中…', opts.message || '');
}

export function updateGlobalLoading(options = {}) {
  const opts = typeof options === 'string' ? { message: options } : options;
  if (loadingDepth <= 0) {
    showGlobalLoading(opts);
    return;
  }
  const textEl = $('appGlobalLoadingText');
  if (!textEl) return;
  const title = opts.title || textEl.textContent.replace(/…$/, '');
  const message = typeof opts.message === 'string' ? opts.message : '';
  textEl.textContent = formatLoadingText(title, message);
}

export function hideGlobalLoading() {
  loadingDepth = Math.max(0, loadingDepth - 1);
  if (loadingDepth > 0) return;
  const root = $('appGlobalLoading');
  if (root) {
    root.classList.add('hidden');
    root.setAttribute('aria-busy', 'false');
  }
}

export async function withGlobalLoading(options, fn) {
  const opts = typeof options === 'function'
    ? { title: '处理中…' }
    : (typeof options === 'string' ? { title: options } : (options || {}));
  const runner = typeof options === 'function' ? options : fn;
  if (typeof runner !== 'function') {
    throw new Error('withGlobalLoading requires a function');
  }

  showGlobalLoading(opts);
  await paintSoon();
  try {
    return await runner((patch = {}) => updateGlobalLoading(patch));
  } finally {
    hideGlobalLoading();
  }
}

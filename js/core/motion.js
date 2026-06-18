/**
 * 统一 UI 动效（anime.js v4）。替代 styles.css 中的 @keyframes 页面/弹窗动画。
 */

const PREF_ANIMATION = 'pref_animation';

export function isAnimationEnabled() {
  try {
    return localStorage.getItem(PREF_ANIMATION) === 'on';
  } catch {
    return false;
  }
}

export function applyAnimationPreference() {
  const enabled = isAnimationEnabled();
  document.body.classList.toggle('animations-on', enabled);
  document.body.classList.toggle('animations-off', !enabled);
}

function getAnimateFn() {
  if (typeof window === 'undefined') return null;
  const lib = window.anime;
  if (!lib) return null;
  // v4 UMD: window.anime.animate(targets, options)
  if (typeof lib.animate === 'function') return lib.animate.bind(lib);
  // v3 兼容：window.anime 本身为函数
  if (typeof lib === 'function') return lib;
  return null;
}

function runAnimation(target, params) {
  if (!isAnimationEnabled()) return Promise.resolve();
  const animate = getAnimateFn();
  if (!animate || !target) return Promise.resolve();
  const anim = animate(target, params);
  if (anim && typeof anim.then === 'function') {
    return anim.then().catch(() => {});
  }
  if (anim && anim.finished && typeof anim.finished.then === 'function') {
    return anim.finished.catch(() => {});
  }
  return Promise.resolve();
}

export function animatePageEnter(el) {
  if (!el || !isAnimationEnabled()) return Promise.resolve();
  el.style.opacity = '0';
  el.style.transform = 'translateY(10px) scale(0.99)';
  return runAnimation(el, {
    opacity: { from: 0, to: 1 },
    y: { from: 10, to: 0 },
    scale: { from: 0.99, to: 1 },
    duration: 260,
    ease: 'out(3)',
  }).finally(() => {
    el.style.opacity = '';
    el.style.transform = '';
  });
}

export function animatePageExit(el) {
  if (!el || !isAnimationEnabled()) return Promise.resolve();
  return runAnimation(el, {
    opacity: { from: 1, to: 0 },
    y: { from: 0, to: -6 },
    scale: { from: 1, to: 0.99 },
    duration: 200,
    ease: 'in(2)',
  }).finally(() => {
    el.style.opacity = '';
    el.style.transform = '';
  });
}

export function animateDialogShow(backdrop, card) {
  if (backdrop) backdrop.style.opacity = '0';
  if (card) {
    card.style.opacity = '0';
    card.style.transform = 'translateY(10px) scale(0.98)';
  }
  const tasks = [];
  if (backdrop) {
    tasks.push(
      runAnimation(backdrop, {
        opacity: { from: 0, to: 1 },
        duration: 220,
        ease: 'out(2)',
      }),
    );
  }
  if (card) {
    tasks.push(
      runAnimation(card, {
        opacity: { from: 0, to: 1 },
        y: { from: 10, to: 0 },
        scale: { from: 0.98, to: 1 },
        duration: 260,
        ease: 'out(3)',
        delay: 20,
      }),
    );
  }
  return Promise.all(tasks).catch(() => {}).finally(() => {
    if (backdrop) backdrop.style.opacity = '';
    if (card) {
      card.style.opacity = '';
      card.style.transform = '';
    }
  });
}

export function animateDialogHide(backdrop, card) {
  const tasks = [];
  if (card) {
    tasks.push(
      runAnimation(card, {
        opacity: { from: 1, to: 0 },
        y: { from: 0, to: 8 },
        scale: { from: 1, to: 0.98 },
        duration: 180,
        ease: 'in(2)',
      }),
    );
  }
  if (backdrop) {
    tasks.push(
      runAnimation(backdrop, {
        opacity: { from: 1, to: 0 },
        duration: 180,
        ease: 'in(2)',
        delay: 40,
      }),
    );
  }
  return Promise.all(tasks).catch(() => {});
}

export function animateSubpanel(el) {
  if (!el || !isAnimationEnabled()) return;
  el.style.opacity = '0';
  el.style.transform = 'translateY(6px)';
  runAnimation(el, {
    opacity: { from: 0, to: 1 },
    y: { from: 6, to: 0 },
    duration: 240,
    ease: 'out(2)',
  }).finally(() => {
    el.style.opacity = '';
    el.style.transform = '';
  });
}

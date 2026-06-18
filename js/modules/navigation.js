import { animatePageEnter, animatePageExit, isAnimationEnabled } from '../core/motion.js';

let pageSwitchSeq = 0;

export function showPage(pages, page) {
  const next = pages.includes(page) ? page : pages[0];

  const current = pages.find((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
  const currentEl = current ? document.getElementById(current) : null;
  const nextEl = document.getElementById(next);
  let exitingEl = currentEl && currentEl !== nextEl ? currentEl : null;

  if (nextEl) {
    pages.forEach((id) => {
      const el = document.getElementById(id);
      if (!el || el === nextEl) return;
      el.classList.remove('page-enter', 'page-exit');
    });

    nextEl.classList.remove('hidden', 'page-exit');
    if (isAnimationEnabled()) {
      nextEl.classList.add('page-enter');
      animatePageEnter(nextEl).finally(() => {
        nextEl.classList.remove('page-enter');
        nextEl.style.opacity = '';
        nextEl.style.transform = '';
      });
    }

    if (exitingEl) {
      if (isAnimationEnabled()) {
        exitingEl.classList.remove('page-enter');
        exitingEl.classList.add('page-exit');
        const seq = ++pageSwitchSeq;
        animatePageExit(exitingEl).finally(() => {
          if (seq !== pageSwitchSeq) return;
          if (!exitingEl) return;
          exitingEl.classList.add('hidden');
          exitingEl.classList.remove('page-exit');
          exitingEl.style.opacity = '';
          exitingEl.style.transform = '';
        });
      } else {
        exitingEl.classList.add('hidden');
        exitingEl.classList.remove('page-enter', 'page-exit');
        exitingEl.style.opacity = '';
        exitingEl.style.transform = '';
        exitingEl = null;
      }
    }
  }

  pages.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', el !== nextEl && el !== exitingEl);
  });

  document.querySelectorAll('.nav-item[data-page]').forEach((btn) => btn.classList.toggle('active', btn.dataset.page === next));
  return next;
}

export function bindNav(pages, onPage) {
  let isSwitchingPage = false;

  document.querySelectorAll('.nav-item[data-page]').forEach((btn) => {
    btn.onclick = () => {
      if (isSwitchingPage) return;
      const targetPage = btn.dataset.page;
      if (!targetPage) return;
      isSwitchingPage = true;
      requestAnimationFrame(() => {
        try {
          onPage(showPage(pages, targetPage));
        } finally {
          isSwitchingPage = false;
        }
      });
    };
  });
}

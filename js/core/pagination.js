import { $ } from './dom.js';

export const DEFAULT_PAGE_SIZE = 10;

export function normalizePagination(input = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || DEFAULT_PAGE_SIZE));
  const total = Math.max(0, Number(input.total) || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const page = Math.min(Math.max(1, Number(input.page) || 1), totalPages);
  return { page, pageSize, total, totalPages };
}

export function parsePagedResponse(data, page, pageSize = DEFAULT_PAGE_SIZE) {
  if (Array.isArray(data)) {
    const total = data.length;
    const normalized = normalizePagination({ page, pageSize, total });
    const start = (normalized.page - 1) * normalized.pageSize;
    return {
      list: data.slice(start, start + normalized.pageSize),
      ...normalized,
    };
  }

  const rawList = Array.isArray(data?.list) ? data.list : [];
  const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : rawList.length;
  const normalized = normalizePagination({
    page: Number(data?.page) || page,
    pageSize: Number(data?.pageSize) || pageSize,
    total,
  });
  const list = rawList.length > normalized.pageSize
    ? rawList.slice(0, normalized.pageSize)
    : rawList;

  return { list, ...normalized };
}

function buildPageSequence(current, totalPages) {
  if (totalPages <= 1) return totalPages === 1 ? [1] : [];
  if (totalPages <= 9) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  if (current <= 4) {
    const head = Array.from({ length: 7 }, (_, i) => i + 1);
    return [...head, 'ellipsis-end', totalPages];
  }

  if (current >= totalPages - 3) {
    const tail = Array.from({ length: 7 }, (_, i) => totalPages - 6 + i);
    return [1, 'ellipsis-start', ...tail];
  }

  return [
    1,
    'ellipsis-start',
    current - 2,
    current - 1,
    current,
    current + 1,
    current + 2,
    'ellipsis-end',
    totalPages,
  ];
}

function renderNavItem(item, current) {
  if (item === 'ellipsis-start') {
    return '<span class="record-pagination-ellipsis" aria-hidden="true">…</span>';
  }
  if (item === 'ellipsis-end') {
    return '<span class="record-pagination-jump" aria-hidden="true"><i class="fa fa-long-arrow-right"></i></span>';
  }
  const active = item === current;
  if (active) {
    return `<span class="record-pagination-num active" aria-current="page">${item}</span>`;
  }
  return `<button type="button" class="record-pagination-num" data-page="${item}" aria-label="第 ${item} 页">${item}</button>`;
}

export function renderPaginationHtml(state, options = {}) {
  const { page, pageSize, total, totalPages } = normalizePagination(state);
  const totalLabel = `<div class="record-pagination-total">共 <strong>${total}</strong> 条</div>`;
  const alwaysShowNav = Boolean(options.alwaysShowNav);

  if (total <= 0) {
    return `${totalLabel}<nav class="record-pagination-nav" aria-label="分页"></nav>`;
  }

  const sequence = buildPageSequence(page, totalPages);
  const items = sequence.map((item) => renderNavItem(item, page)).join('');
  const showArrows = totalPages > 1 || alwaysShowNav;

  return `
    ${totalLabel}
    <nav class="record-pagination-nav" aria-label="分页">
      ${showArrows ? `<button type="button" class="record-pagination-arrow" data-page="prev" aria-label="上一页"${page <= 1 ? ' disabled' : ''}><i class="fa fa-chevron-left" aria-hidden="true"></i></button>` : ''}
      ${items || '<span class="record-pagination-num active" aria-current="page">1</span>'}
      ${showArrows ? `<button type="button" class="record-pagination-arrow" data-page="next" aria-label="下一页"${page >= totalPages ? ' disabled' : ''}><i class="fa fa-chevron-right" aria-hidden="true"></i></button>` : ''}
    </nav>
  `;
}

export function mountPagination(containerId, state, onPageChange, options = {}) {
  const root = typeof containerId === 'string' ? $(containerId) : containerId;
  if (!root) return;

  const normalized = normalizePagination(state);
  root.classList.toggle('hidden', normalized.total <= 0 && !options.alwaysShowNav);
  root.innerHTML = `<div class="record-pagination-bar">${renderPaginationHtml(normalized, options)}</div>`;

  if (normalized.total <= 0) {
    root.onclick = null;
    return;
  }

  root.onclick = (event) => {
    const btn = event.target.closest?.('button[data-page]');
    if (!btn || btn.disabled) return;
    const raw = btn.getAttribute('data-page');
    let next = normalized.page;
    if (raw === 'prev') next -= 1;
    else if (raw === 'next') next += 1;
    else next = Number(raw);
    if (!Number.isFinite(next) || next === normalized.page) return;
    onPageChange?.(Math.min(Math.max(1, next), normalized.totalPages));
  };
}

export function paginateList(list, page, pageSize) {
  const normalized = normalizePagination({ page, pageSize, total: list.length });
  const start = (normalized.page - 1) * normalized.pageSize;
  return {
    ...normalized,
    items: list.slice(start, start + normalized.pageSize),
  };
}

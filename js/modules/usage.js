import { $ } from '../core/dom.js';
import { showAlert, showConfirm } from '../core/dialog.js';
import { DEFAULT_PAGE_SIZE, mountPagination, parsePagedResponse } from '../core/pagination.js';
import { reasoningEffortLabel } from './relay-profiles.js';

const usagePageState = { page: 1, pageSize: 20, total: 0 };
const USAGE_POLL_INTERVAL_MS = 1000;
const USAGE_VIEW_MODES = {
  compact: 'compact',
  detail: 'detail',
};
const usageViewState = {
  mode: USAGE_VIEW_MODES.compact,
};

let usagePollTimer = null;
let usagePollActive = false;
let usageRefreshInFlight = false;
let usagePollPaused = false;
let usageScrollEndTimer = null;
let lastUsageFingerprint = '';
let lastUsageRows = [];
let pendingUsageRows = null;
let pendingUsageApply = null;

function getUsageVisibleColumnCount() {
  return usageViewState.mode === USAGE_VIEW_MODES.detail ? 10 : 7;
}

function formatUsageModeLabel(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'AGENT_MODE_PLAN' || text === 'PLAN') return 'Plan';
  if (text === 'AGENT_MODE_ASK' || text === 'ASK') return 'Ask';
  if (text === 'AGENT_MODE_MULTITASK' || text === 'MULTITASK' || text === 'TASK') return 'Multitask';
  return 'Agent';
}

function applyUsageViewMode(mode = USAGE_VIEW_MODES.compact) {
  usageViewState.mode = mode === USAGE_VIEW_MODES.detail ? USAGE_VIEW_MODES.detail : USAGE_VIEW_MODES.compact;
  const root = $('usage');
  if (root) root.dataset.usageView = usageViewState.mode;
  const compactBtn = $('usageViewCompactBtn');
  const detailBtn = $('usageViewDetailBtn');
  if (compactBtn) {
    const active = usageViewState.mode === USAGE_VIEW_MODES.compact;
    compactBtn.classList.toggle('active', active);
    compactBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (detailBtn) {
    const active = usageViewState.mode === USAGE_VIEW_MODES.detail;
    detailBtn.classList.toggle('active', active);
    detailBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatNumber(value, digits = 0) {
  const number = Number(value) || 0;
  return number.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatCompactToken(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${formatNumber(number / 1_000_000, 2)}M`;
  if (number >= 1_000) return `${formatNumber(number / 1_000, 1)}K`;
  return formatNumber(number);
}

function formatUsd(value, digits = 6) {
  return `$${formatNumber(Number(value) || 0, digits)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setUsageLoading(loading) {
  const body = $('usageTableBody');
  if (!body) return;
  if (loading) {
    body.innerHTML = `<tr><td colspan="${getUsageVisibleColumnCount()}" class="record-table-loading"><i class="fa fa-spinner fa-spin" aria-hidden="true"></i> 加载中…</td></tr>`;
  }
  const root = $('usagePagination');
  if (root) root.classList.toggle('record-pagination-busy', Boolean(loading));
}

function getBillingScopeFilter() {
  const value = String($('usageBillingScopeFilter')?.value || 'all').trim().toLowerCase();
  if (value === 'platform' || value === 'local') return value;
  return 'all';
}

function getFilters(page = usagePageState.page) {
  const billingScope = getBillingScopeFilter();
  return {
    page,
    pageSize: usagePageState.pageSize || DEFAULT_PAGE_SIZE,
    billingScope,
    platformBillingOnly: billingScope === 'platform' ? true : billingScope === 'local' ? false : undefined,
    from: $('usageDateFrom')?.value || '',
    to: $('usageDateTo')?.value || '',
    model: $('usageModelFilter')?.value?.trim() || '',
    cursorAgentAccount: $('usageAccountFilter')?.value?.trim() || '',
    requestId: $('usageRequestFilter')?.value?.trim() || '',
  };
}

function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function renderPriceSources(data = {}) {
  const sources = Array.isArray(data.priceSources) && data.priceSources.length
    ? data.priceSources
    : [
      { label: 'OpenAI', url: 'https://openai.com/api/pricing/' },
      { label: 'Anthropic', url: 'https://www.anthropic.com/pricing' },
      { label: 'DeepSeek', url: 'https://api-docs.deepseek.com/quick_start/pricing' },
      { label: 'Gemini', url: 'https://ai.google.dev/gemini-api/docs/pricing' },
      { label: 'MiMo', url: 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go' },
    ];
  const links = sources.map((item) => (
    `<a href="#" class="usage-link" data-external-url="${escapeHtml(item.url)}">${escapeHtml(item.label)}</a>`
  )).join(' / ');
}

const CACHE_GAUGE_ARC_LENGTH = 157.08;

function computeCacheStats(summary = {}) {
  const inputTokens = Number(summary.input_tokens) || 0;
  const cachedTokens = Number(summary.cached_input_tokens) || 0;
  const outputTokens = Number(summary.output_tokens) || 0;
  const totalTokens = Number(summary.total_tokens) || (inputTokens + outputTokens);
  const billablePrompt = Math.max(0, inputTokens - cachedTokens);
  const cacheHitRate = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : null;
  return {
    inputTokens,
    cachedTokens,
    outputTokens,
    totalTokens,
    billablePrompt,
    cacheHitRate,
  };
}

function renderCacheSummary(summary = {}) {
  const stats = computeCacheStats(summary);
  const rateText = stats.cacheHitRate == null ? '-' : `${formatNumber(stats.cacheHitRate, 2)}%`;
  setTextIfChanged($('usageCacheHitRate'), rateText);
  setTextIfChanged($('usageCacheTokenTotal'), formatCompactToken(stats.totalTokens));
  setTextIfChanged($('usageCachePromptTotal'), formatCompactToken(stats.inputTokens));
  setTextIfChanged($('usageCachePromptCached'), formatCompactToken(stats.cachedTokens));
  setTextIfChanged($('usageCachePromptBillable'), formatCompactToken(stats.billablePrompt));
  const fill = $('usageCacheGaugeFill');
  if (fill) {
    const rate = stats.cacheHitRate == null ? 0 : Math.min(100, Math.max(0, stats.cacheHitRate));
    const offset = CACHE_GAUGE_ARC_LENGTH * (1 - rate / 100);
    const nextOffset = String(offset);
    if (fill.getAttribute('stroke-dashoffset') !== nextOffset) {
      fill.setAttribute('stroke-dashoffset', nextOffset);
    }
  }
}

function renderSummary(data = {}) {
  const summary = data.summary || {};
  const totalTokens = Number(summary.total_tokens) || 0;
  const success = Number(summary.success_count) || 0;
  const pending = Number(summary.pending_count) || 0;
  const errors = Number(summary.error_count) || 0;
  setTextIfChanged($('usageSummaryCount'), formatNumber(summary.count || data.total || 0));
  setTextIfChanged($('usageSummaryTokens'), formatCompactToken(totalTokens));
  setTextIfChanged($('usageSummaryCost'), formatUsd(summary.total_cost_usd || 0));
  renderCacheSummary(summary);
  setTextIfChanged($('usageSummaryStatus'), `${success} / ${pending} / ${errors}`);
  const dbPath = data.dbPath || '-';
  const dbPathEl = $('usageDbPath');
  if (dbPathEl) {
    setTextIfChanged(dbPathEl, dbPath);
    if (dbPathEl.title !== dbPath) dbPathEl.title = dbPath;
  }
  const currentAccount = String(data.currentCursorAgentAccount || '').trim();
  const accountEl = $('usageCurrentAccountText');
  const accountChip = $('usageCurrentAccount');
  setTextIfChanged(accountEl, currentAccount || '未检测到 Cursor 账户');
  if (accountChip) {
    accountChip.classList.toggle('usage-account-chip-empty', !currentAccount);
    const nextTitle = currentAccount
      ? `当前 Cursor Agent 账户：${currentAccount}`
      : '未能从 state.vscdb 读取当前 Cursor 账户';
    if (accountChip.title !== nextTitle) accountChip.title = nextTitle;
  }
  renderPriceSources(data);
}

let usagePopoverEl = null;
let usagePopoverTimer = null;

function hideUsagePopover() {
  if (usagePopoverTimer) {
    clearTimeout(usagePopoverTimer);
    usagePopoverTimer = null;
  }
  usagePopoverEl?.remove();
  usagePopoverEl = null;
  if (pendingUsageRows) {
    const rows = pendingUsageRows;
    pendingUsageRows = null;
    renderRows(rows, { preserveScroll: true });
  } else {
    flushPendingUsageApply();
  }
}

function isUsageTableScrolling() {
  return Boolean(usagePollPaused);
}

function bindUsageTableScrollGuard() {
  const scroller = document.querySelector('#usage .usage-table-scroll');
  if (!scroller || scroller.dataset.usageScrollBound) return;
  scroller.dataset.usageScrollBound = '1';
  scroller.addEventListener('scroll', () => {
    usagePollPaused = true;
    clearTimeout(usageScrollEndTimer);
    usageScrollEndTimer = setTimeout(() => {
      usagePollPaused = false;
      if (pendingUsageApply) {
        const pending = pendingUsageApply;
        pendingUsageApply = null;
        requestAnimationFrame(() => applyUsageData(pending.data, pending.paged, { silent: true }));
      } else {
        refreshUsage(usagePageState.page, { silent: true }).catch(() => {});
      }
    }, 180);
  }, { passive: true });
}

function flushPendingUsageApply() {
  if (!pendingUsageApply || usagePollPaused || usagePopoverEl) return;
  const pending = pendingUsageApply;
  pendingUsageApply = null;
  requestAnimationFrame(() => applyUsageData(pending.data, pending.paged, { silent: true }));
}

function isUsagePageVisible() {
  const panel = $('usage');
  const panelSection = $('panelSection');
  if (!panel || panel.classList.contains('hidden')) return false;
  if (panelSection?.classList.contains('hidden')) return false;
  return true;
}

function applyUsageRows(paged, { silent = false } = {}) {
  if (silent && usagePopoverEl) {
    pendingUsageRows = paged.list;
    return;
  }
  pendingUsageRows = null;
  renderRows(paged.list, { preserveScroll: silent });
}

function buildUsageFingerprint(data = {}, rows = []) {
  const summary = data.summary || {};
  const rowSig = rows.map((row) => [
    row.id,
    row.mode,
    row.phase,
    row.status,
    row.billed_points,
    row.total_tokens,
    row.total_cost_usd,
  ].join(':')).join('|');
  return [
    data.total ?? 0,
    summary.count ?? 0,
    summary.total_tokens ?? 0,
    summary.total_cost_usd ?? 0,
    summary.input_tokens ?? 0,
    summary.cached_input_tokens ?? 0,
    summary.success_count ?? 0,
    summary.pending_count ?? 0,
    summary.error_count ?? 0,
    rowSig,
  ].join(';');
}

function positionUsagePopover(anchor, popover) {
  const anchorRect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 12;
  let top = anchorRect.bottom + 8;
  let left = anchorRect.left + anchorRect.width / 2 - popRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
  if (top + popRect.height > window.innerHeight - margin) {
    top = anchorRect.top - popRect.height - 8;
  }
  popover.style.top = `${Math.max(margin, top)}px`;
  popover.style.left = `${left}px`;
}

function buildTokenPopoverHtml(dataset) {
  const inputTokens = Number(dataset.inputTokens) || 0;
  const outputTokens = Number(dataset.outputTokens) || 0;
  const cachedTokens = Number(dataset.cachedTokens) || 0;
  const totalTokens = Number(dataset.totalTokens) || inputTokens + outputTokens + cachedTokens;
  return `
    <div class="usage-popover-title">Token 明细</div>
    <div class="usage-popover-rows">
      <div class="usage-popover-row"><span>输入 Token</span><span class="mono">${formatNumber(inputTokens)}</span></div>
      <div class="usage-popover-row"><span>输出 Token</span><span class="mono">${formatNumber(outputTokens)}</span></div>
      <div class="usage-popover-row"><span>缓存读取</span><span class="mono">${formatNumber(cachedTokens)}</span></div>
    </div>
    <div class="usage-popover-divider"></div>
    <div class="usage-popover-row usage-popover-total"><span>总 Token</span><span class="mono">${formatNumber(totalTokens)}</span></div>
  `;
}

function buildCostPopoverHtml(dataset) {
  return `
    <div class="usage-popover-title">费用明细</div>
    <div class="usage-popover-rows">
      <div class="usage-popover-row"><span>输入成本</span><span class="mono">${formatUsd(dataset.inputCost)}</span></div>
      <div class="usage-popover-row"><span>缓存输入成本</span><span class="mono">${formatUsd(dataset.cachedInputCost)}</span></div>
      <div class="usage-popover-row"><span>输出成本</span><span class="mono">${formatUsd(dataset.outputCost)}</span></div>
    </div>
    <div class="usage-popover-divider"></div>
    <div class="usage-popover-rows">
      <div class="usage-popover-row"><span>输入单价</span><span class="mono">$${formatNumber(dataset.inputPrice || 0, 4)} / 1M</span></div>
      <div class="usage-popover-row"><span>缓存输入单价</span><span class="mono">$${formatNumber(dataset.cachedInputPrice || 0, 4)} / 1M</span></div>
      <div class="usage-popover-row"><span>输出单价</span><span class="mono">$${formatNumber(dataset.outputPrice || 0, 4)} / 1M</span></div>
    </div>
    <div class="usage-popover-divider"></div>
    <div class="usage-popover-rows">
      <div class="usage-popover-row"><span>本地估算</span><span class="mono">${formatNumber(dataset.localPoints || 0, 4)} 点</span></div>
      <div class="usage-popover-row"><span>平台扣费</span><span class="mono">${Number(dataset.billedPoints) > 0 ? `${formatNumber(dataset.billedPoints, 4)} 点` : '待确认'}</span></div>
      <div class="usage-popover-row"><span>来源</span><span class="usage-popover-source">${escapeHtml(dataset.priceSource || '-')}</span></div>
    </div>
  `;
}

function showUsagePopover(anchor, html) {
  hideUsagePopover();
  const popover = document.createElement('div');
  popover.className = 'usage-popover';
  popover.innerHTML = html;
  popover.onmouseenter = () => {
    if (usagePopoverTimer) {
      clearTimeout(usagePopoverTimer);
      usagePopoverTimer = null;
    }
  };
  popover.onmouseleave = () => {
    usagePopoverTimer = setTimeout(hideUsagePopover, 120);
  };
  document.body.appendChild(popover);
  positionUsagePopover(anchor, popover);
  usagePopoverEl = popover;
}

function buildTokenHelpPopoverHtml() {
  return `
    <div class="usage-popover-title">Token 说明</div>
    <div class="usage-popover-rows">
      <div class="usage-popover-row"><span class="usage-token usage-token-in"><i class="fa fa-arrow-down" aria-hidden="true"></i> 输入</span><span>Prompt Token</span></div>
      <div class="usage-popover-row"><span class="usage-token usage-token-out"><i class="fa fa-arrow-up" aria-hidden="true"></i> 输出</span><span>Completion Token</span></div>
      <div class="usage-popover-row"><span class="usage-token usage-token-cache"><i class="fa fa-minus-square" aria-hidden="true"></i> 缓存</span><span>Cache Read Token</span></div>
    </div>
  `;
}

function buildCacheHelpPopoverHtml() {
  return `
    <div class="usage-popover-title">缓存命中率说明</div>
    <div class="usage-popover-rows">
      <div class="usage-popover-row"><span>命中率</span><span class="mono">缓存读取 ÷ Prompt 消耗</span></div>
      <div class="usage-popover-row"><span>Token 消耗</span><span>输入 + 输出 Token 总量</span></div>
      <div class="usage-popover-row"><span>Prompt 消耗</span><span>全部 Prompt Token</span></div>
      <div class="usage-popover-row"><span>非缓存 Prompt</span><span>按官方定价计费的输入 Token</span></div>
    </div>
  `;
}

function attachUsagePopoverHandlers() {
  document.querySelectorAll('.usage-table .usage-info-btn, #usageTableBody .usage-info-btn, #usage .usage-cache-info-btn').forEach((btn) => {
    btn.onmouseenter = () => {
      if (usagePopoverTimer) {
        clearTimeout(usagePopoverTimer);
        usagePopoverTimer = null;
      }
      const type = btn.dataset.popover;
      let html = '';
      if (type === 'token') html = buildTokenPopoverHtml(btn.dataset);
      else if (type === 'cost') html = buildCostPopoverHtml(btn.dataset);
      else if (type === 'token-help') html = buildTokenHelpPopoverHtml();
      else if (type === 'cache-help') html = buildCacheHelpPopoverHtml();
      if (!html) return;
      showUsagePopover(btn, html);
    };
    btn.onmouseleave = () => {
      usagePopoverTimer = setTimeout(hideUsagePopover, 120);
    };
  });
}

function renderRows(rows = [], { preserveScroll = false } = {}) {
  const body = $('usageTableBody');
  if (!body) return;
  const scroller = preserveScroll ? document.querySelector('#usage .usage-table-scroll') : null;
  const scrollTop = scroller?.scrollTop ?? 0;
  lastUsageRows = Array.isArray(rows) ? rows : [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${getUsageVisibleColumnCount()}" class="record-table-loading">暂无调用记录</td></tr>`;
    return;
  }
  const isDetail = usageViewState.mode === USAGE_VIEW_MODES.detail;
  body.innerHTML = rows.map((row) => {
    const status = String(row.status || 'unknown');
    // 解析缓存命中状态（优先从 status 字段判断，再从 meta_json 兜底）
    let cacheHit = null;
    if (status === 'cache_hit') {
      try { cacheHit = JSON.parse(row.meta_json || '{}').cacheHit || { layer: 'unknown' }; } catch { cacheHit = { layer: 'unknown' }; }
    } else {
      try { cacheHit = JSON.parse(row.meta_json || '{}').cacheHit || null; } catch { /* ignore */ }
    }
    const isCacheHit = !!cacheHit || status === 'cache_hit';
    const cacheLayer = cacheHit?.layer || '';
    const statusClass = isCacheHit
      ? 'usage-status-cache'
      : status === 'success'
        ? 'usage-status-ok'
        : ['paid', 'pending'].includes(status)
          ? 'usage-status-paid'
          : ['stop', 'stopped', 'aborted', 'cancelled', 'canceled'].includes(status)
            ? 'usage-status-stop'
            : 'usage-status-warn';
    const statusLabel = isCacheHit ? (cacheLayer ? `${cacheLayer.toUpperCase()} CACHE` : 'CACHE') : status.toUpperCase();
    const reasoningEffort = String(row.reasoning_effort || '').trim();
    const phase = String(row.phase || '-');
    const endpointMode = String(row.endpoint_mode || '').trim();
    const modeLabel = formatUsageModeLabel(row.mode);
    // 缓存命中：费用归零显示，token 显示缓存标记
    const displayCost = isCacheHit ? '$0.000000' : formatUsd(row.total_cost_usd);
    // 构建状态单元格（含缓存标记）
    const statusCellHtml = `<span class="usage-status ${statusClass}" title="${escapeHtml(row.error || '')}">${escapeHtml(statusLabel)}</span>`
      + (isCacheHit
        ? ` <span class="usage-cache-hit-badge" title="缓存回放 (${cacheLayer})"><i class="fa fa-bolt" aria-hidden="true"></i></span>`
        : ''
      );
    return `
      <tr class="${isCacheHit ? 'usage-row-cache-hit' : ''}">
        <td class="mono usage-time">${escapeHtml(formatDate(row.created_at))}</td>
        <td class="usage-model-cell">
          <div class="usage-model mono" title="${escapeHtml(row.model || '')}">${escapeHtml(row.model || '-')}</div>
          <div class="usage-model-meta">
            ${row.model_label ? `<span class="usage-muted">${escapeHtml(row.model_label)}</span>` : ''}
            ${isCacheHit && !isDetail ? `<span class="usage-cache-tag usage-muted">CACHE</span>` : ''}
          </div>
        </td>
        <td class="usage-mode-cell"><span class="usage-mode-badge">${escapeHtml(modeLabel)}</span></td>
        <td class="usage-reasoning-cell" title="${escapeHtml(reasoningEffort || '未记录')}">${escapeHtml(reasoningEffort ? reasoningEffortLabel(reasoningEffort) : '-')}</td>
        ${isDetail ? `<td class="usage-phase-cell">
          <span class="mono">${escapeHtml(phase)}</span>${endpointMode ? `<span class="usage-muted"> · ${escapeHtml(endpointMode)}</span>` : ''}
        </td>` : ''}
        <td class="usage-token-cell">
          <div class="usage-token-content">
            <div class="usage-token-row">
              <span class="usage-token usage-token-in"><i class="fa fa-arrow-down" aria-hidden="true"></i>${formatCompactToken(row.input_tokens)}</span>
              <span class="usage-token usage-token-out"><i class="fa fa-arrow-up" aria-hidden="true"></i>${formatCompactToken(row.output_tokens)}</span>
              <span class="usage-token usage-token-cache"><i class="fa fa-minus-square" aria-hidden="true"></i>${formatCompactToken(row.cached_input_tokens)}</span>
            </div>
            <button type="button" class="usage-info-btn" aria-label="Token 明细" data-popover="token"
              data-input-tokens="${Number(row.input_tokens) || 0}"
              data-output-tokens="${Number(row.output_tokens) || 0}"
              data-cached-tokens="${Number(row.cached_input_tokens) || 0}"
              data-total-tokens="${Number(row.total_tokens) || 0}">
              <i class="fa fa-question-circle" aria-hidden="true"></i>
            </button>
          </div>
        </td>
        <td class="usage-cost-cell">
          <div class="usage-cost-main">
            <span class="usage-cost-value mono${isCacheHit ? ' usage-cost-cache' : ''}">${displayCost}</span>
            ${!isCacheHit ? `<button type="button" class="usage-info-btn" aria-label="费用明细" data-popover="cost"
              data-input-cost="${Number(row.input_cost_usd) || 0}"
              data-cached-input-cost="${Number(row.cached_input_cost_usd) || 0}"
              data-output-cost="${Number(row.output_cost_usd) || 0}"
              data-input-price="${Number(row.input_price_per_million) || 0}"
              data-cached-input-price="${Number(row.cached_input_price_per_million) || 0}"
              data-output-price="${Number(row.output_price_per_million) || 0}"
              data-local-points="${Number(row.points) || 0}"
              data-billed-points="${Number(row.billed_points) || 0}"
              data-points="${Number(row.billed_points) || Number(row.points) || 0}"
              data-price-source="${escapeHtml(row.price_source || '')}">
              <i class="fa fa-question-circle" aria-hidden="true"></i>
            </button>` : ''}
          </div>
        </td>
        <td>${statusCellHtml}</td>
        ${isDetail ? `<td class="usage-cache-cell">${isCacheHit
          ? `<span class="usage-cache-detail" title="本地缓存回放，跳过上游请求"><i class="fa fa-bolt" aria-hidden="true"></i> <strong>${cacheLayer.toUpperCase()}</strong> 命中</span>`
          : '<span class="usage-muted">-</span>'
        }</td>` : ''}
        ${isDetail ? `<td class="mono usage-request" title="${escapeHtml(row.request_id || '')}">${escapeHtml(row.request_id || '-')}</td>` : ''}
      </tr>
    `;
  }).join('');
  attachUsagePopoverHandlers();
  if (preserveScroll && scroller) scroller.scrollTop = scrollTop;
}

function applyUsageData(data, paged, { silent = false } = {}) {
  const fingerprint = buildUsageFingerprint(data, paged.list);
  if (silent && fingerprint === lastUsageFingerprint) return;

  const prevPage = usagePageState.page;
  const prevTotal = usagePageState.total;
  const prevPageSize = usagePageState.pageSize;
  const dataChanged = fingerprint !== lastUsageFingerprint;

  usagePageState.page = paged.page;
  usagePageState.pageSize = paged.pageSize;
  usagePageState.total = paged.total;

  if (silent && isUsageTableScrolling()) {
    pendingUsageApply = { data, paged };
    return;
  }

  lastUsageFingerprint = fingerprint;
  renderSummary(data);

  if (dataChanged) {
    applyUsageRows(paged, { silent });
  }

  const paginationChanged = prevPage !== paged.page
    || prevTotal !== paged.total
    || prevPageSize !== paged.pageSize;
  if (!silent || paginationChanged || dataChanged) {
    mountPagination('usagePagination', usagePageState, (nextPage) => refreshUsage(nextPage), { alwaysShowNav: true });
  }
}

export async function refreshUsage(page = usagePageState.page, { silent = false } = {}) {
  if (!$('usageTableBody') || !window.electronBridge?.cursorRelayUsageList) return;
  if (silent) {
    if (!isUsagePageVisible() || document.hidden || usageRefreshInFlight || usagePollPaused) return;
  } else {
    lastUsageFingerprint = '';
    pendingUsageRows = null;
    pendingUsageApply = null;
  }

  if (silent) usageRefreshInFlight = true;
  else setUsageLoading(true);

  try {
    const data = await window.electronBridge.cursorRelayUsageList(getFilters(page));
    const paged = parsePagedResponse(data, page, usagePageState.pageSize);
    applyUsageData(data, paged, { silent });
  } catch (error) {
    if (silent) return;
    renderRows([]);
    await showAlert(error?.message || String(error), { title: '读取调用记录失败', tone: 'danger' });
  } finally {
    if (silent) usageRefreshInFlight = false;
    else setUsageLoading(false);
  }
}

export function startUsagePolling() {
  stopUsagePolling();
  usagePollActive = true;
  bindUsageTableScrollGuard();
  const tick = async () => {
    if (!usagePollActive) return;
    await refreshUsage(usagePageState.page, { silent: true }).catch(() => {});
    if (!usagePollActive) return;
    usagePollTimer = setTimeout(tick, USAGE_POLL_INTERVAL_MS);
  };
  usagePollTimer = setTimeout(tick, USAGE_POLL_INTERVAL_MS);
}

export function stopUsagePolling() {
  usagePollActive = false;
  if (usagePollTimer) clearTimeout(usagePollTimer);
  usagePollTimer = null;
  usagePollPaused = false;
  pendingUsageApply = null;
  if (usageScrollEndTimer) clearTimeout(usageScrollEndTimer);
  usageScrollEndTimer = null;
}

export function bindUsageEvents() {
  attachUsagePopoverHandlers();
  applyUsageViewMode(usageViewState.mode);
  const refreshBtn = $('usageRefreshBtn');
  if (refreshBtn) refreshBtn.onclick = () => refreshUsage(1);
  const compactBtn = $('usageViewCompactBtn');
  if (compactBtn) compactBtn.onclick = () => {
    applyUsageViewMode(USAGE_VIEW_MODES.compact);
    renderRows(lastUsageRows, { preserveScroll: true });
  };
  const detailBtn = $('usageViewDetailBtn');
  if (detailBtn) detailBtn.onclick = () => {
    applyUsageViewMode(USAGE_VIEW_MODES.detail);
    renderRows(lastUsageRows, { preserveScroll: true });
  };
  const clearBtn = $('usageClearBtn');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      const ok = await showConfirm('确定清空本地 Relay 调用记录吗？这只会删除 usage.db 中的调用历史。', {
        title: '清空调用记录',
        tone: 'danger',
        confirmText: '清空',
        cancelText: '取消',
      });
      if (!ok) return;
      await window.electronBridge.cursorRelayUsageClear();
      await refreshUsage(1);
    };
  }
  const billingScopeFilter = $('usageBillingScopeFilter');
  if (billingScopeFilter) {
    billingScopeFilter.onchange = () => refreshUsage(1);
  }
  ['usageDateFrom', 'usageDateTo', 'usageModelFilter', 'usageAccountFilter', 'usageRequestFilter'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.onkeydown = (event) => {
      if (event.key === 'Enter') refreshUsage(1);
    };
  });
  const priceSource = $('usagePriceSource');
  if (priceSource) {
    priceSource.onclick = async (event) => {
      const link = event.target.closest?.('.usage-link[data-external-url]');
      if (!link) return;
      event.preventDefault();
      try {
        await window.electronBridge?.openExternal?.(link.dataset.externalUrl);
      } catch (error) {
        await showAlert(error?.message || String(error), { title: '打开链接失败', tone: 'danger' });
      }
    };
  }

  window.addEventListener('scroll', (event) => {
    if (event.target?.closest?.('.usage-table-scroll')) return;
    hideUsagePopover();
  }, true);
  window.addEventListener('resize', hideUsagePopover);
}

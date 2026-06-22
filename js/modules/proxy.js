import { $ } from '../core/dom.js';
import { showAlert, showConfirm } from '../core/dialog.js';
import { withGlobalLoading } from '../core/loading.js';
import { mountPagination, paginateList } from '../core/pagination.js';
import {
  PROVIDER_LABELS,
  PROVIDER_HINTS,
  PROVIDER_BASE_URLS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_OPTIONS,
  VALID_REASONING_EFFORTS,
  getRelayFieldHint,
  reasoningEffortFieldLabel,
  DEFAULT_DEEPSEEK_THINKING_MODE,
  DEFAULT_ENDPOINT_MODE,
  loadProfilesStore,
  saveProfilesStore,
  getActiveProfile,
  getProfileById,
  upsertProfile,
  deleteProfile,
  duplicateProfile,
  setActiveProfile,
  createEmptyProfile,
  profileToUpstreamPayload,
  maskApiKey,
  hostFromBaseUrl,
  endpointLabel,
  testStatusLabel,
  providerIconHtml,
} from './relay-profiles.js';

const RELAY_BUTTON_IDS = [
  'relayToggleBtn',
  'relayAgentTestBtn',
  'relayProbeBtn',
  'relayRefreshBtn',
  'relayCertCheckBtn',
  'relayOpenLogBtn',
  'relayOpenLogDirBtn',
  'relayViewLogBtn',
  'relayDiagnoseBtn',
  'relayOfficialCaptureBtn',
  'relayDisableByokBtn',
  'relayTestAllBtn',
  'relayAddConfigBtn',
  'relayModalSaveBtn',
  'relayModalSaveTestBtn',
];

let relayBusyDepth = 0;
let relayEnabled = false;
let relayDisableInFlight = false;
let upstreamProbePromise = null;
let upstreamProbeCache = null;
const UPSTREAM_PROBE_CACHE_MS = 45_000;
let profilesStore = {
  version: 2,
  activeId: '',
  filterProvider: 'openai',
  configs: [],
};
let modalEditingId = null;
let modalProviderId = 'openai';
let relayFieldHintEl = null;
let relayFieldHintTimer = null;
const CONFIG_PAGE_SIZE = 6;
const configPageByProvider = { openai: 1, anthropic: 1, deepseek: 1, gemini: 1, mimo: 1, custom: 1 };
const RELAY_REVIEW_BRIDGE_STORAGE_KEY = 'cursor_relay_review_bridge_enabled_v1';

function loadRelayReviewBridgePreference() {
  try {
    const raw = localStorage.getItem(RELAY_REVIEW_BRIDGE_STORAGE_KEY);
    return raw == null ? false : raw === '1';
  } catch {
    return false;
  }
}

function saveRelayReviewBridgePreference(enabled) {
  try {
    localStorage.setItem(RELAY_REVIEW_BRIDGE_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function isReviewBridgeRequested() {
  return loadRelayReviewBridgePreference();
}

function syncReviewBridgeToggleFromStorage() {
  const toggle = $('relayReviewBridgeToggle');
  const badge = $('relayReviewBridgeBadge');
  const hint = $('relayReviewBridgeHint');
  const enabled = loadRelayReviewBridgePreference();
  if (toggle) {
    toggle.checked = enabled;
    toggle.onchange = () => {
      saveRelayReviewBridgePreference(toggle.checked);
      paintReviewBridgeStatus();
    };
  }
  toggle?.closest('.adv-inject-row')?.classList.remove('hidden');
  badge?.classList.toggle('hidden', !enabled);
  hint?.classList.remove('hidden');
}

function paintReviewBridgeStatus() {
  const badgeEl = $('relayReviewBridgeBadge');
  const hintEl = $('relayReviewBridgeHint');
  const enabled = loadRelayReviewBridgePreference();
  badgeEl?.classList.toggle('hidden', !enabled);
  hintEl?.classList.remove('hidden');
  badgeEl?.closest('.adv-inject-row')?.classList.remove('hidden');
}

function isRelayAdmin() {
  return true;
}

function applyRelayAdminVisibility() {
  const adminSection = $('relayAdminSection');
  if (adminSection) adminSection.classList.toggle('hidden', !isRelayAdmin());
}

function paintBeforeAwait() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function setRelayBusy(busy, message = '') {
  if (busy) relayBusyDepth += 1;
  else relayBusyDepth = Math.max(0, relayBusyDepth - 1);
  const active = relayBusyDepth > 0;
  RELAY_BUTTON_IDS.forEach((id) => {
    const el = $(id);
    if (el) el.disabled = active;
  });
  const busyEl = $('relayBusyHint');
  if (busyEl) {
    busyEl.textContent = active ? (message || '处理中，请稍候…') : '';
    busyEl.classList.toggle('hidden', !active);
  }
}

async function withRelayBusy(message, fn, { fullscreen = false } = {}) {
  const run = async (update) => {
    setRelayBusy(true, message);
    await paintBeforeAwait();
    try {
      if (update && message) update({ message });
      return await fn(update);
    } finally {
      setRelayBusy(false);
    }
  };

  if (fullscreen) {
    return withGlobalLoading(
      { title: '处理中', message: message || '请稍候…' },
      run,
    );
  }

  return run();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function reloadProfilesStore() {
  profilesStore = await loadProfilesStore();
  return profilesStore;
}

function filteredProfiles() {
  const pid = profilesStore.filterProvider || 'openai';
  return profilesStore.configs.filter((c) => c.providerId === pid);
}

function updateProfileTestStatus(id, patch) {
  const profile = getProfileById(profilesStore, id);
  if (!profile) return;
  profile.testStatus = { ...profile.testStatus, ...patch };
  upsertProfile(profilesStore, profile);
  void saveProfilesStore(profilesStore);
}

function formatProbeSeconds(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '';
  return `${Math.round((value / 1000) * 10) / 10} s`;
}

function formatProbePerformance(status = {}) {
  const tps = Number(status.tokensPerSecond) || 0;
  const ttftMs = Number(status.ttftMs) || 0;
  if (tps > 0 || ttftMs > 0) {
    const speed = tps > 0 ? `${Math.round(tps * 10) / 10} t/s` : '- t/s';
    const first = ttftMs > 0 ? `首字 ${formatProbeSeconds(ttftMs)}` : '首字 -';
    return `${speed} | ${first}`;
  }
  const latency = Number(status.latencyMs);
  return Number.isFinite(latency) && latency > 0 ? `${latency}ms` : '';
}

function paintActiveConfigBadge() {
  const active = getActiveProfile(profilesStore);
  const el = $('relayActiveConfigBadge');
  if (!el) return;
  if (!active) {
    el.textContent = '未选择';
    return;
  }
  el.textContent = `${active.name} · ${active.modelName || '未填模型'}`;
}

function renderProviderTabs() {
  const pid = profilesStore.filterProvider || 'openai';
  document.querySelectorAll('.relay-config-block .relay-provider-tab[data-relay-provider]').forEach((btn) => {
    const active = btn.getAttribute('data-relay-provider') === pid;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function renderConfigCard(profile) {
  const isActive = profile.id === profilesStore.activeId;
  const testClass = profile.testStatus?.status || 'idle';
  const performanceText = formatProbePerformance(profile.testStatus);
  const relayActionLabel = isActive
    ? (relayEnabled ? '重新启用' : '启用 Relay')
    : '切换并启用';
  const testText = testClass === 'testing'
    ? '测试中…'
    : testClass !== 'idle' && performanceText
      ? `${testStatusLabel(testClass)} · ${performanceText}`
      : testStatusLabel(testClass);
  const thinkingText = profile.providerId === 'deepseek' || profile.providerId === 'mimo'
    ? ` · 思考${profile.thinkingMode === 'enabled' ? '开启' : '关闭'}`
    : '';
  const endpointText = profile.providerId === 'anthropic'
    ? ''
    : ` · ${escapeHtml(endpointLabel(profile.endpointMode))}`;

  return `
    <article class="relay-config-card${isActive ? ' active' : ''}" data-config-id="${escapeHtml(profile.id)}">
      <div class="relay-card-head">
        <div class="relay-card-title-wrap">
          <h4 class="relay-card-name">${escapeHtml(profile.name)}</h4>
          <p class="relay-card-model mono">${escapeHtml(profile.modelName || '未填模型')}${endpointText}${escapeHtml(thinkingText)}</p>
        </div>
        <span class="relay-card-provider">
          ${providerIconHtml(profile.providerId)}
          ${escapeHtml(PROVIDER_LABELS[profile.providerId] || '自定义')}
        </span>
      </div>
      <div class="relay-card-body">
        <div>
          <span class="relay-card-kv-label">HOST</span>
          <span class="relay-card-kv-value mono">${escapeHtml(hostFromBaseUrl(profile.baseUrl))}</span>
        </div>
        <div>
          <span class="relay-card-kv-label">API KEY</span>
          <span class="relay-card-kv-value mono">${escapeHtml(maskApiKey(profile.apiKey))}</span>
        </div>
      </div>
      <div class="relay-card-test">
        <span class="relay-card-test-label">测试</span>
        <span class="relay-card-test-status ${escapeHtml(testClass)}">${escapeHtml(testText)}</span>
      </div>
      <div class="relay-card-foot">
        <button type="button" class="relay-card-action" data-action="activate-relay">${escapeHtml(relayActionLabel)}</button>
        <button type="button" class="relay-card-action" data-action="test">测试</button>
        <button type="button" class="relay-card-action" data-action="edit">编辑</button>
        <button type="button" class="relay-card-action" data-action="copy">复制</button>
        <button type="button" class="relay-card-action danger" data-action="delete">删除</button>
      </div>
    </article>
  `;
}

function getConfigPage() {
  const pid = profilesStore.filterProvider || 'openai';
  return configPageByProvider[pid] || 1;
}

function setConfigPage(page) {
  const pid = profilesStore.filterProvider || 'openai';
  configPageByProvider[pid] = Math.max(1, Number(page) || 1);
}

function renderConfigGrid() {
  renderProviderTabs();
  paintActiveConfigBadge();

  const grid = $('relayConfigGrid');
  const emptyHint = $('relayConfigEmptyHint');
  if (!grid) return;

  const all = filteredProfiles();
  const paged = paginateList(all, getConfigPage(), CONFIG_PAGE_SIZE);
  setConfigPage(paged.page);
  grid.innerHTML = paged.items.map(renderConfigCard).join('');

  if (emptyHint) {
    emptyHint.classList.toggle('hidden', all.length > 0);
  }

  mountPagination('relayConfigPagination', {
    page: paged.page,
    pageSize: CONFIG_PAGE_SIZE,
    total: paged.total,
  }, (nextPage) => {
    setConfigPage(nextPage);
    renderConfigGrid();
  });

  grid.querySelectorAll('.relay-config-card').forEach((card) => {
    const id = card.getAttribute('data-config-id');
    card.querySelector('[data-action="activate-relay"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void enableRelayForProfile(id);
    });
    card.querySelector('[data-action="test"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void testProfileById(id, { silent: false });
    });
    card.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openConfigModal(id);
    });
    card.querySelector('[data-action="copy"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateProfile(profilesStore, id);
      void saveProfilesStore(profilesStore);
      renderConfigGrid();
    });
    card.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteProfileWithConfirm(id);
    });
    card.addEventListener('click', () => {
      void activateProfile(id);
    });
  });
}

async function deleteProfileWithConfirm(id) {
  const profile = getProfileById(profilesStore, id);
  if (!profile) return;
  const ok = await showConfirm(
    `确定删除配置「${profile.name}」？此操作不可恢复。`,
    { title: '删除配置', tone: 'danger', confirmText: '删除' },
  );
  if (!ok) return;
  deleteProfile(profilesStore, id);
  await saveProfilesStore(profilesStore);
  renderConfigGrid();
  paintUpstreamProbeFromActive();
}

async function selectActiveProfile(profileId) {
  if (!setActiveProfile(profilesStore, profileId)) return false;
  await saveProfilesStore(profilesStore);
  await reloadProfilesStore();
  renderConfigGrid();
  paintUpstreamProbeFromActive();
  return Boolean(getActiveProfile(profilesStore));
}

async function activateProfile(id) {
  if (!(await selectActiveProfile(id))) return;

  const bridge = window.electronBridge;
  if (relayEnabled && bridge?.cursorRelayQuickSwitchModel) {
    try {
      await withRelayBusy('正在切换本地代理模型…', async () => {
        await bridge.cursorRelayQuickSwitchModel({ profileId: id });
      });
      void refreshRelayStatus().catch(() => null);
      void getUpstreamProbeForEnable().catch(() => null);
      const active = getActiveProfile(profilesStore);
      await showAlert(
        `已切换为 ${describeProfile(active)}，Relay 已应用到新模型配置。`,
        { title: '配置已切换', tone: 'success' },
      );
    } catch (error) {
      await showAlert(error.message || String(error), { title: '切换模型失败', tone: 'danger' });
    }
    return;
  }

  if (relayEnabled) {
    const active = getActiveProfile(profilesStore);
    await showAlert(
      `已切换为 ${describeProfile(active)}。若 Relay 正在运行，请重新启用后才会应用到正在运行的代理。`,
      { title: '配置已切换', tone: 'info' },
    );
  }
}

function hideRelayFieldHint() {
  if (relayFieldHintTimer) {
    clearTimeout(relayFieldHintTimer);
    relayFieldHintTimer = null;
  }
  relayFieldHintEl?.remove();
  relayFieldHintEl = null;
}

function positionRelayFieldHint(anchor, popover) {
  const anchorRect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 12;
  let top = anchorRect.top - popRect.height - 8;
  let left = anchorRect.left;
  if (top < margin) {
    top = anchorRect.bottom + 8;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
  popover.style.top = `${Math.max(margin, top)}px`;
  popover.style.left = `${left}px`;
}

function showRelayFieldHint(anchor, text) {
  const hint = String(text || '').trim();
  if (!hint) return;
  hideRelayFieldHint();
  const popover = document.createElement('div');
  popover.className = 'relay-field-hint-popover';
  popover.textContent = hint;
  popover.onmouseenter = () => {
    if (relayFieldHintTimer) {
      clearTimeout(relayFieldHintTimer);
      relayFieldHintTimer = null;
    }
  };
  popover.onmouseleave = () => {
    relayFieldHintTimer = setTimeout(hideRelayFieldHint, 120);
  };
  document.body.appendChild(popover);
  positionRelayFieldHint(anchor, popover);
  relayFieldHintEl = popover;
}

function bindRelayFieldHints() {
  document.querySelectorAll('#relayConfigModal .relay-field-hint-btn[data-relay-field]').forEach((btn) => {
    const show = () => {
      if (relayFieldHintTimer) {
        clearTimeout(relayFieldHintTimer);
        relayFieldHintTimer = null;
      }
      const fieldKey = btn.getAttribute('data-relay-field') || '';
      const hint = getRelayFieldHint(fieldKey, modalProviderId);
      showRelayFieldHint(btn, hint);
    };
    btn.onmouseenter = show;
    btn.onfocus = show;
    btn.onmouseleave = () => {
      relayFieldHintTimer = setTimeout(hideRelayFieldHint, 120);
    };
    btn.onblur = () => {
      relayFieldHintTimer = setTimeout(hideRelayFieldHint, 120);
    };
    btn.onclick = (event) => {
      event.preventDefault();
    };
  });
}

function populateReasoningEffortSelect(selectEl, selectedValue = DEFAULT_REASONING_EFFORT) {
  if (!selectEl) return;
  const selected = VALID_REASONING_EFFORTS.includes(selectedValue) ? selectedValue : DEFAULT_REASONING_EFFORT;
  selectEl.innerHTML = REASONING_EFFORT_OPTIONS.map((item) => (
    `<option value="${escapeHtml(item.value)}"${item.value === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`
  )).join('');
}

function setModalProviderTab(providerId) {
  modalProviderId = providerId;
  document.querySelectorAll('#relayConfigModal .relay-provider-tab[data-modal-provider]').forEach((btn) => {
    const active = btn.getAttribute('data-modal-provider') === providerId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  setText($('relayModalProviderHint'), PROVIDER_HINTS[providerId] || PROVIDER_HINTS.custom);
  const thinkingField = $('relayModalThinking')?.closest('.relay-modal-field');
  if (thinkingField) {
    thinkingField.classList.toggle('hidden', providerId !== 'deepseek' && providerId !== 'mimo');
  }
  const thinkingHintBtn = document.querySelector('#relayConfigModal .relay-field-hint-btn[data-relay-field="thinkingMode"]');
  if (thinkingHintBtn) {
    const label = providerId === 'mimo' ? 'MiMo 深度思考' : 'DeepSeek 思考';
    thinkingHintBtn.setAttribute('aria-label', `${label}说明`);
  }
  const endpointField = $('relayModalEndpointField');
  if (endpointField) {
    endpointField.classList.toggle('hidden', providerId === 'anthropic');
  }
  if ((providerId === 'gemini' || providerId === 'mimo') && $('relayModalEndpoint') && !modalEditingId) {
    $('relayModalEndpoint').value = 'chat';
  }
  setText($('relayModalReasoningLabel'), reasoningEffortFieldLabel(providerId));
  const reasoningHintBtn = document.querySelector('#relayConfigModal .relay-field-hint-btn[data-relay-field="reasoningEffort"]');
  if (reasoningHintBtn) {
    reasoningHintBtn.setAttribute('aria-label', `${reasoningEffortFieldLabel(providerId)}说明`);
  }
  hideRelayFieldHint();
}

function fillModalForm(profile) {
  const p = profile || createEmptyProfile(modalProviderId);
  modalEditingId = profile?.id || null;
  modalProviderId = p.providerId || modalProviderId;
  setModalProviderTab(modalProviderId);
  if ($('relayModalName')) $('relayModalName').value = p.name || '';
  if ($('relayModalModel')) $('relayModalModel').value = p.modelName || '';
  if ($('relayModalApiKey')) $('relayModalApiKey').value = p.apiKey || '';
  if ($('relayModalBaseUrl')) $('relayModalBaseUrl').value = p.baseUrl || PROVIDER_BASE_URLS[modalProviderId] || '';
  if ($('relayModalContext')) $('relayModalContext').value = String(p.contextWindow || DEFAULT_CONTEXT_WINDOW);
  if ($('relayModalReasoning')) $('relayModalReasoning').value = p.reasoningEffort || DEFAULT_REASONING_EFFORT;
  if ($('relayModalThinking')) $('relayModalThinking').value = p.thinkingMode || DEFAULT_DEEPSEEK_THINKING_MODE;
  if ($('relayModalEndpoint')) $('relayModalEndpoint').value = p.endpointMode || DEFAULT_ENDPOINT_MODE;
  if ($('relayModalNotes')) $('relayModalNotes').value = p.notes || '';
  const testEl = $('relayModalTestStatus');
  if (testEl) {
    const st = p.testStatus?.status || 'idle';
    testEl.textContent = testStatusLabel(st);
    testEl.className = `relay-card-test-status ${st}`;
  }
}

function openConfigModal(id = null) {
  const modal = $('relayConfigModal');
  if (!modal) return;
  const existing = id ? getProfileById(profilesStore, id) : null;
  fillModalForm(existing || createEmptyProfile(profilesStore.filterProvider || 'openai'));
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('dialog-open');
}

function closeConfigModal() {
  const modal = $('relayConfigModal');
  if (!modal) return;
  hideRelayFieldHint();
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('dialog-open');
  modalEditingId = null;
}

function collectModalFormProfile() {
  const existing = modalEditingId ? getProfileById(profilesStore, modalEditingId) : null;
  const base = existing || createEmptyProfile(modalProviderId);
  const rawBaseUrl = ($('relayModalBaseUrl')?.value || '').trim();
  const selectedEndpointMode = ($('relayModalEndpoint')?.value || DEFAULT_ENDPOINT_MODE).trim();
  const inferredEndpointMode = modalProviderId === 'anthropic' || modalProviderId === 'gemini' || modalProviderId === 'mimo'
    ? 'chat'
    : inferEndpointModeFromBaseUrl(rawBaseUrl, selectedEndpointMode);
  return {
    ...base,
    id: existing?.id || base.id,
    name: ($('relayModalName')?.value || '').trim() || ($('relayModalModel')?.value || '').trim() || '未命名配置',
    providerId: modalProviderId,
    baseUrl: normalizeBaseUrlInput(rawBaseUrl),
    apiKey: ($('relayModalApiKey')?.value || '').trim() || existing?.apiKey || '',
    modelName: ($('relayModalModel')?.value || '').trim(),
    endpointMode: inferredEndpointMode,
    reasoningEffort: ($('relayModalReasoning')?.value || DEFAULT_REASONING_EFFORT).trim(),
    thinkingMode: modalProviderId === 'deepseek' || modalProviderId === 'mimo'
      ? (($('relayModalThinking')?.value || DEFAULT_DEEPSEEK_THINKING_MODE).trim())
      : '',
    contextWindow: Number(($('relayModalContext')?.value || '').trim() || DEFAULT_CONTEXT_WINDOW),
    notes: ($('relayModalNotes')?.value || '').trim(),
  };
}

async function saveModalProfile({ testAfter = false } = {}) {
  const isNew = !modalEditingId;
  const profile = collectModalFormProfile();
  try {
    validateUpstreamPayload(profileToUpstreamPayload(profile));
  } catch (error) {
    await showAlert(error.message || String(error), { title: '保存失败', tone: 'danger' });
    return null;
  }
  const saved = upsertProfile(profilesStore, profile);
  if (isNew || !profilesStore.activeId) {
    setActiveProfile(profilesStore, saved.id);
  }
  await saveProfilesStore(profilesStore);
  renderConfigGrid();
  closeConfigModal();
  if (testAfter) {
    await testProfileById(saved.id, { silent: false });
  }
  return saved;
}

async function testProfileById(id, { silent = true } = {}) {
  const profile = getProfileById(profilesStore, id);
  if (!profile) return null;

  updateProfileTestStatus(id, { status: 'testing', message: '测试中…' });
  renderConfigGrid();

  const upstream = profileToUpstreamPayload(profile);
  try {
    validateUpstreamPayload(upstream);
  } catch (error) {
    updateProfileTestStatus(id, { status: 'fail', message: error.message || String(error), latencyMs: 0 });
    renderConfigGrid();
    if (!silent) {
      await showAlert(error.message || String(error), { title: '无法测试', tone: 'danger' });
    }
    return null;
  }

  try {
    const result = await testLocalUpstream(upstream);
    const status = result?.success ? 'ok' : result?.ok ? 'warn' : 'fail';
    updateProfileTestStatus(id, {
      status,
      message: result?.message || '',
      latencyMs: Number(result?.latencyMs) || 0,
      durationMs: Number(result?.durationMs) || Number(result?.latencyMs) || 0,
      ttftMs: Number(result?.ttftMs) || 0,
      generationMs: Number(result?.generationMs) || 0,
      tokensPerSecond: Number(result?.tokensPerSecond) || 0,
      outputTokens: Number(result?.outputTokens) || 0,
      outputTokensEstimated: Boolean(result?.outputTokensEstimated),
    });
    renderConfigGrid();
    if (profilesStore.activeId === id) {
      paintUpstreamProbe(result);
    }
    if (!silent) {
      await showAlert(result?.message || '连接测试完成。', {
        title: '连接测试',
        tone: result?.success ? 'success' : result?.ok ? 'info' : 'danger',
      });
    }
    return result;
  } catch (error) {
    updateProfileTestStatus(id, { status: 'fail', message: error.message || String(error), latencyMs: 0 });
    renderConfigGrid();
    if (!silent) {
      await showAlert(error.message || String(error), { title: '连接测试失败', tone: 'danger' });
    }
    return null;
  }
}

async function testAllProfiles() {
  const list = filteredProfiles();
  if (!list.length) {
    await showAlert('当前厂商暂无配置可测试。', { title: '测试全部', tone: 'info' });
    return;
  }
      await withRelayBusy('正在测试全部配置…', async () => {
    for (const profile of list) {
      await testProfileById(profile.id, { silent: true });
    }
    await showAlert(`已完成 ${list.length} 个配置的连接测试。`, { title: '测试全部', tone: 'success' });
  }, { fullscreen: true });
}

function bindProfilesUi() {
  document.querySelectorAll('.relay-config-block .relay-provider-tab[data-relay-provider]').forEach((btn) => {
    btn.onclick = () => {
      profilesStore.filterProvider = btn.getAttribute('data-relay-provider') || 'openai';
      setConfigPage(1);
      void saveProfilesStore(profilesStore);
      renderConfigGrid();
    };
  });

  const addBtn = $('relayAddConfigBtn');
  if (addBtn) {
    addBtn.onclick = () => openConfigModal(null);
  }

  const testAllBtn = $('relayTestAllBtn');
  if (testAllBtn) {
    testAllBtn.onclick = () => testAllProfiles().catch(() => {});
  }

  document.querySelectorAll('#relayConfigModal [data-relay-modal-close]').forEach((el) => {
    el.onclick = () => closeConfigModal();
  });

  document.querySelectorAll('#relayConfigModal .relay-provider-tab[data-modal-provider]').forEach((btn) => {
    btn.onclick = () => {
      const next = btn.getAttribute('data-modal-provider') || 'custom';
      setModalProviderTab(next);
      if (next !== 'custom' && !($('relayModalBaseUrl')?.value || '').trim()) {
        if ($('relayModalBaseUrl')) $('relayModalBaseUrl').value = PROVIDER_BASE_URLS[next] || '';
      }
    };
  });

  const saveBtn = $('relayModalSaveBtn');
  if (saveBtn) {
    saveBtn.onclick = () => withRelayBusy('正在保存…', () => saveModalProfile({ testAfter: false }));
  }

  const saveTestBtn = $('relayModalSaveTestBtn');
  if (saveTestBtn) {
    saveTestBtn.onclick = () => withRelayBusy('正在保存并测试…', () => saveModalProfile({ testAfter: true }), { fullscreen: true });
  }

  document.querySelectorAll('[data-toggle-pass="relayModalApiKey"]').forEach((btn) => {
    btn.onclick = () => {
      const input = $('relayModalApiKey');
      if (!input) return;
      const isPassword = String(input.type).toLowerCase() === 'password';
      input.type = isPassword ? 'text' : 'password';
      const icon = btn.querySelector('i');
      if (icon) icon.className = `fa ${isPassword ? 'fa-eye-slash' : 'fa-eye'}`;
    };
  });

  bindRelayFieldHints();
}

function paintUpstreamProbeFromActive() {
  const active = getActiveProfile(profilesStore);
  if (!active) {
    paintUpstreamProbe(null);
    return;
  }
  const st = active.testStatus || {};
  if (st.status === 'idle') {
    paintUpstreamProbe(null);
    return;
  }
  paintUpstreamProbe({
    success: st.status === 'ok',
    ok: st.status === 'ok' || st.status === 'warn',
    compatible: st.status !== 'fail',
    latencyMs: st.latencyMs,
    durationMs: st.durationMs,
    ttftMs: st.ttftMs,
    generationMs: st.generationMs,
    tokensPerSecond: st.tokensPerSecond,
    outputTokens: st.outputTokens,
    outputTokensEstimated: st.outputTokensEstimated,
    message: st.message,
  });
}

async function initProfilesUi() {
  await reloadProfilesStore();
  populateReasoningEffortSelect($('relayModalReasoning'));
  syncReviewBridgeToggleFromStorage();
  bindProfilesUi();
  renderConfigGrid();
  paintUpstreamProbeFromActive();
  paintReviewBridgeStatus();
}

function setBadge(el, text, tone = 'muted') {
  if (!el) return;
  el.textContent = text;
  const tones = {
    ok: 'adv-inject-badge adv-inject-badge-ok',
    warn: 'adv-inject-badge adv-inject-badge-warn',
    muted: 'adv-inject-badge adv-inject-badge-muted',
  };
  el.className = tones[tone] || tones.muted;
}

function setText(el, text) {
  if (el) el.textContent = text;
}

function setUpstreamHint(text) {
  setText($('relayUpstreamHint'), text || '支持 OpenAI 兼容接口；接口地址请填到 `/v1`，不要带 `/chat/completions` 或 `/responses`。');
}

function collectUpstreamPayload() {
  const active = getActiveProfile(profilesStore);
  if (!active) {
    return {
      providerId: 'custom',
      baseUrl: '',
      apiKey: '',
      modelName: '',
      endpointMode: DEFAULT_ENDPOINT_MODE,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    };
  }
  return profileToUpstreamPayload(active);
}

function collectRelayModelRoutes() {
  if (!Array.isArray(profilesStore?.configs) || !profilesStore.configs.length) return [];
  const seen = new Set();
  return profilesStore.configs
    .map((profile) => {
      if (!profile || typeof profile !== 'object') return null;
      const modelName = String(profile.modelName || '').trim();
      if (!modelName || seen.has(modelName)) return null;
      seen.add(modelName);
      return {
        modelName,
        upstream: profileToUpstreamPayload(profile),
      };
    })
    .filter(Boolean);
}

function describeProfile(profile) {
  if (!profile) return '未命名配置';
  const endpointText = profile.providerId === 'anthropic'
    ? ''
    : ` · ${endpointLabel(profile.endpointMode)}`;
  return `${profile.name} · ${profile.modelName || '未填模型'}${endpointText}`;
}

function inferEndpointModeFromBaseUrl(rawBaseUrl, fallback = DEFAULT_ENDPOINT_MODE) {
  const text = String(rawBaseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
  if (text.endsWith('/chat/completions')) return 'chat';
  if (text.endsWith('/responses')) return 'responses';
  return fallback;
}

function normalizeBaseUrlInput(rawBaseUrl) {
  const text = String(rawBaseUrl || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    const rawPath = (parsed.pathname || '').replace(/\/+$/, '') || '';
    const pathLower = rawPath.toLowerCase();
    if (pathLower.endsWith('/chat/completions')) {
      parsed.pathname = rawPath.slice(0, rawPath.length - '/chat/completions'.length) || '/';
    } else if (pathLower.endsWith('/responses')) {
      parsed.pathname = rawPath.slice(0, rawPath.length - '/responses'.length) || '/';
    } else if (pathLower.endsWith('/models')) {
      parsed.pathname = rawPath.slice(0, rawPath.length - '/models'.length) || '/';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return text.replace(/\/+$/, '');
  }
}

function collectRelayRuntimeOptions() {
  return {
    mode: 'local_relay',
    localNativeAgentTools: true,
    structuredAgentToolCalls: true,
    emitSyntheticLocalNativeToolFrames: false,
    enableReviewBridge: isReviewBridgeRequested(),
  };
}

function collectUpstreamSessionMeta(upstream) {
  return {
    providerId: upstream.providerId,
    baseUrl: upstream.baseUrl,
    modelName: upstream.modelName,
    endpointMode: upstream.endpointMode,
    reasoningEffort: upstream.reasoningEffort,
    thinkingMode: upstream.thinkingMode,
    contextWindow: upstream.contextWindow,
  };
}

function validateUpstreamPayload(payload) {
  if (!payload.baseUrl) throw new Error('请填写 API 地址');
  if (!payload.apiKey) throw new Error('请填写 API Key');
  if (!['responses', 'chat'].includes(String(payload.endpointMode || ''))) {
    throw new Error('请选择有效的接口端点');
  }
  if (!VALID_REASONING_EFFORTS.includes(String(payload.reasoningEffort || ''))) {
    throw new Error('请选择有效的推理强度');
  }
  if ((payload.providerId === 'deepseek' || payload.providerId === 'mimo')
    && !['enabled', 'disabled'].includes(String(payload.thinkingMode || ''))) {
    throw new Error(payload.providerId === 'mimo' ? '请选择有效的 MiMo 深度思考模式' : '请选择有效的 DeepSeek 思考模式');
  }
  if (!(Number(payload.contextWindow) > 0)) {
    throw new Error('上下文窗口必须大于 0');
  }
}

async function testLocalUpstream(upstream) {
  const bridge = window.electronBridge;
  if (!bridge?.proxyModelTest) {
    throw new Error('当前客户端不支持本地连接测试');
  }
  return bridge.proxyModelTest({
    providerId: upstream.providerId,
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKey,
    modelName: upstream.modelName,
    endpointMode: upstream.endpointMode,
    reasoningEffort: upstream.reasoningEffort,
    thinkingMode: upstream.thinkingMode,
    contextWindow: upstream.contextWindow,
  });
}

function describeRunner(runner) {
  if (!runner?.running) return '已停止';
  const model = runner?.upstream?.modelName ? ` | ${runner.upstream.modelName}` : '';
  const mode = runner?.mode === 'official_passthrough' ? ' | 官方纯记录' : ' | Relay 转发';
  return `运行中 ${runner.proxyServer || `127.0.0.1:${runner.port || '?'}`}${model}${mode}`;
}

function describeCert(cert) {
  if (!cert?.caReady || !cert?.leafReady) return '缺失';
  if (cert?.caTrustStale) return '信任不一致';
  if (cert?.caInstalled) return '本地已信任';
  return '已生成，未信任';
}

function paintCertBadgeFromCheck(result = null) {
  const badge = $('relayCertBadge');
  if (!badge) return;
  if (!result) {
    setBadge(badge, '未知', 'warn');
    return;
  }
  const text = result.readyForMitm
    ? '已信任'
    : result.caTrustStale
      ? '信任不一致'
      : result.caInstalled
        ? '已安装'
        : '未信任';
  const tone = result.readyForMitm ? 'ok' : 'warn';
  setBadge(badge, text, tone);
  if (isRelayAdmin() && result.caCertPath) {
    setText($('relayCertPathHint'), result.caCertPath);
  }
}

function hasLocalOpenAiOverride(settings) {
  return Boolean(
    settings?.useOpenAIKey ||
    settings?.enabled ||
    (settings?.openAIBaseUrl && settings?.openAIBaseUrl.trim()),
  );
}

function describeCursorSettings(settings) {
  if (!settings?.dbExists) return '未找到 state.vscdb';
  if (hasLocalOpenAiOverride(settings)) {
    return `⚠ 本地 OpenAI 覆写残留 | ${settings.openAIBaseUrl || '已写入'}`;
  }
  return '官方 Cursor 路由';
}

function describeRelayProxyLayers(local) {
  const byok = describeCursorSettings(local?.cursorSettings);
  const sys = local?.systemProxy;
  const parts = [byok];
  if (sys?.cursorSettings?.httpProxy) {
    parts.push(`settings.http.proxy=${sys.cursorSettings.httpProxy}`);
  } else {
    parts.push('settings.http.proxy 未设置');
  }
  if (sys?.windows?.enabled) {
    parts.push(`Win系统代理=${sys.windows.server}`);
  } else {
    parts.push('Win系统代理未启用');
  }
  const tr = local?.transparent;
  if (tr?.hasBlock) {
    parts.push(`透明 hosts→127.0.0.1:${tr.directMitmPort || 443}`);
  }
  return parts.join(' | ');
}

function describeInterceptBadge(stats, local) {
  if (local?.runner?.mode === 'official_passthrough') {
    const seenRunSse = Number(stats?.seenAgentRunSse || 0);
    const seenBidi = Number(stats?.seenBidiAppend || 0);
    if (seenRunSse > 0 || seenBidi > 0) return { text: '官方记录中', tone: 'ok' };
    return { text: '官方待记录', tone: 'warn' };
  }
  const chatTotal = Number(stats?.chatTotal || 0);
  if (chatTotal > 0 || local?.runner?.hasChatIntercept || local?.log?.hasChatIntercept) {
    return { text: '聊天已代理', tone: 'ok' };
  }
  if (!local?.runner?.running) {
    return { text: '未运行', tone: 'muted' };
  }
  if (hasLocalOpenAiOverride(local?.cursorSettings)) {
    return { text: '配置冲突', tone: 'warn' };
  }
  const seenUser = Number(stats?.seenBidiUserMessage || 0);
  const seenRunSse = Number(stats?.seenAgentRunSse || 0);
  if (seenUser > 0) return { text: '等待回复', tone: 'warn' };
  if (seenRunSse > 0) return { text: '等待消息', tone: 'warn' };
  const connectMitm = Number(stats?.connectMitm || 0);
  if (connectMitm > 0) return { text: '待验证', tone: 'warn' };
  const connectTotal = Number(stats?.connectTotal || 0);
  if (connectTotal === 0) return { text: '待验证', tone: 'warn' };
  return { text: '待聊天', tone: 'warn' };
}

function updateRelayToggleButton(enabled, runnerRunning = null) {
  const configuredEnabled = Boolean(enabled);
  const actuallyRunning = runnerRunning == null ? configuredEnabled : Boolean(runnerRunning);
  relayEnabled = actuallyRunning;
  const btn = $('relayToggleBtn');
  if (!btn) return;
  btn.title = configuredEnabled && !actuallyRunning
    ? 'Relay 已启用，但本地 runner 未运行。点击重新启用。'
    : '';
  if (actuallyRunning) {
    btn.className = 'ghost-btn adv-btn-warn';
    btn.innerHTML = '<i class="fa fa-stop"></i> 停用 Relay';
  } else {
    btn.className = 'primary-btn';
    btn.innerHTML = '<i class="fa fa-play"></i> 启用 Relay';
  }
  renderConfigGrid();
}

function paintUpstreamProbe(result) {
  const latencyEl = $('relayLatencyBadge');
  if (latencyEl) {
    const performanceText = formatProbePerformance(result || {});
    latencyEl.textContent = performanceText || '-';
  }
  if (!result) {
    setBadge($('relayUpstreamBadge'), '未配置', 'muted');
    setUpstreamHint('请先填写 API 地址、API Key 和模型名。');
    return;
  }
  if (result.success) {
    setBadge($('relayUpstreamBadge'), '可用', 'ok');
  } else if (result.ok) {
    setBadge($('relayUpstreamBadge'), '可达', 'warn');
  } else if (result.compatible === false) {
    setBadge($('relayUpstreamBadge'), '不兼容', 'warn');
  } else {
    setBadge($('relayUpstreamBadge'), '不可用', 'warn');
  }
  const parts = [
    result?.probe ? `探测: ${result.probe}` : '',
    result?.compatMode ? `模式: ${result.compatMode}` : '',
    result?.normalizedBaseUrl ? `建议地址: ${result.normalizedBaseUrl}` : '',
    result?.message || '',
  ].filter(Boolean);
  setUpstreamHint(parts.join(' | '));
}

async function runUpstreamProbe({ silent = true, force = false } = {}) {
  if (upstreamProbePromise) return upstreamProbePromise;

  upstreamProbePromise = (async () => {
    const active = getActiveProfile(profilesStore);
    if (!active) {
      paintUpstreamProbe(null);
      if (!silent) {
        await showAlert('请先添加并选中一个模型配置。', { title: '无法测速', tone: 'danger' });
      }
      return null;
    }

    const now = Date.now();
    if (
      !force
      && upstreamProbeCache
      && upstreamProbeCache.profileId === active.id
      && now - upstreamProbeCache.at < UPSTREAM_PROBE_CACHE_MS
    ) {
      paintUpstreamProbe(upstreamProbeCache.result);
      return upstreamProbeCache.result;
    }

    const result = await testProfileById(active.id, { silent });
    upstreamProbeCache = { profileId: active.id, at: now, result };
    return result;
  })();

  try {
    return await upstreamProbePromise;
  } finally {
    upstreamProbePromise = null;
  }
}

async function getUpstreamProbeForEnable() {
  const active = getActiveProfile(profilesStore);
  if (!active) return null;

  const now = Date.now();
  if (
    upstreamProbeCache
    && upstreamProbeCache.profileId === active.id
    && now - upstreamProbeCache.at < UPSTREAM_PROBE_CACHE_MS
    && upstreamProbeCache.result?.ok
  ) {
    return upstreamProbeCache.result;
  }

  const recentTest = active.testStatus;
  if (
    recentTest?.status === 'ok'
    && Number(recentTest.latencyMs) > 0
    && now - (active.updatedAt || 0) < UPSTREAM_PROBE_CACHE_MS
  ) {
    return {
      ok: true,
      success: true,
      latencyMs: recentTest.latencyMs,
      durationMs: recentTest.durationMs,
      ttftMs: recentTest.ttftMs,
      generationMs: recentTest.generationMs,
      tokensPerSecond: recentTest.tokensPerSecond,
      outputTokens: recentTest.outputTokens,
      outputTokensEstimated: recentTest.outputTokensEstimated,
      message: recentTest.message || '',
    };
  }

  return runUpstreamProbe({ silent: true });
}

async function enableRelayForProfile(profileId) {
  const bridge = window.electronBridge;
  if (!bridge?.cursorRelayApply) {
    await showAlert('桌面客户端未提供 Relay 桥接能力。', {
      title: 'Relay 不可用',
      tone: 'danger',
    });
    return;
  }

  if (!profileId) {
    await showAlert('请先添加并选中一个模型配置。', { title: '缺少配置', tone: 'danger' });
    return;
  }

  if (!(await selectActiveProfile(profileId))) {
    await showAlert('未找到要启用的模型配置，请刷新后重试。', { title: '配置不存在', tone: 'danger' });
    return;
  }

  const active = getActiveProfile(profilesStore);
  if (!active) {
    await showAlert('请先添加并选中一个模型配置。', { title: '缺少配置', tone: 'danger' });
    return;
  }

  const upstream = collectUpstreamPayload();
  try {
    validateUpstreamPayload(upstream);
  } catch (error) {
    await showAlert(error.message || String(error), { title: '缺少配置', tone: 'danger' });
    return;
  }

  const wasRunning = relayEnabled;
  const busyTitle = wasRunning ? '正在切换 Relay 模型…' : '正在启用 Relay...';

  await withRelayBusy(busyTitle, async () => {
    try {
      const local = wasRunning && bridge.cursorRelayQuickSwitchModel
        ? (await bridge.cursorRelayQuickSwitchModel({ profileId })).relay
        : await bridge.cursorRelayApply({
          upstream,
          modelRoutes: collectRelayModelRoutes(),
          forceRestartRunner: true,
          restartCursor: false,
          reloadCursor: false,
          installCert: true,
          useSystemProxy: false,
          ...collectRelayRuntimeOptions(),
        });
      updateRelayToggleButton(true, true);
      {
        const stats = local?.runner?.stats || local?.log?.stats || {};
        const intercept = describeInterceptBadge(stats, local);
        const addr = String(local?.proxyServer || local?.runner?.proxyServer || '').trim();
        setBadge($('relayLocalBadge'), addr || '已启用', 'ok');
        setBadge($('relayInterceptBadge'), intercept.text, intercept.tone);
        setText($('relayStatusHint'), describeUserStatusHint(local));
      }

      relayEnabled = true;
      void refreshRelayStatus().catch(() => null);
      void getUpstreamProbeForEnable().catch(() => null);
      paintReviewBridgeStatus(local);
      const authApplied = local?.cursorAuthEnsure?.applied;
      const restartRequired = Boolean(local?.requiresCursorRestart) || authApplied;
      const authHint = authApplied
        ? `\n\n已写入 Cursor 登录态（${local.cursorAuthEnsure.email || ''}），请完全退出并重新打开 Cursor。`
        : '';
      if (restartRequired) await showAlert(
        `${describeProfile(active)}${authHint}\n\n${local?.restarted
          ? 'Relay 已启用，Cursor 已重启。在 Cursor 里用 Auto 发消息即可。'
          : restartRequired
            ? 'Relay 已启用，并已恢复实验 workbench 补丁。请完全退出并重新打开 Cursor 后继续测试。'
            : 'Relay 已启用，并已切到当前选中的模型配置。'}`,
        { title: restartRequired ? 'Relay 已启用，需重启 Cursor' : wasRunning ? '模型已切换' : 'Relay 已启用', tone: restartRequired ? 'warn' : 'success' },
      );
    } catch (error) {
      try {
        await bridge?.cursorRelayDisable?.({
          restartCursor: false,
          reloadCursor: false,
          clearSystemProxy: false,
        });
      } catch {
        /* ignore */
      }
      await showAlert(error.message || String(error), {
        title: '启用 Relay 失败',
        tone: 'danger',
      });
    }
  }, { fullscreen: true });
}

async function enableOfficialAgentCapture() {
  const bridge = window.electronBridge;
  if (!bridge?.cursorRelayApply) {
    await showAlert('桌面客户端未提供 Relay 桥接能力。', {
      title: '官方流量记录不可用',
      tone: 'danger',
    });
    return;
  }

  const ok = await showConfirm(
    '将启用官方 Agent 纯记录模式：Cursor 请求仍发送到官方服务，本地 Relay 只做 MITM 透传、保存 RunSSE/BidiAppend 协议帧和日志。\n\n此模式不会使用你的第三方 API，也不会生成本地 Agent 回复。继续？',
    { title: '记录官方 Agent 流量', tone: 'info', confirmText: '启用记录' },
  );
  if (!ok) return;

  await withRelayBusy('正在启用官方 Agent 纯记录模式…', async () => {
    try {
      const local = await bridge.cursorRelayApply({
        mode: 'official_passthrough',
        forceRestartRunner: true,
        restartCursor: false,
        reloadCursor: false,
        installCert: true,
        useSystemProxy: false,
        localNativeAgentTools: false,
        structuredAgentToolCalls: false,
        emitLocalToolInteractionFrames: false,
        emitSyntheticLocalNativeToolFrames: false,
        enableReviewBridge: false,
      });
      relayEnabled = true;
      updateRelayToggleButton(true, true);
      await refreshRelayStatus();
      await showAlert(
        '官方 Agent 纯记录模式已启用。\n\n现在在 Cursor 里发起 Agent 请求，Runner 会保存 RunSSE/BidiAppend 原始样本和官方响应帧摘要。样本目录在 Runner 日志目录下的 samples。',
        { title: '记录已启用', tone: 'success' },
      );
      paintReviewBridgeStatus(local);
    } catch (error) {
      await refreshRelayStatus().catch(() => null);
      await showAlert(error.message || String(error), {
        title: '启用官方记录失败',
        tone: 'danger',
      });
    }
  }, { fullscreen: true });
}

function describeUserStatusHint(local, localState = null) {
  if (localState && !localState.cursorLoggedIn) {
    return 'Cursor 尚未登录。启用 Relay 时会自动检测，并从 desktop/js/utils/users.json 写入本地免登账号。';
  }
  if (local?.cert?.caTrustStale) {
    return 'MITM 根证书与本地信任存储不一致（常见于手动删除 relay 目录）；请点击「恢复证书」后重新启用 Relay。';
  }
  if (!local?.cert?.caInstalled && local?.cert?.caReady) {
    return 'MITM 根证书尚未受信任，请点击「检查证书」或重新启用 Relay。';
  }
  if (!local?.cert?.caReady || !local?.cert?.leafReady) {
    return 'MITM 证书未就绪，启用 Relay 时会自动生成并尝试安装。';
  }
  if (!local?.enabled) {
    return '配置无误后点击「启用 Relay」。';
  }
  const stats = local?.runner?.stats || local?.log?.stats || {};
  if (local?.runner?.mode === 'official_passthrough') {
    const seenRunSse = Number(stats.seenAgentRunSse || 0);
    const seenBidi = Number(stats.seenBidiAppend || 0);
    return seenRunSse || seenBidi
      ? '官方 Agent 流量正在透传记录；样本已保存到 Runner 日志目录的 samples。'
      : '官方 Agent 纯记录模式已启用；在 Cursor 里发起 Agent 请求后会记录协议帧。';
  }
  const chatTotal = Number(stats.chatTotal || 0);
  if (chatTotal > 0) {
    return '代理正常，Auto 聊天已走您的 API。';
  }
  if (hasLocalOpenAiOverride(local?.cursorSettings)) {
    return '检测到本地配置冲突，请联系管理员处理。';
  }
  if (local?.runner?.running) {
    return 'Relay 已启用，读写请求都走本地代理。';
  }
  return 'Relay 已启用，但本地 runner 未运行，请重新启用。';
}

function formatCertCheckMessage(result) {
  if (!result) return '未能读取证书检查结果。';
  const lines = [
    result.summary || '',
    '',
    ...(Array.isArray(result.checks)
      ? result.checks.map((item) => `${item.ok ? '✓' : '✗'} ${item.label}：${item.detail}`)
      : []),
  ];
  if (result.caExpiresAt) lines.push('', `CA 过期时间：${result.caExpiresAt}`);
  if (result.leafExpiresAt) lines.push(`Leaf 过期时间：${result.leafExpiresAt}`);
  if (result.caCertPath) lines.push('', `CA 路径：${result.caCertPath}`);
  return lines.filter(Boolean).join('\n');
}

function paintCursorLoginBadge(localState = null) {
  const badge = $('relayCursorLoginBadge');
  if (!badge) return;
  const loggedIn = Boolean(localState?.cursorLoggedIn);
  const email = String(localState?.cursorDbEmail || localState?.localEmail || '').trim();
  if (loggedIn && email) {
    setBadge(badge, email, 'ok');
    badge.title = `Cursor 已登录：${email}`;
    return;
  }
  if (localState?.cursorDbEmail || localState?.localEmail) {
    setBadge(badge, '登录态不完整', 'warn');
    badge.title = localState?.dbError || '检测到邮箱但 accessToken 无效或缺失，启用 Relay 时会从 users.json 重新写入';
    return;
  }
  setBadge(badge, '未登录', 'warn');
  badge.title = 'Cursor 尚未登录；启用 Relay 时会从 desktop/js/utils/users.json 自动写入免登账号';
}

async function refreshRelayStatus() {
  applyRelayAdminVisibility();
  const bridge = window.electronBridge;
  if (!bridge?.cursorRelayGetConfig) return;

  setBadge($('relayLocalBadge'), '加载中...', 'muted');
  setBadge($('relayInterceptBadge'), '-', 'muted');
  setBadge($('relayCertBadge'), '检测中...', 'muted');
  setText($('relayStatusHint'), '正在检查状态…');

  if (isRelayAdmin()) {
    setBadge($('relayRunnerBadge'), '加载中...', 'muted');
    setBadge($('relayPatchBadge'), '加载中...', 'muted');
    setText($('relayServerHint'), '正在检查本地 Relay 状态...');
  }

  try {
    const localState = await window.electronBridge?.getLocalCursorState?.().catch(() => null);
    paintCursorLoginBadge(localState);

    const local = await bridge.cursorRelayGetConfig({ lightweight: true });
    const stats = local?.runner?.stats || local?.log?.stats || {};
    const intercept = describeInterceptBadge(stats, local);

    updateRelayToggleButton(local?.enabled, local?.runner?.running);
    if (local?.enabled) {
      const addr = String(local?.proxyServer || local?.runner?.proxyServer || '').trim();
      setBadge($('relayLocalBadge'), addr || '已启用', 'ok');
    } else {
      setBadge($('relayLocalBadge'), '未启用', 'muted');
    }
    setBadge($('relayInterceptBadge'), intercept.text, intercept.tone);
    setBadge(
      $('relayCertBadge'),
      describeCert(local?.cert),
      local?.cert?.caTrustStale ? 'warn' : local?.cert?.caInstalled ? 'ok' : local?.cert?.caReady ? 'warn' : 'muted',
    );
    paintReviewBridgeStatus(local);
    setText($('relayStatusHint'), describeUserStatusHint(local, localState));

    if (isRelayAdmin()) {
      setBadge(
        $('relayRunnerBadge'),
        describeRunner(local?.runner),
        local?.runner?.healthOk ? 'ok' : local?.runner?.running ? 'warn' : 'muted',
      );
      setBadge(
        $('relayPatchBadge'),
        local?.mainJsAllowsProxy ? '已打补丁' : '需要补丁',
        local?.mainJsAllowsProxy ? 'ok' : 'warn',
      );
      setText($('relayArgvHint'), local?.argv?.path || local?.argvPath || '-');
      setText($('relayCertPathHint'), local?.cert?.caCertPath || '-');
      setText(
        $('relayLogPathHint'),
        local?.runner?.logDisplayPath || local?.log?.displayPath || local?.runner?.logPath || '-',
      );
      setText($('relayCursorSettingsHint'), describeRelayProxyLayers(local));
      setText(
        $('relayServerHint'),
        local?.runner?.running
          ? `本地 runner：${local.runner.proxyServer || '127.0.0.1:17789'}`
          : '本地 runner 未运行。',
      );
    }
  } catch (error) {
    updateRelayToggleButton(false);
    setBadge($('relayLocalBadge'), '读取失败', 'warn');
    setBadge($('relayInterceptBadge'), '-', 'muted');
    setBadge($('relayCertBadge'), '未知', 'warn');
    paintReviewBridgeStatus();
    setText($('relayStatusHint'), error.message || '无法读取 Relay 状态。');
    if (isRelayAdmin()) {
      setBadge($('relayRunnerBadge'), '未知', 'warn');
      setBadge($('relayPatchBadge'), '未知', 'warn');
      setText($('relayServerHint'), '无法读取本地 Cursor Relay 配置。');
      setText($('relayArgvHint'), '-');
      setText($('relayCertPathHint'), '-');
      setText($('relayLogPathHint'), '-');
      setText($('relayCursorSettingsHint'), '-');
    }
  }
}

function bindRelayLogButtons() {
  const openLogBtn = $('relayOpenLogBtn');
  const openLogDirBtn = $('relayOpenLogDirBtn');
  const viewLogBtn = $('relayViewLogBtn');
  const bridge = window.electronBridge;

  if (openLogBtn) {
    openLogBtn.onclick = async () => {
      if (!bridge?.cursorRelayOpenLog) {
        await showAlert('当前客户端不支持打开日志。', { title: '打开日志', tone: 'danger' });
        return;
      }
      await withRelayBusy('正在打开日志文件…', async () => {
        try {
          await bridge.cursorRelayOpenLog();
        } catch (error) {
          await showAlert(
            `${error.message || String(error)}\n\n也可手动打开：\n%LOCALAPPDATA%\\CursorPool\\relay\\runner.log`,
            { title: '打开日志失败', tone: 'danger' },
          );
        }
      });
    };
  }

  if (openLogDirBtn) {
    openLogDirBtn.onclick = async () => {
      if (!bridge?.cursorRelayOpenLogDir) {
        await showAlert('当前客户端不支持打开日志目录。', { title: '打开目录', tone: 'danger' });
        return;
      }
      await withRelayBusy('正在打开日志目录…', async () => {
        try {
          await bridge.cursorRelayOpenLogDir();
        } catch (error) {
          await showAlert(error.message || String(error), { title: '打开目录失败', tone: 'danger' });
        }
      });
    };
  }

  if (viewLogBtn) {
    viewLogBtn.onclick = async () => {
      if (!bridge?.cursorRelayReadLog) {
        await showAlert('当前客户端不支持读取日志。', { title: '查看摘要', tone: 'danger' });
        return;
      }
      await withRelayBusy('正在读取 Runner 日志…', async () => {
        try {
          const result = await bridge.cursorRelayReadLog();
          const stats = result?.stats || {};
          const body = [
            result?.message || '',
            '',
            `代理 CONNECT 次数：${stats.connectTotal ?? '?'}`,
            `MITM 拦截次数：${stats.connectMitm ?? '?'}`,
            `HTTP/2 请求次数：${stats.connectH2 ?? '?'}`,
            `RunSSE 次数：${stats.seenAgentRunSse ?? '?'}`,
            `BidiAppend 次数：${stats.seenBidiAppend ?? '?'}`,
            `Bidi 用户消息次数：${stats.seenBidiUserMessage ?? '?'}`,
            `聊天拦截次数：${stats.chatTotal ?? '?'}`,
            '',
            result?.text ? `最近日志：\n${result.text}` : '（暂无日志内容）',
            '',
            `主路径：${result?.primaryPath || '-'}`,
            result?.mirrorPath ? `镜像路径：${result.mirrorPath}` : '',
          ].filter(Boolean).join('\n');
          await showAlert(body, {
            title: 'Runner 日志摘要',
            tone: result?.hasChatIntercept || Number(stats.chatTotal) > 0 ? 'success' : result?.exists ? 'info' : 'warn',
          });
          await refreshRelayStatus();
        } catch (error) {
          await showAlert(error.message || String(error), { title: '查看摘要失败', tone: 'danger' });
        }
      });
    };
  }

  const diagnoseBtn = $('relayDiagnoseBtn');
  if (diagnoseBtn) {
    diagnoseBtn.onclick = async () => {
      if (!bridge?.cursorRelayDiagnose) {
        await showAlert('当前客户端不支持一键诊断。', { title: '一键诊断', tone: 'danger' });
        return;
      }
      await withRelayBusy('正在生成诊断报告…', async () => {
        try {
          const result = await bridge.cursorRelayDiagnose();
          const tone = result?.hasChatIntercept
            ? 'success'
            : result?.chatLikelyBypassing
              ? 'danger'
              : 'info';
          const body = [
            result?.summary || result?.text || '无诊断内容',
            '',
            result?.diagnosePath
              ? `完整报告（UTF-8）：\n${result.diagnosePath}\n\n将用记事本打开。`
              : '',
          ].filter(Boolean).join('\n');
          await showAlert(body, { title: 'Relay 一键诊断', tone });
          if (result?.diagnosePath && bridge.cursorRelayOpenDiagnose) {
            try {
              await bridge.cursorRelayOpenDiagnose();
            } catch {
              /* ignore */
            }
          }
          await refreshRelayStatus();
        } catch (error) {
          await showAlert(error.message || String(error), { title: '诊断失败', tone: 'danger' });
        }
      });
    };
  }

  const officialCaptureBtn = $('relayOfficialCaptureBtn');
  if (officialCaptureBtn) {
    officialCaptureBtn.onclick = () => enableOfficialAgentCapture().catch(() => {});
  }
}

export async function refreshProxyStatus() {
  await reloadProfilesStore();
  renderConfigGrid();
  await refreshRelayStatus();
  await runUpstreamProbe({ silent: true });
}

export async function bindProxyEvents() {
  applyRelayAdminVisibility();
  await initProfilesUi();
  bindRelayLogButtons();

  const relayAgentTestBtn = $('relayAgentTestBtn');
  if (relayAgentTestBtn) {
    relayAgentTestBtn.onclick = async () => {
      const bridge = window.electronBridge;
      if (!bridge?.cursorRelayTestAgent) {
        await showAlert('当前客户端不支持 Relay 对话测试。', { title: 'Relay 对话测试', tone: 'danger' });
        return;
      }
      if (!relayEnabled) {
        await showAlert('请先启用 Relay，再运行对话测试。', { title: 'Relay 对话测试', tone: 'warn' });
        return;
      }

      const active = getActiveProfile(profilesStore);
      if (!active) {
        await showAlert('请先选择一个 Relay 模型配置，再运行对话测试。', { title: 'Relay 对话测试', tone: 'warn' });
        return;
      }
      const upstream = profileToUpstreamPayload(active);

      const ok = await showConfirm(
        '将模拟 Agent 协议测试 Relay，并尝试在 Cursor Agent 窗口发送测试消息。\n\n请确保 Cursor 已打开且 Agent 聊天输入框可见。是否继续？',
        { title: 'Relay 对话测试', tone: 'info', confirmText: '开始测试' },
      );
      if (!ok) return;

      await withRelayBusy('正在测试 Relay 对话通路（约 30–60 秒）…', async () => {
        try {
          const result = await bridge.cursorRelayTestAgent({
            sendToCursor: true,
            upstream,
            ...collectRelayRuntimeOptions(),
          });
          let tone = 'danger';
          if (result?.ok) tone = 'success';
          else if (result?.probeOk && !result?.cursorPathOk) tone = 'warn';

          await showAlert(result?.summary || '测试完成。', {
            title: result?.ok ? 'Relay 对话测试通过' : result?.probeOk ? 'Relay 可用但 Cursor 未走代理' : 'Relay 对话测试失败',
            tone,
          });
          await refreshProxyStatus();
        } catch (error) {
          await showAlert(error.message || String(error), {
            title: 'Relay 对话测试失败',
            tone: 'danger',
          });
        }
      }, { fullscreen: true });
    };
  }

  const relayProbeBtn = $('relayProbeBtn');
  if (relayProbeBtn) {
    relayProbeBtn.onclick = async () => {
      const active = getActiveProfile(profilesStore);
      if (!active) {
        await showAlert('请先添加并选中一个模型配置。', { title: '无法测速', tone: 'danger' });
        return;
      }
      await withRelayBusy('正在测试上游连接...', async () => {
        await testProfileById(active.id, { silent: false });
      });
    };
  }

  const relayToggleBtn = $('relayToggleBtn');
  if (relayToggleBtn) {
    relayToggleBtn.onclick = async () => {
      const bridge = window.electronBridge;
      if (relayEnabled) {
        const skipRelayDisableConfirm = true;
        if (!skipRelayDisableConfirm) {
        const ok = await showConfirm(
          '确定停用 Cursor Relay？这会停止本地 runner，并还原 Cursor 自己的本地 Relay 代理设置；不会修改你当前的系统代理。',
          { title: '停用 Relay', tone: 'warn', confirmText: '停用' },
        );
        if (!ok) return;
        }

        if (relayDisableInFlight) return;
        relayDisableInFlight = true;
        updateRelayToggleButton(false, false);
        void Promise.resolve()
          .then(async () => {
            await bridge?.cursorRelayDisable?.({
              restartCursor: false,
              reloadCursor: false,
              clearSystemProxy: false,
              stopRunner: true,
              fast: true,
            });
          })
          .catch(async (error) => {
            await showAlert(error.message || String(error), {
              title: '停用 Relay 失败',
              tone: 'danger',
            });
          })
          .finally(async () => {
            relayDisableInFlight = false;
            await refreshRelayStatus().catch(() => null);
          });
        return;
      }

      await enableRelayForProfile(getActiveProfile(profilesStore)?.id || '');
    };
  }

  const relayRefreshBtn = $('relayRefreshBtn');
  if (relayRefreshBtn) {
    relayRefreshBtn.onclick = () => withRelayBusy('正在刷新状态…', () => refreshRelayStatus());
  }

  const relayDisableByokBtn = $('relayDisableByokBtn');
  if (relayDisableByokBtn) {
    relayDisableByokBtn.onclick = async () => {
      const bridge = window.electronBridge;
      if (!bridge?.cursorRelayDisableByok) {
        await showAlert('当前客户端不支持此操作。', { title: '清除本地覆写', tone: 'danger' });
        return;
      }
      const ok = await showConfirm(
        '将清除 state.vscdb 里的本地 OpenAI 覆写残留。清除后需重启 Cursor。是否继续？',
        { title: '清除本地覆写', tone: 'warn', confirmText: '清除并重启 Cursor' },
      );
      if (!ok) return;

      await withRelayBusy('正在清除本地覆写并重启 Cursor…', async () => {
        try {
          const result = await bridge.cursorRelayDisableByok({ restartCursor: true });
          await refreshRelayStatus();
          const stillOn = hasLocalOpenAiOverride(result?.cursorSettings);
          await showAlert(
            stillOn
              ? '覆写标记仍在。请完全退出 Cursor 后再试一次。'
              : '本地覆写已清除。',
            { title: stillOn ? '仍需处理' : '已清除', tone: stillOn ? 'warn' : 'success' },
          );
        } catch (error) {
          await showAlert(error.message || String(error), { title: '清除失败', tone: 'danger' });
        }
      });
    };
  }

  const relayCertCheckBtn = $('relayCertCheckBtn');
  if (relayCertCheckBtn) {
    relayCertCheckBtn.onclick = async () => {
      const bridge = window.electronBridge;
      if (!bridge?.cursorRelayCheckCert) {
        await showAlert('当前客户端不支持证书检查。', { title: '证书检查', tone: 'danger' });
        return;
      }

      let result = null;
      let repairResult = null;
      try {
        await withRelayBusy('正在检查 MITM 证书…', async () => {
          setBadge($('relayCertBadge'), '检查中...', 'muted');
          result = await bridge.cursorRelayCheckCert();
        });

        if (result?.needsRepair && bridge.cursorRelayRepairCert) {
          const repair = await showConfirm(
            `${result.summary || '检测到旧版 Relay 根证书仍受信任，但与当前 ca.crt 不一致。'}\n\n是否立即恢复证书？\n\n将删除旧信任项、重新生成 CA/Leaf，并安装新的根证书；如果 Cursor 正在运行，会自动重启 Cursor 加载新证书。`,
            { title: '恢复 MITM 证书', tone: 'warn', confirmText: '恢复' },
          );
          if (repair) {
            await withRelayBusy('正在恢复 MITM 证书…', async () => {
              repairResult = await bridge.cursorRelayRepairCert({ restartCursor: true });
              result = repairResult?.check || result;
            });
          }
        } else if (!result?.readyForMitm && bridge.cursorRelayInstallCert) {
          const install = await showConfirm(
            '根证书尚未受信任，是否尝试安装到本机受信任存储？\n\n（需当前用户权限；如果 Cursor 正在运行，安装后会自动重启 Cursor 来加载新证书）',
            { title: '安装 MITM 证书', tone: 'warn', confirmText: '安装' },
          );
          if (install) {
            await withRelayBusy('正在安装 MITM 证书…', async () => {
              await bridge.cursorRelayInstallCert({ restartCursor: true });
              result = await bridge.cursorRelayCheckCert();
            });
          }
        }

        paintCertBadgeFromCheck(result);
        void refreshRelayStatus();

        if (repairResult?.message) {
          await showAlert(repairResult.message, {
            title: repairResult.ok ? '证书恢复完成' : '证书恢复未完成',
            tone: repairResult.ok ? 'success' : 'warn',
          });
        } else if (!result?.needsRepair) {
          await showAlert(formatCertCheckMessage(result), {
            title: 'MITM 证书检查',
            tone: result?.readyForMitm ? 'success' : result?.ok ? 'info' : 'danger',
          });
        }
      } catch (error) {
        setBadge($('relayCertBadge'), '检查失败', 'warn');
        await showAlert(error.message || String(error), {
          title: '证书检查失败',
          tone: 'danger',
        });
      }
    };
  }

  const relayCertRepairBtn = $('relayCertRepairBtn');
  if (relayCertRepairBtn) {
    relayCertRepairBtn.onclick = async () => {
      const bridge = window.electronBridge;
      if (!bridge?.cursorRelayRepairCert) {
        await showAlert('当前客户端不支持证书恢复。', { title: '恢复证书', tone: 'danger' });
        return;
      }

      const confirmed = await showConfirm(
        '将删除本地 relay 证书文件、清理旧版 Relay 根证书信任项，并重新生成/安装新的 MITM 证书。\n\n完成后若 Relay 已启用，会自动重启 Runner；如果 Cursor 正在运行，也会自动重启 Cursor 加载新证书。\n\n是否继续？',
        { title: '恢复 MITM 证书', tone: 'warn', confirmText: '恢复' },
      );
      if (!confirmed) return;

      let repairResult = null;
      let result = null;
      try {
        await withRelayBusy('正在恢复 MITM 证书…', async () => {
          setBadge($('relayCertBadge'), '恢复中...', 'muted');
          repairResult = await bridge.cursorRelayRepairCert({ restartCursor: true });
          result = repairResult?.check || null;
          paintCertBadgeFromCheck(result);
          void refreshRelayStatus();
        });
        await showAlert(
          [
            repairResult?.message || '证书恢复已完成。',
            '',
            result ? formatCertCheckMessage(result) : '',
          ].filter(Boolean).join('\n'),
          {
            title: repairResult?.ok ? '证书恢复完成' : '证书恢复未完成',
            tone: repairResult?.ok ? 'success' : 'warn',
          },
        );
      } catch (error) {
        setBadge($('relayCertBadge'), '恢复失败', 'warn');
        await showAlert(error.message || String(error), {
          title: '证书恢复失败',
          tone: 'danger',
        });
      }
    };
  }
}

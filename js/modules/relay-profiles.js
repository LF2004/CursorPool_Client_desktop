export const PROVIDER_IDS = ['openai', 'anthropic', 'deepseek', 'gemini', 'mimo', 'custom'];

export const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  mimo: 'MiMo',
  custom: '自定义',
};

export const PROVIDER_HINTS = {
  openai: 'OpenAI 官方或兼容端点。',
  anthropic: 'Anthropic 需使用 OpenAI 兼容网关地址。',
  deepseek: 'DeepSeek 官方端点。',
  gemini: 'Google Gemini OpenAI 兼容端点（官方：https://generativelanguage.googleapis.com/v1beta/openai）。',
  mimo: '小米 MiMo OpenAI 兼容端点（官方：https://api.xiaomimimo.com/v1）。推荐模型：mimo-v2.5-pro、mimo-v2.5。',
  custom: '任意 OpenAI 兼容网关。',
};

export const PROVIDER_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: '',
  deepseek: 'https://api.deepseek.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mimo: 'https://api.xiaomimimo.com/v1',
  custom: '',
};

export const PROVIDER_ICONS = {
  openai: './assets/icons/providers/openai.svg',
  anthropic: './assets/icons/providers/anthropic.svg',
  deepseek: './assets/icons/providers/deepseek.svg',
  gemini: './assets/icons/providers/gemini.svg',
  mimo: './assets/icons/providers/mimo.svg',
  custom: './assets/icons/providers/custom.svg',
};

export const DEFAULT_CONTEXT_WINDOW = 250000;
export const DEFAULT_REASONING_EFFORT = 'medium';
export const REASONING_EFFORT_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
];
export const VALID_REASONING_EFFORTS = REASONING_EFFORT_OPTIONS.map((item) => item.value);

export const RELAY_FIELD_HINTS = {
  name: '配置列表中显示的名称，便于区分多个上游模型。',
  modelName: '请求上游 API 时使用的 model 参数，需与服务商文档一致。',
  apiKey: '上游服务商或中转网关的 API Key，仅保存在本机，不会上传服务器。',
  baseUrl: 'OpenAI 兼容接口的根地址，通常填写到 /v1；不要在地址末尾附加 /chat/completions 或 /responses。',
  contextWindow: 'Relay 压缩较早对话时参考的上下文 token 预算，越大保留历史越多，但也更占额度。',
  reasoningEffort: '推理强度仅对部分支持 reasoning_effort 的模型生效，并不是所有模型都支持。越高通常越稳，但也可能更慢。',
  anthropicThinkingEffort: 'Anthropic adaptive thinking 的思考强度。请求会固定使用新版 thinking.type=adaptive。',
  thinkingMode: 'DeepSeek 思考模式。开启后模型会先输出思考内容，再给出最终回复。',
  mimoThinkingMode: 'MiMo 深度思考。关闭时发送 thinking.type=disabled；开启后模型会先输出思考内容，再给出最终回复。',
  endpointMode: 'OpenAI 兼容接口使用的协议端点。未选择时默认使用 /v1/responses。',
  notes: '可选备注，仅用于本地记录配置用途或特殊说明。',
};

export function getRelayFieldHint(fieldKey, providerId = 'openai') {
  const provider = String(providerId || 'openai').trim().toLowerCase();
  if (fieldKey === 'reasoningEffort' && provider === 'anthropic') {
    return RELAY_FIELD_HINTS.anthropicThinkingEffort;
  }
  if (fieldKey === 'thinkingMode' && provider === 'mimo') {
    return RELAY_FIELD_HINTS.mimoThinkingMode;
  }
  return RELAY_FIELD_HINTS[fieldKey] || '';
}

export function reasoningEffortFieldLabel(providerId = 'openai') {
  return String(providerId || '').trim().toLowerCase() === 'anthropic' ? '思考强度' : '推理强度';
}
export const DEFAULT_DEEPSEEK_THINKING_MODE = 'disabled';
export const DEFAULT_ENDPOINT_MODE = 'responses';

const STORAGE_KEY = 'cursor_relay_upstream_profiles_v2';
const LEGACY_KEY = 'cursor_relay_upstream_config_v1';

function normalizeProviderId(id) {
  const v = String(id || 'custom').trim();
  if (PROVIDER_IDS.includes(v)) return v;
  return 'custom';
}

export function createProfileId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function emptyTestStatus() {
  return {
    status: 'idle',
    message: '',
    latencyMs: 0,
    durationMs: 0,
    ttftMs: 0,
    generationMs: 0,
    tokensPerSecond: 0,
    outputTokens: 0,
    outputTokensEstimated: false,
  };
}

function normalizeTestStatus(raw = {}) {
  const status = String(raw.status || 'idle');
  return {
    status: ['idle', 'ok', 'warn', 'fail', 'testing'].includes(status) ? status : 'idle',
    message: String(raw.message || ''),
    latencyMs: Number(raw.latencyMs) || 0,
    durationMs: Number(raw.durationMs) || Number(raw.latencyMs) || 0,
    ttftMs: Number(raw.ttftMs) || 0,
    generationMs: Number(raw.generationMs) || 0,
    tokensPerSecond: Number(raw.tokensPerSecond) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
    outputTokensEstimated: Boolean(raw.outputTokensEstimated),
  };
}

export function createEmptyProfile(providerId = 'openai') {
  const pid = normalizeProviderId(providerId);
  const now = Date.now();
  return {
    id: createProfileId(),
    name: '',
    providerId: pid,
    baseUrl: PROVIDER_BASE_URLS[pid] || '',
    apiKey: '',
    modelName: '',
    endpointMode: pid === 'gemini' || pid === 'mimo' ? 'chat' : DEFAULT_ENDPOINT_MODE,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    thinkingMode: pid === 'deepseek' || pid === 'mimo' ? DEFAULT_DEEPSEEK_THINKING_MODE : '',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    notes: '',
    testStatus: emptyTestStatus(),
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const providerId = normalizeProviderId(raw.providerId);
  const now = Date.now();
  return {
    id: String(raw.id || createProfileId()),
    name: String(raw.name || raw.modelName || '未命名配置').trim() || '未命名配置',
    providerId,
    baseUrl: String(raw.baseUrl || '').trim(),
    apiKey: String(raw.apiKey || '').trim(),
    modelName: String(raw.modelName || '').trim(),
    endpointMode: raw.endpointMode === 'chat' ? 'chat' : DEFAULT_ENDPOINT_MODE,
    reasoningEffort: VALID_REASONING_EFFORTS.includes(raw.reasoningEffort) ? raw.reasoningEffort : DEFAULT_REASONING_EFFORT,
    thinkingMode: providerId === 'deepseek' || providerId === 'mimo'
      ? (['enabled', 'disabled'].includes(raw.thinkingMode) ? raw.thinkingMode : DEFAULT_DEEPSEEK_THINKING_MODE)
      : '',
    contextWindow: Number(raw.contextWindow) > 0 ? Number(raw.contextWindow) : DEFAULT_CONTEXT_WINDOW,
    notes: String(raw.notes || '').trim(),
    testStatus: normalizeTestStatus(raw.testStatus),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  };
}

function loadLegacySingleConfig() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function migrateLegacyToStore() {
  const legacy = loadLegacySingleConfig();
  if (!legacy) return null;
  const profile = normalizeProfile({
    id: createProfileId(),
    name: legacy.modelName || '默认配置',
    providerId: legacy.providerId,
    baseUrl: legacy.baseUrl,
    apiKey: legacy.apiKey,
    modelName: legacy.modelName,
    endpointMode: legacy.endpointMode,
    reasoningEffort: legacy.reasoningEffort,
    thinkingMode: legacy.thinkingMode,
    contextWindow: legacy.contextWindow,
  });
  return {
    version: 2,
    activeId: profile.id,
    filterProvider: profile.providerId,
    configs: [profile],
  };
}

function loadProfilesStoreFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const configs = Array.isArray(parsed?.configs)
        ? parsed.configs.map(normalizeProfile).filter(Boolean)
        : [];
      const activeId = configs.some((c) => c.id === parsed?.activeId)
        ? parsed.activeId
        : configs[0]?.id || '';
      return {
        version: 2,
        activeId,
        filterProvider: normalizeProviderId(parsed?.filterProvider || 'openai'),
        configs,
      };
    }
  } catch {
    /* ignore */
  }

  const migrated = migrateLegacyToStore();
  if (migrated) {
    saveProfilesStoreToLocalStorage(migrated);
    return migrated;
  }

  return {
    version: 2,
    activeId: '',
    filterProvider: 'openai',
    configs: [],
  };
}

function saveProfilesStoreToLocalStorage(store) {
  try {
    const payload = {
      version: 2,
      activeId: store.activeId || '',
      filterProvider: normalizeProviderId(store.filterProvider || 'openai'),
      configs: (store.configs || []).map((item) => {
        const p = normalizeProfile(item);
        return {
          id: p.id,
          name: p.name,
          providerId: p.providerId,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          modelName: p.modelName,
          endpointMode: p.endpointMode,
          reasoningEffort: p.reasoningEffort,
          thinkingMode: p.thinkingMode,
          contextWindow: p.contextWindow,
          notes: p.notes,
          testStatus: p.testStatus,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        };
      }),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    syncLegacyActiveConfig(payload);
  } catch {
    /* ignore */
  }
}

function syncLegacyActiveConfig(store) {
  const active = store.configs.find((c) => c.id === store.activeId);
  if (!active) return;
  try {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({
      providerId: active.providerId,
      baseUrl: active.baseUrl,
      modelName: active.modelName,
      apiKey: active.apiKey,
      endpointMode: active.endpointMode,
      reasoningEffort: active.reasoningEffort,
      thinkingMode: active.thinkingMode,
      contextWindow: active.contextWindow,
    }));
  } catch {
    /* ignore */
  }
}

export function getActiveProfile(store) {
  return store.configs.find((c) => c.id === store.activeId) || null;
}

export function getProfileById(store, id) {
  return store.configs.find((c) => c.id === id) || null;
}

export function upsertProfile(store, profile) {
  const normalized = normalizeProfile(profile);
  const idx = store.configs.findIndex((c) => c.id === normalized.id);
  normalized.updatedAt = Date.now();
  if (idx >= 0) {
    store.configs[idx] = { ...store.configs[idx], ...normalized };
  } else {
    store.configs.push(normalized);
    if (!store.activeId) store.activeId = normalized.id;
  }
  saveProfilesStoreToLocalStorage(store);
  return normalized;
}

export function deleteProfile(store, id) {
  store.configs = store.configs.filter((c) => c.id !== id);
  if (store.activeId === id) {
    store.activeId = store.configs[0]?.id || '';
  }
  saveProfilesStoreToLocalStorage(store);
}

export function duplicateProfile(store, id) {
  const src = getProfileById(store, id);
  if (!src) return null;
  const copy = normalizeProfile({
    ...src,
    id: createProfileId(),
    name: `${src.name} 副本`,
    testStatus: emptyTestStatus(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.configs.push(copy);
  saveProfilesStoreToLocalStorage(store);
  return copy;
}

export function setActiveProfile(store, id) {
  if (!store.configs.some((c) => c.id === id)) return false;
  store.activeId = id;
  saveProfilesStoreToLocalStorage(store);
  return true;
}

export async function loadProfilesStore() {
  const bridge = window.electronBridge;
  if (!bridge?.cursorRelayProfilesLoad) {
    return loadProfilesStoreFromLocalStorage();
  }
  try {
    const dbStore = await bridge.cursorRelayProfilesLoad();
    const hasDbConfigs = Array.isArray(dbStore?.configs) && dbStore.configs.length > 0;
    if (hasDbConfigs) {
      const normalized = {
        version: Number(dbStore.version) || 2,
        activeId: String(dbStore.activeId || ''),
        filterProvider: normalizeProviderId(dbStore.filterProvider || 'openai'),
        configs: dbStore.configs.map(normalizeProfile).filter(Boolean),
      };
      saveProfilesStoreToLocalStorage(normalized);
      return normalized;
    }

    const localStore = loadProfilesStoreFromLocalStorage();
    if (Array.isArray(localStore.configs) && localStore.configs.length > 0) {
      await bridge.cursorRelayProfilesSave(localStore);
    }
    return localStore;
  } catch {
    return loadProfilesStoreFromLocalStorage();
  }
}

export async function saveProfilesStore(store) {
  const payload = {
    version: 2,
    activeId: store.activeId || '',
    filterProvider: normalizeProviderId(store.filterProvider || 'openai'),
    configs: (store.configs || []).map((item) => {
      const p = normalizeProfile(item);
      return {
        id: p.id,
        name: p.name,
        providerId: p.providerId,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        modelName: p.modelName,
        endpointMode: p.endpointMode,
        reasoningEffort: p.reasoningEffort,
        thinkingMode: p.thinkingMode,
        contextWindow: p.contextWindow,
        notes: p.notes,
        testStatus: p.testStatus,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    }),
  };
  saveProfilesStoreToLocalStorage(payload);
  const bridge = window.electronBridge;
  if (!bridge?.cursorRelayProfilesSave) return payload;
  try {
    await bridge.cursorRelayProfilesSave(payload);
    await bridge.refreshTrayMenu?.();
  } catch {
    /* ignore */
  }
  return payload;
}

export function profileToUpstreamPayload(profile) {
  const p = normalizeProfile(profile);
  return {
    providerId: p.providerId,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    modelName: p.modelName,
    endpointMode: p.endpointMode,
    reasoningEffort: p.reasoningEffort,
    thinkingMode: p.thinkingMode,
    contextWindow: p.contextWindow,
  };
}

export function maskApiKey(key) {
  const v = String(key || '').trim();
  if (!v) return '-';
  if (v.length <= 4) return '****';
  return `**${v.slice(-2)}`;
}

export function hostFromBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.host || baseUrl;
  } catch {
    return String(baseUrl || '-').replace(/^https?:\/\//, '').split('/')[0] || '-';
  }
}

export function endpointLabel(mode) {
  return mode === 'chat' ? '/v1/chat/completions' : '/v1/responses';
}

export function reasoningEffortLabel(effort) {
  const value = String(effort || '').trim().toLowerCase();
  return REASONING_EFFORT_OPTIONS.find((item) => item.value === value)?.label
    || REASONING_EFFORT_OPTIONS.find((item) => item.value === DEFAULT_REASONING_EFFORT)?.label
    || '中';
}

export function testStatusLabel(status) {
  switch (status) {
    case 'ok': return '可用';
    case 'warn': return '可达';
    case 'fail': return '不可用';
    case 'testing': return '测试中…';
    default: return '未测试';
  }
}

export function providerIconHtml(providerId, className = 'relay-provider-icon') {
  const id = normalizeProviderId(providerId);
  const src = PROVIDER_ICONS[id] || PROVIDER_ICONS.custom;
  const label = PROVIDER_LABELS[id] || '自定义';
  return `<img class="${className}" src="${src}" alt="${label}" width="16" height="16" />`;
}

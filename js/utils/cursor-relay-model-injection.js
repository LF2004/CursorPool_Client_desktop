/**
 * cursor-relay-model-injection.js
 *
 * 把软件内本地模型列表注入 Cursor 客户端。
 *
 * 原理（逆向文档已确认）：
 *   Cursor 客户端通过两个 RPC 获取可用模型：
 *     1. /aiserver.v1.AiService/AvailableModels  → AvailableModelsResponse { model_names: [] }
 *     2. /agent.v1.AgentService/GetUsableModels  → GetUsableModelsResponse { models: [ModelDetails] }
 *
 *   AvailableModels 返回的是模型名列表（string[]），
 *   GetUsableModels 返回的是 ModelDetails[]（含 model_id/display_name/display_name_short 等）。
 *
 *   Cursor 客户端右下角的模型下拉框数据来源就是这两个 RPC 的响应。
 *
 *   我们在 MITM 代理拦截这两个响应，把本地 relay profile 里配置的模型合并进去，
 *   这样用户就能在 Cursor 客户端直接选择本地模型。
 *
 *   同时拦截 GetDefaultModelForCli（返回默认模型），
 *   如果本地 relay profile 指定了默认模型，就改成返回本地的。
 *
 * 配合 tray.js 的"切换本地模型"菜单：
 *   tray 切换 → 改 relay profile store 的 activeId + 重启 runner upstream
 *   本模块 → 把所有 relay profile 模型都塞进 Cursor 下拉框
 *   两者结合：用户在 Cursor 客户端选哪个模型，relay 就用哪个 upstream
 */

const fs = require('fs');
const path = require('path');
const {
  loadCursorProtoRoot,
  getRootSync,
  encodeMessageSync,
  decodeMessageSync,
  readConnectFrames,
  buildConnectFrame,
  resolveTypesFromPathSync,
} = require('./cursor-relay-protobuf');
const { loadRelayProfileStore } = require('./cursor-relay-profile-store');
const { getRelayDataDir } = require('./cursor-relay-cert');

// 需要拦截的路径
const AVAILABLE_MODELS_PATH = '/aiserver.v1.AiService/AvailableModels';
const GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';
const GET_DEFAULT_MODEL_PATH = '/agent.v1.AgentService/GetDefaultModelForCli';
const GET_DEFAULT_MODEL_NUDGE_PATH = '/aiserver.v1.AiService/GetDefaultModelNudgeData';

function buildRelayModelParameterDefinitions() {
  return [
    {
      id: 'thinking',
      name: 'thinking',
      markdownTooltip: 'Enable thinking mode for this local relay model.',
      parameterType: {
        booleanParameter: {},
      },
    },
    {
      id: 'reasoning',
      name: 'reasoning',
      markdownTooltip: 'Reasoning effort level.',
      parameterType: {
        enumParameter: {
          values: [
            { value: 'low', displayName: 'Low' },
            { value: 'medium', displayName: 'Medium' },
            { value: 'high', displayName: 'High' },
            { value: 'extra-high', displayName: 'XHigh' },
          ],
        },
      },
    },
  ];
}

function buildRelayModelVariants(displayName, shortName, rawReasoningEffort = 'medium') {
  const normalizedEffort = (() => {
    const effort = String(rawReasoningEffort || 'medium').trim().toLowerCase();
    if (!effort) return 'medium';
    if (effort === 'xhigh') return 'extra-high';
    return effort;
  })();
  const badgeLabel = normalizedEffort === 'extra-high'
    ? 'XHigh'
    : `${normalizedEffort.charAt(0).toUpperCase()}${normalizedEffort.slice(1)}`;
  const outsidePicker = `${shortName} ${badgeLabel}`.trim();
  return [
    {
      parameterValues: [
        { id: 'thinking', value: 'true' },
        { id: 'reasoning', value: normalizedEffort },
      ],
      displayName: `${displayName} ${badgeLabel}`.trim(),
      displayNameOutsidePicker: outsidePicker,
      variantStringRepresentation: `${String(displayName || '').toLowerCase().replace(/\s+/g, '-')}-thinking-${normalizedEffort}`,
      isMaxMode: false,
      isDefaultMaxConfig: false,
      isDefaultNonMaxConfig: true,
      tooltipData: {
        markdownContent: `Thinking enabled<br /><br />Reasoning: ${badgeLabel}`,
      },
      tagline: 'Reasoning enabled',
    },
  ];
}

function buildRelayModelPickerDisplayConfiguration() {
  return {
    routedModelViewConfig: {
      title: 'Auto',
      hideRoutedModelView: true,
      hideSearchBar: false,
      routedModelViewToNamedViewToggle: {
        titleMarkdown: 'Models',
        subtitle: '',
        setToLastNamedModel: true,
      },
    },
    namedModelsViewConfig: {
      namedViewToRoutedModelViewNoButton: {},
    },
  };
}

/**
 * 从 relay profile store 收集所有本地模型
 * @returns {{modelName, displayName, displayNameShort, profileId, modelId, reasoningEffort, thinkingMode}[]}
 */
function dedupeModels(models = []) {
  const seen = new Set();
  const merged = [];
  for (const item of Array.isArray(models) ? models : []) {
    const modelName = String(item?.modelName || '').trim();
    if (!modelName || seen.has(modelName)) continue;
    seen.add(modelName);
    merged.push({
      modelName,
      displayName: String(item?.displayName || modelName).trim() || modelName,
      displayNameShort: String(item?.displayNameShort || item?.displayName || modelName).trim().slice(0, 20) || modelName.slice(0, 20),
      profileId: String(item?.profileId || '').trim(),
      modelId: String(item?.modelId || modelName).trim() || modelName,
      reasoningEffort: String(item?.reasoningEffort || 'medium').trim() || 'medium',
      thinkingMode: String(item?.thinkingMode || '').trim(),
      contextWindow: Number(item?.contextWindow) > 0 ? Number(item.contextWindow) : 200000,
      endpointMode: String(item?.endpointMode || '').trim().toLowerCase() || 'responses',
    });
  }
  return merged;
}

function collectModelsFromRunnerConfig(customRoot = '') {
  try {
    const configPath = path.join(getRelayDataDir(customRoot), 'runner-config.json');
    if (!fs.existsSync(configPath)) return [];
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const models = [];

    const pushSourceModels = (source, profileId) => {
      if (!source || typeof source !== 'object') return;
      const displayName = String(source.displayName || source.name || source.modelName || '').trim();
      const candidates = [
        String(source.modelName || '').trim(),
        ...(Array.isArray(source.availableModels) ? source.availableModels.map((item) => String(item || '').trim()) : []),
      ].filter(Boolean);
      for (const modelName of candidates) {
        models.push({
          modelName,
          displayName: displayName || modelName,
          displayNameShort: (displayName || modelName).slice(0, 20),
          profileId,
          modelId: modelName,
          reasoningEffort: String(source.reasoningEffort || 'medium').trim() || 'medium',
          thinkingMode: String(source.thinkingMode || '').trim(),
          contextWindow: Number(source.contextWindow) > 0 ? Number(source.contextWindow) : 200000,
          endpointMode: String(source.endpointMode || '').trim().toLowerCase() || 'responses',
        });
      }
    };

    pushSourceModels(raw?.upstream, 'runner-upstream');
    for (const route of Array.isArray(raw?.modelRoutes) ? raw.modelRoutes : []) {
      const routeModelName = String(route?.modelName || '').trim();
      pushSourceModels(
        {
          ...(route?.upstream && typeof route.upstream === 'object' ? route.upstream : {}),
          modelName: routeModelName || route?.upstream?.modelName,
        },
        routeModelName ? `runner-route:${routeModelName}` : 'runner-route',
      );
    }

    return dedupeModels(models);
  } catch {
    return [];
  }
}

function collectLocalModels() {
  const models = [];
  try {
    const store = loadRelayProfileStore('');
    if (Array.isArray(store.configs)) {
      for (const c of store.configs.filter((item) => item && item.modelName)) {
        const candidateNames = [
          String(c.modelName || '').trim(),
        ].filter(Boolean);
        for (const modelName of candidateNames) {
          models.push({
            modelName,
            displayName: String(c.name || modelName || '').trim(),
            displayNameShort: String(c.name || modelName || '').trim().slice(0, 20),
            profileId: String(c.id || ''),
            modelId: modelName,
            reasoningEffort: String(c.reasoningEffort || 'medium').trim() || 'medium',
            thinkingMode: String(c.thinkingMode || '').trim(),
            contextWindow: Number(c.contextWindow) > 0 ? Number(c.contextWindow) : 200000,
            endpointMode: String(c.endpointMode || '').trim().toLowerCase() || 'responses',
          });
        }
      }
    }
  } catch {
    // 忽略 profile store 读取失败，继续尝试 runner-config 兜底
  }
  models.push(...collectModelsFromRunnerConfig(''));
  return dedupeModels(models);
}

function decodeUnaryOrConnect(typeName, upstreamResponseBody) {
  const frames = readConnectFrames(upstreamResponseBody);
  if (frames.length) {
    return {
      mode: 'connect',
      frames,
      messages: frames.map((frame) => ({
        flags: frame.flags,
        value: decodeMessageSync(typeName, frame.payload),
      })),
    };
  }
  return {
    mode: 'unary',
    frames: [],
    messages: [{ flags: 0, value: decodeMessageSync(typeName, upstreamResponseBody) }],
  };
}

function encodeUnaryOrConnect(typeName, decoded, buildMergedValue) {
  const messages = [];
  let modified = false;
  for (const entry of decoded.messages) {
    const nextValue = buildMergedValue(entry.value);
    if (nextValue !== entry.value) modified = true;
    messages.push({
      flags: entry.flags || 0,
      payload: encodeMessageSync(typeName, nextValue),
    });
  }
  if (!modified) return null;
  if (decoded.mode === 'connect') {
    return Buffer.concat(messages.map((frame) => buildConnectFrame(frame.payload, frame.flags)));
  }
  return messages[0]?.payload || null;
}

/**
 * 判断当前请求路径是否需要模型注入
 */
function isModelListPath(pathname) {
  return (
    pathname === AVAILABLE_MODELS_PATH ||
    pathname === GET_USABLE_MODELS_PATH ||
    pathname === GET_DEFAULT_MODEL_PATH ||
    pathname === GET_DEFAULT_MODEL_NUDGE_PATH
  );
}

/**
 * 拦截 AvailableModels 响应：把本地模型名合并进 model_names 和 models
 *
 * 关键发现（逆向 workbench.desktop.main.js 确认）：
 *   AvailableModelsResponse 有两个字段：
 *     - model_names (field #1, repeated string) — 旧格式兼容
 *     - models (field #2, repeated ModelDetails/复杂对象) — **UI 主要读这个！**
 *   Cursor 的 refreshDefaultModels() 用 i.models (字段#2)，每个元素有：
 *     name, clientDisplayName, serverModelName, degradationStatus, price,
 *     supportsMaxMode, visibleInRoutedModelView
 *   如果只写 modelNames 而不写 models，UI 显示 "No models available"
 *
 * @param {Buffer} upstreamResponseBody 上游原始响应体（Connect 帧）
 * @returns {Buffer|null} 注入后的响应体，或 null 表示不修改
 */
function injectAvailableModelsResponse(upstreamResponseBody) {
  const localModels = collectLocalModels();
  if (!localModels.length) return null;

  try {
    const decoded = decodeUnaryOrConnect('aiserver.v1.AvailableModelsResponse', upstreamResponseBody);
    return encodeUnaryOrConnect('aiserver.v1.AvailableModelsResponse', decoded, (resp) => {
      const localModelNames = localModels.map((m) => String(m.modelName || '').trim()).filter(Boolean);
      const defaultModel = localModelNames[0] || '';
      const localModelConfig = {
        defaultModel,
        fallbackModels: localModelNames,
        bestOfNDefaultModels: localModelNames,
      };

      // ── 注入到 model_names (field #1, string[]) — 兼容旧路径 ──
      const existingNames = new Set(
        Array.isArray(resp.modelNames) ? resp.modelNames.map((s) => String(s)) : [],
      );
      const namesToAdd = localModels
        .map((m) => m.modelName)
        .filter((name) => !existingNames.has(name));

      // ── 注入到 models (field #2, AvailableModel[]) — UI 主要读这个！──
      // [FIX #3] 使用正确的 AvailableModel 字段名（从源 proto 还原，非 ModelDetails 占位）
      // 关键字段：supportsAgent(=#5) 决定是否出现在 Agent 下拉框
      const existingModels = Array.isArray(resp.models) ? resp.models : [];
      const existingModelNames = new Set(existingModels.map((m) => String(m.name || '')));
      const modelsToAdd = localModels
        .filter((m) => !existingModelNames.has(m.modelName))
        .map((m) => {
          const reasoningEffort = String(m.reasoningEffort || 'medium').trim() || 'medium';
          const shortName = m.displayNameShort || m.displayName || m.modelName;
          const reasoningLabel = reasoningEffort === 'xhigh'
            ? 'XHigh'
            : reasoningEffort === 'extra-high'
              ? 'XHigh'
              : `${reasoningEffort.charAt(0).toUpperCase()}${reasoningEffort.slice(1)}`;
          const tooltipParts = [
            `**${m.displayName || m.modelName}**`,
            `Model: ${m.modelName}`,
            'Local relay model',
            '200000 context window',
            m.thinkingMode === 'disabled' ? 'Thinking: disabled' : 'Thinking: enabled',
            `Reasoning: ${reasoningLabel}`,
          ];
          return ({
          name: m.modelName,                              // #1 模型标识
          defaultOn: true,                                 // #2 默认启用，确保对话框可见
          visibleInRoutedModelView: true,                  // 路由视图与聊天模型选择器都可见
          namedModelSectionIndex: 99,
          tagline: 'Local provider model',
          supportsAgent: true,                             // #5 ← **关键！** 出现在 Agent 下拉
          supportsThinking: true,                          // #9 支持推理
          supportsImages: true,                            // #10 支持图片
          supportsAutoContext: true,                       // #11 支持自动上下文
          autoContextMaxTokens: 200000,                    // #12 自动上下文最大 token
          autoContextExtendedMaxTokens: 200000,            // #13 扩展自动上下文最大 token
          supportsMaxMode: true,                           // #14 支持 Max 模式
          contextTokenLimit: 200000,                       // #15 上下文 token 限制
          supportsNonMaxMode: true,                        // #19 支持 Non-Max
          supportsPlanMode: true,                          // #22 支持 Plan 模式
          supportsSandboxing: true,                        // #25 支持沙箱
          supportsCmdK: true,                              // #26 支持 Cmd+K
          parameterDefinitions: buildRelayModelParameterDefinitions(),
          variants: buildRelayModelVariants(
            m.displayName || m.modelName,
            shortName,
            reasoningEffort,
          ),
          legacySlugs: [],
          idAliases: [],
          cloudAgentEffortModes: ['low', 'medium', 'high', 'extra-high'],
          clientDisplayName: m.displayName || m.modelName, // #17 UI 显示名
          serverModelName: m.modelName,                    // #18 服务端模型名
          tooltipData: {
            markdownContent: tooltipParts.join('<br /><br />'),
          },
          inputboxShortModelName: shortName, // #24 输入框简短名
          degradationStatus: 0,                             // #6 UNSPECIFIED
        });
        });

      const hasLocalFeatureConfig = [
        resp.defaultModelConfig,
        resp.composerModelConfig,
        resp.cmdKModelConfig,
        resp.backgroundComposerModelConfig,
        resp.planExecutionModelConfig,
      ].some((entry) => {
        const defaultName = String(entry?.defaultModel || '').trim();
        const fallback = Array.isArray(entry?.fallbackModels) ? entry.fallbackModels : [];
        return localModelNames.includes(defaultName) || fallback.some((name) => localModelNames.includes(String(name || '').trim()));
      });

      if (!namesToAdd.length && !modelsToAdd.length && hasLocalFeatureConfig) return resp;

      return {
        ...resp,
        modelNames: [...(resp.modelNames || []), ...namesToAdd],
        models: [...existingModels, ...modelsToAdd],
        defaultModelConfig: resp.defaultModelConfig || localModelConfig,
        composerModelConfig: localModelConfig,
        cmdKModelConfig: localModelConfig,
        backgroundComposerModelConfig: localModelConfig,
        planExecutionModelConfig: localModelConfig,
        specModelConfig: localModelConfig,
        deepSearchModelConfig: resp.deepSearchModelConfig || { defaultModel },
        quickAgentModelConfig: resp.quickAgentModelConfig || { defaultModel },
        slowPoolModelConfig: resp.slowPoolModelConfig || localModelConfig,
        disableUnusedModelsAfterNHours: Number(resp.disableUnusedModelsAfterNHours) || 2400000,
        upgradeUnchangedModelsAfterNHours: Number(resp.upgradeUnchangedModelsAfterNHours) || 2,
        displayConfiguration: resp.displayConfiguration || buildRelayModelPickerDisplayConfiguration(),
        useModelParameters: true,
      };
    });
  } catch {
    return null;
  }
}

/**
 * 拦截 GetUsableModels 响应：把本地模型作为 ModelDetails 合并进 models
 *
 * @param {Buffer} upstreamResponseBody
 * @returns {Buffer|null}
 */
function injectGetUsableModelsResponse(upstreamResponseBody) {
  const localModels = collectLocalModels();
  if (!localModels.length) return null;

  try {
    const decoded = decodeUnaryOrConnect('agent.v1.GetUsableModelsResponse', upstreamResponseBody);
    return encodeUnaryOrConnect('agent.v1.GetUsableModelsResponse', decoded, (resp) => {
      const existing = new Set(
        Array.isArray(resp.models)
          ? resp.models.map((m) => String(m.modelId || ''))
          : [],
      );
      const toAdd = localModels
        .filter((m) => !existing.has(m.modelId))
        .map((m) => ({
          modelId: m.modelId,
          displayModelId: m.modelId,
          displayName: m.displayName,
          displayNameShort: m.displayNameShort,
          aliases: [m.modelName],
        }));
      if (!toAdd.length) return resp;
      return {
        ...resp,
        models: [...(resp.models || []), ...toAdd],
      };
    });
  } catch {
    return null;
  }
}

/**
 * 拦截 GetDefaultModelForCli 响应：如果本地 relay profile 有 activeId，
 * 返回该 profile 的模型作为默认模型
 *
 * 注意 proto 定义：GetDefaultModelForCliResponse { ModelDetails model = 1; }
 *   model 是嵌套的 ModelDetails 消息，不是扁平的 modelId 字符串。
 *   ModelDetails 包含 modelId/displayName/displayNameShort/aliases 等字段。
 *
 * @param {Buffer} upstreamResponseBody
 * @returns {Buffer|null}
 */
function injectGetDefaultModelResponse(upstreamResponseBody) {
  try {
    const store = loadRelayProfileStore('');
    const activeProfile = Array.isArray(store.configs)
      ? store.configs.find((c) => String(c.id) === String(store.activeId))
      : null;
    if (!activeProfile?.modelName) return null;

    const decoded = decodeUnaryOrConnect('agent.v1.GetDefaultModelForCliResponse', upstreamResponseBody);
    return encodeUnaryOrConnect('agent.v1.GetDefaultModelForCliResponse', decoded, (resp) => {
        // resp.model 是 ModelDetails 嵌套对象 (resp.model.modelId)
        const currentModelId = String(resp.model?.modelId || '');
        // 如果已经是本地模型就不改
        if (currentModelId === String(activeProfile.modelName)) return resp;
        // 构造新的 ModelDetails，保留上游原有字段，只覆盖 modelId
        return {
          ...resp,
          model: {
            ...(resp.model || {}),
            modelId: String(activeProfile.modelName),
            displayName: String(activeProfile.name || activeProfile.modelName || resp.model?.displayName || ''),
            displayNameShort: String(activeProfile.name || activeProfile.modelName || resp.model?.displayNameShort || ''),
          },
        };
    });
  } catch {
    return null;
  }
}

/**
 * 统一入口：给定请求路径和上游响应体，返回注入后的响应体
 * @param {string} pathname HTTP 路径
 * @param {Buffer} upstreamResponseBody
 * @returns {Buffer|null} 修改后的响应体，null 表示原样透传
 */
function injectModelListResponse(pathname, upstreamResponseBody) {
  if (!isModelListPath(pathname)) return null;
  try {
    if (pathname === AVAILABLE_MODELS_PATH) {
      return injectAvailableModelsResponse(upstreamResponseBody);
    }
    if (pathname === GET_USABLE_MODELS_PATH) {
      return injectGetUsableModelsResponse(upstreamResponseBody);
    }
    if (pathname === GET_DEFAULT_MODEL_PATH) {
      return injectGetDefaultModelResponse(upstreamResponseBody);
    }
    if (pathname === GET_DEFAULT_MODEL_NUDGE_PATH) {
      const localModels = collectLocalModels();
      const modelNames = localModels.map((m) => String(m.modelName || '').trim()).filter(Boolean);
      if (!modelNames.length) return null;
      const decoded = decodeUnaryOrConnect('aiserver.v1.GetDefaultModelNudgeDataResponse', upstreamResponseBody);
      return encodeUnaryOrConnect('aiserver.v1.GetDefaultModelNudgeDataResponse', decoded, (resp) => ({
        ...resp,
        nudgeDate: String(resp.nudgeDate || '0'),
        shouldDefaultSwitchOnNewChat: false,
        modelsWithNoDefaultSwitch: Array.from(new Set([
          ...(Array.isArray(resp.modelsWithNoDefaultSwitch) ? resp.modelsWithNoDefaultSwitch : []),
          ...modelNames,
        ])),
      }));
    }
  } catch (e) {
    // 注入失败不影响正常流程
  }
  return null;
}

/**
 * 当 tray 切换本地模型后，可选地触发 Cursor 客户端刷新模型列表。
 * Cursor 客户端会在下次发 AvailableModels 请求时自动拿到新列表，
 * 所以这里只是个 no-op 占位，真正的注入在响应拦截时完成。
 */
function notifyModelListChanged() {
  // no-op: 下次 AvailableModels 请求会自动注入
}

module.exports = {
  AVAILABLE_MODELS_PATH,
  GET_USABLE_MODELS_PATH,
  GET_DEFAULT_MODEL_PATH,
  GET_DEFAULT_MODEL_NUDGE_PATH,
  collectLocalModels,
  isModelListPath,
  injectAvailableModelsResponse,
  injectGetUsableModelsResponse,
  injectGetDefaultModelResponse,
  injectModelListResponse,
  notifyModelListChanged,
};

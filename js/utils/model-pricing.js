/**
 * Official API pricing per 1M tokens (cache miss input / cache hit input / output).
 * Sources verified 2026-06-15:
 * - OpenAI: https://openai.com/api/pricing/
 * - Anthropic: https://www.anthropic.com/pricing (cache read = 10% of input)
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
 * - Gemini: https://ai.google.dev/gemini-api/docs/pricing
 * - MiMo: https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go
 */

const PRICE_SOURCES = {
  openai: {
    id: 'openai_api_pricing_2026-06-10',
    url: 'https://openai.com/api/pricing/',
    label: 'OpenAI',
  },
  anthropic: {
    id: 'anthropic_api_pricing_2026-06-10',
    url: 'https://www.anthropic.com/pricing',
    label: 'Anthropic',
  },
  deepseek: {
    id: 'deepseek_api_pricing_2026-06-10',
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    label: 'DeepSeek',
  },
  gemini: {
    id: 'gemini_api_pricing_2026-06-15',
    url: 'https://ai.google.dev/gemini-api/docs/pricing',
    label: 'Gemini',
  },
  mimo: {
    id: 'mimo_api_pricing_2026-06-15',
    url: 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go',
    label: 'MiMo',
  },
};

/** @type {Array<{ match: RegExp, provider: keyof typeof PRICE_SOURCES, label: string, inputPerMillion: number, cachedInputPerMillion: number, outputPerMillion: number }>} */
const MODEL_PRICES = [
  // --- OpenAI GPT ---
  { match: /^gpt-5\.5-pro(?:$|[-_:])/i, provider: 'openai', label: 'gpt-5.5 pro', inputPerMillion: 30, cachedInputPerMillion: 0, outputPerMillion: 180 },
  { match: /^gpt-5\.5(?:$|[-_:])/i, provider: 'openai', label: 'gpt-5.5', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
  { match: /^gpt-5\.4-mini(?:$|[-_:])/i, provider: 'openai', label: 'gpt-5.4 mini', inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 },
  { match: /^gpt-5\.4-nano(?:$|[-_:])/i, provider: 'openai', label: 'gpt-5.4 nano', inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.25 },
  { match: /^gpt-5\.4-pro(?:$|[-_:])/i, provider: 'openai', label: 'gpt-5.4 pro', inputPerMillion: 30, cachedInputPerMillion: 0, outputPerMillion: 180 },
  { match: /^gpt-5\.4(?:$|[-_:])/i, provider: 'openai', label: 'gpt-5.4', inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15 },
  { match: /^gpt-5-mini(?:$|[-_:])/i, provider: 'openai', label: 'gpt-5 mini', inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  { match: /^gpt-5-nano(?:$|[-_:])/i, provider: 'openai', label: 'gpt-5 nano', inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 },
  { match: /^gpt-5(?:$|[-_:])/i, provider: 'openai', label: 'gpt-5', inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  { match: /^gpt-4o-mini(?:$|[-_:])/i, provider: 'openai', label: 'gpt-4o mini', inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6 },
  { match: /^gpt-4o(?:$|[-_:])/i, provider: 'openai', label: 'gpt-4o', inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10 },
  { match: /^o3-mini(?:$|[-_:])/i, provider: 'openai', label: 'o3 mini', inputPerMillion: 1.1, cachedInputPerMillion: 0.55, outputPerMillion: 4.4 },
  { match: /^o3(?:$|[-_:])/i, provider: 'openai', label: 'o3', inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 },
  { match: /^o1-mini(?:$|[-_:])/i, provider: 'openai', label: 'o1 mini', inputPerMillion: 1.1, cachedInputPerMillion: 0.55, outputPerMillion: 4.4 },
  { match: /^o1(?:$|[-_:])/i, provider: 'openai', label: 'o1', inputPerMillion: 15, cachedInputPerMillion: 7.5, outputPerMillion: 60 },

  // --- Anthropic Claude (newest first) ---
  { match: /^claude-opus-4-8(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Opus 4.8', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 25 },
  { match: /^claude-opus-4-7(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Opus 4.7', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 25 },
  { match: /^claude-opus-4-6(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Opus 4.6', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 25 },
  { match: /^claude-opus-4-5(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Opus 4.5', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 25 },
  { match: /^claude-opus-4-1(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Opus 4.1', inputPerMillion: 15, cachedInputPerMillion: 1.5, outputPerMillion: 75 },
  { match: /^claude-opus-4(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Opus 4', inputPerMillion: 15, cachedInputPerMillion: 1.5, outputPerMillion: 75 },
  { match: /^claude-sonnet-4-6(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Sonnet 4.6', inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
  { match: /^claude-sonnet-4-5(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Sonnet 4.5', inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
  { match: /^claude-sonnet-4(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Sonnet 4', inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
  { match: /^claude-haiku-4-5(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Haiku 4.5', inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 5 },
  { match: /^claude-haiku-3-5(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Haiku 3.5', inputPerMillion: 0.8, cachedInputPerMillion: 0.08, outputPerMillion: 4 },
  { match: /^claude-haiku-3(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Haiku 3', inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 1.25 },
  { match: /^claude-opus(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Opus', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 25 },
  { match: /^claude-sonnet(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Sonnet', inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
  { match: /^claude-haiku(?:$|[-_:])/i, provider: 'anthropic', label: 'Claude Haiku', inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 5 },

  // --- DeepSeek ---
  { match: /^deepseek-v4-pro(?:$|[-_:])/i, provider: 'deepseek', label: 'DeepSeek V4 Pro', inputPerMillion: 0.435, cachedInputPerMillion: 0.003625, outputPerMillion: 0.87 },
  { match: /^deepseek-v4-flash(?:$|[-_:])/i, provider: 'deepseek', label: 'DeepSeek V4 Flash', inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 },
  { match: /^deepseek-reasoner(?:$|[-_:])/i, provider: 'deepseek', label: 'DeepSeek Reasoner (V4 Flash)', inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 },
  { match: /^deepseek-chat(?:$|[-_:])/i, provider: 'deepseek', label: 'DeepSeek Chat (V4 Flash)', inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 },
  { match: /^deepseek-(?:coder|v3|v2)(?:$|[-_:])/i, provider: 'deepseek', label: 'DeepSeek', inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 },

  // --- Gemini (Standard paid tier, text) ---
  { match: /^gemini-3\.5-flash(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 3.5 Flash', inputPerMillion: 1.5, cachedInputPerMillion: 0.15, outputPerMillion: 9 },
  { match: /^gemini-3\.1-flash-lite(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 3.1 Flash-Lite', inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 1.5 },
  { match: /^gemini-3\.1-pro(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 3.1 Pro', inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 },
  { match: /^gemini-3-pro(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 3 Pro', inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 },
  { match: /^gemini-3-flash(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 3 Flash', inputPerMillion: 0.5, cachedInputPerMillion: 0.05, outputPerMillion: 3 },
  { match: /^gemini-2\.5-pro(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 2.5 Pro', inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  { match: /^gemini-2\.5-flash-lite(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 2.5 Flash-Lite', inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.4 },
  { match: /^gemini-2\.5-flash(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 2.5 Flash', inputPerMillion: 0.3, cachedInputPerMillion: 0.03, outputPerMillion: 2.5 },
  { match: /^gemini-2\.0-flash-lite(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 2.0 Flash-Lite', inputPerMillion: 0.075, cachedInputPerMillion: 0.0075, outputPerMillion: 0.3 },
  { match: /^gemini-2\.0-flash(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini 2.0 Flash', inputPerMillion: 0.15, cachedInputPerMillion: 0.015, outputPerMillion: 0.6 },
  { match: /^gemini-(?:$|[-_:])/i, provider: 'gemini', label: 'Gemini', inputPerMillion: 0.5, cachedInputPerMillion: 0.05, outputPerMillion: 3 },

  // --- MiMo (overseas USD / 1M tokens) ---
  { match: /^mimo-v2\.5-pro(?:$|[-_:])/i, provider: 'mimo', label: 'MiMo V2.5 Pro', inputPerMillion: 0.435, cachedInputPerMillion: 0.0036, outputPerMillion: 0.87 },
  { match: /^mimo-v2\.5(?:$|[-_:])/i, provider: 'mimo', label: 'MiMo V2.5', inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 },
  { match: /^mimo-v2-pro(?:$|[-_:])/i, provider: 'mimo', label: 'MiMo V2 Pro', inputPerMillion: 0.435, cachedInputPerMillion: 0.0036, outputPerMillion: 0.87 },
  { match: /^mimo-v2-flash(?:$|[-_:])/i, provider: 'mimo', label: 'MiMo V2 Flash', inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.3 },
  { match: /^mimo-(?:$|[-_:])/i, provider: 'mimo', label: 'MiMo', inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 },
];

function matchModelPrice(modelName) {
  const model = String(modelName || '').trim();
  const entry = MODEL_PRICES.find((item) => item.match.test(model));
  if (!entry) {
    return {
      modelLabel: model || 'unknown',
      inputPerMillion: 0,
      cachedInputPerMillion: 0,
      outputPerMillion: 0,
      priceSource: 'unmatched',
      priceSourceUrl: PRICE_SOURCES.openai.url,
      provider: '',
    };
  }
  const source = PRICE_SOURCES[entry.provider];
  return {
    modelLabel: entry.label,
    inputPerMillion: entry.inputPerMillion,
    cachedInputPerMillion: entry.cachedInputPerMillion,
    outputPerMillion: entry.outputPerMillion,
    priceSource: source.id,
    priceSourceUrl: source.url,
    provider: entry.provider,
  };
}

function getAllPriceSources() {
  return Object.values(PRICE_SOURCES);
}

module.exports = {
  PRICE_SOURCES,
  MODEL_PRICES,
  matchModelPrice,
  getAllPriceSources,
};

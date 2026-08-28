import OpenAI from 'openai';

let runtimeConfig = {
  apiKey: process.env.OPENAI_API_KEY || '',
  baseURL: process.env.OPENAI_BASE_URL || '',
  model: process.env.OPENAI_MODEL || 'gemini-3.7-flash',
  reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'none' // 'none', 'low', 'medium', 'high'
};

/**
 * Get current AI provider configuration.
 */
export function getAIConfig() {
  return {
    apiKey: runtimeConfig.apiKey || process.env.OPENAI_API_KEY || '',
    baseURL: runtimeConfig.baseURL || process.env.OPENAI_BASE_URL || '',
    model: runtimeConfig.model || process.env.OPENAI_MODEL || 'gemini-3.7-flash',
    reasoningEffort: runtimeConfig.reasoningEffort || 'none',
    hasApiKey: Boolean(runtimeConfig.apiKey || process.env.OPENAI_API_KEY)
  };
}

/**
 * Update AI provider runtime configuration.
 */
export function setAIConfig(newConfig = {}) {
  if (newConfig.apiKey !== undefined) {
    runtimeConfig.apiKey = newConfig.apiKey.trim();
  }
  if (newConfig.baseURL !== undefined) {
    runtimeConfig.baseURL = newConfig.baseURL.trim();
  }
  if (newConfig.model !== undefined && newConfig.model.trim()) {
    runtimeConfig.model = newConfig.model.trim();
  }
  if (newConfig.reasoningEffort !== undefined) {
    runtimeConfig.reasoningEffort = newConfig.reasoningEffort.trim().toLowerCase();
  }
  console.log(`[Config] AI Provider settings updated: BaseURL="${runtimeConfig.baseURL || 'default (OpenAI)'}", Model="${runtimeConfig.model}", ReasoningEffort="${runtimeConfig.reasoningEffort}"`);
  return getAIConfig();
}

/**
 * Create an OpenAI SDK instance with the effective config.
 */
export function getOpenAIClient(overrides = {}) {
  const current = getAIConfig();
  const rawKey = overrides.apiKey !== undefined ? overrides.apiKey : current.apiKey;
  const baseURL = overrides.baseURL !== undefined ? overrides.baseURL : current.baseURL;

  // Local/custom OpenAI-compatible endpoints (Ollama, LM Studio, LocalAI, vLLM, etc.) often don't require an API key.
  // The official OpenAI SDK client constructor requires a non-empty string for apiKey, so use a placeholder if empty.
  const apiKey = rawKey && rawKey.trim() !== '' ? rawKey.trim() : 'not-needed';

  const clientOptions = {
    apiKey
  };

  if (baseURL && baseURL.trim() !== '') {
    clientOptions.baseURL = baseURL.trim();
  }

  return new OpenAI(clientOptions);
}

/**
 * Fetch available models from the configured /models endpoint.
 */
export async function fetchAvailableModels(overrides = {}) {
  const client = getOpenAIClient(overrides);
  const response = await client.models.list();
  const models = [];

  for await (const model of response) {
    if (model && model.id) {
      models.push(model.id);
    }
  }

  // Sort alphabetically
  models.sort((a, b) => a.localeCompare(b));
  return models;
}

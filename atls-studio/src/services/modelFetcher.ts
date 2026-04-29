import { invoke } from '@tauri-apps/api/core';
import { deriveModelCapabilities, getKnownContextWindow } from '../utils/modelCapabilities';
import { clearOpenRouterModelPricing, registerOpenRouterModelPricing, type OpenRouterModelPricing } from '../stores/costStore';

export type AIProvider = 'anthropic' | 'openai' | 'google' | 'vertex' | 'lmstudio' | 'openrouter';

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  isReasoning?: boolean;
  isFast?: boolean;
  hasHighContext?: boolean;
  supportedParameters?: string[];
  openRouterPricing?: OpenRouterModelPricing;
}

interface TauriAIModel {
  id: string;
  name: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  supported_parameters?: string[];
  pricing_prompt_cents_per_million?: number | null;
  pricing_completion_cents_per_million?: number | null;
}

export async function fetchModels(provider: AIProvider, apiKey: string, _projectId?: string, _region?: string): Promise<ModelInfo[]> {
  switch (provider) {
    case 'anthropic':
      return fetchAnthropicModelsTauri(apiKey);
    case 'openai':
      return fetchOpenAIModelsTauri(apiKey);
    case 'lmstudio':
      return fetchLMStudioModelsTauri(apiKey);
    case 'openrouter':
      return fetchOpenRouterModelsTauri(apiKey);
    case 'google':
      return fetchGoogleModelsTauri(apiKey);
    case 'vertex':
      if (!_projectId) throw new Error('Project ID required for Vertex AI');
      return fetchVertexModelsTauri(apiKey, _projectId, _region);
    default:
      return [];
  }
}

function enrichWithCapabilities(
  m: TauriAIModel,
  provider: AIProvider
): ModelInfo {
  const ctx =
    (typeof m.context_window === 'number' && m.context_window > 0
      ? m.context_window
      : undefined) ?? getKnownContextWindow(m.id, provider);
  const caps = deriveModelCapabilities(m.id, provider, ctx);
  const openRouterPricing =
    provider === 'openrouter' &&
    typeof m.pricing_prompt_cents_per_million === 'number' &&
    typeof m.pricing_completion_cents_per_million === 'number'
      ? {
        input: m.pricing_prompt_cents_per_million,
        output: m.pricing_completion_cents_per_million,
      }
      : undefined;
  return {
    id: m.id,
    name: m.name,
    contextWindow: ctx,
    maxOutputTokens: m.max_output_tokens ?? undefined,
    isReasoning: caps.isReasoning,
    isFast: caps.isFast,
    hasHighContext: caps.hasHighContext,
    supportedParameters: m.supported_parameters,
    openRouterPricing,
  };
}

async function fetchAnthropicModelsTauri(apiKey: string): Promise<ModelInfo[]> {
  try {
    const models = await invoke<TauriAIModel[]>('fetch_anthropic_models', { apiKey });
    return models.map(m => enrichWithCapabilities(m, 'anthropic'));
  } catch (err) {
    console.error('Failed to fetch Anthropic models:', err);
    return [];
  }
}

async function fetchOpenAIModelsTauri(apiKey: string): Promise<ModelInfo[]> {
  try {
    const models = await invoke<TauriAIModel[]>('fetch_openai_models', { apiKey });
    return models.map(m => enrichWithCapabilities(m, 'openai'));
  } catch (err) {
    console.error('Failed to fetch OpenAI models:', err);
    return [];
  }
}

async function fetchLMStudioModelsTauri(baseUrl: string): Promise<ModelInfo[]> {
  try {
    const models = await invoke<TauriAIModel[]>('fetch_lmstudio_models', { baseUrl });
    return models.map(m => enrichWithCapabilities(m, 'lmstudio'));
  } catch (err) {
    console.error('Failed to fetch LMStudio models:', err);
    return [];
  }
}

async function fetchOpenRouterModelsTauri(apiKey: string): Promise<ModelInfo[]> {
  try {
    clearOpenRouterModelPricing();
    const models = await invoke<TauriAIModel[]>('fetch_openrouter_models', { apiKey });
    const enriched = models.map(m => enrichWithCapabilities(m, 'openrouter'));
    registerOpenRouterModelPricing(enriched);
    return enriched;
  } catch (err) {
    console.error('Failed to fetch OpenRouter models:', err);
    return [];
  }
}

async function fetchGoogleModelsTauri(apiKey: string): Promise<ModelInfo[]> {
  try {
    const models = await invoke<TauriAIModel[]>('fetch_google_models', { apiKey });
    return models.map(m => enrichWithCapabilities(m, 'google'));
  } catch (err) {
    console.error('Failed to fetch Google models:', err);
    return [];
  }
}

async function fetchVertexModelsTauri(accessToken: string, projectId: string, region?: string): Promise<ModelInfo[]> {
  try {
    const models = await invoke<TauriAIModel[]>('fetch_vertex_models', {
      accessToken,
      projectId,
      region,
    });
    return models.map(m => enrichWithCapabilities(m, 'vertex'));
  } catch (err) {
    console.error('Failed to fetch Vertex models:', err);
    return [];
  }
}

import type { AIProvider } from '../stores/costStore';

/**
 * Infer API provider from model id (same rules as aiService.getProviderFromModel).
 */
export function getProviderFromModelId(modelId: string): AIProvider {
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) return 'openai';
  if (modelId.startsWith('gemini-')) return 'google';
  if (modelId.startsWith('claude-')) return 'anthropic';
  return 'anthropic';
}

/**
 * Provider for API routing, tokenizer IPC, and $/token estimates.
 * Matches AiChat getAIConfig().provider (catalog model wins; Vertex override when unlisted Gemini).
 */
export function getPricingProviderForModel(
  modelId: string,
  selectedProvider: AIProvider,
  availableModels: Array<{ id: string; provider: AIProvider }> | undefined,
): AIProvider {
  const info = (availableModels ?? []).find((m) => m.id === modelId);
  if (info?.provider) return info.provider;
  const heuristic = getProviderFromModelId(modelId);
  if (heuristic === 'google' && selectedProvider === 'vertex') return 'vertex';
  return heuristic;
}

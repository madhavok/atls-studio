import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { fetchModels } from './modelFetcher';

describe('fetchModels', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('returns enriched models for anthropic on success', async () => {
    invoke.mockResolvedValueOnce([
      { id: 'claude-3-5-sonnet-20241022', name: 'Sonnet', context_window: 200000, max_output_tokens: 8192 },
    ]);
    const out = await fetchModels('anthropic', 'k');
    expect(invoke).toHaveBeenCalledWith('fetch_anthropic_models', { apiKey: 'k' });
    expect(out[0]?.id).toBe('claude-3-5-sonnet-20241022');
    expect(out[0]?.contextWindow).toBe(200000);
  });

  it('returns empty array when invoke throws', async () => {
    invoke.mockRejectedValueOnce(new Error('network'));
    const out = await fetchModels('openai', 'k');
    expect(out).toEqual([]);
  });

  it('throws for vertex without project id', async () => {
    await expect(fetchModels('vertex', 'tok')).rejects.toThrow('Project ID required');
  });

  it('fetches google and lmstudio models', async () => {
    invoke.mockResolvedValueOnce([{ id: 'gem-1', name: 'G', context_window: 1_000_000 }]);
    const g = await fetchModels('google', 'gk');
    expect(invoke).toHaveBeenCalledWith('fetch_google_models', { apiKey: 'gk' });
    expect(g[0]?.id).toBe('gem-1');

    invoke.mockResolvedValueOnce([{ id: 'local', name: 'L' }]);
    const ls = await fetchModels('lmstudio', 'http://127.0.0.1:1234');
    expect(invoke).toHaveBeenCalledWith('fetch_lmstudio_models', { baseUrl: 'http://127.0.0.1:1234' });
    expect(ls[0]?.id).toBe('local');
  });

  it('fetches vertex models when project id is set', async () => {
    invoke.mockResolvedValueOnce([{ id: 'v1', name: 'V', context_window: null, max_output_tokens: 8 }]);
    const v = await fetchModels('vertex', 'tok', 'my-proj', 'us-central1');
    expect(invoke).toHaveBeenCalledWith('fetch_vertex_models', {
      accessToken: 'tok',
      projectId: 'my-proj',
      region: 'us-central1',
    });
    expect(v[0]?.id).toBe('v1');
  });

  it('fetches openrouter models and carries pricing metadata', async () => {
    invoke.mockResolvedValueOnce([{
      id: 'openai/gpt-5.2',
      name: 'GPT-5.2',
      context_window: 400_000,
      max_output_tokens: 32_000,
      supported_parameters: ['tools', 'reasoning_effort'],
      pricing_prompt_cents_per_million: 125,
      pricing_completion_cents_per_million: 1000,
    }]);
    const models = await fetchModels('openrouter', 'sk-or-test');
    expect(invoke).toHaveBeenCalledWith('fetch_openrouter_models', { apiKey: 'sk-or-test' });
    expect(models[0]).toMatchObject({
      id: 'openai/gpt-5.2',
      contextWindow: 400_000,
      maxOutputTokens: 32_000,
      supportedParameters: ['tools', 'reasoning_effort'],
      openRouterPricing: { input: 125, output: 1000 },
    });
  });

  it('uses known context window when API returns 0 or null', async () => {
    invoke.mockResolvedValueOnce([
      { id: 'claude-3-5-sonnet-20241022', name: 'S', context_window: 0, max_output_tokens: 1 },
    ]);
    const out = await fetchModels('anthropic', 'k');
    expect(out[0]?.contextWindow).toBeGreaterThan(0);
  });

  it('returns empty for unknown provider (default branch)', async () => {
    const out = await fetchModels('not-a-provider' as import('./modelFetcher').AIProvider, 'k');
    expect(out).toEqual([]);
  });

  it('returns empty when anthropic, lmstudio, google, or vertex invoke throws', async () => {
    invoke.mockRejectedValueOnce(new Error('network'));
    expect(await fetchModels('anthropic', 'k')).toEqual([]);

    invoke.mockRejectedValueOnce(new Error('network'));
    expect(await fetchModels('lmstudio', 'http://127.0.0.1:1234')).toEqual([]);

    invoke.mockRejectedValueOnce(new Error('network'));
    expect(await fetchModels('google', 'k')).toEqual([]);

    invoke.mockRejectedValueOnce(new Error('network'));
    expect(await fetchModels('vertex', 'tok', 'p', 'r')).toEqual([]);

    invoke.mockRejectedValueOnce(new Error('network'));
    expect(await fetchModels('openrouter', 'k')).toEqual([]);
  });
});

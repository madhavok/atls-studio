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
});

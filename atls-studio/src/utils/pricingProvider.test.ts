import { describe, expect, it } from 'vitest';
import { getPricingProviderForModel, getProviderFromModelId } from './pricingProvider';

describe('getProviderFromModelId', () => {
  it('maps known prefixes', () => {
    expect(getProviderFromModelId('gpt-4o')).toBe('openai');
    expect(getProviderFromModelId('gemini-2.0-flash')).toBe('google');
    expect(getProviderFromModelId('claude-3-5-sonnet-20241022')).toBe('anthropic');
    expect(getProviderFromModelId('unknown-model')).toBe('anthropic');
  });
});

describe('getPricingProviderForModel', () => {
  it('uses catalog provider when model is listed', () => {
    expect(
      getPricingProviderForModel('claude-3-5-sonnet-20241022', 'openai', [
        { id: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
      ]),
    ).toBe('anthropic');
  });

  it('keeps OpenRouter catalog slugs routed through OpenRouter', () => {
    expect(
      getPricingProviderForModel('openai/gpt-5.2', 'openai', [
        { id: 'openai/gpt-5.2', provider: 'openrouter' },
      ]),
    ).toBe('openrouter');
  });

  it('falls back to selected OpenRouter for unlisted vendor slugs', () => {
    expect(
      getPricingProviderForModel('anthropic/claude-sonnet-4', 'openrouter', []),
    ).toBe('openrouter');
  });

  it('maps unlisted gemini to vertex when Vertex is selected', () => {
    expect(
      getPricingProviderForModel('gemini-2.0-flash-custom', 'vertex', []),
    ).toBe('vertex');
  });

  it('maps unlisted gemini to google when Google AI is selected', () => {
    expect(
      getPricingProviderForModel('gemini-2.0-flash-custom', 'google', []),
    ).toBe('google');
  });

  it('treats undefined catalog like empty (heuristic provider)', () => {
    expect(getPricingProviderForModel('claude-3-5-sonnet-20241022', 'anthropic', undefined)).toBe('anthropic');
  });
});

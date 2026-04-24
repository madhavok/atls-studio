import { describe, expect, it } from 'vitest';
import {
  EXTENDED_CONTEXT_VALUE,
  deriveModelCapabilities,
  getEffectiveContextWindow,
  getExtendedContextResolutionFromSettings,
  getKnownContextWindow,
  isExtendedContextEnabled,
  modelPassesFilters,
  modelSupportsExtendedContext,
  modelSupportsTools,
  showExtendedContextToggleForModel,
} from './modelCapabilities';

describe('modelCapabilities', () => {
  it('GPT-5.4 and GPT-5.5 known windows are 1M', () => {
    expect(getKnownContextWindow('gpt-5.4', 'openai')).toBe(EXTENDED_CONTEXT_VALUE);
    expect(getKnownContextWindow('gpt-5.4-mini', 'openai')).toBe(EXTENDED_CONTEXT_VALUE);
    expect(getKnownContextWindow('gpt-5.5', 'openai')).toBe(EXTENDED_CONTEXT_VALUE);
    expect(getKnownContextWindow('gpt-5.5-pro', 'openai')).toBe(EXTENDED_CONTEXT_VALUE);
  });

  it('legacy provider extended bumps Anthropic when per-model unset', () => {
    const r = getExtendedContextResolutionFromSettings({
      extendedContextByModelId: {},
      extendedContext: { anthropic: true },
    });
    expect(
      getEffectiveContextWindow('claude-sonnet-4-5', 'anthropic', 200_000, r)
    ).toBe(EXTENDED_CONTEXT_VALUE);
  });

  it('per-model id overrides legacy provider', () => {
    const r = getExtendedContextResolutionFromSettings({
      extendedContextByModelId: { 'claude-sonnet-4-5': false },
      extendedContext: { anthropic: true },
    });
    expect(
      getEffectiveContextWindow('claude-sonnet-4-5', 'anthropic', 200_000, r)
    ).toBe(200_000);
  });

  it('isExtendedContextEnabled prefers explicit per-model', () => {
    expect(
      isExtendedContextEnabled('m1', 'anthropic', { m1: true }, { anthropic: false })
    ).toBe(true);
    expect(
      isExtendedContextEnabled('m2', 'anthropic', {}, { anthropic: true })
    ).toBe(true);
  });

  it('OpenAI extended only for native 1M GPT-5 classes; toggle hidden when base is 1M', () => {
    expect(modelSupportsExtendedContext('gpt-5.4', 'openai')).toBe(true);
    expect(modelSupportsExtendedContext('gpt-5.5', 'openai')).toBe(true);
    expect(modelSupportsExtendedContext('gpt-4o', 'openai')).toBe(false);
    expect(showExtendedContextToggleForModel('gpt-5.4', 'openai', undefined)).toBe(false);
    expect(showExtendedContextToggleForModel('gpt-5.5', 'openai', undefined)).toBe(false);
    expect(showExtendedContextToggleForModel('claude-sonnet-4-5', 'anthropic', 200_000)).toBe(true);
  });
});

describe('getKnownContextWindow branches', () => {
  it('maps Anthropic id patterns to 200K / 100K / default', () => {
    expect(getKnownContextWindow('claude-opus-4-6', 'anthropic')).toBe(200_000);
    expect(getKnownContextWindow('claude-sonnet-4-5', 'anthropic')).toBe(200_000);
    expect(getKnownContextWindow('claude-sonnet-4-1', 'anthropic')).toBe(200_000);
    expect(getKnownContextWindow('claude-haiku-4-5', 'anthropic')).toBe(200_000);
    expect(getKnownContextWindow('claude-3-5-sonnet', 'anthropic')).toBe(200_000);
    expect(getKnownContextWindow('claude-3-opus', 'anthropic')).toBe(100_000);
    expect(getKnownContextWindow('claude-weird', 'anthropic')).toBe(200_000);
  });

  it('maps OpenAI id patterns', () => {
    expect(getKnownContextWindow('o3-mini', 'openai')).toBe(200_000);
    expect(getKnownContextWindow('gpt-4o-mini', 'openai')).toBe(128_000);
    expect(getKnownContextWindow('gpt-4-turbo-preview', 'openai')).toBe(128_000);
    expect(getKnownContextWindow('gpt-4-0125', 'openai')).toBe(128_000);
    expect(getKnownContextWindow('gpt-3.5-turbo', 'openai')).toBeUndefined();
  });

  it('returns undefined for non-covered providers', () => {
    expect(getKnownContextWindow('gemini-2.5-pro', 'google')).toBeUndefined();
    expect(getKnownContextWindow('local', 'lmstudio')).toBeUndefined();
  });
});

describe('modelSupportsExtendedContext', () => {
  it('covers Gemini extended bump', () => {
    expect(modelSupportsExtendedContext('gemini-2.5-pro', 'google')).toBe(true);
    expect(modelSupportsExtendedContext('gemini-3-pro', 'vertex')).toBe(true);
  });

  it('returns false for lmstudio / unknown provider fall-through', () => {
    expect(modelSupportsExtendedContext('any', 'lmstudio')).toBe(false);
  });
});

describe('getEffectiveContextWindow resolution shapes', () => {
  it('accepts legacy ExtendedContextFlags object', () => {
    expect(
      getEffectiveContextWindow('claude-sonnet-4-5', 'anthropic', 200_000, { anthropic: false }),
    ).toBe(200_000);
  });

  it('returns base when extended flag is on but model does not support bump', () => {
    const r = getExtendedContextResolutionFromSettings({
      extendedContextByModelId: {},
      extendedContext: { openai: true },
    });
    expect(getEffectiveContextWindow('gpt-4o', 'openai', 128_000, r)).toBe(128_000);
  });

  it('returns base when already at 1M', () => {
    expect(
      getEffectiveContextWindow('gpt-5.4', 'openai', EXTENDED_CONTEXT_VALUE, {
        openai: true,
      }),
    ).toBe(EXTENDED_CONTEXT_VALUE);
    expect(
      getEffectiveContextWindow('gpt-5.5', 'openai', EXTENDED_CONTEXT_VALUE, {
        openai: true,
      }),
    ).toBe(EXTENDED_CONTEXT_VALUE);
  });

  it('uses getKnownContextWindow when base is undefined', () => {
    expect(
      getEffectiveContextWindow('claude-sonnet-4-5', 'anthropic', undefined, { anthropic: false }),
    ).toBe(200_000);
  });
});

describe('deriveModelCapabilities', () => {
  it('tags OpenAI reasoning and fast models', () => {
    expect(deriveModelCapabilities('o3-mini', 'openai')).toMatchObject({
      isReasoning: true,
      isFast: true,
    });
    expect(deriveModelCapabilities('gpt-5-preview', 'openai')).toMatchObject({
      isReasoning: true,
      isFast: false,
    });
  });

  it('tags Anthropic reasoning / Haiku fast', () => {
    expect(deriveModelCapabilities('claude-sonnet-4-5', 'anthropic')).toMatchObject({
      isReasoning: true,
      isFast: false,
    });
    expect(deriveModelCapabilities('claude-3-haiku', 'anthropic')).toMatchObject({
      isReasoning: false,
      isFast: true,
    });
    expect(deriveModelCapabilities('claude-haiku-4-5', 'anthropic')).toMatchObject({
      isReasoning: true,
      isFast: true,
    });
  });

  it('tags Gemini reasoning / flash', () => {
    expect(deriveModelCapabilities('gemini-2.5-pro', 'google')).toMatchObject({
      isReasoning: true,
      isFast: false,
    });
    expect(deriveModelCapabilities('gemini-2.5-flash', 'google')).toMatchObject({
      isReasoning: true,
      isFast: true,
    });
  });

  it('sets hasHighContext from resolved window', () => {
    expect(deriveModelCapabilities('custom', 'lmstudio', 200_000).hasHighContext).toBe(true);
    expect(deriveModelCapabilities('custom', 'lmstudio', 64_000).hasHighContext).toBe(false);
  });
});

describe('modelSupportsTools', () => {
  it('denies legacy Claude Instant without haiku', () => {
    expect(modelSupportsTools('claude-instant-1.2', 'anthropic')).toBe(false);
    expect(modelSupportsTools('claude-instant-haiku', 'anthropic')).toBe(true);
  });

  it('denies audio-only OpenAI chat models', () => {
    expect(modelSupportsTools('gpt-4o-audio-preview', 'openai')).toBe(false);
    expect(modelSupportsTools('gpt-4o-mini-audio', 'openai')).toBe(false);
  });

  it('denies Gemini 1.0', () => {
    expect(modelSupportsTools('gemini-1.0-pro', 'google')).toBe(false);
    expect(modelSupportsTools('x-gemini-1.0-ultra', 'google')).toBe(false);
  });

  it('assumes tools for lmstudio', () => {
    expect(modelSupportsTools('any', 'lmstudio')).toBe(true);
  });
});

describe('modelPassesFilters', () => {
  const filters = {
    showReasoning: true,
    showFast: false,
    showHighContext: false,
    showToolCapableOnly: true,
  };

  it('includes uncategorized models', () => {
    expect(modelPassesFilters({}, filters)).toBe(true);
  });

  it('excludes non-tool models when required', () => {
    expect(
      modelPassesFilters(
        { id: 'claude-instant-1.2', provider: 'anthropic', isReasoning: true },
        filters,
      ),
    ).toBe(false);
  });

  it('matches capability OR with enabled filter slots', () => {
    expect(
      modelPassesFilters(
        { isReasoning: true, isFast: false, hasHighContext: false },
        filters,
      ),
    ).toBe(true);
    expect(
      modelPassesFilters(
        { isReasoning: false, isFast: true, hasHighContext: false },
        { ...filters, showReasoning: false, showFast: true },
      ),
    ).toBe(true);
  });
});

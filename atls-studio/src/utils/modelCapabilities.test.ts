import { describe, expect, it } from 'vitest';
import {
  EXTENDED_CONTEXT_VALUE,
  getEffectiveContextWindow,
  getExtendedContextResolutionFromSettings,
  getKnownContextWindow,
  isExtendedContextEnabled,
  modelSupportsExtendedContext,
  showExtendedContextToggleForModel,
} from './modelCapabilities';

describe('modelCapabilities', () => {
  it('GPT-5.4 known window is 1M', () => {
    expect(getKnownContextWindow('gpt-5.4', 'openai')).toBe(EXTENDED_CONTEXT_VALUE);
    expect(getKnownContextWindow('gpt-5.4-mini', 'openai')).toBe(EXTENDED_CONTEXT_VALUE);
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

  it('OpenAI extended only for gpt-5.4-class; toggle hidden when base is 1M', () => {
    expect(modelSupportsExtendedContext('gpt-5.4', 'openai')).toBe(true);
    expect(modelSupportsExtendedContext('gpt-4o', 'openai')).toBe(false);
    expect(showExtendedContextToggleForModel('gpt-5.4', 'openai', undefined)).toBe(false);
    expect(showExtendedContextToggleForModel('claude-sonnet-4-5', 'anthropic', 200_000)).toBe(true);
  });
});

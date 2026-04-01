import { describe, it, expect } from 'vitest';
import {
  supportsVerbosity,
  supportsThinking,
  thinkingToAnthropicBudget,
  thinkingToGeminiBudget,
  thinkingToOpenAIEffort,
  speedToOpenAIVerbosity,
  resolveModelSettings,
  type OutputSpeedLevel,
  type ThinkingLevel,
} from './modelSettings';

// ---------------------------------------------------------------------------
// supportsVerbosity
// ---------------------------------------------------------------------------
describe('supportsVerbosity', () => {
  it('returns true for GPT-5 models', () => {
    expect(supportsVerbosity('gpt-5')).toBe(true);
    expect(supportsVerbosity('gpt-5.2-chat-latest')).toBe(true);
    expect(supportsVerbosity('gpt-5.4-pro')).toBe(true);
  });

  it('returns false for non-GPT-5 models', () => {
    expect(supportsVerbosity('gpt-4o')).toBe(false);
    expect(supportsVerbosity('claude-sonnet-4-5')).toBe(false);
    expect(supportsVerbosity('o3-mini')).toBe(false);
    expect(supportsVerbosity('gemini-2.5-pro')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// supportsThinking
// ---------------------------------------------------------------------------
describe('supportsThinking', () => {
  it('returns true for Anthropic Claude 4.x / 3.7', () => {
    expect(supportsThinking('claude-sonnet-4-5', 'anthropic')).toBe(true);
    expect(supportsThinking('claude-opus-4-6', 'anthropic')).toBe(true);
    expect(supportsThinking('claude-haiku-4-5', 'anthropic')).toBe(true);
    expect(supportsThinking('claude-3-7-sonnet', 'anthropic')).toBe(true);
    expect(supportsThinking('claude-sonnet-4-1', 'anthropic')).toBe(true);
  });

  it('returns false for older Anthropic models', () => {
    expect(supportsThinking('claude-3-opus', 'anthropic')).toBe(false);
    expect(supportsThinking('claude-3-5-sonnet', 'anthropic')).toBe(false);
  });

  it('returns true for OpenAI reasoning models', () => {
    expect(supportsThinking('o1-mini', 'openai')).toBe(true);
    expect(supportsThinking('o3-mini', 'openai')).toBe(true);
    expect(supportsThinking('o4-mini', 'openai')).toBe(true);
    expect(supportsThinking('gpt-5', 'openai')).toBe(true);
  });

  it('returns false for OpenAI non-reasoning models', () => {
    expect(supportsThinking('gpt-4o', 'openai')).toBe(false);
    expect(supportsThinking('gpt-4o-mini', 'openai')).toBe(false);
  });

  it('returns true for Gemini 2.5 / 3 models', () => {
    expect(supportsThinking('gemini-2.5-pro', 'google')).toBe(true);
    expect(supportsThinking('gemini-2.5-flash', 'google')).toBe(true);
    expect(supportsThinking('gemini-3-pro', 'vertex')).toBe(true);
  });

  it('returns false for older Gemini models', () => {
    expect(supportsThinking('gemini-2.0-flash', 'google')).toBe(false);
    expect(supportsThinking('gemini-1.5-pro', 'google')).toBe(false);
  });

  it('returns false for lmstudio', () => {
    expect(supportsThinking('any-model', 'lmstudio')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Individual converters
// ---------------------------------------------------------------------------
describe('thinkingToAnthropicBudget', () => {
  it('maps levels correctly', () => {
    expect(thinkingToAnthropicBudget('off')).toBeNull();
    expect(thinkingToAnthropicBudget('low')).toBe(1024);
    expect(thinkingToAnthropicBudget('medium')).toBe(10_000);
    expect(thinkingToAnthropicBudget('high')).toBe(32_000);
  });
});

describe('thinkingToGeminiBudget', () => {
  it('maps levels correctly', () => {
    expect(thinkingToGeminiBudget('off')).toBeNull();
    expect(thinkingToGeminiBudget('low')).toBe(1024);
    expect(thinkingToGeminiBudget('medium')).toBe(8192);
    expect(thinkingToGeminiBudget('high')).toBe(24_576);
  });
});

describe('thinkingToOpenAIEffort', () => {
  it('maps levels correctly', () => {
    expect(thinkingToOpenAIEffort('off')).toBe('none');
    expect(thinkingToOpenAIEffort('low')).toBe('low');
    expect(thinkingToOpenAIEffort('medium')).toBe('medium');
    expect(thinkingToOpenAIEffort('high')).toBe('high');
  });
});

describe('speedToOpenAIVerbosity', () => {
  it('passes through level as-is', () => {
    expect(speedToOpenAIVerbosity('low')).toBe('low');
    expect(speedToOpenAIVerbosity('medium')).toBe('medium');
    expect(speedToOpenAIVerbosity('high')).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// resolveModelSettings
// ---------------------------------------------------------------------------
describe('resolveModelSettings', () => {
  it('returns empty for unsupported model', () => {
    const r = resolveModelSettings('medium', 'medium', 'gpt-4o', 'openai');
    expect(r.outputVerbosity).toBeUndefined();
    expect(r.reasoningEffort).toBeUndefined();
    expect(r.thinkingBudget).toBeUndefined();
  });

  it('sets verbosity for GPT-5', () => {
    const r = resolveModelSettings('high', 'medium', 'gpt-5.2', 'openai');
    expect(r.outputVerbosity).toBe('high');
    expect(r.reasoningEffort).toBe('medium');
  });

  it('sets reasoningEffort for o-series', () => {
    const r = resolveModelSettings('low', 'high', 'o3-mini', 'openai');
    expect(r.outputVerbosity).toBeUndefined();
    expect(r.reasoningEffort).toBe('high');
  });

  it('sets thinkingBudget for Anthropic', () => {
    const r = resolveModelSettings('medium', 'medium', 'claude-sonnet-4-5', 'anthropic', 16384);
    expect(r.thinkingBudget).toBe(10_000);
    expect(r.reasoningEffort).toBeUndefined();
  });

  it('omits thinkingBudget when thinking is off for Anthropic', () => {
    const r = resolveModelSettings('medium', 'off', 'claude-sonnet-4-5', 'anthropic', 16384);
    expect(r.thinkingBudget).toBeNull();
  });

  it('clamps Anthropic budget below maxTokens', () => {
    const r = resolveModelSettings('medium', 'high', 'claude-sonnet-4-5', 'anthropic', 2048);
    expect(r.thinkingBudget).toBe(2047);
  });

  it('nulls Anthropic budget when clamped below 1024', () => {
    const r = resolveModelSettings('medium', 'low', 'claude-sonnet-4-5', 'anthropic', 1024);
    expect(r.thinkingBudget).toBeNull();
  });

  it('sets thinkingBudget for Google', () => {
    const r = resolveModelSettings('medium', 'high', 'gemini-2.5-pro', 'google');
    expect(r.thinkingBudget).toBe(24_576);
  });

  it('omits thinkingBudget when thinking is off for Google', () => {
    const r = resolveModelSettings('medium', 'off', 'gemini-2.5-pro', 'google');
    expect(r.thinkingBudget).toBeNull();
  });

  it('works for Vertex with same logic as Google', () => {
    const r = resolveModelSettings('medium', 'low', 'gemini-3-pro', 'vertex');
    expect(r.thinkingBudget).toBe(1024);
  });

  it('omits everything for non-thinking Google model', () => {
    const r = resolveModelSettings('medium', 'high', 'gemini-2.0-flash', 'google');
    expect(r.outputVerbosity).toBeUndefined();
    expect(r.reasoningEffort).toBeUndefined();
    expect(r.thinkingBudget).toBeUndefined();
  });

  it('omits everything for lmstudio', () => {
    const r = resolveModelSettings('high', 'high', 'some-local-model', 'lmstudio');
    expect(r.outputVerbosity).toBeUndefined();
    expect(r.reasoningEffort).toBeUndefined();
    expect(r.thinkingBudget).toBeUndefined();
  });
});

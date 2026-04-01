/**
 * Model Speed & Thinking preset mapping.
 *
 * Single source of truth for converting UI presets (Speed / Thinking) into
 * provider-specific API fields. Called by getAIConfig before invoke so
 * Rust stays a dumb passthrough.
 */

import type { AIProvider } from './modelCapabilities';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type OutputSpeedLevel = 'low' | 'medium' | 'high';
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export interface ResolvedModelSettings {
  outputVerbosity?: 'low' | 'medium' | 'high';
  reasoningEffort?: string;
  thinkingBudget?: number | null;
}

// ---------------------------------------------------------------------------
// Model capability checks
// ---------------------------------------------------------------------------

/** Models that support OpenAI `verbosity` parameter (GPT-5 family on Responses API). */
export function supportsVerbosity(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.startsWith('gpt-5');
}

/** Models that support reasoning/thinking configuration. */
export function supportsThinking(modelId: string, provider: AIProvider): boolean {
  const id = modelId.toLowerCase();
  switch (provider) {
    case 'anthropic':
      return (
        id.includes('4-6') || id.includes('4.6') ||
        id.includes('4-5') || id.includes('4.5') ||
        id.includes('4-1') || id.includes('4.1') ||
        id.includes('opus-4') || id.includes('sonnet-4') || id.includes('haiku-4') ||
        id.includes('3-7') || id.includes('3.7')
      );
    case 'openai':
      return (
        id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4') ||
        id.startsWith('gpt-5')
      );
    case 'google':
    case 'vertex':
      return (
        id.includes('gemini-2.5') || id.includes('gemini-3')
      );
    case 'lmstudio':
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Preset → provider value converters
// ---------------------------------------------------------------------------

const ANTHROPIC_BUDGET: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 1024,
  medium: 10_000,
  high: 32_000,
};

export function thinkingToAnthropicBudget(level: ThinkingLevel): number | null {
  return ANTHROPIC_BUDGET[level];
}

const GEMINI_BUDGET: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 1024,
  medium: 8192,
  high: 24_576,
};

export function thinkingToGeminiBudget(level: ThinkingLevel): number | null {
  return GEMINI_BUDGET[level];
}

const OPENAI_EFFORT: Record<ThinkingLevel, string | null> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

export function thinkingToOpenAIEffort(level: ThinkingLevel): string | null {
  return OPENAI_EFFORT[level];
}

export function speedToOpenAIVerbosity(level: OutputSpeedLevel): string {
  return level;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Convert UI presets → provider-specific AIConfig fields.
 * Returns only the fields that should be passed to Tauri; omits when
 * the model doesn't support a given capability.
 */
export function resolveModelSettings(
  speed: OutputSpeedLevel,
  thinking: ThinkingLevel,
  modelId: string,
  provider: AIProvider,
  maxTokens?: number,
): ResolvedModelSettings {
  const result: ResolvedModelSettings = {};

  if (supportsVerbosity(modelId)) {
    result.outputVerbosity = speedToOpenAIVerbosity(speed) as OutputSpeedLevel;
  }

  if (!supportsThinking(modelId, provider)) return result;

  switch (provider) {
    case 'anthropic': {
      let budget = thinkingToAnthropicBudget(thinking);
      if (budget != null) {
        if (budget < 1024) budget = 1024;
        if (maxTokens != null && budget >= maxTokens) budget = maxTokens - 1;
        if (budget < 1024) budget = null;
      }
      result.thinkingBudget = budget;
      break;
    }
    case 'openai': {
      result.reasoningEffort = thinkingToOpenAIEffort(thinking) ?? undefined;
      break;
    }
    case 'google':
    case 'vertex': {
      result.thinkingBudget = thinkingToGeminiBudget(thinking);
      break;
    }
    default:
      break;
  }

  return result;
}

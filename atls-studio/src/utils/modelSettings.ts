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
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

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

/**
 * Anthropic models that require (or prefer) `thinking.type: "adaptive"` together
 * with `output_config.effort` instead of the legacy
 * `thinking.type: "enabled" + budget_tokens` shape.
 *
 * - Opus 4.7: adaptive is the ONLY supported thinking mode; `enabled` is rejected with 400.
 * - Opus 4.6 / Sonnet 4.6: adaptive is the recommended mode; `enabled` is deprecated.
 * - Mythos Preview: adaptive is the default.
 *
 * Older models (Opus 4.5, Sonnet 4.5, Haiku 4.5, 3.7, ...) stay on the legacy path.
 */
export function supportsAdaptiveThinking(modelId: string, provider: AIProvider): boolean {
  if (provider !== 'anthropic') return false;
  const id = modelId.toLowerCase();
  return (
    id.includes('opus-4-7') || id.includes('opus-4.7') ||
    id.includes('opus-4-6') || id.includes('opus-4.6') ||
    id.includes('sonnet-4-6') || id.includes('sonnet-4.6') ||
    id.includes('mythos')
  );
}

/** Models that support reasoning/thinking configuration. */
export function supportsThinking(modelId: string, provider: AIProvider): boolean {
  const id = modelId.toLowerCase();
  switch (provider) {
    case 'anthropic':
      return (
        id.includes('4-7') || id.includes('4.7') ||
        id.includes('4-6') || id.includes('4.6') ||
        id.includes('4-5') || id.includes('4.5') ||
        id.includes('4-1') || id.includes('4.1') ||
        id.includes('opus-4') || id.includes('sonnet-4') || id.includes('haiku-4') ||
        id.includes('3-7') || id.includes('3.7') ||
        id.includes('mythos')
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

export function supportsExtraHighThinking(modelId: string, provider: AIProvider): boolean {
  return supportsAdaptiveThinking(modelId, provider);
}

export function getSupportedThinkingLevels(modelId: string, provider: AIProvider): ThinkingLevel[] {
  if (!supportsThinking(modelId, provider)) return ['off'];
  const levels: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];
  if (supportsExtraHighThinking(modelId, provider)) levels.push('xhigh');
  return levels;
}

export function clampThinkingLevel(level: ThinkingLevel, modelId: string, provider: AIProvider): ThinkingLevel {
  const supported = getSupportedThinkingLevels(modelId, provider);
  if (supported.includes(level)) return level;
  return supported[supported.length - 1] ?? 'off';
}

// ---------------------------------------------------------------------------
// Preset → provider value converters
// ---------------------------------------------------------------------------

const ANTHROPIC_BUDGET: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 1024,
  medium: 10_000,
  high: 32_000,
  xhigh: 64_000,
};

export function thinkingToAnthropicBudget(level: ThinkingLevel): number | null {
  return ANTHROPIC_BUDGET[level];
}

const GEMINI_BUDGET: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 1024,
  medium: 8192,
  high: 24_576,
  xhigh: 32_768,
};

export function thinkingToGeminiBudget(level: ThinkingLevel): number | null {
  return GEMINI_BUDGET[level];
}

const OPENAI_EFFORT: Record<ThinkingLevel, string | null> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  // OpenAI currently tops out at "high"; xhigh selects the highest valid effort.
  xhigh: 'high',
};

export function thinkingToOpenAIEffort(level: ThinkingLevel): string | null {
  return OPENAI_EFFORT[level];
}

/**
 * Map UI thinking preset → Anthropic `output_config.effort` value for
 * adaptive-thinking models (Opus 4.7, Opus 4.6, Sonnet 4.6, Mythos).
 *
 * `off` returns null: callers should omit `thinking` and `output_config` so
 * the model falls back to its default non-thinking behavior. (On Opus 4.7,
 * thinking is off unless `thinking.type: "adaptive"` is set explicitly.)
 */
const ANTHROPIC_EFFORT: Record<ThinkingLevel, string | null> = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

export function thinkingToAnthropicEffort(level: ThinkingLevel): string | null {
  return ANTHROPIC_EFFORT[level];
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
  const supportedThinking = clampThinkingLevel(thinking, modelId, provider);

  if (supportsVerbosity(modelId)) {
    result.outputVerbosity = speedToOpenAIVerbosity(speed) as OutputSpeedLevel;
  }

  if (!supportsThinking(modelId, provider)) return result;

  switch (provider) {
    case 'anthropic': {
      if (supportsAdaptiveThinking(modelId, provider)) {
        // Adaptive-thinking models: use output_config.effort + thinking.type=adaptive.
        // budget_tokens is rejected (Opus 4.7) or deprecated (Opus 4.6, Sonnet 4.6).
        const effort = thinkingToAnthropicEffort(supportedThinking);
        if (effort != null) result.reasoningEffort = effort;
        // Signal explicitly that no budget is in play so Rust doesn't try to
        // attach the legacy thinking block.
        result.thinkingBudget = null;
        break;
      }
      let budget = thinkingToAnthropicBudget(supportedThinking);
      if (budget != null) {
        if (budget < 1024) budget = 1024;
        if (maxTokens != null && budget >= maxTokens) budget = maxTokens - 1;
        if (budget < 1024) budget = null;
      }
      result.thinkingBudget = budget;
      break;
    }
    case 'openai': {
      result.reasoningEffort = thinkingToOpenAIEffort(supportedThinking) ?? undefined;
      break;
    }
    case 'google':
    case 'vertex': {
      result.thinkingBudget = thinkingToGeminiBudget(supportedThinking);
      break;
    }
    default:
      break;
  }

  return result;
}

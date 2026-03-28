/**
 * Capability derivation for AI models.
 * APIs do not expose reasoning/fast/high-context; we derive from model id + context window.
 * Anthropic and OpenAI model lists do not include context_window; we use known values as fallback.
 */

export type AIProvider = 'anthropic' | 'openai' | 'google' | 'vertex' | 'lmstudio';

/** Max extended context we surface in UI and budgets (1M). */
export const EXTENDED_CONTEXT_VALUE = 1_000_000;

/**
 * Known context windows for models when API does not provide them.
 * Anthropic /v1/models and OpenAI /v1/models do not return context_window.
 */
export function getKnownContextWindow(modelId: string, provider: AIProvider): number | undefined {
  const id = modelId.toLowerCase();
  if (provider === 'anthropic') {
    // Claude 4.6, 4.5: 200K; Claude 4.1, 4: 200K; Claude 3.5: 200K; Claude 3: 100K
    if (id.includes('4-6') || id.includes('4.6')) return 200_000;
    if (id.includes('4-5') || id.includes('4.5')) return 200_000;
    if (id.includes('4-1') || id.includes('4.1')) return 200_000;
    if (id.includes('opus-4') || id.includes('sonnet-4') || id.includes('haiku-4')) return 200_000;
    if (id.includes('3-5') || id.includes('3.5')) return 200_000;
    if (id.includes('3-opus') || id.includes('3-sonnet') || id.includes('3-haiku')) return 100_000;
    return 200_000; // default for unknown Claude
  }
  if (provider === 'openai') {
    // GPT-5.4: native 1M context (API)
    if (id.includes('gpt-5.4')) return EXTENDED_CONTEXT_VALUE;
    // o1/o3/o4: 200K; gpt-4o/mini: 128K+; gpt-4-turbo: 128K
    if (id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 200_000;
    if (id.includes('gpt-4o') || id.includes('gpt-4-turbo')) return 128_000;
    if (id.includes('gpt-4')) return 128_000;
    return undefined;
  }
  return undefined;
}

/**
 * Whether a model supports optional extended context (e.g. 200K → 1M via provider beta).
 * OpenAI: only GPT-5.4-class models use native 1M — no separate “extended” bump; toggle hidden when base is already 1M.
 */
export function modelSupportsExtendedContext(modelId: string, provider: AIProvider): boolean {
  const id = modelId.toLowerCase();
  if (provider === 'anthropic') {
    return id.includes('4-6') || id.includes('4.5') || id.includes('opus-4') || id.includes('sonnet-4');
  }
  if (provider === 'openai') {
    return id.includes('gpt-5.4');
  }
  if (provider === 'google' || provider === 'vertex') {
    return id.includes('gemini-2') || id.includes('gemini-3');
  }
  return false;
}

export type ExtendedContextFlags = Partial<Record<AIProvider, boolean>>;

/** Per-model extended 1M toggle; legacy provider-wide flags for migration. */
export interface ExtendedContextResolution {
  byModelId: Record<string, boolean>;
  legacyByProvider?: Partial<Record<AIProvider, boolean>>;
}

/** Build resolution payload from persisted settings (single import site for call sites). */
export function getExtendedContextResolutionFromSettings(s: {
  extendedContextByModelId?: Record<string, boolean>;
  extendedContext?: Partial<Record<AIProvider, boolean>>;
}): ExtendedContextResolution {
  return {
    byModelId: s.extendedContextByModelId ?? {},
    legacyByProvider: s.extendedContext,
  };
}

/**
 * Whether extended 1M is enabled: per-model wins, then legacy per-provider.
 */
export function isExtendedContextEnabled(
  modelId: string,
  provider: AIProvider,
  byModelId: Record<string, boolean>,
  legacyByProvider?: Partial<Record<AIProvider, boolean>>
): boolean {
  if (Object.prototype.hasOwnProperty.call(byModelId, modelId)) {
    return Boolean(byModelId[modelId]);
  }
  return Boolean(legacyByProvider?.[provider]);
}

/**
 * Effective context window: base value, or 1M when extended is enabled and model supports a bump (base &lt; 1M).
 */
export function getEffectiveContextWindow(
  modelId: string,
  provider: AIProvider,
  baseContextWindow: number | undefined,
  extended: ExtendedContextResolution | ExtendedContextFlags
): number | undefined {
  let byModelId: Record<string, boolean> = {};
  let legacyByProvider: Partial<Record<AIProvider, boolean>> | undefined;
  if (extended && typeof extended === 'object' && 'byModelId' in extended) {
    byModelId = extended.byModelId ?? {};
    legacyByProvider = extended.legacyByProvider;
  } else {
    legacyByProvider = extended as ExtendedContextFlags;
  }

  const base = baseContextWindow ?? getKnownContextWindow(modelId, provider);
  if (!base || base >= EXTENDED_CONTEXT_VALUE) return base;

  const enabled = isExtendedContextEnabled(modelId, provider, byModelId, legacyByProvider);
  if (enabled && modelSupportsExtendedContext(modelId, provider)) {
    return EXTENDED_CONTEXT_VALUE;
  }
  return base;
}

/** Show the 1M toggle only when the model can bump from a smaller base window to 1M. */
export function showExtendedContextToggleForModel(
  modelId: string,
  provider: AIProvider,
  baseContextWindow: number | undefined
): boolean {
  if (!modelSupportsExtendedContext(modelId, provider)) return false;
  const base = baseContextWindow ?? getKnownContextWindow(modelId, provider);
  return typeof base === 'number' && base > 0 && base < EXTENDED_CONTEXT_VALUE;
}

export interface ModelCapabilities {
  isReasoning: boolean;
  isFast: boolean;
  hasHighContext: boolean;
}

const HIGH_CONTEXT_THRESHOLD = 128_000;

/**
 * Derive capability flags from model id, provider, and optional context window.
 */
export function deriveModelCapabilities(
  modelId: string,
  provider: AIProvider,
  contextWindow?: number
): ModelCapabilities {
  const id = modelId.toLowerCase();
  let isReasoning = false;
  let isFast = false;

  if (provider === 'openai') {
    isReasoning =
      id.startsWith('o1') ||
      id.startsWith('o3') ||
      id.startsWith('o4') ||
      id.startsWith('gpt-5');
    isFast = id.includes('mini') || id.includes('nano') || id.includes('flash');
  } else if (provider === 'anthropic') {
    isReasoning =
      id.includes('4-5') || id.includes('4.5') || id.includes('4-6') || id.includes('4.6');
    isFast = id.includes('haiku');
  } else if (provider === 'google' || provider === 'vertex') {
    isReasoning =
      id.startsWith('gemini-2.0') ||
      id.startsWith('gemini-2.5') ||
      id.startsWith('gemini-3');
    isFast = id.includes('flash') || id.includes('flash-lite');
  }
  // lmstudio: no static patterns

  const resolvedWindow = contextWindow ?? getKnownContextWindow(modelId, provider);
  const hasHighContext =
    typeof resolvedWindow === 'number' && resolvedWindow >= HIGH_CONTEXT_THRESHOLD;

  return { isReasoning, isFast, hasHighContext };
}

/**
 * Whether a model supports tool/function calling (required for Agent, Designer, etc.).
 * Uses deny list: we assume tools supported unless model is known not to.
 */
export function modelSupportsTools(modelId: string, provider: AIProvider): boolean {
  const id = modelId.toLowerCase();
  if (provider === 'anthropic') {
    // Claude-Instant (legacy) does not support tools; current Opus/Sonnet/Haiku do
    if (id.includes('claude-instant') && !id.includes('haiku')) return false;
    return true;
  }
  if (provider === 'openai') {
    // Chat models we list support tools; exclude any known non-tool chat models
    if (id.includes('gpt-4o-audio') || id.includes('gpt-4o-mini-audio')) return false;
    return true;
  }
  if (provider === 'google' || provider === 'vertex') {
    // Gemini 1.0 does not support function calling; 1.5+, 2.x, 3.x do
    if (id.startsWith('gemini-1.0') || id.includes('gemini-1.0-')) return false;
    return true;
  }
  // LM Studio: assume support (user's local models; we can't know)
  return true;
}

export interface ModelFilters {
  showReasoning: boolean;
  showFast: boolean;
  showHighContext: boolean;
  /** When true (default), only show tool-capable models; when false, show all */
  showToolCapableOnly: boolean;
}

export interface ModelWithCapabilities {
  id?: string;
  provider?: AIProvider;
  isReasoning?: boolean;
  isFast?: boolean;
  hasHighContext?: boolean;
}

/**
 * Return true if model should be shown given current filters.
 * Include if uncategorized (no capabilities) or matches at least one enabled filter.
 * Exclude non-tool models when showToolCapableOnly is true (default).
 */
export function modelPassesFilters(
  m: ModelWithCapabilities,
  filters: ModelFilters
): boolean {
  const showToolCapableOnly = filters.showToolCapableOnly ?? true;
  if (showToolCapableOnly && m.id && m.provider) {
    if (!modelSupportsTools(m.id, m.provider)) return false;
  }
  const hasReasoning = m.isReasoning ?? false;
  const hasFast = m.isFast ?? false;
  const hasHighContext = m.hasHighContext ?? false;
  if (!hasReasoning && !hasFast && !hasHighContext) return true;
  return (
    (hasReasoning && filters.showReasoning) ||
    (hasFast && filters.showFast) ||
    (hasHighContext && filters.showHighContext)
  );
}

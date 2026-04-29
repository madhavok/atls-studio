import { create } from 'zustand';
import { useRoundHistoryStore } from './roundHistoryStore';

// Types
export type AIProvider = 'anthropic' | 'openai' | 'google' | 'vertex' | 'lmstudio' | 'openrouter';

export interface OpenRouterModelPricing {
  input: number;
  output: number;
  cachedInput?: number;
}

const openRouterPricing = new Map<string, OpenRouterModelPricing>();

export function registerOpenRouterModelPricing(
  models: Array<{ id: string; openRouterPricing?: OpenRouterModelPricing }>,
): void {
  for (const model of models) {
    if (!model.id || !model.openRouterPricing) continue;
    const { input, output, cachedInput } = model.openRouterPricing;
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    openRouterPricing.set(model.id.toLowerCase(), { input, output, cachedInput });
  }
}

export function clearOpenRouterModelPricing(): void {
  openRouterPricing.clear();
}

export interface UsageRecord {
  provider: AIProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costCents: number;
  timestamp: Date;
}

export interface DailyUsage {
  date: string; // YYYY-MM-DD
  provider: AIProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  apiCalls: number;
}

export interface ProviderTotals {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  apiCalls: number;
}

const EMPTY_TOTALS = Object.freeze({ inputTokens: 0, outputTokens: 0, costCents: 0, apiCalls: 0 });

function createEmptyTotals(): ProviderTotals {
  return { ...EMPTY_TOTALS };
}

function accumulateTotals(
  target: ProviderTotals,
  usage: Pick<DailyUsage, 'inputTokens' | 'outputTokens' | 'costCents' | 'apiCalls'>,
): ProviderTotals {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.costCents += usage.costCents;
  target.apiCalls += usage.apiCalls;
  return target;
}

function sumUsageTotals(entries: DailyUsage[]): ProviderTotals {
  return entries.reduce((acc, entry) => accumulateTotals(acc, entry), createEmptyTotals());
}

function createProviderTotalsRecord(): Record<AIProvider, ProviderTotals> {
  return {
    anthropic: createEmptyTotals(),
    openai: createEmptyTotals(),
    google: createEmptyTotals(),
    vertex: createEmptyTotals(),
    lmstudio: createEmptyTotals(),
    openrouter: createEmptyTotals(),
  };
}

function groupUsageByProvider(entries: DailyUsage[]): Record<AIProvider, ProviderTotals> {
  return entries.reduce((result, entry) => {
    accumulateTotals(result[entry.provider], entry);
    return result;
  }, createProviderTotalsRecord());
}

export interface SubAgentUsage {
  invocationId: string;
  type: 'retriever' | 'design' | 'coder' | 'tester';
  provider: AIProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCents: number;
  rounds: number;
  toolCalls: number;
  pinTokens: number;
  timestamp: Date;
}

// LocalStorage key
const COST_DATA_KEY = 'atls-cost-data';
const COST_SETTINGS_KEY = 'atls-cost-settings';

// Pricing per 1M tokens (in cents) - updated Apr 2026
// Use prefixes for versioned model matching (more specific prefixes first)
const PRICING: Record<string, Array<{ prefix: string; input: number; output: number; cachedInput?: number }>> = {
  anthropic: [
    // Claude 4.6 series (Feb 2026) - current flagship
    { prefix: 'claude-sonnet-4-6', input: 300, output: 1500 },    // $3/$15
    { prefix: 'claude-sonnet-4.6', input: 300, output: 1500 },
    { prefix: 'claude-opus-4-7', input: 500, output: 2500 },      // $5/$25 (same as 4.6; must precede claude-opus-4)
    { prefix: 'claude-opus-4.7', input: 500, output: 2500 },
    { prefix: 'claude-opus-4-6', input: 500, output: 2500 },      // $5/$25
    { prefix: 'claude-opus-4.6', input: 500, output: 2500 },
    // Claude 4.5 series (Nov 2025)
    { prefix: 'claude-haiku-4-5', input: 100, output: 500 },      // $1/$5
    { prefix: 'claude-haiku-4.5', input: 100, output: 500 },
    { prefix: 'claude-sonnet-4-5', input: 300, output: 1500 },    // $3/$15
    { prefix: 'claude-sonnet-4.5', input: 300, output: 1500 },
    { prefix: 'claude-opus-4-5', input: 500, output: 2500 },      // $5/$25
    { prefix: 'claude-opus-4.5', input: 500, output: 2500 },
    // Claude 4 series (legacy)
    { prefix: 'claude-opus-4', input: 1500, output: 7500 },       // $15/$75
    { prefix: 'claude-sonnet-4', input: 300, output: 1500 },      // $3/$15
    // Claude 3.x series (legacy - deprecated Jan 2026)
    { prefix: 'claude-3-7-sonnet', input: 300, output: 1500 },
    { prefix: 'claude-3-5-sonnet', input: 300, output: 1500 },
    { prefix: 'claude-3-5-haiku', input: 100, output: 500 },
    { prefix: 'claude-3-opus', input: 1500, output: 7500 },
    { prefix: 'claude-3-haiku', input: 25, output: 125 },
  ],
  openai: [
    // o-series reasoning models (specific variants first)
    { prefix: 'o4-mini', input: 110, output: 440 },               // $1.10/$4.40
    { prefix: 'o3-pro', input: 2000, output: 8000 },              // $20/$80
    { prefix: 'o3-mini', input: 110, output: 440 },               // $1.10/$4.40
    { prefix: 'o3', input: 200, output: 800 },                    // $2/$8
    { prefix: 'o1-mini', input: 300, output: 1200 },              // legacy
    { prefix: 'o1', input: 1500, output: 6000 },                  // legacy
    // GPT-5 series (specific variants before base, longer prefixes first)
    { prefix: 'gpt-5.5-pro', input: 3000, output: 18000 },        // $30/$180
    { prefix: 'gpt-5.5', input: 500, output: 3000, cachedInput: 50 }, // $5/$30, cached $0.50
    { prefix: 'gpt-5.4-mini', input: 75, output: 450, cachedInput: 7.5 }, // $0.75/$4.50, cached $0.075
    { prefix: 'gpt-5.4', input: 250, output: 1500, cachedInput: 25 }, // $2.50/$15, cached $0.25
    { prefix: 'gpt-5.2-pro', input: 2100, output: 16800 },       // $21/$168
    { prefix: 'gpt-5.2', input: 175, output: 1400 },              // $1.75/$14
    { prefix: 'gpt-5.1', input: 125, output: 1000 },              // $1.25/$10
    { prefix: 'gpt-5-pro', input: 1500, output: 12000 },          // $15/$120
    { prefix: 'gpt-5-nano', input: 5, output: 40 },               // $0.05/$0.40
    { prefix: 'gpt-5-mini', input: 25, output: 200 },             // $0.25/$2
    { prefix: 'gpt-5', input: 125, output: 1000 },                // $1.25/$10
    // GPT-4o series
    { prefix: 'gpt-4o-mini', input: 15, output: 60 },             // $0.15/$0.60
    { prefix: 'gpt-4o', input: 250, output: 1000 },               // $2.50/$10
    { prefix: 'gpt-4-turbo', input: 1000, output: 3000 },         // legacy
    { prefix: 'gpt-4', input: 3000, output: 6000 },               // legacy
  ],
  google: [
    // Gemini 3.1 series (preview)
    { prefix: 'gemini-3.1-pro-preview', input: 200, output: 1200 }, // Assumed similar to 3.0 Pro
    // Gemini 3 series (latest)
    { prefix: 'gemini-3-pro', input: 200, output: 1200 },         // $2/$12
    { prefix: 'gemini-3.0-pro', input: 200, output: 1200 },
    { prefix: 'gemini-3-flash', input: 50, output: 300 },         // $0.50/$3
    { prefix: 'gemini-3.0-flash', input: 50, output: 300 },
    // Gemini 2.5 series
    { prefix: 'gemini-2.5-pro', input: 125, output: 1000 },       // $1.25/$10
    { prefix: 'gemini-2.5-flash-lite', input: 10, output: 40 },   // $0.10/$0.40
    { prefix: 'gemini-2.5-flash', input: 30, output: 250 },       // $0.30/$2.50
    // Gemini 2.0 series
    { prefix: 'gemini-2.0-flash-lite', input: 10, output: 40 },   // $0.10/$0.40
    { prefix: 'gemini-2.0-flash', input: 7.5, output: 30 },       // $0.075/$0.30
    // Gemini 1.5 series (legacy)
    { prefix: 'gemini-1.5-pro', input: 125, output: 500 },        // $1.25/$5
    { prefix: 'gemini-1.5-flash', input: 7.5, output: 30 },       // $0.075/$0.30
    // Generic aliases (fallbacks)
    { prefix: 'gemini-pro', input: 125, output: 500 },            // Assume 1.5 Pro
    { prefix: 'gemini-flash', input: 7.5, output: 30 },           // Assume 1.5 Flash
  ],
  vertex: [
    // Same pricing as Google AI, different endpoint
    { prefix: 'gemini-3.1-pro-preview', input: 200, output: 1200 },
    { prefix: 'gemini-3-pro', input: 200, output: 1200 },
    { prefix: 'gemini-3.0-pro', input: 200, output: 1200 },
    { prefix: 'gemini-3-flash', input: 50, output: 300 },
    { prefix: 'gemini-3.0-flash', input: 50, output: 300 },
    { prefix: 'gemini-2.5-pro', input: 125, output: 1000 },
    { prefix: 'gemini-2.5-flash-lite', input: 10, output: 40 },
    { prefix: 'gemini-2.5-flash', input: 30, output: 250 },
    { prefix: 'gemini-2.0-flash-lite', input: 10, output: 40 },
    { prefix: 'gemini-2.0-flash', input: 7.5, output: 30 },
    { prefix: 'gemini-1.5-pro', input: 125, output: 500 },
    { prefix: 'gemini-1.5-flash', input: 7.5, output: 30 },
    // Generic aliases (fallbacks)
    { prefix: 'gemini-pro', input: 125, output: 500 },
    { prefix: 'gemini-flash', input: 7.5, output: 30 },
  ],
  openrouter: [],
};

// Cache pricing multipliers (relative to base input price)
const ANTHROPIC_CACHE_READ_MULT = 0.1;   // 10% of base input price
const ANTHROPIC_CACHE_WRITE_MULT = 1.25; // 125% of base input price (5-min TTL)
const OPENAI_CACHED_MULT = 0.5;          // legacy fallback when OpenAI has no explicit cached rate
const GEMINI_CACHED_MULT = 0.25;         // 25% of base input price (75% discount)

// Calculate cost for given tokens.
// For Anthropic: inputTokens = uncached only; cacheReadTokens/cacheWriteTokens priced separately.
// For OpenAI: inputTokens = total prompt tokens; cacheReadTokens = cached subset (50% discount).
// For Google/Vertex: inputTokens = total prompt tokens; cacheReadTokens = cached subset (75% discount).
export interface CostBreakdown {
  inputCostCents: number;
  outputCostCents: number;
  totalCostCents: number;
}

export function calculateCostBreakdown(
  provider: AIProvider,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): CostBreakdown {
  const zero: CostBreakdown = { inputCostCents: 0, outputCostCents: 0, totalCostCents: 0 };
  if (
    !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) ||
    !Number.isFinite(cacheReadTokens) || !Number.isFinite(cacheWriteTokens) ||
    inputTokens < 0 || outputTokens < 0 || cacheReadTokens < 0 || cacheWriteTokens < 0
  ) {
    return zero;
  }
  const providerPricing = provider === 'openrouter'
    ? Array.from(openRouterPricing.entries()).map(([prefix, pricing]) => ({ prefix, ...pricing }))
    : PRICING[provider];
  if (!providerPricing) {
    console.warn(`[CostStore] No pricing for provider: ${provider}`);
    return zero;
  }
  if (!model || typeof model !== 'string') {
    console.warn(`[CostStore] Invalid model value: ${model} (provider: ${provider})`);
    return zero;
  }

  const normalizedModel = model.toLowerCase();
  const modelPricing = providerPricing.find(p => normalizedModel.startsWith(p.prefix));
  if (!modelPricing) {
    console.warn(`[CostStore] No pricing for model: ${model} (provider: ${provider})`);
    return zero;
  }

  const perM = 1_000_000;
  let inputCostCents: number;

  if (provider === 'anthropic') {
    // Anthropic: input_tokens = uncached only, cache tokens are separate line items
    const uncachedCost = (inputTokens / perM) * modelPricing.input;
    const cacheReadCost = (cacheReadTokens / perM) * modelPricing.input * ANTHROPIC_CACHE_READ_MULT;
    const cacheWriteCost = (cacheWriteTokens / perM) * modelPricing.input * ANTHROPIC_CACHE_WRITE_MULT;
    inputCostCents = uncachedCost + cacheReadCost + cacheWriteCost;
  } else if (provider === 'openai' && cacheReadTokens > 0) {
    // OpenAI: prompt_tokens includes cached; subtract cached portion and re-add at the cached rate
    const uncached = Math.max(0, inputTokens - cacheReadTokens);
    const uncachedCost = (uncached / perM) * modelPricing.input;
    const cachedInput = modelPricing.cachedInput ?? modelPricing.input * OPENAI_CACHED_MULT;
    const cachedCost = (cacheReadTokens / perM) * cachedInput;
    inputCostCents = uncachedCost + cachedCost;
  } else if ((provider === 'google' || provider === 'vertex') && cacheReadTokens > 0) {
    // Google/Vertex with Gemini Context Caching: cached tokens at 75% discount
    const uncached = Math.max(0, inputTokens - cacheReadTokens);
    const uncachedCost = (uncached / perM) * modelPricing.input;
    const cachedCost = (cacheReadTokens / perM) * modelPricing.input * GEMINI_CACHED_MULT;
    inputCostCents = uncachedCost + cachedCost;
  } else {
    // No cache data: full rate on all input tokens
    inputCostCents = (inputTokens / perM) * modelPricing.input;
  }

  const outputCostCents = (outputTokens / perM) * modelPricing.output;

  return { inputCostCents, outputCostCents, totalCostCents: inputCostCents + outputCostCents };
}

/** Convenience wrapper — returns total cost only. Use calculateCostBreakdown for input/output split. */
export function calculateCost(
  provider: AIProvider,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  return calculateCostBreakdown(provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens).totalCostCents;
}

// Get today's date as YYYY-MM-DD
function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

// Get current month as YYYY-MM
function getCurrentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// Load saved data
function loadCostData(): DailyUsage[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const saved = localStorage.getItem(COST_DATA_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      // Validate each entry has required fields
      return parsed.filter((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const e = entry as Record<string, unknown>;
        if (typeof e.date !== 'string' || typeof e.provider !== 'string' || typeof e.model !== 'string') return false;
        // Validate numeric fields — reject entries with non-finite numbers
        for (const key of ['inputTokens', 'outputTokens', 'costCents', 'apiCalls', 'cacheReadTokens', 'cacheWriteTokens']) {
          if (key in e && (typeof e[key] !== 'number' || !Number.isFinite(e[key] as number))) return false;
        }
        return true;
      }) as DailyUsage[];
    }
  } catch (e) {
    console.error('Failed to load cost data:', e);
  }
  return [];
}

function loadCostSettings(): { dailyLimitCents: number | null; monthlyLimitCents: number | null } {
  if (typeof localStorage === 'undefined') return { dailyLimitCents: null, monthlyLimitCents: null };
  try {
    const saved = localStorage.getItem(COST_SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        dailyLimitCents: typeof parsed?.dailyLimitCents === 'number' ? parsed.dailyLimitCents : null,
        monthlyLimitCents: typeof parsed?.monthlyLimitCents === 'number' ? parsed.monthlyLimitCents : null,
      };
    }
  } catch (e) {
    console.error('Failed to load cost settings:', e);
  }
  return { dailyLimitCents: null, monthlyLimitCents: null };
}

interface CostState {
  // Current chat totals (reset per conversation)
  chatCostCents: number;
  chatApiCalls: number;

  // SubAgent cost breakdown (subset of chatCostCents)
  subAgentUsages: SubAgentUsage[];
  chatSubAgentCostCents: number;

  /**
   * Session = since app launch (until resetSession / clearAllData).
   * Input/output are sums of provider-reported tokens per HTTP request:
   * main chat (each agent/tool-loop round is its own request with a full prompt),
   * plus every subagent round. Parallel swarm workers omit costStore when
   * affectMainChatMetrics is false. Not comparable to the context-meter bar
   * (single-round prompt estimate).
   */
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionCostCents: number;
  /** Count of recordUsage calls this session (one per billed API request in costStore). */
  sessionApiCalls: number;

  // HPP v2: Output efficiency tracking
  outputTokensSaved: number;
  outputDedupsApplied: number;
  refDensityHistory: number[];

  // HPP v3: Set-ref tracking
  setRefReplacements: number;
  setRefTokensSaved: number;

  // Daily usage data (persisted)
  dailyUsage: DailyUsage[];

  // Limits
  dailyLimitCents: number | null;
  monthlyLimitCents: number | null;

  // Actions
  recordUsage: (record: UsageRecord) => void;
  recordSubAgentUsage: (usage: SubAgentUsage) => void;
  recordOutputSavings: (tokensSaved: number, dedupsApplied: number) => void;
  recordRefDensity: (ratio: number) => void;
  recordSetRefReplacement: (tokensSaved: number) => void;
  resetChat: () => void;
  /** Restore per-conversation totals after loading a session from persistence (cold start / history). */
  restorePersistedChatTotals: (payload: {
    chatCostCents?: number;
    chatApiCalls?: number;
    chatSubAgentCostCents?: number;
    subAgentUsages?: SubAgentUsage[];
  }) => void;
  resetSession: () => void;
  setLimits: (daily: number | null, monthly: number | null) => void;
  clearAllData: () => void;

  // Computed getters
  getTodayTotals: () => ProviderTotals;
  getMonthTotals: () => ProviderTotals;
  getTodayByProvider: () => Record<AIProvider, ProviderTotals>;
  getMonthByProvider: () => Record<AIProvider, ProviderTotals>;
  isOverDailyLimit: () => boolean;
  isOverMonthlyLimit: () => boolean;
  getDailyLimitPercent: () => number;
  getMonthlyLimitPercent: () => number;
  getOutputEfficiency: () => number;
}

export const useCostStore = create<CostState>((set, get) => {
  // Load initial data
  const savedData = loadCostData();
  const savedSettings = loadCostSettings();

  return {
    // Chat state (per conversation)
    chatCostCents: 0,
    chatApiCalls: 0,

    // SubAgent breakdown
    subAgentUsages: [],
    chatSubAgentCostCents: 0,

    // Session state (per app launch)
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    sessionCostCents: 0,
    sessionApiCalls: 0,

    // HPP v2: Output efficiency tracking
    outputTokensSaved: 0,
    outputDedupsApplied: 0,
    refDensityHistory: [],

    // HPP v3: Set-ref tracking
    setRefReplacements: 0,
    setRefTokensSaved: 0,

    // Persisted data
    dailyUsage: savedData,

    // Limits
    dailyLimitCents: savedSettings.dailyLimitCents,
    monthlyLimitCents: savedSettings.monthlyLimitCents,

    // Record usage from an API call
    recordUsage: (record: UsageRecord) => {
      console.log(`[CostStore] Recording usage: ${record.inputTokens}in/${record.outputTokens}out = ${record.costCents}¢ (${record.provider}/${record.model})`);
      
      const today = getToday();
      const state = get();

      // Update chat totals
      const newChatCost = state.chatCostCents + record.costCents;
      const newChatCalls = state.chatApiCalls + 1;

      // Update session totals
      const newSessionInput = state.sessionInputTokens + record.inputTokens;
      const newSessionOutput = state.sessionOutputTokens + record.outputTokens;
      const newSessionCost = state.sessionCostCents + record.costCents;
      const newSessionCalls = state.sessionApiCalls + 1;
      
      console.log(`[CostStore] Chat: ${newChatCost}¢ | Session: ${newSessionCost}¢ (${newSessionCalls} calls)`);

      // Update or create daily usage entry
      const dailyUsage = [...state.dailyUsage];
      const existingIdx = dailyUsage.findIndex(
        (d) => d.date === today && d.provider === record.provider && d.model === record.model
      );

      if (existingIdx >= 0) {
        dailyUsage[existingIdx] = {
          ...dailyUsage[existingIdx],
          inputTokens: dailyUsage[existingIdx].inputTokens + record.inputTokens,
          outputTokens: dailyUsage[existingIdx].outputTokens + record.outputTokens,
          costCents: dailyUsage[existingIdx].costCents + record.costCents,
          apiCalls: dailyUsage[existingIdx].apiCalls + 1,
        };
      } else {
        dailyUsage.push({
          date: today,
          provider: record.provider,
          model: record.model,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          costCents: record.costCents,
          apiCalls: 1,
        });
      }

      // Persist to localStorage
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(COST_DATA_KEY, JSON.stringify(dailyUsage));
        }
      } catch (e) {
        console.error('Failed to save cost data:', e);
      }

      set({
        chatCostCents: newChatCost,
        chatApiCalls: newChatCalls,
        sessionInputTokens: newSessionInput,
        sessionOutputTokens: newSessionOutput,
        sessionCostCents: newSessionCost,
        sessionApiCalls: newSessionCalls,
        dailyUsage,
      });
    },

    recordSubAgentUsage: (usage: SubAgentUsage) => {
      const state = get();
      console.log(`[CostStore] SubAgent ${usage.type}: ${usage.costCents}¢ (${usage.provider}/${usage.model}, ${usage.rounds} rounds, ${usage.pinTokens} pin tokens)`);
      set({
        subAgentUsages: [...state.subAgentUsages, usage],
        chatSubAgentCostCents: state.chatSubAgentCostCents + usage.costCents,
      });
    },

    recordOutputSavings: (tokensSaved: number, dedupsApplied: number) => {
      const state = get();
      set({
        outputTokensSaved: state.outputTokensSaved + tokensSaved,
        outputDedupsApplied: state.outputDedupsApplied + dedupsApplied,
      });
    },

    recordRefDensity: (ratio: number) => {
      const state = get();
      const history = [...state.refDensityHistory, ratio];
      if (history.length > 100) history.shift();
      set({ refDensityHistory: history });
    },

    recordSetRefReplacement: (tokensSaved: number) => {
      const state = get();
      set({
        setRefReplacements: state.setRefReplacements + 1,
        setRefTokensSaved: state.setRefTokensSaved + tokensSaved,
      });
    },

    resetChat: () => {
      set({
        chatCostCents: 0,
        chatApiCalls: 0,
        subAgentUsages: [],
        chatSubAgentCostCents: 0,
        outputTokensSaved: 0,
        outputDedupsApplied: 0,
        refDensityHistory: [],
        setRefReplacements: 0,
        setRefTokensSaved: 0,
      });
    },

    restorePersistedChatTotals: (payload) => {
      const state = get();
      set({
        chatCostCents: payload.chatCostCents !== undefined ? Math.max(0, payload.chatCostCents) : state.chatCostCents,
        chatApiCalls: payload.chatApiCalls !== undefined ? Math.max(0, payload.chatApiCalls) : state.chatApiCalls,
        chatSubAgentCostCents:
          payload.chatSubAgentCostCents !== undefined ? Math.max(0, payload.chatSubAgentCostCents) : state.chatSubAgentCostCents,
        subAgentUsages: payload.subAgentUsages !== undefined ? payload.subAgentUsages : state.subAgentUsages,
      });
    },

    resetSession: () => {
      set({
        sessionInputTokens: 0,
        sessionOutputTokens: 0,
        sessionCostCents: 0,
        sessionApiCalls: 0,
        outputTokensSaved: 0,
        outputDedupsApplied: 0,
        refDensityHistory: [],
        setRefReplacements: 0,
        setRefTokensSaved: 0,
      });
    },

    setLimits: (daily: number | null, monthly: number | null) => {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(COST_SETTINGS_KEY, JSON.stringify({
            dailyLimitCents: daily,
            monthlyLimitCents: monthly,
          }));
        }
      } catch (e) {
        console.error('Failed to save cost settings:', e);
      }
      set({ dailyLimitCents: daily, monthlyLimitCents: monthly });
    },

    clearAllData: () => {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(COST_DATA_KEY);
          localStorage.removeItem(COST_SETTINGS_KEY);
        }
      } catch (e) {
        console.error('Failed to clear cost data/settings:', e);
      }
      useRoundHistoryStore.getState().reset();
      set({
        chatCostCents: 0,
        chatApiCalls: 0,
        subAgentUsages: [],
        chatSubAgentCostCents: 0,
        sessionInputTokens: 0,
        sessionOutputTokens: 0,
        sessionCostCents: 0,
        sessionApiCalls: 0,
        outputTokensSaved: 0,
        outputDedupsApplied: 0,
        refDensityHistory: [],
        setRefReplacements: 0,
        setRefTokensSaved: 0,
        dailyUsage: [],
        dailyLimitCents: null,
        monthlyLimitCents: null,
      });
    },

    // Get today's totals across all providers
    getTodayTotals: () => {
      const today = getToday();
      return sumUsageTotals(get().dailyUsage.filter((d) => d.date === today));
    },

    // Get this month's totals across all providers
    getMonthTotals: () => {
      const month = getCurrentMonth();
      return sumUsageTotals(get().dailyUsage.filter((d) => d.date.startsWith(month)));
    },

    // Get today's totals by provider
    getTodayByProvider: () => {
      const today = getToday();
      return groupUsageByProvider(get().dailyUsage.filter((d) => d.date === today));
    },

    // Get this month's totals by provider
    getMonthByProvider: () => {
      const month = getCurrentMonth();
      return groupUsageByProvider(get().dailyUsage.filter((d) => d.date.startsWith(month)));
    },

    isOverDailyLimit: () => {
      const state = get();
      if (!state.dailyLimitCents) return false;
      return state.getTodayTotals().costCents >= state.dailyLimitCents;
    },

    isOverMonthlyLimit: () => {
      const state = get();
      if (!state.monthlyLimitCents) return false;
      return state.getMonthTotals().costCents >= state.monthlyLimitCents;
    },

    getDailyLimitPercent: () => {
      const state = get();
      if (!state.dailyLimitCents) return 0;
      return Math.min(100, (state.getTodayTotals().costCents / state.dailyLimitCents) * 100);
    },

    getMonthlyLimitPercent: () => {
      const state = get();
      if (!state.monthlyLimitCents) return 0;
      return Math.min(100, (state.getMonthTotals().costCents / state.monthlyLimitCents) * 100);
    },

    getOutputEfficiency: () => {
      const state = get();
      const history = state.refDensityHistory;
      if (history.length === 0) return 0;
      const sum = history.reduce((a, b) => a + b, 0);
      return Math.round((sum / history.length) * 100);
    },
  };
});

// Helper to format cost in dollars
export function formatCost(cents: number): string {
  if (cents === 0) return '$0.00';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  if (abs < 0.1) {
    return `${sign}$${(abs / 100).toFixed(4)}`;
  } else if (abs < 1) {
    return `${sign}$${(abs / 100).toFixed(3)}`;
  }
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

// Helper to format token count
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(2)}M`;
}

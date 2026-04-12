/**
 * Token Counter — async wrapper around Rust tokenizer with LRU cache.
 *
 * Provides real BPE token counts via Tauri IPC to the backend tokenizer
 * (tiktoken-rs for OpenAI, ctoc greedy for Anthropic, calibrated heuristic for Gemini).
 *
 * Hot paths should use countTokens/countTokensBatch for accurate counts.
 * Cold paths (display, analytics) can continue using estimateTokens from contextHash.ts.
 */

import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/appStore';
import { getPricingProviderForModel } from './pricingProvider';
import { estimateTokens, hashContentSync } from './contextHash';

// ---------------------------------------------------------------------------
// LRU Cache (keyed by provider:model:contentHash)
// ---------------------------------------------------------------------------

const CACHE_MAX = 2048;

interface CacheEntry {
  key: string;
  value: number;
}

class LRUCache {
  private map = new Map<string, number>();
  private maxSize: number;
  private lastKey: string | undefined;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): number | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Only do delete+re-set when key isn't already the most recent entry.
      // When the last-inserted key is accessed again (common in hot loops),
      // this avoids the O(1)-but-costly Map delete+set overhead.
      if (this.lastKey !== key) {
        this.map.delete(key);
        this.map.set(key, val);
        this.lastKey = key;
      }
    }
    return val;
  }

  set(key: string, value: number): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first key in Map iteration order)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
    this.lastKey = key;
  }

  clear(): void {
    this.map.clear();
    this.lastKey = undefined;
  }

  get size(): number {
    return this.map.size;
  }
}

const cache = new LRUCache(CACHE_MAX);

// ---------------------------------------------------------------------------
// Provider/model resolution (cached; invalidated on settings change)
// ---------------------------------------------------------------------------

let _cachedProvider: string | undefined;
let _cachedModel: string | undefined;
let _subscribed = false;

function ensureProviderSubscription(): void {
  if (_subscribed) return;
  _subscribed = true;
  useAppStore.subscribe((state, prev) => {
    if (
      state.settings.selectedProvider !== prev.settings.selectedProvider ||
      state.settings.selectedModel !== prev.settings.selectedModel ||
      state.availableModels !== prev.availableModels
    ) {
      _cachedProvider = undefined;
      _cachedModel = undefined;
      clearTokenCache();
    }
  });
}

function getActiveProviderModel(): { provider: string; model: string } {
  ensureProviderSubscription();
  if (_cachedProvider !== undefined && _cachedModel !== undefined) {
    return { provider: _cachedProvider, model: _cachedModel };
  }
  const { settings, availableModels } = useAppStore.getState();
  _cachedModel = settings.selectedModel;
  _cachedProvider = getPricingProviderForModel(settings.selectedModel, settings.selectedProvider, availableModels);
  return { provider: _cachedProvider, model: _cachedModel };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count tokens for a single string using the real provider-specific tokenizer.
 * Results are LRU-cached to avoid redundant IPC for repeated content.
 */
export async function countTokens(content: string, precomputedHash?: string): Promise<number> {
  const { provider, model } = getActiveProviderModel();
  const hash = precomputedHash || hashContentSync(content);
  const cacheKey = `${provider}:${model}:${hash}`;

  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const count = await invoke<number>('count_tokens', { provider, model, content });
    cache.set(cacheKey, count);
    const priorHeuristic = heuristicCache.get(cacheKey);
    if (priorHeuristic !== undefined) {
      recordDrift(priorHeuristic, count);
    }
    return count;
  } catch {
    return estimateTokens(content);
  }
}

/**
 * Count tokens for multiple strings in a single IPC call.
 * Checks cache for each item; only sends uncached items to the backend.
 */
export async function countTokensBatch(contents: string[], precomputedHashes?: string[]): Promise<number[]> {
  const { provider, model } = getActiveProviderModel();
  const keyPrefix = `${provider}:${model}:`;
  const results = new Array<number>(contents.length);
  const uncachedIndices: number[] = [];
  const uncachedContents: string[] = [];
  const uncachedHashes: string[] = [];

  for (let i = 0; i < contents.length; i++) {
    if (!contents[i] || contents[i].length === 0) {
      results[i] = 0;
      continue;
    }
    const hash = precomputedHashes?.[i] || hashContentSync(contents[i]);
    const cacheKey = keyPrefix + hash;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
      uncachedContents.push(contents[i]);
      uncachedHashes.push(hash);
    }
  }

  if (uncachedContents.length > 0) {
    try {
      const counts = await invoke<number[]>('count_tokens_batch', {
        provider,
        model,
        contents: uncachedContents,
      });
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        results[idx] = counts[j];
        const batchCacheKey = keyPrefix + uncachedHashes[j];
        cache.set(batchCacheKey, counts[j]);
        const priorHeuristic = heuristicCache.get(batchCacheKey);
        if (priorHeuristic !== undefined) {
          recordDrift(priorHeuristic, counts[j]);
        }
      }
    } catch {
      for (const idx of uncachedIndices) {
        results[idx] = estimateTokens(contents[idx]);
      }
    }
  }

  return results;
}

/**
 * Count tokens for tool definitions using the real tokenizer.
 */
export async function countToolDefTokens(): Promise<number> {
  const { provider, model } = getActiveProviderModel();
  try {
    return await invoke<number>('count_tool_def_tokens', { provider, model });
  } catch {
    return 0;
  }
}

// Keys where the cached value came from the heuristic (not real BPE).
// These are NOT promoted into the main cache so that a later async
// countTokens call can still do a real IPC and cache the accurate result.
const heuristicCache = new LRUCache(512);

// Drift telemetry: track when heuristic diverges from real BPE counts
let _driftSamples = 0;
let _driftSumAbsPct = 0;
let _driftMaxAbsPct = 0;
let _driftOverThreshold = 0;
const DRIFT_THRESHOLD_PCT = 10;
const DRIFT_LOG_INTERVAL = 50;

function recordDrift(heuristic: number, real: number): void {
  if (heuristic === 0 || real === 0) return;
  const pct = Math.abs(((heuristic - real) / real) * 100);
  _driftSamples++;
  _driftSumAbsPct += pct;
  if (pct > _driftMaxAbsPct) _driftMaxAbsPct = pct;
  if (pct > DRIFT_THRESHOLD_PCT) _driftOverThreshold++;
  if (_driftSamples % DRIFT_LOG_INTERVAL === 0) {
    const avg = (_driftSumAbsPct / _driftSamples).toFixed(1);
    console.log(
      `[tokenizer] heuristic drift: ${_driftSamples} samples, avg=${avg}%, max=${_driftMaxAbsPct.toFixed(1)}%, >${DRIFT_THRESHOLD_PCT}%=${_driftOverThreshold}`,
    );
  }
}

/**
 * Synchronous token count — returns real BPE count from cache when available,
 * otherwise falls back to heuristic estimateTokens. The heuristic result is
 * stored in a separate cache so it does not prevent later async countTokens
 * calls from computing and caching the real count.
 */
export function countTokensSync(content: string, precomputedHash?: string): number {
  const { provider, model } = getActiveProviderModel();
  const hash = precomputedHash || hashContentSync(content);
  const cacheKey = `${provider}:${model}:${hash}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const hCached = heuristicCache.get(cacheKey);
  if (hCached !== undefined) return hCached;
  const estimate = estimateTokens(content);
  heuristicCache.set(cacheKey, estimate);
  return estimate;
}

/**
 * Invalidate the cache (e.g., when provider/model changes).
 */
export function clearTokenCache(): void {
  cache.clear();
  heuristicCache.clear();
  _cachedProvider = undefined;
  _cachedModel = undefined;
}

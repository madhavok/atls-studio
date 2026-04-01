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
import { estimateTokens } from './contextHash';

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
// FNV-1a hash (matches contextHash.ts but inlined to avoid import cycles)
// ---------------------------------------------------------------------------

function quickHash(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}

// ---------------------------------------------------------------------------
// Provider/model resolution
// ---------------------------------------------------------------------------

function getActiveProviderModel(): { provider: string; model: string } {
  const { settings } = useAppStore.getState();
  return {
    provider: settings.selectedProvider,
    model: settings.selectedModel,
  };
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
  const hash = precomputedHash || quickHash(content);
  const cacheKey = `${provider}:${model}:${hash}`;

  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const count = await invoke<number>('count_tokens', { provider, model, content });
    cache.set(cacheKey, count);
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
  const results = new Array<number>(contents.length);
  const uncachedIndices: number[] = [];
  const uncachedContents: string[] = [];
  const uncachedHashes: string[] = [];

  for (let i = 0; i < contents.length; i++) {
    if (!contents[i] || contents[i].length === 0) {
      results[i] = 0;
      continue;
    }
    const hash = precomputedHashes?.[i] || quickHash(contents[i]);
    const cacheKey = `${provider}:${model}:${hash}`;
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
        const cacheKey = `${provider}:${model}:${uncachedHashes[j]}`;
        cache.set(cacheKey, counts[j]);
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

/**
 * Synchronous token count — falls back to heuristic estimateTokens.
 * Use this only when async is impossible (initial renders, synchronous loops).
 * Checks the LRU cache first for previously counted content.
 */
export function countTokensSync(content: string, precomputedHash?: string): number {
  const { provider, model } = getActiveProviderModel();
  const hash = precomputedHash || quickHash(content);
  const cacheKey = `${provider}:${model}:${hash}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const estimate = estimateTokens(content);
  cache.set(cacheKey, estimate);
  return estimate;
}

/**
 * Invalidate the cache (e.g., when provider/model changes).
 */
export function clearTokenCache(): void {
  cache.clear();
}

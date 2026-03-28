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
  private order: string[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): number | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      const idx = this.order.indexOf(key);
      if (idx > -1) {
        this.order.splice(idx, 1);
        this.order.push(key);
      }
    }
    return val;
  }

  set(key: string, value: number): void {
    if (this.map.has(key)) {
      this.map.set(key, value);
      const idx = this.order.indexOf(key);
      if (idx > -1) {
        this.order.splice(idx, 1);
        this.order.push(key);
      }
      return;
    }
    if (this.order.length >= this.maxSize) {
      const evicted = this.order.shift();
      if (evicted) this.map.delete(evicted);
    }
    this.map.set(key, value);
    this.order.push(key);
  }

  clear(): void {
    this.map.clear();
    this.order = [];
  }
}

const cache = new LRUCache(CACHE_MAX);

// ---------------------------------------------------------------------------
// FNV-1a hash (matches contextHash.ts but inlined to avoid import cycles)
// ---------------------------------------------------------------------------

function fnv1a32(content: string, offsetBasis: number): number {
  let hash = offsetBasis;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function quickHash(content: string): string {
  const h1 = fnv1a32(content, 0x811c9dc5);
  const h2 = fnv1a32(content, 0x050c5d1f);
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
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
export async function countTokens(content: string): Promise<number> {
  if (!content || content.length === 0) return 0;

  const { provider, model } = getActiveProviderModel();
  const hash = quickHash(content);
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
export async function countTokensBatch(contents: string[]): Promise<number[]> {
  if (contents.length === 0) return [];

  const { provider, model } = getActiveProviderModel();
  const results = new Array<number>(contents.length);
  const uncachedIndices: number[] = [];
  const uncachedContents: string[] = [];

  for (let i = 0; i < contents.length; i++) {
    if (!contents[i] || contents[i].length === 0) {
      results[i] = 0;
      continue;
    }
    const hash = quickHash(contents[i]);
    const cacheKey = `${provider}:${model}:${hash}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
      uncachedContents.push(contents[i]);
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
        const hash = quickHash(contents[idx]);
        const cacheKey = `${provider}:${model}:${hash}`;
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
export function countTokensSync(content: string): number {
  if (!content || content.length === 0) return 0;

  const { provider, model } = getActiveProviderModel();
  const hash = quickHash(content);
  const cacheKey = `${provider}:${model}:${hash}`;

  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  return estimateTokens(content);
}

/**
 * Invalidate the cache (e.g., when provider/model changes).
 */
export function clearTokenCache(): void {
  cache.clear();
}

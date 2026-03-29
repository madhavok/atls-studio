import { invoke } from '@tauri-apps/api/core';
import { serializeMessageContentForTokens } from '../utils/toon';
import { estimateTokens, SHORT_HASH_LEN } from '../utils/contextHash';
import { useContextStore } from '../stores/contextStore';
import type { ChatMessage } from './aiService';

const GEMINI_CACHE_VERSION = 'v6';

interface GeminiCacheState {
  version: string;
  googleCacheName: string | null;
  vertexCacheName: string | null;
  googleCachedMessageCount: number;
  vertexCachedMessageCount: number;
}

const geminiCacheState: GeminiCacheState = {
  version: GEMINI_CACHE_VERSION,
  googleCacheName: null,
  vertexCacheName: null,
  googleCachedMessageCount: 0,
  vertexCachedMessageCount: 0,
};

interface HppHydrationState {
  lastMessageCount: number;
  lastHashCount: number;
  cacheValid: boolean;
}

const _hppHydrationState: HppHydrationState = {
  lastMessageCount: 0,
  lastHashCount: 0,
  cacheValid: false,
};

export function resetHppHydrationCache(): void {
  _hppHydrationState.cacheValid = false;
}

function hydrateHppReferences(messages: ChatMessage[]): ChatMessage[] {
  const store = useContextStore.getState();
  if (_hppHydrationState.cacheValid && _hppHydrationState.lastMessageCount === messages.length) {
    const currentHashCount = store.chunks.size + store.archivedChunks.size;
    if (_hppHydrationState.lastHashCount === currentHashCount) {
      return messages;
    }
  }

  const canReuse = _hppHydrationState.cacheValid && _hppHydrationState.lastMessageCount < messages.length;
  const startIdx = canReuse ? _hppHydrationState.lastMessageCount : 0;
  const result = canReuse ? messages.slice(0, startIdx) : [];

  // Build shortHash -> chunk lookup (chunks Map keyed by full 16-char hash)
  const shortHashMap = new Map<string, { content: string }>();
  store.chunks.forEach((chunk, fullHash) => {
    if (chunk.content) shortHashMap.set(fullHash.substring(0, SHORT_HASH_LEN), chunk);
  });
  store.archivedChunks.forEach((chunk, fullHash) => {
    if (chunk.content && !shortHashMap.has(fullHash.substring(0, SHORT_HASH_LEN))) {
      shortHashMap.set(fullHash.substring(0, SHORT_HASH_LEN), chunk);
    }
  });

  // Match h:ref (6-16 hex chars per HPP)
  const hppTestRegex = /h:[0-9a-f]{6,16}/;

  const MAX_HYDRATED_CHARS = 1200;

  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string' && hppTestRegex.test(msg.content)) {
      const hydrated = msg.content.replace(/h:([0-9a-f]{6,16})/g, (match, hash) => {
        const chunk = shortHashMap.get(hash.slice(0, SHORT_HASH_LEN));
        if (chunk?.content) {
          const excerpt = chunk.content.length > MAX_HYDRATED_CHARS
            ? `${chunk.content.slice(0, MAX_HYDRATED_CHARS)}\n...[cache hydration truncated; resolve the ref on demand for full content]`
            : chunk.content;
          return `${match}\n${excerpt}`;
        }
        return match;
      });
      result.push({ ...msg, content: hydrated });
    } else {
      result.push(msg);
    }
  }

  _hppHydrationState.lastMessageCount = messages.length;
  _hppHydrationState.lastHashCount = store.chunks.size + store.archivedChunks.size;
  _hppHydrationState.cacheValid = true;

  return result;
}

export async function manageGeminiRollingCache(
  provider: 'google' | 'vertex',
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  projectId?: string,
  region?: string,
): Promise<{ cacheName: string | null; cachedMessageCount: number }> {
  const isVertex = provider === 'vertex';
  const currentCache = isVertex ? geminiCacheState.vertexCacheName : geminiCacheState.googleCacheName;
  const prevCachedCount = isVertex ? geminiCacheState.vertexCachedMessageCount : geminiCacheState.googleCachedMessageCount;

  const totalChars = systemPrompt.length + messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : serializeMessageContentForTokens(m.content);
    return sum + content.length;
  }, 0);

  const estimatedTokens = Math.ceil(totalChars / 3.5);

  const ZONE_A_LIMIT = 32768;
  const ZONE_B_LIMIT = 128000;

  let shouldCreateCache = estimatedTokens >= ZONE_B_LIMIT;

  if (currentCache && estimatedTokens >= ZONE_A_LIMIT && estimatedTokens < ZONE_B_LIMIT) {
    let uncachedChars = 0;
    for (let i = prevCachedCount; i < messages.length; i++) {
      const m = messages[i];
      const content = typeof m.content === 'string' ? m.content : serializeMessageContentForTokens(m.content);
      uncachedChars += content.length;
    }
    const uncachedTokens = Math.ceil(uncachedChars / 3.5);
    shouldCreateCache = uncachedTokens >= ZONE_A_LIMIT;
  }

  if (!shouldCreateCache) {
    return { cacheName: null, cachedMessageCount: 0 };
  }

  let messagesToCache = messages.length;
  const hydratedMessages = hydrateHppReferences(messages);

  let currentSize = systemPrompt.length + hydratedMessages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : serializeMessageContentForTokens(m.content);
    return sum + content.length;
  }, 0);

  const currentTokens = Math.ceil(currentSize / 3.5);

  const cacheInstructions = `
## GEMINI CACHE CONTEXT
This conversation history is cached for efficiency. The cache contains:
- System prompt
- ${messagesToCache} message(s)
- Total estimated tokens: ~${currentTokens}

Cache will be refreshed when significant new context is added.
  `.trim();

  const effectiveSystemPrompt = `${systemPrompt}\n\n${cacheInstructions}`;

  try {
    const cacheName = await invoke<string>('gemini_create_cache', {
      provider,
      apiKey,
      model,
      systemPrompt: effectiveSystemPrompt,
      messages: hydratedMessages.slice(0, messagesToCache),
      includeDefaultTools: true,
      ttlSeconds: 3600,
      projectId: projectId ?? null,
      region: region ?? null,
    });

    // Delete old cache only after new one is successfully created
    if (currentCache) {
      try {
        await invoke('gemini_delete_cache', {
          cacheName: currentCache,
          provider,
          apiKey,
          projectId: projectId ?? null,
          region: region ?? null,
        });
      } catch (err) {
        console.warn('Failed to delete old cache:', err);
      }
    }

    if (isVertex) {
      geminiCacheState.vertexCacheName = cacheName;
      geminiCacheState.vertexCachedMessageCount = messagesToCache;
    } else {
      geminiCacheState.googleCacheName = cacheName;
      geminiCacheState.googleCachedMessageCount = messagesToCache;
    }

    return { cacheName, cachedMessageCount: messagesToCache };
  } catch (err) {
    console.error('Failed to create Gemini cache:', err);
    // Creation failed — old cache was already deleted server-side or never existed.
    // Clear in-memory state so we don't reference a stale name.
    if (isVertex) {
      geminiCacheState.vertexCacheName = null;
      geminiCacheState.vertexCachedMessageCount = 0;
    } else {
      geminiCacheState.googleCacheName = null;
      geminiCacheState.googleCachedMessageCount = 0;
    }
    return { cacheName: null, cachedMessageCount: 0 };
  }
}

export async function cleanupGeminiCache(apiKey?: string, vertexAccessToken?: string, projectId?: string, region?: string): Promise<void> {
  if (!apiKey) {
    const key = localStorage.getItem('google_api_key');
    if (!key) return;
    apiKey = key;
  }

  const promises = [];
  if (geminiCacheState.googleCacheName) {
    promises.push(
      invoke('gemini_delete_cache', {
        cacheName: geminiCacheState.googleCacheName,
        provider: 'google',
        apiKey,
        projectId: null,
        region: null,
      }).catch(err => console.warn('Failed to delete Google cache:', err))
    );
  }
  if (geminiCacheState.vertexCacheName) {
    promises.push(
      invoke('gemini_delete_cache', {
        cacheName: geminiCacheState.vertexCacheName,
        provider: 'vertex',
        apiKey: vertexAccessToken || apiKey,
        projectId: projectId ?? null,
        region: region ?? null,
      }).catch(err => console.warn('Failed to delete Vertex cache:', err))
    );
  }
  await Promise.all(promises);
  geminiCacheState.googleCacheName = null;
  geminiCacheState.vertexCacheName = null;
  geminiCacheState.googleCachedMessageCount = 0;
  geminiCacheState.vertexCachedMessageCount = 0;
}

export interface GeminiCacheSnapshot {
  version: string;
  googleCacheName: string | null;
  vertexCacheName: string | null;
  googleCachedMessageCount: number;
  vertexCachedMessageCount: number;
}

export function getGeminiCacheSnapshot(): GeminiCacheSnapshot {
  return {
    version: geminiCacheState.version,
    googleCacheName: geminiCacheState.googleCacheName,
    vertexCacheName: geminiCacheState.vertexCacheName,
    googleCachedMessageCount: geminiCacheState.googleCachedMessageCount,
    vertexCachedMessageCount: geminiCacheState.vertexCachedMessageCount,
  };
}

export function restoreGeminiCacheSnapshot(snapshot: GeminiCacheSnapshot): void {
  geminiCacheState.version = snapshot.version;
  geminiCacheState.googleCacheName = snapshot.googleCacheName;
  geminiCacheState.vertexCacheName = snapshot.vertexCacheName;
  geminiCacheState.googleCachedMessageCount = snapshot.googleCachedMessageCount;
  geminiCacheState.vertexCachedMessageCount = snapshot.vertexCachedMessageCount;
}

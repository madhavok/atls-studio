/**
 * Session-scoped context partitions for grid agent windows.
 * Swaps the singleton contextStore + HPP state per dbSessionId on focus and concurrent runs.
 */

import { useContextStore } from '../stores/contextStore';
import { chatDb, type PersistedMemorySnapshot } from './chatDb';
import { getGeminiCacheSnapshot } from './geminiCache';
import { exportHppSnapshot, importHppSnapshot, type HppSnapshot } from './hashProtocol';
import { exportManifestSnapshot, importManifestSnapshot, type ManifestSnapshot } from './hashManifest';
import { applyMemorySnapshotToStore } from './memorySnapshotApply';
import { serializeMemorySnapshot } from '../hooks/useChatPersistence';

export interface ActivateContextSessionOptions {
  /** Reset to empty seeded session (new parent card). */
  fresh?: boolean;
  /** Load from chatDb when not in hot cache. Default true. */
  loadFromDb?: boolean;
  /** Skip hash-first freshness on restore (hot swap during concurrent runs). */
  lite?: boolean;
}

let activeContextSessionId: string | null = null;
const partitionCache = new Map<string, PersistedMemorySnapshot>();

interface SessionAuxPartition {
  hpp: HppSnapshot;
  manifest: ManifestSnapshot;
}

const auxPartitionCache = new Map<string, SessionAuxPartition>();
let contextOpChain: Promise<void> = Promise.resolve();
let contextLockDepth = 0;

export function getActiveContextSessionId(): string | null {
  return activeContextSessionId;
}

export function isContextSessionLocked(): boolean {
  return contextLockDepth > 0;
}

async function serializedContextOp<T>(fn: () => Promise<T>): Promise<T> {
  const prior = contextOpChain;
  let release!: () => void;
  contextOpChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
}

function captureActivePartition(): void {
  if (!activeContextSessionId) return;
  partitionCache.set(
    activeContextSessionId,
    serializeMemorySnapshot(useContextStore.getState(), getGeminiCacheSnapshot()),
  );
  captureActiveAuxPartition();
}

function captureActiveAuxPartition(): void {
  if (!activeContextSessionId) return;
  auxPartitionCache.set(activeContextSessionId, {
    hpp: exportHppSnapshot(),
    manifest: exportManifestSnapshot(),
  });
}

function restoreAuxPartition(sessionId: string, options?: { fresh?: boolean }): void {
  if (options?.fresh) {
    importHppSnapshot(null);
    importManifestSnapshot(null);
    return;
  }
  const aux = auxPartitionCache.get(sessionId);
  importHppSnapshot(aux?.hpp);
  importManifestSnapshot(aux?.manifest);
}

export async function activateContextSession(
  sessionId: string,
  options?: ActivateContextSessionOptions,
): Promise<void> {
  if (!sessionId) return;
  if (activeContextSessionId === sessionId && !options?.fresh) return;

  if (activeContextSessionId && activeContextSessionId !== sessionId) {
    captureActivePartition();
  }

  useContextStore.getState().resetSession();

  if (options?.fresh) {
    restoreAuxPartition(sessionId, { fresh: true });
    activeContextSessionId = sessionId;
    return;
  }

  const cached = partitionCache.get(sessionId);
  if (cached) {
    await applyMemorySnapshotToStore(cached, { lite: options?.lite });
    restoreAuxPartition(sessionId);
    activeContextSessionId = sessionId;
    return;
  }

  if (options?.loadFromDb !== false && chatDb.isInitialized()) {
    try {
      const fromDb = await chatDb.getMemorySnapshot(sessionId);
      if (fromDb && fromDb.version >= 2 && fromDb.version <= 8) {
        await applyMemorySnapshotToStore(fromDb, { lite: options?.lite });
        partitionCache.set(sessionId, fromDb);
        restoreAuxPartition(sessionId);
        activeContextSessionId = sessionId;
        return;
      }
    } catch (error) {
      console.warn('[contextSessionPartition] DB snapshot load failed:', error);
    }
  }

  restoreAuxPartition(sessionId, { fresh: true });
  activeContextSessionId = sessionId;
}

export async function persistContextSession(
  sessionId: string,
  options?: { toDb?: boolean; skipCache?: boolean },
): Promise<void> {
  if (!sessionId) return;
  if (activeContextSessionId !== sessionId) return;
  captureActiveAuxPartition();
  const snapshot = serializeMemorySnapshot(useContextStore.getState(), getGeminiCacheSnapshot());
  if (!options?.skipCache) {
    partitionCache.set(sessionId, snapshot);
  }
  if (options?.toDb !== false && chatDb.isInitialized()) {
    try {
      await chatDb.saveMemorySnapshot(sessionId, snapshot);
    } catch (error) {
      console.warn('[contextSessionPartition] DB snapshot save failed:', error);
    }
  }
}

export async function withContextSession<T>(
  sessionId: string,
  fn: () => Promise<T>,
  options?: ActivateContextSessionOptions,
): Promise<T> {
  const previousSessionId = activeContextSessionId;
  contextLockDepth++;
  try {
    return await serializedContextOp(async () => {
      await activateContextSession(sessionId, options);
      try {
        return await fn();
      } finally {
        await persistContextSession(sessionId, { toDb: true });
        if (previousSessionId && previousSessionId !== sessionId) {
          await activateContextSession(previousSessionId, { loadFromDb: false, lite: true });
        }
      }
    });
  } finally {
    contextLockDepth = Math.max(0, contextLockDepth - 1);
  }
}

/** Drop hot cache entry when a window/session is closed. */
export function evictContextPartition(sessionId: string): void {
  partitionCache.delete(sessionId);
  auxPartitionCache.delete(sessionId);
  if (activeContextSessionId === sessionId) {
    activeContextSessionId = null;
  }
}

/** Persist all hot cached memory snapshots (active session uses full persist path). */
export async function flushAllCachedContextPartitions(): Promise<void> {
  captureActivePartition();
  const sessionIds = new Set<string>([
    ...partitionCache.keys(),
    ...auxPartitionCache.keys(),
    ...(activeContextSessionId ? [activeContextSessionId] : []),
  ]);
  for (const sessionId of sessionIds) {
    if (sessionId === activeContextSessionId) {
      await persistContextSession(sessionId, { toDb: true });
      continue;
    }
    const snapshot = partitionCache.get(sessionId);
    if (snapshot && chatDb.isInitialized()) {
      try {
        // The snapshot only persists into the project DB that owns this session.
        // With per-repo pooled connections the active DB may belong to a different
        // repo, so skip (its own project's persist path saves it) rather than FK-fail.
        const owner = await chatDb.getSession(sessionId);
        if (!owner) continue;
        await chatDb.saveMemorySnapshot(sessionId, snapshot);
      } catch (error) {
        console.warn('[contextSessionPartition] flush cached snapshot failed:', error);
      }
    }
  }
}

/**
 * Shared memory snapshot hydration for main chat and grid context partitions.
 */

import { useContextStore, type BlackboardEntry, type StagedSnippet, parseBbKey } from '../stores/contextStore';
import { classifyStageSnippet, MAX_PERSISTENT_STAGE_ENTRY_TOKENS } from './promptMemory';
import { migrateLegacyFileView } from './fileViewStore';
import { restoreJournal } from './freshnessJournal';
import { restoreGeminiCacheSnapshot } from './geminiCache';
import type { PersistedMemorySnapshot } from './chatDb';
import { applyV4SessionExtras, applyHashFirstFreshness, rehydrateChunkDates } from '../hooks/useChatPersistence';

function rehydrateBbEntry(
  key: string,
  entry: Partial<BlackboardEntry> & { content: string; createdAt: Date | string; tokens: number },
): BlackboardEntry {
  return {
    ...entry as BlackboardEntry,
    createdAt: new Date(entry.createdAt),
    kind: entry.kind ?? parseBbKey(key).kind,
    state: entry.state ?? 'active',
    updatedAt: entry.updatedAt ?? Date.now(),
  };
}

function normalizePersistedSnippet(key: string, snippet: StagedSnippet): StagedSnippet | null {
  const lifecycle = classifyStageSnippet(key, snippet.tokens);
  if (key.startsWith('entry:') && snippet.tokens > MAX_PERSISTENT_STAGE_ENTRY_TOKENS && lifecycle.persistencePolicy === 'doNotPersist') {
    return null;
  }
  return {
    ...snippet,
    admissionClass: snippet.admissionClass ?? lifecycle.admissionClass,
    persistencePolicy: snippet.persistencePolicy ?? lifecycle.persistencePolicy,
    demotedFrom: snippet.demotedFrom ?? lifecycle.demotedFrom,
    evictionReason: snippet.evictionReason,
    lastUsedAt: snippet.lastUsedAt ?? 0,
    lastUsedRound: snippet.lastUsedRound ?? 0,
  };
}

function normalizePersistedStagedEntries(
  stagedEntries: Array<[string, StagedSnippet]>,
): Array<[string, StagedSnippet]> {
  const normalized: Array<[string, StagedSnippet]> = [];
  for (const [key, snippet] of stagedEntries) {
    const next = normalizePersistedSnippet(key, snippet);
    if (next) normalized.push([key, next]);
  }
  return normalized;
}

export interface ApplyMemorySnapshotOptions {
  /** Skip hash-first freshness + reconcile (used for hot partition swaps during concurrent runs). */
  lite?: boolean;
}

export async function applyMemorySnapshotToStore(
  snapshot: PersistedMemorySnapshot,
  options?: ApplyMemorySnapshotOptions,
): Promise<void> {
  if (snapshot.version < 2 || snapshot.version > 8) return;

  const normalizedStagedSnippets = normalizePersistedStagedEntries(snapshot.stagedSnippets);
  useContextStore.setState({
    chunks: new Map(rehydrateChunkDates(snapshot.chunks).map((chunk) => [chunk.hash, chunk])),
    archivedChunks: new Map(rehydrateChunkDates(snapshot.archivedChunks).map((chunk) => [chunk.hash, chunk])),
    droppedManifest: new Map(snapshot.droppedManifest),
    stagedSnippets: new Map(normalizedStagedSnippets),
    blackboardEntries: new Map(snapshot.blackboardEntries.map(([key, entry]) => [key, rehydrateBbEntry(key, entry)])),
    cognitiveRules: new Map(snapshot.cognitiveRules.map(([key, rule]) => [key, { ...rule, createdAt: new Date(rule.createdAt) }])),
    taskPlan: snapshot.taskPlan,
    task: snapshot.taskPlan,
    freedTokens: snapshot.freedTokens,
    stageVersion: snapshot.stageVersion,
    transitionBridge: snapshot.transitionBridge,
    batchMetrics: {
      ...snapshot.batchMetrics,
      hadReads: snapshot.batchMetrics?.hadReads ?? false,
      hadBbWrite: snapshot.batchMetrics?.hadBbWrite ?? false,
      hadSubstantiveBbWrite: (snapshot.batchMetrics as Record<string, unknown>)?.hadSubstantiveBbWrite as boolean ?? false,
    },
    hashStack: snapshot.hashStack,
    editHashStack: snapshot.editHashStack,
    readHashStack: snapshot.readHashStack,
    stageHashStack: snapshot.stageHashStack,
    memoryEvents: snapshot.memoryEvents ?? [],
    reconcileStats: snapshot.reconcileStats ?? null,
    verifyArtifacts: new Map(snapshot.verifyArtifacts ?? []),
    awarenessCache: new Map(snapshot.awarenessCache ?? []),
    cumulativeCoveragePaths: new Set(snapshot.cumulativeCoveragePaths ?? []),
    fileReadSpinByPath: snapshot.fileReadSpinByPath ?? {},
    fileReadSpinRanges: snapshot.fileReadSpinRanges ?? {},
    fileViews: new Map((snapshot.fileViews ?? []).map(
      ([k, v]) => [k, migrateLegacyFileView(v)] as [string, typeof v],
    )),
  });

  if (snapshot.freshnessJournal?.length) {
    restoreJournal(snapshot.freshnessJournal);
  }

  if (!options?.lite) {
    const freshnessResult = await applyHashFirstFreshness();
    if (freshnessResult.changedPaths.length > 0) {
      const ctxStore = useContextStore.getState();
      ctxStore.invalidateArtifactsForPaths(freshnessResult.changedPaths);
      ctxStore.invalidateAwarenessForPaths(freshnessResult.changedPaths);
    }
    if (snapshot.geminiCache) restoreGeminiCacheSnapshot(snapshot.geminiCache);
    applyV4SessionExtras(snapshot);
    try {
      const stats = await useContextStore.getState().reconcileRestoredSession();
      if (stats.updated + stats.invalidated + stats.evicted > 0) {
        console.log('[memorySnapshotApply] reconciliation:', stats);
      }
    } catch (error) {
      console.warn('[memorySnapshotApply] reconciliation failed:', error);
    }
  }
}

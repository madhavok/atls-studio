/**
 * Retention Store — session-scoped latest+1 index for tool result deduplication.
 *
 * Tracks equivalent tool reruns by fingerprint. For each fingerprint:
 * - Keeps the latest chunk hash (full content in working memory)
 * - Keeps the previous chunk hash when the outcome differs (for diff context)
 * - Collapses older same-outcome runs into metadata (occurrence count + transition log)
 *
 * Safety invariant: never collapse across outcome boundaries. If ok/classification
 * changed between runs, both results are retained in full.
 */

import { create } from 'zustand';

export interface RetentionEntry {
  fingerprint: string;
  latestHash: string;
  latestOutcome: boolean;
  latestClassification?: string;
  previousHash?: string;
  previousOutcome?: boolean;
  occurrenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  transitions: string[];
}

export type RetentionAction =
  | { action: 'keep'; reason: 'new_fingerprint' }
  | { action: 'keep'; reason: 'outcome_changed'; previousHash: string }
  | { action: 'collapse'; reason: 'same_outcome'; latestHash: string; occurrenceCount: number };

const MAX_TRANSITIONS = 10;

export interface RetentionState {
  entries: Map<string, RetentionEntry>;
  readsReused: number;
  resultsCollapsed: number;
  transitionsRecorded: number;

  recordResult: (fingerprint: string, chunkHash: string, ok: boolean, classification?: string) => RetentionAction;
  incrementReadsReused: () => void;
  getEntry: (fingerprint: string) => RetentionEntry | null;
  getMetrics: () => { readsReused: number; resultsCollapsed: number; transitionsRecorded: number };
  evictByPrefix: (prefix: string) => number;
  evictMutationSensitive: () => number;
  reset: () => void;
}

function outcomeKey(ok: boolean, classification?: string): string {
  return classification ? `${ok}:${classification}` : String(ok);
}

export const useRetentionStore = create<RetentionState>()((set, get) => ({
  entries: new Map(),
  readsReused: 0,
  resultsCollapsed: 0,
  transitionsRecorded: 0,

  recordResult: (fingerprint: string, chunkHash: string, ok: boolean, classification?: string): RetentionAction => {
    const state = get();
    const existing = state.entries.get(fingerprint);
    const now = Date.now();

    if (!existing) {
      const entry: RetentionEntry = {
        fingerprint,
        latestHash: chunkHash,
        latestOutcome: ok,
        latestClassification: classification,
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        transitions: [],
      };
      set(s => {
        const ne = new Map(s.entries);
        ne.set(fingerprint, entry);
        return { entries: ne };
      });
      return { action: 'keep', reason: 'new_fingerprint' };
    }

    const prevKey = outcomeKey(existing.latestOutcome, existing.latestClassification);
    const newKey = outcomeKey(ok, classification);
    const outcomeChanged = prevKey !== newKey;

    if (outcomeChanged) {
      const transition = `${prevKey}->${newKey}`;
      const transitions = [...existing.transitions, transition].slice(-MAX_TRANSITIONS);
      const oldPreviousHash = existing.previousHash;
      const entry: RetentionEntry = {
        ...existing,
        previousHash: existing.latestHash,
        previousOutcome: existing.latestOutcome,
        latestHash: chunkHash,
        latestOutcome: ok,
        latestClassification: classification,
        occurrenceCount: existing.occurrenceCount + 1,
        lastSeenAt: now,
        transitions,
      };
      set(s => {
        const ne = new Map(s.entries);
        ne.set(fingerprint, entry);
        return { entries: ne, transitionsRecorded: s.transitionsRecorded + 1 };
      });
      return { action: 'keep', reason: 'outcome_changed', previousHash: existing.latestHash, _compactHash: oldPreviousHash } as RetentionAction & { _compactHash?: string };
    }

    // Same outcome — collapse
    const entry: RetentionEntry = {
      ...existing,
      latestHash: chunkHash,
      occurrenceCount: existing.occurrenceCount + 1,
      lastSeenAt: now,
    };
    set(s => {
      const ne = new Map(s.entries);
      ne.set(fingerprint, entry);
      return { entries: ne, resultsCollapsed: s.resultsCollapsed + 1 };
    });
    return { action: 'collapse', reason: 'same_outcome', latestHash: existing.latestHash, occurrenceCount: entry.occurrenceCount };
  },

  incrementReadsReused: () => set(s => ({ readsReused: s.readsReused + 1 })),

  getEntry: (fingerprint: string): RetentionEntry | null => {
    return get().entries.get(fingerprint) ?? null;
  },

  getMetrics: () => {
    const s = get();
    return { readsReused: s.readsReused, resultsCollapsed: s.resultsCollapsed, transitionsRecorded: s.transitionsRecorded };
  },

  evictByPrefix: (prefix: string): number => {
    const state = get();
    const toDelete: string[] = [];
    for (const key of state.entries.keys()) {
      if (key.startsWith(prefix)) toDelete.push(key);
    }
    if (toDelete.length === 0) return 0;
    set(s => {
      const ne = new Map(s.entries);
      for (const key of toDelete) ne.delete(key);
      return { entries: ne };
    });
    return toDelete.length;
  },

  evictMutationSensitive: (): number => {
    const PREFIXES = ['verify:', 'exec:', 'git:', 'search.issues', 'analyze:'];
    const state = get();
    const toDelete: string[] = [];
    for (const key of state.entries.keys()) {
      if (PREFIXES.some(p => key.startsWith(p))) toDelete.push(key);
    }
    if (toDelete.length === 0) return 0;
    set(s => {
      const ne = new Map(s.entries);
      for (const key of toDelete) ne.delete(key);
      return { entries: ne };
    });
    return toDelete.length;
  },

  reset: () => set({ entries: new Map(), readsReused: 0, resultsCollapsed: 0, transitionsRecorded: 0 }),
}));

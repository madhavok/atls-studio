/**
 * Chat Persistence Hook
 *
 * Bridges appStore with chatDb for per-project chat persistence.
 * Serialized snapshots (SQLite + localStorage helpers) use JSON — not TOON;
 * that is intentional storage format, separate from model-facing batch/history TOON.
 * Handles:
 * - Loading sessions when project opens
 * - Saving sessions to database
 * - Syncing context store with blackboard
 * - Full context state persistence (archived chunks, staged snippets, hash stacks, etc.)
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAppStore, type Message, type ChatSession } from '../stores/appStore';
import { useContextStore, type ContextChunk, type TaskPlan, type ManifestEntry, type TransitionBridge, type StagedSnippet, type BlackboardEntry, parseBbKey } from '../stores/contextStore';
import { useCostStore, type SubAgentUsage, type AIProvider } from '../stores/costStore';
import { chatDb, type PersistedMemorySnapshot, type PersistedSubAgentUsageRow } from '../services/chatDb';
import { useRoundHistoryStore } from '../stores/roundHistoryStore';
import {
  readLastActiveSessionId,
  writeLastActiveSessionId,
  syncCurrentSessionIdToLocalStorage,
} from '../services/lastActiveSession';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getGeminiCacheSnapshot, restoreGeminiCacheSnapshot, type GeminiCacheSnapshot } from '../services/aiService';
import { classifyStageSnippet, MAX_PERSISTENT_STAGE_ENTRY_TOKENS } from '../services/promptMemory';
import { emptyRollingSummary } from '../services/historyDistiller';

// Reserved blackboard note keys for per-session context state
const RESERVED_NOTE_PREFIX = '__ctx_';
const NOTE_KEY_TASK_PLAN = '__ctx_task_plan__';
const NOTE_KEY_DROPPED_MANIFEST = '__ctx_dropped_manifest__';
const NOTE_KEY_FREED_TOKENS = '__ctx_freed_tokens__';

// Session state keys for the session_state table
const STATE_KEY_HASH_STACK = 'hash_stack';
const STATE_KEY_EDIT_HASH_STACK = 'edit_hash_stack';
const STATE_KEY_TRANSITION_BRIDGE = 'transition_bridge';
const STATE_KEY_BATCH_METRICS = 'batch_metrics';
const STATE_KEY_STAGE_VERSION = 'stage_version';
const STATE_KEY_GEMINI_CACHE = 'gemini_cache_state';

export function isReservedNoteKey(key: string): boolean {
  return key.startsWith(RESERVED_NOTE_PREFIX);
}

const LS_MIGRATION_KEY = '__atls_ls_migrated__';

function migrateLocalStorage(): void {
  try {
    if (localStorage.getItem(LS_MIGRATION_KEY)) return;
    const raw = localStorage.getItem('atls-context-store');
    if (raw) {
      localStorage.removeItem('atls-context-store');
      console.log('[ChatPersistence] Cleared legacy localStorage context store');
    }
    localStorage.setItem(LS_MIGRATION_KEY, '1');
  } catch {
    // localStorage may be unavailable in some environments
  }
}

/** Tauri `invoke` often rejects with a string or non-Error payload; surface it in UI. */
function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function subAgentUsagesToRows(usages: SubAgentUsage[]): PersistedSubAgentUsageRow[] {
  return usages.map((u) => ({
    invocationId: u.invocationId,
    type: u.type,
    provider: u.provider,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    costCents: u.costCents,
    rounds: u.rounds,
    toolCalls: u.toolCalls,
    pinTokens: u.pinTokens,
    timestamp: u.timestamp instanceof Date ? u.timestamp.toISOString() : String(u.timestamp),
  }));
}

function rehydrateSubAgentRows(rows: PersistedSubAgentUsageRow[] | undefined): SubAgentUsage[] {
  if (!rows?.length) return [];
  return rows.map((r) => ({
    ...r,
    provider: r.provider as AIProvider,
    timestamp: new Date(r.timestamp),
  }));
}

/** Apply v4+ fields (prompt/cache metrics, round history, chat cost, v5 rolling summary) after context snapshot. */
export function applyV4SessionExtras(snapshot: PersistedMemorySnapshot): void {
  if (snapshot.version !== 4 && snapshot.version !== 5 && snapshot.version !== 6) return;
  if (snapshot.promptMetrics) {
    const pm = snapshot.promptMetrics;
    useAppStore.setState({
      promptMetrics: {
        ...useAppStore.getState().promptMetrics,
        ...pm,
        rollingSavings: pm.rollingSavings ?? 0,
        rolledRounds: pm.rolledRounds ?? 0,
      },
    });
  }
  if (snapshot.cacheMetrics) {
    useAppStore.setState({ cacheMetrics: { ...useAppStore.getState().cacheMetrics, ...snapshot.cacheMetrics } });
  }
  useRoundHistoryStore.setState({ snapshots: snapshot.roundHistorySnapshots ?? [] });
  if (snapshot.costChat) {
    useCostStore.getState().restorePersistedChatTotals({
      chatCostCents: snapshot.costChat.chatCostCents,
      chatApiCalls: snapshot.costChat.chatApiCalls,
      chatSubAgentCostCents: snapshot.costChat.chatSubAgentCostCents ?? 0,
      subAgentUsages: rehydrateSubAgentRows(snapshot.costChat.subAgentUsages),
    });
  }
  if ((snapshot.version === 5 || snapshot.version === 6) && snapshot.rollingSummary) {
    const rs = snapshot.rollingSummary;
    useContextStore.getState().setRollingSummary({
      ...rs,
      findings: rs.findings ?? [],
    });
  } else {
    useContextStore.getState().setRollingSummary(emptyRollingSummary());
  }
}

export function serializeMemorySnapshot(
  ctxState: ReturnType<typeof useContextStore.getState>,
  geminiCache: GeminiCacheSnapshot,
): PersistedMemorySnapshot {
  const persistedStaged = Array.from(ctxState.stagedSnippets.entries())
    .filter(([, snippet]) => snippet.persistencePolicy !== 'doNotPersist')
    .map(([key, snippet]) => [key, normalizePersistedSnippet(key, snippet) ?? snippet] as [string, StagedSnippet]);
  const app = useAppStore.getState();
  const cost = useCostStore.getState();
  const rounds = useRoundHistoryStore.getState();
  return {
    version: 6,
    savedAt: new Date().toISOString(),
    chunks: Array.from(ctxState.chunks.values()),
    archivedChunks: Array.from(ctxState.archivedChunks.values()),
    droppedManifest: Array.from(ctxState.droppedManifest.entries()),
    stagedSnippets: persistedStaged,
    blackboardEntries: Array.from(ctxState.blackboardEntries.entries()),
    cognitiveRules: Array.from(ctxState.cognitiveRules.entries()),
    taskPlan: ctxState.taskPlan,
    freedTokens: ctxState.freedTokens,
    stageVersion: ctxState.stageVersion,
    transitionBridge: ctxState.transitionBridge,
    batchMetrics: ctxState.batchMetrics,
    hashStack: ctxState.hashStack,
    editHashStack: ctxState.editHashStack,
    readHashStack: ctxState.readHashStack,
    stageHashStack: ctxState.stageHashStack,
    memoryEvents: ctxState.memoryEvents,
    reconcileStats: ctxState.reconcileStats,
    geminiCache,
    promptMetrics: { ...app.promptMetrics },
    cacheMetrics: { ...app.cacheMetrics },
    roundHistorySnapshots: [...rounds.snapshots],
    costChat: {
      chatCostCents: cost.chatCostCents,
      chatApiCalls: cost.chatApiCalls,
      chatSubAgentCostCents: cost.chatSubAgentCostCents,
      subAgentUsages: subAgentUsagesToRows(cost.subAgentUsages),
    },
    rollingSummary: {
      decisions: [...ctxState.rollingSummary.decisions],
      filesChanged: [...ctxState.rollingSummary.filesChanged],
      userPreferences: [...ctxState.rollingSummary.userPreferences],
      workDone: [...ctxState.rollingSummary.workDone],
      findings: [...(ctxState.rollingSummary.findings ?? [])],
      errors: [...ctxState.rollingSummary.errors],
      currentGoal: ctxState.rollingSummary.currentGoal || '',
      nextSteps: [...(ctxState.rollingSummary.nextSteps ?? [])],
      blockers: [...(ctxState.rollingSummary.blockers ?? [])],
    },
    verifyArtifacts: Array.from(ctxState.verifyArtifacts.entries()),
    awarenessCache: Array.from(ctxState.awarenessCache.entries()),
    cumulativeCoveragePaths: Array.from(ctxState.cumulativeCoveragePaths),
    fileReadSpinByPath: { ...ctxState.fileReadSpinByPath },
    fileReadSpinRanges: Object.fromEntries(
      Object.entries(ctxState.fileReadSpinRanges).map(([k, v]) => [k, [...v]]),
    ),
  };
}

export function rehydrateChunkDates(chunks: ContextChunk[]): ContextChunk[] {
  return chunks.map((chunk) => ({
    ...chunk,
    createdAt: new Date(chunk.createdAt),
    lastAccessed: chunk.lastAccessed ?? (chunk.createdAt ? new Date(chunk.createdAt).getTime() : Date.now()),
  }));
}

function rehydrateBbEntry(key: string, entry: Partial<BlackboardEntry> & { content: string; createdAt: Date | string; tokens: number }): BlackboardEntry {
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

/**
 * Single save queue for the whole app. `useChatPersistence()` is mounted from
 * both App and AiChat, so per-hook refs would still allow overlapping saves.
 */
let saveSessionChain = Promise.resolve();

export function useChatPersistence() {
  const projectPath = useAppStore(state => state.projectPath);
  const messages = useAppStore(state => state.messages);
  const currentSessionId = useAppStore(state => state.currentSessionId);
  const contextUsage = useAppStore(state => state.contextUsage);

  const lastSaveRef = useRef<number>(0);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Avoid spamming identical save-failure toasts while auto-save retries. */
  const lastSaveErrorToastAtRef = useRef<number>(0);
  // Track the session ID across debounced saves to avoid re-creating on each invocation
  const pendingSessionIdRef = useRef<string | null>(null);
  /** Always points at latest saveSession (avoids stale closures in timeouts / effect cleanups). */
  const saveSessionRef = useRef<() => Promise<void>>(async () => {});

  /**
   * Initialize chat database when project opens.
   * Also performs one-time migration of localStorage data to DB.
   */
  const initChatDb = useCallback(async (path: string) => {
    try {
      const success = await chatDb.init(path);
      if (success) {
        console.log('[ChatPersistence] Database initialized for:', path);
        migrateLocalStorage();
      }
      return success;
    } catch (error) {
      console.error('[ChatPersistence] Failed to initialize:', error);
      return false;
    }
  }, []);

  /**
   * Load sessions from database and sync to appStore
   */
  const loadSessions = useCallback(async (): Promise<ChatSession[]> => {
    if (!chatDb.isInitialized()) return [];
    
    try {
      const dbSessions = await chatDb.getSessions(200);
      
      // Convert to ChatSession format (lightweight - no messages loaded)
      const sessions: ChatSession[] = dbSessions.map((dbSession) => ({
        id: dbSession.id,
        title: dbSession.title,
        messages: [], // Don't load messages for list - load on demand
        createdAt: new Date(dbSession.created_at),
        updatedAt: new Date(dbSession.updated_at),
        contextUsage: dbSession.context_usage ? {
          inputTokens: dbSession.context_usage.input_tokens,
          outputTokens: dbSession.context_usage.output_tokens,
          totalTokens: dbSession.context_usage.total_tokens,
          costCents: dbSession.context_usage.cost_cents ?? 0,
        } : undefined,
      }));
      
      // Sync to appStore
      useAppStore.setState({ chatSessions: sessions });
      
      console.log('[ChatPersistence] Loaded', sessions.length, 'sessions from database');
      return sessions;
    } catch (error) {
      console.error('[ChatPersistence] Failed to load sessions:', error);
      return [];
    }
  }, []);

  /**
   * Save current session to database.
   * Always reads latest state via getState() so timers/refs never persist stale messages or context.
   */
  const saveSession = useCallback(async () => {
    if (!chatDb.isInitialized()) return;

    // Debounce saves (wall clock only; payload is read after the gate)
    const now = Date.now();
    if (now - lastSaveRef.current < 2000) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => {
        void saveSessionRef.current();
      }, 2000);
      return;
    }
    lastSaveRef.current = now;

    const app = useAppStore.getState();
    const messages = app.messages;
    if (messages.length === 0) return;

    const performSaveSession = async () => {
      const appInner = useAppStore.getState();
      const messagesInner = appInner.messages;
      if (messagesInner.length === 0) return;

      const contextUsageInner = appInner.contextUsage;
      try {
        let sessionId = appInner.currentSessionId || pendingSessionIdRef.current;

        // Create session if new (or verify it exists)
        if (!sessionId) {
          sessionId = crypto.randomUUID();
          pendingSessionIdRef.current = sessionId;
          const title = messagesInner.find(m => m.role === 'user')?.content.slice(0, 50) || 'New Chat';
          await chatDb.createSession('agent', title, sessionId);
        } else {
          const existingSession = await chatDb.getSession(sessionId);
          if (!existingSession) {
            const title = messagesInner.find(m => m.role === 'user')?.content.slice(0, 50) || 'New Chat';
            await chatDb.createSession('agent', title, sessionId);
          }
        }

        const blackboard = Array.from(useContextStore.getState().chunks.values());

        const chatCostCents = useCostStore.getState().chatCostCents;
        await chatDb.saveFullSession(
          sessionId,
          messagesInner,
          blackboard,
          {
            inputTokens: contextUsageInner.inputTokens,
            outputTokens: contextUsageInner.outputTokens,
            costCents: chatCostCents,
          }
        );

        const ctxState = useContextStore.getState();
        const geminiSnapshot = getGeminiCacheSnapshot();
        const snapshot = serializeMemorySnapshot(ctxState, geminiSnapshot);
        await chatDb.saveMemorySnapshot(sessionId, snapshot);

        const title = messagesInner.find(m => m.role === 'user')?.content.slice(0, 50) || 'New Chat';
        const currentSessions = useAppStore.getState().chatSessions;
        const existingIndex = currentSessions.findIndex(s => s.id === sessionId);

        const updatedSession = {
          id: sessionId,
          title,
          messages: [],
          createdAt: existingIndex >= 0 ? currentSessions[existingIndex].createdAt : new Date(),
          updatedAt: new Date(),
          contextUsage: {
            inputTokens: contextUsageInner.inputTokens,
            outputTokens: contextUsageInner.outputTokens,
            totalTokens: contextUsageInner.inputTokens + contextUsageInner.outputTokens,
            costCents: useCostStore.getState().chatCostCents,
          },
        };

        let newSessions;
        if (existingIndex >= 0) {
          newSessions = [...currentSessions];
          newSessions[existingIndex] = updatedSession;
        } else {
          newSessions = [updatedSession, ...currentSessions];
        }

        useAppStore.setState({
          chatSessions: newSessions,
          currentSessionId: sessionId,
        });
        pendingSessionIdRef.current = null;
        const pp = useAppStore.getState().projectPath;
        if (pp) {
          writeLastActiveSessionId(pp, sessionId);
          syncCurrentSessionIdToLocalStorage(sessionId);
        }
        console.log('[ChatPersistence] Session saved:', sessionId);
        lastSaveErrorToastAtRef.current = 0;
      } catch (error) {
        console.error('[ChatPersistence] Failed to save session:', error);
        const detail = describeUnknownError(error);
        const nowToast = Date.now();
        const cooldownMs = 90_000;
        if (nowToast - lastSaveErrorToastAtRef.current < cooldownMs) {
          return;
        }
        lastSaveErrorToastAtRef.current = nowToast;
        try {
          useAppStore.getState().addToast({
            type: 'error',
            message: `Chat save failed: ${detail}. Your latest messages may not persist across restart.`,
            duration: 8000,
          });
        } catch { /* toast system may not be available */ }
      }
    };

    saveSessionChain = saveSessionChain
      .catch(() => undefined)
      .then(() => performSaveSession());
    await saveSessionChain;
  }, []);

  saveSessionRef.current = saveSession;

  /**
   * Cancel any pending debounce timer and immediately execute a save.
   * Bypasses the debounce gate so the most recent state is always flushed.
   */
  const flushPendingSave = useCallback(async () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    lastSaveRef.current = 0;
    await saveSessionRef.current();
  }, []);

  /**
   * Load a specific session with its blackboard and restore to stores
   */
  const loadSession = useCallback(async (sessionId: string): Promise<boolean> => {
    if (!chatDb.isInitialized()) return false;

    // Flush any pending debounced save before switching sessions
    const outgoing = useAppStore.getState();
    if (outgoing.currentSessionId && outgoing.currentSessionId !== sessionId && outgoing.messages.length > 0) {
      try { await flushPendingSave(); } catch { /* best effort */ }
    }
    
    try {
      const result = await chatDb.loadFullSession(sessionId);
      if (!result) return false;

      // Per-session cost/subagent breakdown must not leak from the previous session.
      useCostStore.getState().resetChat();

      // Restore messages; prompt/cache/cost filled from snapshot v4 or DB below
      useAppStore.setState({
        currentSessionId: sessionId,
        messages: result.messages,
        contextUsage: result.session.context_usage ? {
          inputTokens: result.session.context_usage.input_tokens,
          outputTokens: result.session.context_usage.output_tokens,
          totalTokens: result.session.context_usage.total_tokens,
          maxTokens: contextUsage.maxTokens,
          percentage: Math.min(100, (result.session.context_usage.total_tokens / contextUsage.maxTokens) * 100),
          costCents: result.session.context_usage.cost_cents,
        } : {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          maxTokens: contextUsage.maxTokens,
          percentage: 0,
        },
        promptMetrics: {
          modePromptTokens: 0, toolRefTokens: 0, shellGuideTokens: 0,
          nativeToolTokens: 0, primerTokens: 0, contextControlTokens: 0,
          workspaceContextTokens: 0, entryManifestTokens: 0,
          totalOverheadTokens: 0, compressionSavings: 0,
          compressionCount: 0, rollingSavings: 0, rolledRounds: 0, roundCount: 0, cumulativeInputSaved: 0,
          orphanSummaryRemovals: 0,
        },
        cacheMetrics: {
          sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
          sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
          lastRequestCachedTokens: undefined,
        },
      });
      
      // Restore blackboard/context chunks to contextStore
      const contextStore = useContextStore.getState();
      contextStore.resetSession(); // Clear existing chunks

      let restoredFromSnapshot = false;
      let memorySnapshot: PersistedMemorySnapshot | null = null;
      try {
        memorySnapshot = await chatDb.getMemorySnapshot(sessionId);
        if (memorySnapshot && memorySnapshot.version >= 2 && memorySnapshot.version <= 6) {
          const normalizedStagedSnippets = normalizePersistedStagedEntries(memorySnapshot.stagedSnippets);
          useContextStore.setState({
            chunks: new Map(rehydrateChunkDates(memorySnapshot.chunks).map(chunk => [chunk.hash, chunk])),
            archivedChunks: new Map(rehydrateChunkDates(memorySnapshot.archivedChunks).map(chunk => [chunk.hash, chunk])),
            droppedManifest: new Map(memorySnapshot.droppedManifest),
            stagedSnippets: new Map(normalizedStagedSnippets),
            blackboardEntries: new Map(memorySnapshot.blackboardEntries.map(([key, entry]) => [key, rehydrateBbEntry(key, entry)])),
            cognitiveRules: new Map(memorySnapshot.cognitiveRules.map(([key, rule]) => [key, { ...rule, createdAt: new Date(rule.createdAt) }])),
            taskPlan: memorySnapshot.taskPlan,
            task: memorySnapshot.taskPlan,
            freedTokens: memorySnapshot.freedTokens,
            stageVersion: memorySnapshot.stageVersion,
            transitionBridge: memorySnapshot.transitionBridge,
            batchMetrics: { ...memorySnapshot.batchMetrics, hadReads: memorySnapshot.batchMetrics?.hadReads ?? false, hadBbWrite: memorySnapshot.batchMetrics?.hadBbWrite ?? false, hadSubstantiveBbWrite: (memorySnapshot.batchMetrics as Record<string, unknown>)?.hadSubstantiveBbWrite as boolean ?? false },
            hashStack: memorySnapshot.hashStack,
            editHashStack: memorySnapshot.editHashStack,
            readHashStack: memorySnapshot.readHashStack,
            stageHashStack: memorySnapshot.stageHashStack,
            memoryEvents: memorySnapshot.memoryEvents ?? [],
            reconcileStats: memorySnapshot.reconcileStats ?? null,
            ...(memorySnapshot.version >= 6 ? {
              verifyArtifacts: new Map(memorySnapshot.verifyArtifacts ?? []),
              awarenessCache: new Map(memorySnapshot.awarenessCache ?? []),
              cumulativeCoveragePaths: new Set(memorySnapshot.cumulativeCoveragePaths ?? []),
              fileReadSpinByPath: memorySnapshot.fileReadSpinByPath ?? {},
              fileReadSpinRanges: memorySnapshot.fileReadSpinRanges ?? {},
            } : {}),
          });
          useContextStore.setState(state => {
            const now = Date.now();
            const chunks = new Map(state.chunks);
            for (const [hash, chunk] of chunks) {
              chunks.set(hash, { ...chunk, freshness: 'suspect', freshnessCause: 'session_restore', suspectSince: now });
            }
            const stagedSnippets = new Map(state.stagedSnippets);
            for (const [key, snippet] of stagedSnippets) {
              stagedSnippets.set(key, { ...snippet, stageState: 'stale', suspectSince: now });
            }
            return { chunks, stagedSnippets };
          });
          if (memorySnapshot.geminiCache) restoreGeminiCacheSnapshot(memorySnapshot.geminiCache);
          restoredFromSnapshot = true;
          console.log('[ChatPersistence] Restored memory snapshot v' + memorySnapshot.version + ' (chunks/staged marked suspect)');
        }
      } catch (e) {
        console.warn('[ChatPersistence] Failed to restore memory snapshot:', e);
        contextStore.setBlackboardEntry('persistence:restore_error', 'Memory snapshot restore failed; falling back to legacy partial restore.');
      }

      const dbCostCents = result.session.context_usage?.cost_cents ?? 0;
      if (memorySnapshot && memorySnapshot.version >= 4) {
        applyV4SessionExtras(memorySnapshot);
        if (!memorySnapshot.costChat) {
          useCostStore.getState().restorePersistedChatTotals({ chatCostCents: dbCostCents });
        }
      } else {
        useCostStore.getState().restorePersistedChatTotals({ chatCostCents: dbCostCents });
      }

      if (!restoredFromSnapshot) {
        for (const chunk of result.blackboard) {
          useContextStore.setState(state => {
            const newChunks = new Map(state.chunks);
            newChunks.set(chunk.hash, chunk);
            return { chunks: newChunks };
          });
        }

        try {
          const notes = await chatDb.getBlackboardNotes(sessionId);
          let userNoteCount = 0;

          for (const note of notes) {
            if (note.key === NOTE_KEY_TASK_PLAN) {
              try {
                const plan = JSON.parse(note.content) as TaskPlan;
                contextStore.setTaskPlan(plan);
              } catch { /* malformed — skip */ }
            } else if (note.key === NOTE_KEY_DROPPED_MANIFEST) {
              try {
                const entries = JSON.parse(note.content) as Array<[string, ManifestEntry]>;
                useContextStore.setState({ droppedManifest: new Map(entries) });
              } catch { /* malformed — skip */ }
            } else if (note.key === NOTE_KEY_FREED_TOKENS) {
              const val = parseInt(note.content, 10);
              if (!isNaN(val)) useContextStore.setState({ freedTokens: val });
            } else {
              contextStore.setBlackboardEntry(note.key, note.content, {
                filePath: note.file_path ?? undefined,
              });
              if (note.state && note.state !== 'active') {
                useContextStore.setState(state => {
                  const entry = state.blackboardEntries.get(note.key);
                  if (!entry) return {};
                  const newBb = new Map(state.blackboardEntries);
                  newBb.set(note.key, { ...entry, state: note.state as BlackboardEntry['state'] });
                  return { blackboardEntries: newBb };
                });
              }
              userNoteCount++;
            }
          }

          if (notes.length > 0) {
            console.log('[ChatPersistence] Restored', userNoteCount, 'blackboard notes +',
              notes.length - userNoteCount, 'context metadata keys');
          }
        } catch (e) {
          console.warn('[ChatPersistence] Failed to restore blackboard notes:', e);
        }

        try {
          const archivedChunks = await chatDb.getArchivedChunks(sessionId);
          if (archivedChunks.length > 0) {
            const archivedMap = new Map<string, ContextChunk>();
            for (const chunk of archivedChunks) {
              archivedMap.set(chunk.hash, chunk);
            }
            useContextStore.setState({ archivedChunks: archivedMap });
            console.log('[ChatPersistence] Restored', archivedChunks.length, 'archived chunks');
          }
        } catch (e) {
          console.warn('[ChatPersistence] Failed to restore archived chunks:', e);
        }

        try {
          const rawSnippets = await chatDb.getStagedSnippets(sessionId);
          if (rawSnippets.size > 0) {
            const snippetMap = new Map<string, StagedSnippet>();
            for (const [key, data] of rawSnippets) {
              const normalized = normalizePersistedSnippet(key, {
                content: data.content,
                source: data.source ?? '',
                lines: data.lines,
                tokens: data.tokens,
                sourceRevision: data.sourceRevision,
                shapeSpec: data.shapeSpec,
                viewKind: data.viewKind,
              });
              if (normalized) snippetMap.set(key, normalized);
            }
            useContextStore.setState({ stagedSnippets: snippetMap });
            console.log('[ChatPersistence] Restored', rawSnippets.size, 'staged snippets');
          }
        } catch (e) {
          console.warn('[ChatPersistence] Failed to restore staged snippets:', e);
        }

        try {
          const sessionState = await chatDb.getAllSessionState(sessionId);

          if (sessionState[STATE_KEY_HASH_STACK]) {
            try {
              const stack = JSON.parse(sessionState[STATE_KEY_HASH_STACK]) as string[];
              useContextStore.setState({ hashStack: stack });
            } catch { /* malformed */ }
          }

          if (sessionState[STATE_KEY_EDIT_HASH_STACK]) {
            try {
              const stack = JSON.parse(sessionState[STATE_KEY_EDIT_HASH_STACK]) as string[];
              useContextStore.setState({ editHashStack: stack });
            } catch { /* malformed */ }
          }

          if (sessionState[STATE_KEY_TRANSITION_BRIDGE]) {
            try {
              const bridge = JSON.parse(sessionState[STATE_KEY_TRANSITION_BRIDGE]) as TransitionBridge;
              useContextStore.setState({ transitionBridge: bridge });
            } catch { /* malformed */ }
          }

          if (sessionState[STATE_KEY_BATCH_METRICS]) {
            try {
              const metrics = JSON.parse(sessionState[STATE_KEY_BATCH_METRICS]) as { toolCalls: number; manageOps: number; hadReads?: boolean; hadBbWrite?: boolean; hadSubstantiveBbWrite?: boolean };
              useContextStore.setState({ batchMetrics: { ...metrics, hadReads: metrics.hadReads ?? false, hadBbWrite: metrics.hadBbWrite ?? false, hadSubstantiveBbWrite: metrics.hadSubstantiveBbWrite ?? false } });
            } catch { /* malformed */ }
          }

          if (sessionState[STATE_KEY_STAGE_VERSION]) {
            const val = parseInt(sessionState[STATE_KEY_STAGE_VERSION], 10);
            if (!isNaN(val)) useContextStore.setState({ stageVersion: val });
          }

          if (sessionState[STATE_KEY_GEMINI_CACHE]) {
            try {
              const snapshot = JSON.parse(sessionState[STATE_KEY_GEMINI_CACHE]) as GeminiCacheSnapshot;
              restoreGeminiCacheSnapshot(snapshot);
              console.log('[ChatPersistence] Restored Gemini cache state');
            } catch { /* malformed */ }
          }
        } catch (e) {
          console.warn('[ChatPersistence] Failed to restore session state:', e);
        }
      }
      
      const pp = useAppStore.getState().projectPath;
      if (pp) writeLastActiveSessionId(pp, sessionId);
      syncCurrentSessionIdToLocalStorage(sessionId);

      if (restoredFromSnapshot) {
        useContextStore.getState().reconcileRestoredSession().then(stats => {
          if (stats.updated + stats.invalidated + stats.evicted > 0) {
            console.log('[ChatPersistence] Post-restore reconciliation:', stats);
          }
        }).catch(e => console.warn('[ChatPersistence] Post-restore reconciliation failed:', e));
      }

      console.log('[ChatPersistence] Session loaded:', sessionId, 
        `${result.messages.length} messages, ${result.blackboard.length} context chunks`);
      return true;
    } catch (error) {
      console.error('[ChatPersistence] Failed to load session:', error);
      return false;
    }
  }, [contextUsage.maxTokens]);

  const loadSessionRef = useRef(loadSession);
  loadSessionRef.current = loadSession;

  /**
   * Create a new session
   */
  const createNewSession = useCallback(async (): Promise<string | null> => {
    if (!chatDb.isInitialized()) return null;
    
    try {
      // Flush any pending debounced save before creating a new session
      if (messages.length > 0) {
        await flushPendingSave();
      }
      
      // Create new session
      const sessionId = await chatDb.createSession('agent', 'New Chat');
      
      // Add to sessions list
      const currentSessions = useAppStore.getState().chatSessions;
      const newSession = {
        id: sessionId,
        title: 'New Chat',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      
      // Clear app state and add new session to list
      useAppStore.setState({
        chatSessions: [newSession, ...currentSessions],
        currentSessionId: sessionId,
        messages: [],
        contextUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          maxTokens: contextUsage.maxTokens,
          percentage: 0,
        },
        promptMetrics: {
          modePromptTokens: 0, toolRefTokens: 0, shellGuideTokens: 0,
          nativeToolTokens: 0, primerTokens: 0, contextControlTokens: 0,
          workspaceContextTokens: 0,
          totalOverheadTokens: 0, compressionSavings: 0,
          compressionCount: 0, rollingSavings: 0, rolledRounds: 0, roundCount: 0, cumulativeInputSaved: 0,
          orphanSummaryRemovals: 0,
        },
        cacheMetrics: {
          sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
          sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
        },
      });
      
      // Clear context store (includes blackboard entries)
      useContextStore.getState().resetSession();
      useCostStore.getState().resetChat();

      const pp = useAppStore.getState().projectPath;
      if (pp) {
        writeLastActiveSessionId(pp, sessionId);
        syncCurrentSessionIdToLocalStorage(sessionId);
      }

      console.log('[ChatPersistence] New session created:', sessionId);
      return sessionId;
    } catch (error) {
      console.error('[ChatPersistence] Failed to create session:', error);
      return null;
    }
  }, [messages, contextUsage.maxTokens]);

  /**
   * Delete a session
   */
  const deleteSession = useCallback(async (sessionId: string) => {
    if (!chatDb.isInitialized()) return;
    
    try {
      await chatDb.deleteSession(sessionId);
      
      // Remove from local sessions list
      const currentSessions = useAppStore.getState().chatSessions;
      useAppStore.setState({
        chatSessions: currentSessions.filter(s => s.id !== sessionId),
      });
      
      // If deleting current session, clear state and metrics
      if (currentSessionId === sessionId) {
        const pp = useAppStore.getState().projectPath;
        if (pp) writeLastActiveSessionId(pp, null);
        syncCurrentSessionIdToLocalStorage(null);
        useAppStore.setState({
          currentSessionId: null,
          messages: [],
          promptMetrics: {
            modePromptTokens: 0, toolRefTokens: 0, shellGuideTokens: 0,
            nativeToolTokens: 0, primerTokens: 0, contextControlTokens: 0,
            workspaceContextTokens: 0,
            totalOverheadTokens: 0, compressionSavings: 0,
            compressionCount: 0, rollingSavings: 0, rolledRounds: 0, roundCount: 0, cumulativeInputSaved: 0,
            orphanSummaryRemovals: 0,
          },
          cacheMetrics: {
            sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
            sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
          },
        });
        useContextStore.getState().resetSession();
        useCostStore.getState().resetChat();
      }
      
      console.log('[ChatPersistence] Session deleted:', sessionId);
    } catch (error) {
      console.error('[ChatPersistence] Failed to delete session:', error);
    }
  }, [currentSessionId]);

  /**
   * Sync blackboard entry to database
   */
  const syncBlackboardEntry = useCallback(async (chunk: ContextChunk) => {
    if (!chatDb.isInitialized() || !currentSessionId) return;
    
    try {
      await chatDb.addBlackboardEntry(currentSessionId, chunk);
    } catch (error) {
      console.error('[ChatPersistence] Failed to sync blackboard entry:', error);
    }
  }, [currentSessionId]);

  /**
   * Remove blackboard entries from database
   */
  const removeBlackboardEntries = useCallback(async (shortHashes: string[]) => {
    if (!chatDb.isInitialized() || !currentSessionId) return;
    
    try {
      await chatDb.removeBlackboardEntries(currentSessionId, shortHashes);
    } catch (error) {
      console.error('[ChatPersistence] Failed to remove blackboard entries:', error);
    }
  }, [currentSessionId]);

  // Track previous project path to detect switches
  const prevProjectPathRef = useRef<string | null>(null);

  // Initialize database when project changes and load sessions
  useEffect(() => {
    const prevPath = prevProjectPathRef.current;
    prevProjectPathRef.current = projectPath;

    if (projectPath) {
      // Project changed (not first mount) -- save current session, then reset
      const isSwitch = prevPath !== null && prevPath !== projectPath;

      const init = async () => {
        // Flush any pending debounced save before switching DB
        if (isSwitch && useAppStore.getState().messages.length > 0) {
          try {
            if (saveTimeoutRef.current) {
              clearTimeout(saveTimeoutRef.current);
              saveTimeoutRef.current = null;
            }
            lastSaveRef.current = 0;
            await saveSessionRef.current();
          } catch {
            /* best effort */
          }
        }

        const success = await initChatDb(projectPath);
        if (success) {
          // Clear current chat state so old messages/metrics don't persist across projects
          if (isSwitch) {
            useAppStore.setState({
              currentSessionId: null,
              messages: [],
              contextUsage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                maxTokens: contextUsage.maxTokens,
                percentage: 0,
              },
              promptMetrics: {
                modePromptTokens: 0, toolRefTokens: 0, shellGuideTokens: 0,
                nativeToolTokens: 0, primerTokens: 0, contextControlTokens: 0,
                workspaceContextTokens: 0,
                totalOverheadTokens: 0, compressionSavings: 0,
                compressionCount: 0, rollingSavings: 0, rolledRounds: 0, roundCount: 0, cumulativeInputSaved: 0,
                orphanSummaryRemovals: 0,
              },
              cacheMetrics: {
                sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
                sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
              },
            });
            useContextStore.getState().resetSession();
          }

          // Load sessions and auto-resume last active (or most recent)
          const sessions = await loadSessions();
          if (sessions.length > 0) {
            const st = useAppStore.getState();
            if (st.messages.length === 0 && !st.currentSessionId) {
              const lastId = readLastActiveSessionId(projectPath);
              const targetId = lastId && sessions.some(s => s.id === lastId) ? lastId : sessions[0].id;
              try {
                await loadSessionRef.current(targetId);
              } catch (e) {
                console.warn('[ChatPersistence] Auto-resume failed:', e);
              }
            }
          }
        }
      };
      void init();
    } else {
      const closeWithoutProject = async () => {
        if (chatDb.isInitialized() && useAppStore.getState().messages.length > 0) {
          try {
            if (saveTimeoutRef.current) {
              clearTimeout(saveTimeoutRef.current);
              saveTimeoutRef.current = null;
            }
            lastSaveRef.current = 0;
            await saveSessionRef.current();
          } catch {
            /* best effort */
          }
        }
        await chatDb.close();
        syncCurrentSessionIdToLocalStorage(null);
        useAppStore.setState({
          chatSessions: [],
          currentSessionId: null,
          messages: [],
        });
        useContextStore.getState().resetSession();
      };
      void closeWithoutProject();
    }

    // Do not save in cleanup: including messages.length in deps caused a save on every new message
    // with a stale closure (one message behind) and raced with project DB switches.
  }, [projectPath, initChatDb, loadSessions, contextUsage.maxTokens]);

  // Best-effort save on window close / refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!chatDb.isInitialized() || useAppStore.getState().messages.length === 0) return;
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      lastSaveRef.current = 0;
      void saveSessionRef.current();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Tauri: await final save before window closes (beforeunload cannot reliably flush async IO)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const run = async () => {
      try {
        const w = getCurrentWindow();
        let finishing = false;
        unlisten = await w.onCloseRequested(async (event) => {
          if (finishing) return;
          event.preventDefault();
          finishing = true;
          try {
            if (saveTimeoutRef.current) {
              clearTimeout(saveTimeoutRef.current);
              saveTimeoutRef.current = null;
            }
            lastSaveRef.current = 0;
            await saveSessionRef.current();
          } catch (err) {
            console.warn('[ChatPersistence] Final save on close failed:', err);
          } finally {
            unlisten?.();
            unlisten = undefined;
            if (!cancelled) await w.close();
          }
        });
      } catch {
        /* Web dev / non-Tauri */
      }
    };
    void run();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Auto-save on message changes (debounced)
  useEffect(() => {
    if (messages.length > 0 && chatDb.isInitialized()) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => {
        void saveSessionRef.current();
      }, 5000); // Auto-save every 5 seconds of inactivity
    }
    
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [messages]);

  // =========================================================================
  // Chat Restore Points (edit-and-resend)
  // =========================================================================

  const RESTORE_POINT_PREFIX = '__restore_point__';

  const saveRestorePoint = useCallback(async (sessionId: string, messageId: string) => {
    if (!chatDb.isInitialized()) return;
    try {
      const ctxState = useContextStore.getState();
      const geminiSnapshot = getGeminiCacheSnapshot();
      const snapshot = serializeMemorySnapshot(ctxState, geminiSnapshot);
      const key = RESTORE_POINT_PREFIX + messageId;
      await chatDb.setSessionState(sessionId, key, JSON.stringify(snapshot));
    } catch (e) {
      console.warn('[ChatPersistence] Failed to save restore point:', e);
      useAppStore.getState().addToast({
        type: 'error',
        message: 'Could not save restore point for edit-and-resend. If you edit a message, undo may be incomplete.',
        duration: 6000,
      });
    }
  }, []);

  const loadRestorePoint = useCallback(async (sessionId: string, messageId: string): Promise<PersistedMemorySnapshot | null> => {
    if (!chatDb.isInitialized()) return null;
    try {
      const key = RESTORE_POINT_PREFIX + messageId;
      const raw = await chatDb.getSessionState(sessionId, key);
      if (!raw) return null;
      return JSON.parse(raw) as PersistedMemorySnapshot;
    } catch (e) {
      console.warn('[ChatPersistence] Failed to load restore point:', e);
      return null;
    }
  }, []);

  const applyMemorySnapshot = useCallback((snapshot: PersistedMemorySnapshot) => {
    const normalizedStagedSnippets = normalizePersistedStagedEntries(snapshot.stagedSnippets);
    useContextStore.setState({
      chunks: new Map(rehydrateChunkDates(snapshot.chunks).map(chunk => [chunk.hash, chunk])),
      archivedChunks: new Map(rehydrateChunkDates(snapshot.archivedChunks).map(chunk => [chunk.hash, chunk])),
      droppedManifest: new Map(snapshot.droppedManifest),
      stagedSnippets: new Map(normalizedStagedSnippets),
      blackboardEntries: new Map(snapshot.blackboardEntries.map(([key, entry]) => [key, rehydrateBbEntry(key, entry)])),
      cognitiveRules: new Map(snapshot.cognitiveRules.map(([key, rule]) => [key, { ...rule, createdAt: new Date(rule.createdAt) }])),
      taskPlan: snapshot.taskPlan,
      task: snapshot.taskPlan,
      freedTokens: snapshot.freedTokens,
      stageVersion: snapshot.stageVersion,
      transitionBridge: snapshot.transitionBridge,
      batchMetrics: { ...snapshot.batchMetrics, hadReads: snapshot.batchMetrics?.hadReads ?? false, hadBbWrite: snapshot.batchMetrics?.hadBbWrite ?? false, hadSubstantiveBbWrite: (snapshot.batchMetrics as Record<string, unknown>)?.hadSubstantiveBbWrite as boolean ?? false },
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
    });
    useContextStore.setState(state => {
      const now = Date.now();
      const chunks = new Map(state.chunks);
      for (const [hash, chunk] of chunks) {
        chunks.set(hash, { ...chunk, freshness: 'suspect', freshnessCause: 'session_restore', suspectSince: now });
      }
      const stagedSnippets = new Map(state.stagedSnippets);
      for (const [key, snippet] of stagedSnippets) {
        stagedSnippets.set(key, { ...snippet, stageState: 'stale', suspectSince: now });
      }
      return { chunks, stagedSnippets };
    });
    if (snapshot.geminiCache) restoreGeminiCacheSnapshot(snapshot.geminiCache);
    applyV4SessionExtras(snapshot);
    useContextStore.getState().reconcileRestoredSession().catch(e =>
      console.warn('[ChatPersistence] applyMemorySnapshot reconciliation failed:', e),
    );
  }, []);

  /**
   * Restore chat to a specific user message, optionally replacing its content.
   * Stashes current state for undo. Returns the edited content for auto-resend.
   */
  const restoreToPoint = useCallback(async (messageId: string, editedContent?: string): Promise<string | null> => {
    const appState = useAppStore.getState();
    const sessionId = appState.currentSessionId;
    const hasDb = sessionId && chatDb.isInitialized();

    try {
      // 1. Stash current state for undo
      const ctxState = useContextStore.getState();
      const geminiSnapshot = getGeminiCacheSnapshot();
      const currentSnapshot = serializeMemorySnapshot(ctxState, geminiSnapshot);
      useAppStore.getState().setRestoreUndoStack({
        messages: [...appState.messages],
        memorySnapshot: currentSnapshot,
        restoredAtMessageId: messageId,
      });

      // 2. Load the restore point snapshot if DB is available
      const restoreSnapshot = hasDb ? await loadRestorePoint(sessionId, messageId) : null;

      // 3. Truncate messages in appStore.
      // When editing: truncates *before* the target (exclusive) so handleSend re-adds it.
      // When just restoring: truncates *after* the target (inclusive of target).
      useAppStore.getState().restoreToMessage(messageId, editedContent);

      // 4. Restore memory state if we have a snapshot
      if (restoreSnapshot) {
        applyMemorySnapshot(restoreSnapshot);
        console.log('[ChatPersistence] Restored memory snapshot for message:', messageId);
      }

      // 5. Clean up DB (if available)
      if (hasDb) {
        if (editedContent !== undefined) {
          await chatDb.deleteMessagesFrom(sessionId, messageId);
        } else {
          await chatDb.deleteMessagesAfter(sessionId, messageId);
        }

        // 6. Re-save the session with truncated state
        lastSaveRef.current = 0;
        await saveSession();
      }

      console.log('[ChatPersistence] Restored to message:', messageId);
      return editedContent ?? null;
    } catch (e) {
      console.error('[ChatPersistence] Failed to restore to point:', e);
      return null;
    }
  }, [loadRestorePoint, applyMemorySnapshot]);

  /**
   * Undo the last restore operation, bringing back discarded messages and context.
   */
  const undoRestoreOp = useCallback(async () => {
    const appState = useAppStore.getState();
    const undoEntry = appState.restoreUndoStack;
    if (!undoEntry) return;

    const sessionId = appState.currentSessionId;

    // Restore messages
    useAppStore.getState().undoRestore();

    // Restore memory snapshot
    applyMemorySnapshot(undoEntry.memorySnapshot);

    // Re-save to DB
    if (sessionId && chatDb.isInitialized()) {
      lastSaveRef.current = 0;
      try { await saveSession(); } catch { /* best effort */ }
    }

    console.log('[ChatPersistence] Undo restore completed');
  }, [applyMemorySnapshot]);

  return {
    initChatDb,
    loadSessions,
    loadSession,
    saveSession,
    flushPendingSave,
    createNewSession,
    deleteSession,
    syncBlackboardEntry,
    removeBlackboardEntries,
    saveRestorePoint,
    restoreToPoint,
    undoRestore: undoRestoreOp,
    isInitialized: chatDb.isInitialized(),
  };
}

export default useChatPersistence;

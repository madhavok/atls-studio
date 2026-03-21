/**
 * Chat Persistence Hook
 * 
 * Bridges appStore with chatDb for per-project chat persistence.
 * Handles:
 * - Loading sessions when project opens
 * - Saving sessions to database
 * - Syncing context store with blackboard
 * - Full context state persistence (archived chunks, staged snippets, hash stacks, etc.)
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAppStore, type Message, type ChatSession } from '../stores/appStore';
import { useContextStore, type ContextChunk, type TaskPlan, type ManifestEntry, type TransitionBridge, type StagedSnippet } from '../stores/contextStore';
import { useCostStore } from '../stores/costStore';
import { chatDb, type PersistedMemorySnapshot } from '../services/chatDb';
import { getGeminiCacheSnapshot, restoreGeminiCacheSnapshot, type GeminiCacheSnapshot } from '../services/aiService';
import { classifyStageSnippet, MAX_PERSISTENT_STAGE_ENTRY_TOKENS } from '../services/promptMemory';

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

export function serializeMemorySnapshot(
  ctxState: ReturnType<typeof useContextStore.getState>,
  geminiCache: GeminiCacheSnapshot,
): PersistedMemorySnapshot {
  const persistedStaged = Array.from(ctxState.stagedSnippets.entries())
    .filter(([, snippet]) => snippet.persistencePolicy !== 'doNotPersist')
    .map(([key, snippet]) => [key, normalizePersistedSnippet(key, snippet) ?? snippet] as [string, StagedSnippet]);
  return {
    version: 3,
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
  };
}

export function rehydrateChunkDates(chunks: ContextChunk[]): ContextChunk[] {
  return chunks.map((chunk) => ({
    ...chunk,
    createdAt: new Date(chunk.createdAt),
    lastAccessed: chunk.lastAccessed ?? (chunk.createdAt ? new Date(chunk.createdAt).getTime() : Date.now()),
  }));
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

export function useChatPersistence() {
  const projectPath = useAppStore(state => state.projectPath);
  const messages = useAppStore(state => state.messages);
  const currentSessionId = useAppStore(state => state.currentSessionId);
  const contextUsage = useAppStore(state => state.contextUsage);
  
  const contextChunks = useContextStore(state => state.chunks);
  const archivedChunks = useContextStore(state => state.archivedChunks);
  const stagedSnippets = useContextStore(state => state.stagedSnippets);
  const blackboardEntries = useContextStore(state => state.blackboardEntries);
  const cognitiveRules = useContextStore(state => state.cognitiveRules);
  const droppedManifest = useContextStore(state => state.droppedManifest);
  const taskPlan = useContextStore(state => state.taskPlan);
  const freedTokens = useContextStore(state => state.freedTokens);
  const stageVersion = useContextStore(state => state.stageVersion);
  const transitionBridge = useContextStore(state => state.transitionBridge);
  const batchMetrics = useContextStore(state => state.batchMetrics);
  const hashStack = useContextStore(state => state.hashStack);
  const editHashStack = useContextStore(state => state.editHashStack);
  const readHashStack = useContextStore(state => state.readHashStack);
  const stageHashStack = useContextStore(state => state.stageHashStack);
  const memoryEvents = useContextStore(state => state.memoryEvents);
  const reconcileStats = useContextStore(state => state.reconcileStats);
  
  const lastSaveRef = useRef<number>(0);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const dbSessions = await chatDb.getSessions(50);
      
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
   * Save current session to database
   */
  const saveSession = useCallback(async () => {
    if (!chatDb.isInitialized() || messages.length === 0) return;
    
    // Debounce saves
    const now = Date.now();
    if (now - lastSaveRef.current < 2000) {
      // Schedule a save for later
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => saveSession(), 2000);
      return;
    }
    lastSaveRef.current = now;
    
    try {
      let sessionId = currentSessionId;
      
      // Create session if new (or verify it exists)
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        const title = messages.find(m => m.role === 'user')?.content.slice(0, 50) || 'New Chat';
        // Pass sessionId to ensure we use the same ID we'll save with
        await chatDb.createSession('agent', title, sessionId);
      } else {
        // Verify session exists before saving (handles orchestrator race condition)
        const existingSession = await chatDb.getSession(sessionId);
        if (!existingSession) {
          // Session doesn't exist in this database - create it
          const title = messages.find(m => m.role === 'user')?.content.slice(0, 50) || 'New Chat';
          await chatDb.createSession('agent', title, sessionId);
        }
      }
      
      // Convert context chunks to array
      const blackboard = Array.from(contextChunks.values());
      
      // Save session
      const chatCostCents = useCostStore.getState().chatCostCents;
      await chatDb.saveFullSession(
        sessionId,
        messages,
        blackboard,
        {
          inputTokens: contextUsage.inputTokens,
          outputTokens: contextUsage.outputTokens,
          costCents: chatCostCents,
        }
      );

      const ctxState = useContextStore.getState();
      const geminiSnapshot = getGeminiCacheSnapshot();
      const snapshot = serializeMemorySnapshot(ctxState, geminiSnapshot);
      await chatDb.saveMemorySnapshot(sessionId, snapshot);
      
      // Update local sessions list with current session info
      const title = messages.find(m => m.role === 'user')?.content.slice(0, 50) || 'New Chat';
      const currentSessions = useAppStore.getState().chatSessions;
      const existingIndex = currentSessions.findIndex(s => s.id === sessionId);
      
      const updatedSession = {
        id: sessionId,
        title,
        messages: [], // Don't store messages in list
        createdAt: existingIndex >= 0 ? currentSessions[existingIndex].createdAt : new Date(),
        updatedAt: new Date(),
        contextUsage: {
          inputTokens: contextUsage.inputTokens,
          outputTokens: contextUsage.outputTokens,
          totalTokens: contextUsage.inputTokens + contextUsage.outputTokens,
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
      
      // Update store
      useAppStore.setState({ 
        chatSessions: newSessions,
        currentSessionId: sessionId,
      });
      
      console.log('[ChatPersistence] Session saved:', sessionId);
    } catch (error) {
      console.error('[ChatPersistence] Failed to save session:', error);
    }
  }, [
    messages,
    currentSessionId,
    contextChunks,
    archivedChunks,
    stagedSnippets,
    blackboardEntries,
    cognitiveRules,
    droppedManifest,
    taskPlan,
    freedTokens,
    stageVersion,
    transitionBridge,
    batchMetrics,
    hashStack,
    editHashStack,
    readHashStack,
    stageHashStack,
    memoryEvents,
    reconcileStats,
    contextUsage,
  ]);

  /**
   * Load a specific session with its blackboard and restore to stores
   */
  const loadSession = useCallback(async (sessionId: string): Promise<boolean> => {
    if (!chatDb.isInitialized()) return false;

    // Save outgoing session before switching to prevent data loss
    const outgoing = useAppStore.getState();
    if (outgoing.currentSessionId && outgoing.currentSessionId !== sessionId && outgoing.messages.length > 0) {
      lastSaveRef.current = 0; // Bypass debounce for session switch
      try { await saveSession(); } catch { /* best effort */ }
    }
    
    try {
      const result = await chatDb.loadFullSession(sessionId);
      if (!result) return false;
      
      // Restore messages to appStore; reset metrics since they aren't persisted
      useAppStore.setState({
        currentSessionId: sessionId,
        messages: result.messages,
        contextUsage: result.session.context_usage ? {
          inputTokens: result.session.context_usage.input_tokens,
          outputTokens: result.session.context_usage.output_tokens,
          totalTokens: result.session.context_usage.total_tokens,
          maxTokens: contextUsage.maxTokens,
          percentage: Math.min(100, (result.session.context_usage.total_tokens / contextUsage.maxTokens) * 100),
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
          workspaceContextTokens: 0,
          totalOverheadTokens: 0, compressionSavings: 0,
          compressionCount: 0, roundCount: 0, cumulativeInputSaved: 0,
        },
        cacheMetrics: {
          sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
          sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
        },
      });
      
      // Restore blackboard/context chunks to contextStore
      const contextStore = useContextStore.getState();
      contextStore.resetSession(); // Clear existing chunks

      let restoredFromSnapshot = false;
      try {
        const snapshot = await chatDb.getMemorySnapshot(sessionId);
        if (snapshot && (snapshot.version === 2 || snapshot.version === 3)) {
          const normalizedStagedSnippets = normalizePersistedStagedEntries(snapshot.stagedSnippets);
          useContextStore.setState({
            chunks: new Map(rehydrateChunkDates(snapshot.chunks).map(chunk => [chunk.hash, chunk])),
            archivedChunks: new Map(rehydrateChunkDates(snapshot.archivedChunks).map(chunk => [chunk.hash, chunk])),
            droppedManifest: new Map(snapshot.droppedManifest),
            stagedSnippets: new Map(normalizedStagedSnippets),
            blackboardEntries: new Map(snapshot.blackboardEntries.map(([key, entry]) => [key, { ...entry, createdAt: new Date(entry.createdAt) }])),
            cognitiveRules: new Map(snapshot.cognitiveRules.map(([key, rule]) => [key, { ...rule, createdAt: new Date(rule.createdAt) }])),
            taskPlan: snapshot.taskPlan,
            task: snapshot.taskPlan,
            freedTokens: snapshot.freedTokens,
            stageVersion: snapshot.stageVersion,
            transitionBridge: snapshot.transitionBridge,
            batchMetrics: snapshot.batchMetrics,
            hashStack: snapshot.hashStack,
            editHashStack: snapshot.editHashStack,
            readHashStack: snapshot.readHashStack,
            stageHashStack: snapshot.stageHashStack,
            memoryEvents: snapshot.memoryEvents ?? [],
            reconcileStats: snapshot.reconcileStats ?? null,
          });
          if (snapshot.geminiCache) restoreGeminiCacheSnapshot(snapshot.geminiCache);
          restoredFromSnapshot = true;
          console.log('[ChatPersistence] Restored memory snapshot');
        }
      } catch (e) {
        console.warn('[ChatPersistence] Failed to restore memory snapshot:', e);
        contextStore.setBlackboardEntry('persistence:restore_error', 'Memory snapshot restore failed; falling back to legacy partial restore.');
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
              contextStore.setBlackboardEntry(note.key, note.content);
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
              const metrics = JSON.parse(sessionState[STATE_KEY_BATCH_METRICS]) as { toolCalls: number; manageOps: number };
              useContextStore.setState({ batchMetrics: metrics });
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
      
      console.log('[ChatPersistence] Session loaded:', sessionId, 
        `${result.messages.length} messages, ${result.blackboard.length} context chunks`);
      return true;
    } catch (error) {
      console.error('[ChatPersistence] Failed to load session:', error);
      return false;
    }
  }, [contextUsage.maxTokens, saveSession]);

  /**
   * Create a new session
   */
  const createNewSession = useCallback(async (): Promise<string | null> => {
    if (!chatDb.isInitialized()) return null;
    
    try {
      // Save current session first
      if (messages.length > 0) {
        await saveSession();
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
          compressionCount: 0, roundCount: 0, cumulativeInputSaved: 0,
        },
        cacheMetrics: {
          sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
          sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
        },
      });
      
      // Clear context store (includes blackboard entries)
      useContextStore.getState().resetSession();
      
      console.log('[ChatPersistence] New session created:', sessionId);
      return sessionId;
    } catch (error) {
      console.error('[ChatPersistence] Failed to create session:', error);
      return null;
    }
  }, [messages, saveSession, contextUsage.maxTokens]);

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
        useAppStore.setState({
          currentSessionId: null,
          messages: [],
          promptMetrics: {
            modePromptTokens: 0, toolRefTokens: 0, shellGuideTokens: 0,
            nativeToolTokens: 0, primerTokens: 0, contextControlTokens: 0,
            workspaceContextTokens: 0,
            totalOverheadTokens: 0, compressionSavings: 0,
            compressionCount: 0, roundCount: 0, cumulativeInputSaved: 0,
          },
          cacheMetrics: {
            sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
            sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
          },
        });
        useContextStore.getState().resetSession();
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
        // Save outgoing session before switching DB
        if (isSwitch && messages.length > 0) {
          try { await saveSession(); } catch { /* best effort */ }
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
                compressionCount: 0, roundCount: 0, cumulativeInputSaved: 0,
              },
              cacheMetrics: {
                sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
                sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
              },
            });
            useContextStore.getState().resetSession();
          }

          // Load sessions from the new project's database
          loadSessions();
        }
      };
      init();
    } else {
      chatDb.close();
      // Clear everything when no project
      useAppStore.setState({
        chatSessions: [],
        currentSessionId: null,
        messages: [],
      });
      useContextStore.getState().resetSession();
    }
    
    return () => {
      // Save on unmount
      if (messages.length > 0) {
        saveSession();
      }
    };
  }, [projectPath, initChatDb, loadSessions]);

  // Best-effort save on window close / refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (messages.length > 0 && chatDb.isInitialized()) {
        lastSaveRef.current = 0; // Bypass debounce
        saveSession();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [messages.length, saveSession]);

  // Auto-save on message changes (debounced)
  useEffect(() => {
    if (messages.length > 0 && chatDb.isInitialized()) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => {
        saveSession();
      }, 5000); // Auto-save every 5 seconds of inactivity
    }
    
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [messages, saveSession]);

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
      blackboardEntries: new Map(snapshot.blackboardEntries.map(([key, entry]) => [key, { ...entry, createdAt: new Date(entry.createdAt) }])),
      cognitiveRules: new Map(snapshot.cognitiveRules.map(([key, rule]) => [key, { ...rule, createdAt: new Date(rule.createdAt) }])),
      taskPlan: snapshot.taskPlan,
      task: snapshot.taskPlan,
      freedTokens: snapshot.freedTokens,
      stageVersion: snapshot.stageVersion,
      transitionBridge: snapshot.transitionBridge,
      batchMetrics: snapshot.batchMetrics,
      hashStack: snapshot.hashStack,
      editHashStack: snapshot.editHashStack,
      readHashStack: snapshot.readHashStack,
      stageHashStack: snapshot.stageHashStack,
      memoryEvents: snapshot.memoryEvents ?? [],
      reconcileStats: snapshot.reconcileStats ?? null,
    });
    if (snapshot.geminiCache) restoreGeminiCacheSnapshot(snapshot.geminiCache);
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
  }, [loadRestorePoint, applyMemorySnapshot, saveSession]);

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
  }, [applyMemorySnapshot, saveSession]);

  return {
    initChatDb,
    loadSessions,
    loadSession,
    saveSession,
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

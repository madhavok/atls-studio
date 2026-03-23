/**
 * Chat Database Service
 * 
 * Per-project chat persistence using SQLite via Tauri.
 * Stores sessions, messages, blackboard context, and swarm tasks.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Message, MessageSegment, ChatSession } from '../stores/appStore';
import { extractFirstTextFromMessage, getMessageParts } from '../stores/appStore';
import type { ContextChunk, ChunkType, BlackboardEntry, CognitiveRule, ManifestEntry, ReconcileStats, StagedSnippet, TaskPlan, TransitionBridge, MemoryEvent } from '../stores/contextStore';
import type { GeminiCacheSnapshot } from './aiService';
import type { RoundSnapshot } from '../stores/roundHistoryStore';

// ============================================================================
// Database Types
// ============================================================================

export interface DbSession {
  id: string;
  title: string;
  mode: ChatMode;
  created_at: string;
  updated_at: string;
  is_swarm: boolean;
  swarm_status?: SwarmStatus;
  context_usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_cents: number;
  };
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'agent';
  content: string;
  agent_id?: string;
  timestamp: string;
}

export interface DbSegment {
  id: number;
  message_id: string;
  seq: number;
  type: 'text' | 'tool';
  content: string;
  tool_name?: string;
  tool_args?: string;
  tool_result?: string;
}

export interface DbBlackboardEntry {
  id: number;
  session_id: string;
  hash: string;
  short_hash: string;
  type: string;
  source?: string;
  content: string;
  tokens: number;
  pinned: boolean;
  created_at: string;
}

export interface DbBlackboardNote {
  id: number;
  session_id: string;
  key: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface DbTask {
  id: string;
  session_id: string;
  parent_task_id?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assigned_model?: string;
  assigned_role?: string;
  context_hashes?: string[];
  file_claims?: string[];
  result?: string;
  error?: string;
  tokens_used: number;
  cost_cents: number;
  started_at?: string;
  completed_at?: string;
}

export interface DbAgentStats {
  id: number;
  session_id: string;
  task_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  api_calls: number;
}

export type ChatMode = 'agent' | 'designer' | 'ask' | 'reviewer' | 'retriever' | 'custom' | 'swarm';
export type SwarmStatus = 'researching' | 'planning' | 'running' | 'paused' | 'synthesizing' | 'completed' | 'failed';
export type TaskStatus = 'pending' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled';

// ============================================================================
// Chat Database Service
// ============================================================================

class ChatDbService {
  private initialized = false;
  private projectPath: string | null = null;

  /**
   * Initialize chat database for a project
   * Always closes existing connection first to ensure clean state
   */
  async init(projectPath: string): Promise<boolean> {
    try {
      const _prevPath = this.projectPath;
      const _wasInitialized = this.initialized;
      
      // CRITICAL: Always close existing connection first to prevent stale connections
      // This ensures we switch databases cleanly when changing projects
      if (this.initialized && this.projectPath !== projectPath) {
        console.log('[ChatDb] Closing previous connection for:', this.projectPath);
        await this.close();
      }
      
      await invoke('chat_db_init', { projectPath });
      this.initialized = true;
      this.projectPath = projectPath;
      console.log('[ChatDb] Initialized for:', projectPath);
      return true;
    } catch (error) {
      console.error('[ChatDb] Failed to initialize:', error);
      this.initialized = false;
      this.projectPath = null;
      return false;
    }
  }

  /**
   * Close current database connection
   */
  async close(): Promise<void> {
    if (!this.initialized) return;
    try {
      await invoke('chat_db_close');
      this.initialized = false;
      this.projectPath = null;
    } catch (error) {
      console.error('[ChatDb] Failed to close:', error);
    }
  }

  /**
   * Check if database is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get current project path
   */
  getProjectPath(): string | null {
    return this.projectPath;
  }

  // ==========================================================================
  // Session Operations
  // ==========================================================================

  /**
   * Create a new chat session
   * @param mode Chat mode (agent, designer, ask, reviewer, swarm)
   * @param title Session title
   * @param sessionId Optional session ID (generates UUID if not provided)
   */
  async createSession(mode: ChatMode = 'agent', title = 'New Chat', sessionId?: string): Promise<string> {
    const id = sessionId || crypto.randomUUID();
    await invoke('chat_db_create_session', { 
      id, 
      title, 
      mode,
      isSwarm: mode === 'swarm',
    });
    return id;
  }

  /** Migrate legacy 'planner' mode to 'designer' when loading from DB */
  private migrateSessionMode(session: DbSession): DbSession {
    if ((session.mode as string) === 'planner') {
      return { ...session, mode: 'designer' };
    }
    return session;
  }

  /**
   * Get all sessions (most recent first)
   */
  async getSessions(limit = 50): Promise<DbSession[]> {
    const sessions = await invoke<DbSession[]>('chat_db_get_sessions', { limit });
    return sessions.map(s => this.migrateSessionMode(s));
  }

  /**
   * Get a specific session by ID
   */
  async getSession(sessionId: string): Promise<DbSession | null> {
    const session = await invoke<DbSession | null>('chat_db_get_session', { sessionId });
    return session ? this.migrateSessionMode(session) : null;
  }

  /**
   * Update session title
   */
  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    await invoke('chat_db_update_session_title', { sessionId, title });
  }

  /**
   * Update session mode
   */
  async updateSessionMode(sessionId: string, mode: ChatMode): Promise<void> {
    await invoke('chat_db_update_session_mode', { sessionId, mode });
  }

  /**
   * Update swarm status
   */
  async updateSwarmStatus(sessionId: string, status: SwarmStatus): Promise<void> {
    await invoke('chat_db_update_swarm_status', { sessionId, status });
  }

  /**
   * Update session context usage
   */
  async updateContextUsage(
    sessionId: string, 
    inputTokens: number, 
    outputTokens: number,
    costCents?: number,
  ): Promise<void> {
    await invoke('chat_db_update_context_usage', { 
      sessionId, 
      inputTokens, 
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costCents: costCents ?? 0,
    });
  }

  /**
   * Delete a session and all its data
   */
  async deleteSession(sessionId: string): Promise<void> {
    await invoke('chat_db_delete_session', { sessionId });
  }

  // ==========================================================================
  // Message Operations
  // ==========================================================================

  /**
   * Add a message to a session
   * @param sessionId Session ID
   * @param role Message role
   * @param content Message content
   * @param agentId Optional agent ID for swarm messages
   * @param messageId Optional message ID (generates UUID if not provided)
   */
  async addMessage(
    sessionId: string,
    role: 'user' | 'assistant' | 'system' | 'agent',
    content: string,
    agentId?: string,
    messageId?: string
  ): Promise<string> {
    const id = messageId || crypto.randomUUID();
    await invoke('chat_db_add_message', { 
      id, 
      sessionId, 
      role, 
      content,
      agentId,
    });
    return id;
  }

  /**
   * Get all messages for a session
   */
  async getMessages(sessionId: string): Promise<DbMessage[]> {
    return await invoke<DbMessage[]>('chat_db_get_messages', { sessionId });
  }

  /**
   * Add segments to a message (for tool calls)
   */
  async addSegments(messageId: string, segments: MessageSegment[]): Promise<void> {
    const dbSegments = segments.map((seg, idx) => {
      if (seg.type === 'text') {
        return { message_id: messageId, seq: idx, type: seg.type, content: seg.content, tool_name: undefined, tool_args: undefined, tool_result: undefined };
      }
      const tc = seg.toolCall;
      const argsPayload = tc.syntheticChildren?.length
        ? { ...tc.args, __syntheticChildren: tc.syntheticChildren }
        : tc.args;
      return {
        message_id: messageId, seq: idx, type: seg.type, content: '',
        tool_name: tc.name,
        tool_args: JSON.stringify(argsPayload),
        tool_result: tc.result,
      };
    });
    await invoke('chat_db_add_segments', { messageId, segments: dbSegments });
  }

  /**
   * Get segments for a message
   */
  async getSegments(messageId: string): Promise<DbSegment[]> {
    return await invoke<DbSegment[]>('chat_db_get_segments', { messageId });
  }

  // ==========================================================================
  // Blackboard Operations (Context Persistence)
  // ==========================================================================

  /**
   * Add a chunk to the blackboard
   */
  async addBlackboardEntry(
    sessionId: string,
    chunk: ContextChunk
  ): Promise<void> {
    await invoke('chat_db_add_blackboard_entry', {
      sessionId,
      hash: chunk.hash,
      shortHash: chunk.shortHash,
      entryType: chunk.type,  // Backend expects entry_type -> entryType
      source: chunk.source,
      content: chunk.content,
      tokens: chunk.tokens,
      pinned: chunk.pinned || false,
    });
  }

  /**
   * Get all blackboard entries for a session
   */
  async getBlackboardEntries(sessionId: string): Promise<DbBlackboardEntry[]> {
    return await invoke<DbBlackboardEntry[]>('chat_db_get_blackboard_entries', { sessionId });
  }

  /**
   * Look up blackboard content by hash (full or short) for a session.
   * Returns { content, source } if found.
   */
  async getContentByHash(sessionId: string, hash: string): Promise<{ content: string; source?: string } | null> {
    const result = await invoke<[string, string | null] | null>('chat_db_get_content_by_hash', { sessionId, hash });
    if (!result) return null;
    const [content, source] = result;
    return { content, source: source ?? undefined };
  }

  /**
   * Update blackboard entry pinned status
   */
  async updateBlackboardPinned(sessionId: string, shortHash: string, pinned: boolean): Promise<void> {
    await invoke('chat_db_update_blackboard_pinned', { sessionId, shortHash, pinned });
  }

  /**
   * Remove blackboard entries by hash
   */
  async removeBlackboardEntries(sessionId: string, shortHashes: string[]): Promise<void> {
    await invoke('chat_db_remove_blackboard_entries', { sessionId, shortHashes });
  }

  /**
   * Clear all non-pinned blackboard entries
   */
  async clearBlackboard(sessionId: string, keepPinned = true): Promise<void> {
    await invoke('chat_db_clear_blackboard', { sessionId, keepPinned });
  }

  // ==========================================================================
  // Blackboard Notes Operations (Persistent Key-Value Knowledge)
  // ==========================================================================

  /**
   * Set a blackboard note (upsert: creates or updates)
   */
  async setBlackboardNote(sessionId: string, key: string, content: string): Promise<void> {
    await invoke('chat_db_set_note', { sessionId, key, content });
  }

  /**
   * Get all blackboard notes for a session
   */
  async getBlackboardNotes(sessionId: string): Promise<DbBlackboardNote[]> {
    return await invoke<DbBlackboardNote[]>('chat_db_get_notes', { sessionId });
  }

  /**
   * Delete a blackboard note by key
   */
  async deleteBlackboardNote(sessionId: string, key: string): Promise<void> {
    await invoke('chat_db_delete_note', { sessionId, key });
  }

  /**
   * Clear all blackboard notes for a session
   */
  async clearBlackboardNotes(sessionId: string): Promise<void> {
    await invoke('chat_db_clear_notes', { sessionId });
  }

  // ==========================================================================
  // Task Operations (Swarm)
  // ==========================================================================

  /**
   * Create a new task
   */
  async createTask(
    sessionId: string,
    title: string,
    description?: string,
    parentTaskId?: string,
    assignedModel?: string,
    assignedRole?: string,
    contextHashes?: string[],
    fileClaims?: string[],
    taskId?: string // Optional: Use existing taskId for FK consistency
  ): Promise<string> {
    const id = taskId || crypto.randomUUID();
    await invoke('chat_db_create_task', {
      id,
      sessionId,
      parentTaskId,
      title,
      description,
      assignedModel,
      assignedRole,
      contextHashes: contextHashes ? JSON.stringify(contextHashes) : undefined,
      fileClaims: fileClaims ? JSON.stringify(fileClaims) : undefined,
    });
    return id;
  }

  /**
   * Get all tasks for a session
   */
  async getTasks(sessionId: string): Promise<DbTask[]> {
    const tasks = await invoke<any[]>('chat_db_get_tasks', { sessionId });
    return tasks.map(t => ({
      ...t,
      context_hashes: t.context_hashes ? JSON.parse(t.context_hashes) : undefined,
      file_claims: t.file_claims ? JSON.parse(t.file_claims) : undefined,
    }));
  }

  /**
   * Get a specific task
   */
  async getTask(taskId: string): Promise<DbTask | null> {
    const task = await invoke<any | null>('chat_db_get_task', { taskId });
    if (!task) return null;
    return {
      ...task,
      context_hashes: task.context_hashes ? JSON.parse(task.context_hashes) : undefined,
      file_claims: task.file_claims ? JSON.parse(task.file_claims) : undefined,
    };
  }

  /**
   * Update task status
   */
  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    await invoke('chat_db_update_task_status', { taskId, status });
  }

  /**
   * Update task result
   */
  async updateTaskResult(taskId: string, result: string): Promise<void> {
    await invoke('chat_db_update_task_result', { taskId, result });
  }

  /**
   * Update task error
   */
  async updateTaskError(taskId: string, error: string): Promise<void> {
    await invoke('chat_db_update_task_error', { taskId, error });
  }

  /**
   * Update task stats (tokens, cost)
   */
  async updateTaskStats(taskId: string, tokensUsed: number, costCents: number): Promise<void> {
    await invoke('chat_db_update_task_stats', { taskId, tokensUsed, costCents });
  }

  // ==========================================================================
  // Agent Stats Operations
  // ==========================================================================

  /**
   * Record agent stats
   */
  async recordAgentStats(
    sessionId: string,
    taskId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    costCents: number
  ): Promise<void> {
    await invoke('chat_db_record_agent_stats', {
      sessionId,
      taskId,
      model,
      inputTokens,
      outputTokens,
      costCents,
    });
  }

  /**
   * Get agent stats for a session
   */
  async getAgentStats(sessionId: string): Promise<DbAgentStats[]> {
    return await invoke<DbAgentStats[]>('chat_db_get_agent_stats', { sessionId });
  }

  /**
   * Get total stats for a session
   */
  async getSessionTotalStats(sessionId: string): Promise<{
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostCents: number;
    totalApiCalls: number;
  }> {
    return await invoke('chat_db_get_session_total_stats', { sessionId });
  }

  // ==========================================================================
  // High-Level Helpers
  // ==========================================================================

  /**
   * Load a full session with messages and segments
   */
  async loadFullSession(sessionId: string): Promise<{
    session: DbSession;
    messages: Message[];
    blackboard: ContextChunk[];
    tasks: DbTask[];
  } | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    const [dbMessages, blackboardEntries, tasks] = await Promise.all([
      this.getMessages(sessionId),
      this.getBlackboardEntries(sessionId),
      session.is_swarm ? this.getTasks(sessionId) : Promise.resolve([]),
    ]);

    // Load segments for each message
    const messages: Message[] = await Promise.all(
      dbMessages.map(async (msg) => {
        const segments = await this.getSegments(msg.id);
        const messageSegments: MessageSegment[] = segments.map(seg => {
          if (seg.type === 'text') {
            return { type: 'text', content: seg.content };
          }
          let parsedArgs: Record<string, unknown> | undefined;
          let syntheticChildren: Array<{ id: string; name: string; args?: Record<string, unknown>; result?: string; status?: string }> | undefined;
          if (seg.tool_args) {
            const raw = JSON.parse(seg.tool_args);
            if (raw && Array.isArray(raw.__syntheticChildren)) {
              syntheticChildren = raw.__syntheticChildren;
              const { __syntheticChildren: _, ...rest } = raw;
              parsedArgs = Object.keys(rest).length > 0 ? rest : undefined;
            } else {
              parsedArgs = raw;
            }
          }
          return {
            type: 'tool',
            toolCall: {
              id: seg.id.toString(),
              name: seg.tool_name || '',
              args: parsedArgs,
              result: seg.tool_result,
              status: 'completed' as const,
              ...(syntheticChildren?.length ? { syntheticChildren } : {}),
            },
          };
        });

        return {
          id: msg.id,
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
          timestamp: new Date(msg.timestamp),
          segments: messageSegments.length > 0 ? messageSegments : undefined,
        };
      })
    );

    // Convert blackboard entries to ContextChunks
    const blackboard: ContextChunk[] = blackboardEntries.map(entry => ({
      hash: entry.hash,
      shortHash: entry.short_hash,
      type: entry.type as ChunkType,
      source: entry.source,
      content: entry.content,
      tokens: entry.tokens,
      createdAt: new Date(entry.created_at),
      lastAccessed: new Date(entry.created_at).getTime(), // Use created_at as initial lastAccessed
      pinned: entry.pinned,
    }));

    return { session, messages, blackboard, tasks };
  }

  /**
   * Save a full session (messages + context)
   */
  async saveFullSession(
    sessionId: string,
    messages: Message[],
    blackboard: ContextChunk[],
    contextUsage?: { inputTokens: number; outputTokens: number; costCents?: number }
  ): Promise<void> {
    // Get existing messages once to avoid repeated queries
    const existingMessages = await this.getMessages(sessionId);
    const existingMessageIds = new Set(existingMessages.map(m => m.id));
    
    // Save messages with segments
    for (const msg of messages) {
      if (!existingMessageIds.has(msg.id)) {
        // Pass the original message ID to maintain FK consistency
        await this.addMessage(sessionId, msg.role, msg.content, undefined, msg.id);
        
        const parts = getMessageParts(msg);
        const segmentsToSave: MessageSegment[] = parts
          .filter((p) => p.type === 'text' || p.type === 'tool')
          .map((p) =>
            p.type === 'text' ? { type: 'text' as const, content: p.content } : { type: 'tool' as const, toolCall: p.toolCall },
          );
        if (segmentsToSave.length > 0) {
          await this.addSegments(msg.id, segmentsToSave);
        }
      }
    }

    // Save blackboard entries
    const existingEntries = await this.getBlackboardEntries(sessionId);
    const existingHashes = new Set(existingEntries.map(e => e.short_hash));
    
    for (const chunk of blackboard) {
      if (!existingHashes.has(chunk.shortHash)) {
        await this.addBlackboardEntry(sessionId, chunk);
      }
    }

    // Update context usage
    if (contextUsage) {
      await this.updateContextUsage(sessionId, contextUsage.inputTokens, contextUsage.outputTokens, contextUsage.costCents);
    }

    // Update session title from first user message (handles multimodal/segmented)
    if (messages.length > 0) {
      const firstUser = messages.find(m => m.role === 'user');
      if (firstUser) {
        const text = extractFirstTextFromMessage(firstUser);
        const title = text ? text.slice(0, 50) + (text.length > 50 ? '...' : '') : 'New Chat';
        await this.updateSessionTitle(sessionId, title);
      }
    }
  }

  /**
   * Convert DbSession to ChatSession format (for compatibility)
   */
  dbSessionToChatSession(dbSession: DbSession, messages: Message[]): ChatSession {
    return {
      id: dbSession.id,
      title: dbSession.title,
      messages,
      createdAt: new Date(dbSession.created_at),
      updatedAt: new Date(dbSession.updated_at),
      contextUsage: dbSession.context_usage ? {
        inputTokens: dbSession.context_usage.input_tokens,
        outputTokens: dbSession.context_usage.output_tokens,
        totalTokens: dbSession.context_usage.total_tokens,
        costCents: dbSession.context_usage.cost_cents ?? 0,
      } : undefined,
    };
  }

  // ==========================================================================
  // Archived Chunks Operations
  // ==========================================================================

  async saveArchivedChunks(sessionId: string, chunks: ContextChunk[]): Promise<void> {
    const input = chunks.map(c => ({
      hash: c.hash,
      short_hash: c.shortHash,
      type: c.type,
      source: c.source ?? null,
      content: c.content,
      tokens: c.tokens,
      digest: c.digest ?? null,
      edit_digest: c.editDigest ?? null,
      summary: c.summary ?? null,
      pinned: c.pinned ?? false,
    }));
    await invoke('chat_db_save_archived_chunks', { sessionId, chunks: input });
  }

  async getArchivedChunks(sessionId: string): Promise<ContextChunk[]> {
    const entries = await invoke<DbArchivedChunk[]>('chat_db_get_archived_chunks', { sessionId });
    return entries.map(e => ({
      hash: e.hash,
      shortHash: e.short_hash,
      type: e.type as ChunkType,
      source: e.source ?? undefined,
      content: e.content,
      tokens: e.tokens,
      digest: e.digest ?? undefined,
      editDigest: e.edit_digest ?? undefined,
      summary: e.summary ?? undefined,
      pinned: e.pinned,
      createdAt: new Date(e.created_at),
      lastAccessed: new Date(e.created_at).getTime(),
    }));
  }

  async clearArchivedChunks(sessionId: string): Promise<void> {
    await invoke('chat_db_clear_archived_chunks', { sessionId });
  }

  // ==========================================================================
  // Session State Operations (key-value per session)
  // ==========================================================================

  async setSessionState(sessionId: string, key: string, value: string): Promise<void> {
    await invoke('chat_db_set_session_state', { sessionId, key, value });
  }

  async getSessionState(sessionId: string, key: string): Promise<string | null> {
    return await invoke<string | null>('chat_db_get_session_state', { sessionId, key });
  }

  async getAllSessionState(sessionId: string): Promise<Record<string, string>> {
    const entries = await invoke<Array<{ key: string; value: string }>>('chat_db_get_all_session_state', { sessionId });
    const result: Record<string, string> = {};
    for (const e of entries) result[e.key] = e.value;
    return result;
  }

  async setSessionStateBatch(sessionId: string, entries: Record<string, string>): Promise<void> {
    const pairs = Object.entries(entries);
    if (pairs.length === 0) return;
    await invoke('chat_db_set_session_state_batch', { sessionId, entries: pairs });
  }

  // ==========================================================================
  // Staged Snippets Operations
  // ==========================================================================

  async saveStagedSnippets(sessionId: string, snippets: Map<string, StagedSnippetData>): Promise<void> {
    const input = Array.from(snippets.entries()).map(([key, s]) => ({
      key,
      content: s.content,
      source: s.source ?? null,
      lines: s.lines ?? null,
      tokens: s.tokens,
      source_revision: s.sourceRevision ?? null,
      shape_spec: s.shapeSpec ?? null,
    }));
    await invoke('chat_db_save_staged_snippets', { sessionId, snippets: input });
  }

  async getStagedSnippets(sessionId: string): Promise<Map<string, StagedSnippetData>> {
    const entries = await invoke<DbStagedSnippet[]>('chat_db_get_staged_snippets', { sessionId });
    const map = new Map<string, StagedSnippetData>();
    for (const e of entries) {
      map.set(e.key, {
        content: e.content,
        source: e.source ?? undefined,
        lines: e.lines ?? undefined,
        tokens: e.tokens,
        sourceRevision: e.source_revision ?? undefined,
        shapeSpec: e.shape_spec ?? undefined,
        viewKind: (e as DbStagedSnippet & { view_kind?: 'latest' | 'snapshot' | 'derived' }).view_kind,
      });
    }
    return map;
  }

  async saveMemorySnapshot(sessionId: string, snapshot: PersistedMemorySnapshot): Promise<void> {
    await invoke('chat_db_save_memory_snapshot', {
      sessionId,
      snapshotJson: JSON.stringify(snapshot),
    });
  }

  async getMemorySnapshot(sessionId: string): Promise<PersistedMemorySnapshot | null> {
    const raw = await invoke<string | null>('chat_db_get_memory_snapshot', { sessionId });
    if (!raw) return null;
    return JSON.parse(raw) as PersistedMemorySnapshot;
  }

  // ==========================================================================
  // Message Edit / Restore Operations
  // ==========================================================================

  async deleteMessagesAfter(sessionId: string, messageId: string): Promise<number> {
    return await invoke<number>('chat_db_delete_messages_after', { sessionId, messageId });
  }

  /** Delete the target message and all messages after it (inclusive). */
  async deleteMessagesFrom(sessionId: string, messageId: string): Promise<number> {
    return await invoke<number>('chat_db_delete_messages_from', { sessionId, messageId });
  }

  async updateMessageContent(messageId: string, content: string): Promise<void> {
    await invoke('chat_db_update_message_content', { messageId, content });
  }

  // ==========================================================================
  // Hash Registry Operations (exposed from Rust)
  // ==========================================================================

  async registerHash(
    sessionId: string,
    hash: string,
    metadata: {
      source?: string;
      tokens?: number;
      lang?: string;
      lineCount?: number;
      symbolCount?: number;
      chunkType?: string;
      subtaskId?: string;
    }
  ): Promise<void> {
    await invoke('chat_db_register_hash', {
      sessionId,
      hash,
      source: metadata.source ?? null,
      tokens: metadata.tokens ?? 0,
      lang: metadata.lang ?? null,
      lineCount: metadata.lineCount ?? 0,
      symbolCount: metadata.symbolCount ?? null,
      chunkType: metadata.chunkType ?? null,
      subtaskId: metadata.subtaskId ?? null,
    });
  }

  async getHashEntry(sessionId: string, hash: string): Promise<DbHashRegistryEntry | null> {
    return await invoke<DbHashRegistryEntry | null>('chat_db_get_hash_entry', { sessionId, hash });
  }

  async getSessionHashes(sessionId: string): Promise<DbHashRegistryEntry[]> {
    return await invoke<DbHashRegistryEntry[]>('chat_db_get_session_hashes', { sessionId });
  }
}

// ============================================================================
// Additional DB Types
// ============================================================================

export interface DbArchivedChunk {
  id: number;
  session_id: string;
  hash: string;
  short_hash: string;
  type: string;
  source: string | null;
  content: string;
  tokens: number;
  digest: string | null;
  edit_digest: string | null;
  summary: string | null;
  pinned: boolean;
  created_at: string;
}

export interface DbStagedSnippet {
  id: number;
  session_id: string;
  key: string;
  content: string;
  source: string | null;
  lines: string | null;
  tokens: number;
  source_revision: string | null;
  shape_spec: string | null;
  created_at: string;
}

export interface StagedSnippetData {
  content: string;
  source?: string;
  lines?: string;
  tokens: number;
  sourceRevision?: string;
  shapeSpec?: string;
  viewKind?: 'latest' | 'snapshot' | 'derived';
}

/** Mirrors PromptMetrics / CacheMetrics for JSON snapshots (avoids circular imports). */
export interface PersistedPromptMetrics {
  modePromptTokens: number;
  toolRefTokens: number;
  shellGuideTokens: number;
  nativeToolTokens: number;
  primerTokens: number;
  contextControlTokens: number;
  workspaceContextTokens: number;
  entryManifestTokens?: number;
  totalOverheadTokens: number;
  compressionSavings: number;
  compressionCount: number;
  roundCount: number;
  cumulativeInputSaved: number;
  bp2ToolDefTokens?: number;
  bp3PriorTurnsTokens?: number;
}

export interface PersistedCacheMetrics {
  sessionCacheWrites: number;
  sessionCacheReads: number;
  sessionUncached: number;
  sessionRequests: number;
  lastRequestHitRate: number;
  sessionHitRate: number;
  lastRequestCachedTokens?: number;
}

/** SubAgent usage row as stored in JSON (timestamp ISO string). */
export interface PersistedSubAgentUsageRow {
  invocationId: string;
  type: 'retriever' | 'design';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCents: number;
  rounds: number;
  toolCalls: number;
  pinTokens: number;
  timestamp: string;
}

export interface PersistedCostChat {
  chatCostCents: number;
  chatApiCalls: number;
  chatSubAgentCostCents?: number;
  subAgentUsages?: PersistedSubAgentUsageRow[];
}

export interface PersistedMemorySnapshot {
  version: 2 | 3 | 4;
  savedAt: string;
  chunks: ContextChunk[];
  archivedChunks: ContextChunk[];
  droppedManifest: Array<[string, ManifestEntry]>;
  stagedSnippets: Array<[string, StagedSnippet]>;
  blackboardEntries: Array<[string, BlackboardEntry]>;
  cognitiveRules: Array<[string, CognitiveRule]>;
  taskPlan: TaskPlan | null;
  freedTokens: number;
  stageVersion: number;
  transitionBridge: TransitionBridge | null;
  batchMetrics: { toolCalls: number; manageOps: number };
  hashStack: string[];
  editHashStack: string[];
  readHashStack: string[];
  stageHashStack: string[];
  memoryEvents: MemoryEvent[];
  reconcileStats: ReconcileStats | null;
  geminiCache?: GeminiCacheSnapshot | null;
  /** v4+: session-scoped UI/runtime parity */
  promptMetrics?: PersistedPromptMetrics;
  cacheMetrics?: PersistedCacheMetrics;
  roundHistorySnapshots?: RoundSnapshot[];
  costChat?: PersistedCostChat;
}

export interface DbHashRegistryEntry {
  hash: string;
  short_hash: string;
  source: string | null;
  tokens: number;
  lang: string | null;
  line_count: number;
  symbol_count: number | null;
  chunk_type: string | null;
  subtask_id: string | null;
}

// Export singleton instance
export const chatDb = new ChatDbService();

// Export types
export type { ChatDbService };

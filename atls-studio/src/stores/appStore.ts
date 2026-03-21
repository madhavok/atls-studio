import { create } from 'zustand';
import type { Toast } from '../components/Toast';
import { useContextStore } from './contextStore';
import type { ChatAttachment } from './attachmentStore';
import { rehydrateDate } from '../utils/persistenceHelpers';
import type { LanguageHealth, TabType } from '../components/AtlsPanel/types';
import {
  type ProjectHistoryEntry,
  loadProjectHistory,
  saveProjectHistory,
  normalizeProjectHistory,
} from './projectHistory';
import type { PersistedMemorySnapshot } from '../services/chatDb';

export type { ProjectHistoryEntry };

export interface RestoreUndoEntry {
  messages: Message[];
  memorySnapshot: PersistedMemorySnapshot;
  restoredAtMessageId: string;
}

export interface RootFileTree {
  root: string;
  name: string;
  files: FileNode[];
}

/** Normalize message to MessagePart[]. Prefers parts, falls back to segments then toolCalls. */
export function getMessageParts(msg: Message | { parts?: MessagePart[]; segments?: MessageSegment[]; toolCalls?: MessageToolCall[]; content?: string }): MessagePart[] {
  if (msg.parts && msg.parts.length > 0) return msg.parts;
  if (msg.segments && msg.segments.length > 0) {
    return msg.segments.map((s) =>
      s.type === 'text'
        ? { type: 'text' as const, content: s.content }
        : { type: 'tool' as const, toolCall: s.toolCall },
    );
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    const parts: MessagePart[] = msg.toolCalls.map((tc) => ({ type: 'tool' as const, toolCall: tc }));
    if (typeof msg.content === 'string' && msg.content.trim()) {
      parts.push({ type: 'text', content: msg.content });
    }
    return parts;
  }
  // Plain text content with no structured parts
  if (typeof msg.content === 'string' && msg.content.trim()) {
    return [{ type: 'text', content: msg.content }];
  }
  return [];
}

/** Extract first text from a message for title/summary. Handles string content, parts, or segments. */
export function extractFirstTextFromMessage(msg: Message): string {
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
  const parts = getMessageParts(msg);
  if (parts.length) {
    for (const p of parts) {
      if (p.type === 'text' && p.content?.trim()) return p.content;
    }
  }
  return '';
}

/** Maximum characters for auto-generated chat titles. */
const TITLE_MAX_LENGTH = 50;

// Generate chat title from first user message (handles multimodal/segmented)
function generateTitle(messages: Message[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) {
    const text = extractFirstTextFromMessage(firstUser);
    if (text) {
      const chars = Array.from(text);
      const truncated = chars.slice(0, TITLE_MAX_LENGTH).join('');
      return chars.length > TITLE_MAX_LENGTH ? truncated + '...' : truncated;
    }
  }
  // Fallback: use first assistant message text (e.g. tool-only conversations)
  const firstAssistant = messages.find(m => m.role === 'assistant');
  if (firstAssistant) {
    const text = extractFirstTextFromMessage(firstAssistant);
    if (text) {
      const chars = Array.from(text);
      const truncated = chars.slice(0, TITLE_MAX_LENGTH).join('');
      return chars.length > TITLE_MAX_LENGTH ? truncated + '...' : truncated;
    }
  }
  return 'New Chat';
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  language?: string;
  expanded?: boolean;
  /** True when this path matches .atlsignore */
  ignored?: boolean;
}

export interface Issue {
  id: string;
  patternId: string;
  file: string;
  line: number;
  message: string;
  severity: 'high' | 'medium' | 'low';
  category: string;
}

export interface MessageToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  thoughtSignature?: string;
  /** Per-step breakdown for batch tool calls; metrics expand these instead of the parent */
  syntheticChildren?: Array<{ id: string; name: string; args?: Record<string, unknown>; result?: string; status?: string }>;
}

// ── Typed Stream Protocol (Vercel AI SDK-inspired) ──────────────────────

/** Wire format: discriminated chunks emitted by the Rust backend via `chat-chunk-{id}`. */
export type StreamChunk =
  | { type: 'text_start'; id: string }
  | { type: 'text_delta'; id: string; delta: string }
  | { type: 'text_end'; id: string }
  | { type: 'reasoning_start'; id: string }
  | { type: 'reasoning_delta'; id: string; delta: string }
  | { type: 'reasoning_end'; id: string }
  | { type: 'tool_input_start'; tool_call_id: string; tool_name: string }
  | { type: 'tool_input_delta'; tool_call_id: string; input_text_delta: string }
  | { type: 'tool_input_available'; tool_call_id: string; tool_name: string; input: Record<string, unknown>; thought_signature?: string }
  | { type: 'start_step' }
  | { type: 'finish_step' }
  | { type: 'usage'; input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; openai_cached_tokens?: number; cached_content_tokens?: number }
  | { type: 'stop_reason'; reason: string }
  | { type: 'status'; message: string }
  | { type: 'error'; error_text: string }
  | { type: 'done' };

/** Tool call lifecycle states during streaming. */
export type ToolCallStatus = 'input-streaming' | 'input-available' | 'running' | 'completed' | 'failed' | 'output-error';

/** Live streaming part (mutable, used during streaming). */
export type StreamPart =
  | { type: 'text'; id: string; content: string; state: 'streaming' | 'done' }
  | { type: 'reasoning'; id: string; content: string; state: 'streaming' | 'done' }
  | { type: 'tool'; toolCall: { id: string; name: string; args?: Record<string, unknown>; argsText?: string; result?: string; status: ToolCallStatus } }
  | { type: 'step-boundary' }
  | { type: 'error'; errorText: string };

/** Finalized message part (immutable, stored in Message). */
export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool'; toolCall: MessageToolCall }
  | { type: 'step-boundary' }
  | { type: 'error'; errorText: string };

// Legacy segment type (backward compat alias)
export type MessageSegment = 
  | { type: 'text'; content: string }
  | { type: 'tool'; toolCall: MessageToolCall };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /** Rich typed parts (preferred renderer path). Use getMessageParts() for normalized access. */
  parts?: MessagePart[];
  /** @deprecated Use parts. Kept for backward compat with loaded sessions. */
  segments?: MessageSegment[];
  /** @deprecated Use parts. Kept for backward compat with loaded sessions. */
  toolCalls?: MessageToolCall[];
  actions?: Array<{
    type: 'view' | 'explain';
    label: string;
    data: any;
  }>;
  /** True if this message content is a compressed chunk reference */
  isChunkRef?: boolean;
  /** Hash of the full content stored in contextStore (when isChunkRef is true) */
  chunkHash?: string;
  /** Snapshot of file/image attachments sent with this message (for display components) */
  attachments?: ChatAttachment[];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  contextUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costCents: number;
  };
}

export interface ScanStatus {
  isScanning: boolean;
  progress: number;
  currentFile?: string;
  filesProcessed: number;
  filesTotal: number;
  /** Human-readable label for current phase (e.g. "Scanning files", "Indexing") */
  phase?: string;
  /** Multi-repo scan queue tracking */
  scanQueueTotal?: number;
  scanQueueCompleted?: number;
  currentScanRoot?: string;
}

export interface IssueCounts {
  high: number;
  medium: number;
  low: number;
  total: number;
}

/**
 * Project profile for AI context (TOON-optimized)
 */
export interface WorkspaceEntry {
  name: string;
  path: string;       // relative to project root ("." for root)
  abs_path?: string;  // absolute path for running commands
  types: string[];     // ["rust"], ["node", "typescript"], etc.
  build_files: string[];
  group: string | null;
  source: 'auto' | 'manual';
}

export interface EntryManifestEntry {
  path: string;
  sig: string;
  tokens: number;
  lines: number;
  importance: number;
  method: 'naming' | 'graph' | 'both';
  tier: 'full' | 'summary';
}

export interface ProjectProfile {
  proj: string;
  stats: {
    files: number;
    loc: number;
    langs: Record<string, number>;
  };
  stack: string[];
  arch: {
    mods: string[];
    entry: string[];
  };
  health: {
    issues: { h: number; m: number; l: number };
    hotspots: string[];
    cats: Record<string, number>;
  };
  patterns: string[];
  deps: {
    prod: string[];
    dev: string[];
  };
  workspaces: WorkspaceEntry[];
  entryManifest?: EntryManifestEntry[];
}

// Tool call tracking
export interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  args?: Record<string, any>;
  result?: string;
  startTime: Date;
  endTime?: Date;
  error?: string;
  thoughtSignature?: string;
}

// Context usage tracking
export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  /** Session cost in cents (optional until first usage update) */
  costCents?: number;
}

// Prompt overhead breakdown — tokens consumed by instructions/tools, not user content
export interface PromptMetrics {
  modePromptTokens: number;
  toolRefTokens: number;
  shellGuideTokens: number;
  nativeToolTokens: number;
  primerTokens: number;
  contextControlTokens: number;
  workspaceContextTokens: number;
  entryManifestTokens?: number;
  totalOverheadTokens: number;
  // Per-round delta: tokens not sent due to compression (cumulative across compressions)
  compressionSavings: number;
  compressionCount: number;
  // Per-round delta: tokens freed from working memory (mirrors contextStore.freedTokens)
  // => total per-round savings = compressionSavings + freedTokens (from contextStore)
  // Compounding: each API round re-sends everything, so savings multiply across rounds
  roundCount: number;
  cumulativeInputSaved: number; // sum of perRoundSavings across all rounds
  /** Cache composition estimates (for CacheCompositionSection) */
  bp2ToolDefTokens?: number;
  bp3PriorTurnsTokens?: number;
}

// Provider-level cache metrics (Anthropic cache_creation/cache_read tokens)
export interface CacheMetrics {
  sessionCacheWrites: number;
  sessionCacheReads: number;
  sessionUncached: number;
  sessionRequests: number;
  lastRequestHitRate: number;
  sessionHitRate: number;
  /** Last request cached tokens (OpenAI cached_tokens or Gemini cachedContentTokenCount) */
  lastRequestCachedTokens?: number;
}

// AI Model info
export interface ModelInfo {
  id: string;
  name: string;
  provider: 'anthropic' | 'openai' | 'google' | 'vertex' | 'lmstudio';
  contextWindow?: number;
  isReasoning?: boolean;
  isFast?: boolean;
  hasHighContext?: boolean;
}

// AI Agent configuration
export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  icon?: string;
  isCustom?: boolean;
}

// Chat mode - matches aiService.ts (swarm is extended mode for multi-agent)
// 'planner' is internal-only for swarm orchestrator planning phase
export type ChatMode = 'agent' | 'designer' | 'ask' | 'reviewer' | 'retriever' | 'custom' | 'swarm' | 'refactor' | 'planner';

// Agent progress tracking - displayed in status card
export interface AgentToolSummary {
  id: string;
  name: string;
  detail: string;
  status: 'running' | 'completed' | 'failed';
  round: number;
  parentId?: string;
  stepId?: string;
  stepIndex?: number;
  totalSteps?: number;
}

export type AgentPendingAction = 'none' | 'confirmation_required' | 'paused_on_error' | 'state_changed' | 'blocked';
export type AgentPendingActionSource = 'tool' | 'user' | 'system';

export interface AgentPendingActionState {
  kind: AgentPendingAction;
  source: AgentPendingActionSource;
  summary: string;
  toolName?: string;
  stepId?: string;
  stepIndex?: number;
}

export interface AgentProgress {
  status: 'idle' | 'thinking' | 'executing' | 'auto_continuing' | 'stopped';
  round: number;
  maxRounds: number;
  toolsCompleted: number;
  toolsTotal: number;
  currentTask: string;
  stoppedReason: string;
  autoContinueCount: number;
  maxAutoContinues: number;
  recentTools: AgentToolSummary[];
  pendingAction: AgentPendingActionState;
  canTaskComplete: boolean;
}

const DEFAULT_AGENT_PROGRESS: AgentProgress = {
  status: 'idle',
  round: 0,
  maxRounds: 50,
  toolsCompleted: 0,
  toolsTotal: 0,
  currentTask: '',
  stoppedReason: '',
  autoContinueCount: 0,
  maxAutoContinues: 5,
  recentTools: [],
  pendingAction: {
    kind: 'none',
    source: 'system',
    summary: '',
  },
  canTaskComplete: true,
};

// AI provider type (matches aiService)
export type AIProvider = 'anthropic' | 'openai' | 'google' | 'vertex' | 'lmstudio';

// Settings
export interface Settings {
  // Provider enable/disable (empty = all enabled)
  disabledProviders: AIProvider[];
  // Provider credentials
  anthropicApiKey: string;
  openaiApiKey: string;
  googleApiKey: string;
  vertexAccessToken: string;
  vertexProjectId: string;
  vertexRegion: string;
  lmstudioBaseUrl: string;
  // Model selection
  selectedModel: string;
  selectedProvider: 'anthropic' | 'openai' | 'google' | 'vertex' | 'lmstudio';
  // SubAgent model: 'none' = disabled, '' = auto-select cheapest, or explicit model id
  subagentModel: string;
  subagentProvider: 'anthropic' | 'openai' | 'google' | 'vertex' | 'lmstudio' | '';
  // Generation settings
  maxTokens: number;
  temperature: number;
  // Agent settings
  maxIterations: number; // 0 = unlimited
  // Editor settings
  fontSize: number;
  autoSave: boolean;
  // Theme
  theme: 'dark' | 'light';
  // Model visibility filters (Settings > Models tab)
  modelFilters: {
    showReasoning: boolean;
    showFast: boolean;
    showHighContext: boolean;
    /** When true (default), only show models that support tools */
    showToolCapableOnly: boolean;
  };
  // Extended context (200K→1M) per provider when model supports it
  extendedContext: Partial<Record<AIProvider, boolean>>;
  // Entry manifest depth: 'off' = skip, 'paths' = file list only, 'sigs' = full signatures (default)
  entryManifestDepth: 'off' | 'paths' | 'sigs';
}

/** Per-category severity enables. Key = category, value = enabled severities */
export type FocusMatrix = Record<string, string[]>;

export interface FocusProfile {
  matrix: FocusMatrix;
}

/** All known categories for the matrix UI */
export const ALL_CATEGORIES = [
  'performance', 'security', 'maintainability', 'style',
  'correctness', 'code_quality', 'error_handling', 'architecture',
] as const;

/** Default "Full Scan" profile: every category at all severities */
export const DEFAULT_FOCUS_PROFILE: FocusProfile = {
  matrix: Object.fromEntries(ALL_CATEGORIES.map(c => [c, ['high', 'medium', 'low']])),
};

interface AppState {
  // Project
  projectPath: string | null;
  setProjectPath: (path: string | null) => void;
  atlsInitialized: boolean;
  setAtlsInitialized: (initialized: boolean) => void;
  projectHistory: ProjectHistoryEntry[];
  addToProjectHistory: (path: string) => void;

  // Files
  files: FileNode[];
  setFiles: (files: FileNode[]) => void;
  selectedFile: string | null;
  setSelectedFile: (path: string | null) => void;
  selectedFiles: Set<string>;
  lastSelectedFile: string | null;
  toggleFileSelection: (path: string, ctrlKey: boolean, shiftKey: boolean, allVisiblePaths: string[]) => void;
  clearFileSelection: () => void;
  clearSelection: () => void;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
  collapseAllFolders: () => void;
  openFiles: string[];
  activeFile: string | null;
  openFile: (path: string) => void;
  closeFile: (path: string) => void;
  setActiveFile: (path: string | null) => void;
  pendingScrollLine: number | null;
  setPendingScrollLine: (line: number | null) => void;

  // Issues
  issues: Issue[];
  setIssues: (issues: Issue[]) => void;
  issueCounts: IssueCounts;
  setIssueCounts: (counts: IssueCounts) => void;
  scanStatus: ScanStatus;
  setScanStatus: (status: Partial<ScanStatus>) => void;

  // Project profile
  projectProfile: ProjectProfile | null;
  setProjectProfile: (profile: ProjectProfile | null) => void;
  languageHealth: LanguageHealth[] | null;
  setLanguageHealth: (data: LanguageHealth[] | null) => void;
  atlsPanelTab: TabType;
  setAtlsPanelTab: (tab: TabType) => void;

  // Focus profile
  focusProfile: FocusProfile;
  focusProfileName: string;
  setFocusProfile: (name: string, profile: FocusProfile) => void;

  // Chat sessions
  chatSessions: ChatSession[];
  currentSessionId: string | null;
  messages: Message[];
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => void;
  clearMessages: () => void;
  newChat: () => void;
  loadSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  saveCurrentSession: () => void;
  isGenerating: boolean;
  setIsGenerating: (isGenerating: boolean) => void;
  currentInput: string;
  setCurrentInput: (input: string) => void;
  chatSessionId: number;
  incrementChatSession: () => number;
  agentCanContinue: boolean;
  setAgentCanContinue: (canContinue: boolean) => void;
  agentProgress: AgentProgress;
  setAgentProgress: (progress: Partial<AgentProgress>) => void;
  setAgentPendingAction: (pendingAction: AgentPendingActionState) => void;
  clearAgentPendingAction: () => void;
  resetAgentProgress: () => void;

  // Chat restore (edit-and-resend)
  restoreUndoStack: RestoreUndoEntry | null;
  setRestoreUndoStack: (entry: RestoreUndoEntry | null) => void;
  restoreToMessage: (messageId: string, editedContent?: string) => Message[];
  undoRestore: () => void;
  clearRestoreUndo: () => void;

  // Tool calls
  toolCalls: ToolCall[];
  addToolCall: (toolCall: ToolCall) => void;
  updateToolCall: (id: string, updates: Partial<ToolCall>) => void;
  upsertToolCall: (id: string, call: Partial<ToolCall>) => void;
  clearToolCalls: () => void;

  // Context accounting
  contextUsage: ContextUsage;
  setContextUsage: (usage: Partial<ContextUsage>) => void;
  promptMetrics: PromptMetrics;
  setPromptMetrics: (metrics: Partial<PromptMetrics>) => void;
  addCompressionSavings: (tokensSaved: number, count: number) => void;
  recordRound: () => void;
  cacheMetrics: CacheMetrics;
  addCacheMetrics: (metrics: { cacheWrite: number; cacheRead: number; uncached: number; lastRequestCachedTokens?: number }) => void;
  resetCacheMetrics: () => void;

  // Settings
  settings: Settings;
  setSettings: (settings: Partial<Settings>) => void;
  updateSettings: (settings: Partial<Settings>) => void;
  availableModels: ModelInfo[];
  setAvailableModels: (models: ModelInfo[]) => void;
  modelsLoading: boolean;
  setModelsLoading: (loading: boolean) => void;

  // Chat mode and custom agents
  chatMode: ChatMode;
  setChatMode: (mode: ChatMode) => void;
  selectedAgent: string;
  setSelectedAgent: (agentId: string) => void;
  customAgents: Agent[];
  addCustomAgent: (agent: Omit<Agent, 'id' | 'isCustom'>) => void;
  removeCustomAgent: (id: string) => void;
  designPreviewContent: string;
  designPreviewSessionId: string | null;
  setDesignPreview: (content: string, sessionId: string | null) => void;
  clearDesignPreview: () => void;

  // Workspace
  rootFolders: string[];
  activeRoot: string | null;
  workspaceFilePath: string | null;
  rootFileTrees: RootFileTree[];
  addRootFolder: (path: string) => void;
  removeRootFolder: (path: string) => void;
  setActiveRoot: (path: string | null) => void;
  setWorkspaceFilePath: (path: string | null) => void;
  setRootFileTrees: (trees: RootFileTree[]) => void;
  clearWorkspace: () => void;

  // UI state
  quickActionsOpen: boolean;
  setQuickActionsOpen: (open: boolean) => void;
  quickFindOpen: boolean;
  setQuickFindOpen: (open: boolean) => void;
  searchPanelOpen: boolean;
  setSearchPanelOpen: (open: boolean) => void;
  terminalOpen: boolean;
  setTerminalOpen: (open: boolean) => void;
  explorerCollapsed: boolean;
  terminalCollapsed: boolean;
  toggleExplorerCollapsed: () => void;
  toggleTerminalCollapsed: () => void;

  // Clipboard
  clipboardPaths: string[];
  clipboardMode: 'copy' | 'cut' | null;
  setClipboard: (paths: string[], mode: 'copy' | 'cut') => void;
  clearClipboard: () => void;

  // Toasts
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Project
  projectPath: null,
  setProjectPath: (path) => set({ projectPath: path }),
  atlsInitialized: false,
  setAtlsInitialized: (initialized) => set({ atlsInitialized: initialized }),
  projectHistory: [],
  addToProjectHistory: (path) => set((state) => {
    const name = path.split(/[/\\]/).pop() || path;
    const entry: ProjectHistoryEntry = {
      path,
      name,
      lastOpened: new Date(),
    };
    
    // Remove existing entry for same path, add new one at front
    const filtered = state.projectHistory.filter(h => h.path !== path);
    const newHistory = normalizeProjectHistory([entry, ...filtered]);
    saveProjectHistory(newHistory);
    
    return { projectHistory: newHistory };
  }),
  
  // Files
  files: [],
  setFiles: (files) => set({ files }),
  selectedFile: null,
  setSelectedFile: (path) => set({ selectedFile: path }),
  selectedFiles: new Set<string>(),
  lastSelectedFile: null,
  toggleFileSelection: (path, ctrlKey, shiftKey, allVisiblePaths) => set((state) => {
    const newSelected = new Set(state.selectedFiles);
    let lastSelectedFile = state.lastSelectedFile;

    if (shiftKey && lastSelectedFile) {
      const startIdx = allVisiblePaths.indexOf(lastSelectedFile);
      const endIdx = allVisiblePaths.indexOf(path);
      if (startIdx === -1) {
        newSelected.clear();
        newSelected.add(path);
        return { selectedFiles: newSelected, lastSelectedFile: path, selectedFile: path };
      }
      if (endIdx !== -1) {
        const from = Math.min(startIdx, endIdx);
        const to = Math.max(startIdx, endIdx);
        if (!ctrlKey) newSelected.clear();
        for (let i = from; i <= to; i++) {
          newSelected.add(allVisiblePaths[i]);
        }
        return { selectedFiles: newSelected, lastSelectedFile, selectedFile: path };
      }
      // Target path not in visible list — no-op, preserve current selection
      return { selectedFiles: newSelected, lastSelectedFile, selectedFile: state.selectedFile };
    }

    if (ctrlKey) {
      if (newSelected.has(path)) {
        newSelected.delete(path);
        if (lastSelectedFile === path) {
          const remaining = [...newSelected];
          lastSelectedFile = remaining.length > 0 ? remaining[0] ?? null : null;
        }
      } else {
        newSelected.add(path);
        lastSelectedFile = path;
      }
      return { selectedFiles: newSelected, lastSelectedFile, selectedFile: path };
    }

    newSelected.clear();
    newSelected.add(path);
    return { selectedFiles: newSelected, lastSelectedFile: path, selectedFile: path };
  }),
  clearSelection: () => set({ selectedFiles: new Set(), lastSelectedFile: null }),
  clearFileSelection: () => set({ selectedFiles: new Set(), lastSelectedFile: null }),
  expandedFolders: new Set(),
  toggleFolder: (path) => set((state) => {
    const newExpanded = new Set(state.expandedFolders);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
    }
    return { expandedFolders: newExpanded };
  }),
  collapseAllFolders: () => set({ expandedFolders: new Set() }),
  
  // Clipboard for cut/copy/paste
  clipboardPaths: [],
  clipboardMode: null,
  setClipboard: (paths, mode) => set({ clipboardPaths: paths, clipboardMode: mode }),
  clearClipboard: () => set({ clipboardPaths: [], clipboardMode: null }),
  
  // Editor
  openFiles: [],
  activeFile: null,
  openFile: (path) => set((state) => {
    if (state.openFiles.includes(path)) {
      return { activeFile: path };
    }
    const openFiles = [...state.openFiles, path];
    return { openFiles, activeFile: path };
  }),
  closeFile: (path) => set((state) => {
    const newOpenFiles = state.openFiles.filter((f) => f !== path);
    let newActiveFile = state.activeFile;
    if (state.activeFile === path) {
      const idx = state.openFiles.indexOf(path);
      if (idx === -1 || newOpenFiles.length === 0) {
        // File already removed or last tab closed
        newActiveFile = newOpenFiles.length > 0 ? newOpenFiles[0] : null;
      } else {
        // Prefer tab at same position (right neighbor), else left neighbor
        newActiveFile = newOpenFiles[Math.min(idx, newOpenFiles.length - 1)] ?? null;
      }
    }
    return { openFiles: newOpenFiles, activeFile: newActiveFile };
  }),
  setActiveFile: (path) => set({ activeFile: path }),
  pendingScrollLine: null,
  setPendingScrollLine: (line) => set({ pendingScrollLine: line }),
  
  // Issues
  issues: [],
  setIssues: (issues) => set({ issues }),
  issueCounts: { high: 0, medium: 0, low: 0, total: 0 },
  setIssueCounts: (counts) => set({ issueCounts: counts }),
  // Scan status
  scanStatus: {
    isScanning: false,
    progress: 0,
    filesProcessed: 0,
    filesTotal: 0,
    phase: undefined,
  },
  setScanStatus: (status) => set((state) => ({
    scanStatus: { ...state.scanStatus, ...status }
  })),
  
  // Project profile
  projectProfile: null,
  
  // Language health
  languageHealth: null,
  setLanguageHealth: (data) => set({ languageHealth: data }),

  // ATLS panel tab
  atlsPanelTab: 'issues' as import('../components/AtlsPanel/types').TabType,
  setAtlsPanelTab: (tab) => set({ atlsPanelTab: tab }),

  // Focus profile defaults
  focusProfile: DEFAULT_FOCUS_PROFILE,
  focusProfileName: 'Full Scan',
  setFocusProfile: (name, profile) => set({ focusProfileName: name, focusProfile: profile }),
  setProjectProfile: (profile) => set({ projectProfile: profile }),
  
  // Chat sessions (populated from database via useChatPersistence)
  chatSessions: [],
  currentSessionId: null,
  messages: [],
  
  addMessage: (message) => set((state) => {
    const newMessage: Message = {
      ...message,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    return { messages: [...state.messages, newMessage] };
  }),
  
  clearMessages: () => set({ messages: [] }),
  
  newChat: () => set((state) => {
    // Just clear state - database persistence handled by useChatPersistence
    return { 
      currentSessionId: null, 
      messages: [],
      restoreUndoStack: null,
      // Reset context usage for new chat
      contextUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        maxTokens: state.contextUsage.maxTokens,
        percentage: 0,
      },
      // Reset prompt metrics for new session
      promptMetrics: {
        modePromptTokens: 0, toolRefTokens: 0, shellGuideTokens: 0,
        nativeToolTokens: 0, primerTokens: 0, contextControlTokens: 0,
        workspaceContextTokens: 0,
        totalOverheadTokens: 0, compressionSavings: 0,
        compressionCount: 0, roundCount: 0, cumulativeInputSaved: 0,
      },
      // Reset cache metrics for new session
      cacheMetrics: {
        sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
        sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
        lastRequestCachedTokens: undefined,
      },
    };
  }),
  
  // Note: Actual session loading from database is done via useChatPersistence.loadSession()
  // This is kept for compatibility but should use the hook instead
  loadSession: (sessionId: string) => set((state) => {
    // Just set the session ID - messages loaded via useChatPersistence
    return { currentSessionId: sessionId };
  }),
  
  // Note: Actual deletion from database is done via useChatPersistence.deleteSession()
  deleteSession: (sessionId: string) => set((state) => {
    const newSessions = state.chatSessions.filter(s => s.id !== sessionId);
    
    // If deleting current session, clear messages and reset context
    if (state.currentSessionId === sessionId) {
      return {
        chatSessions: newSessions,
        currentSessionId: null,
        messages: [],
        contextUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          maxTokens: state.contextUsage.maxTokens,
          percentage: 0,
        },
        promptMetrics: {
          modePromptTokens: 0, toolRefTokens: 0, shellGuideTokens: 0,
          nativeToolTokens: 0, primerTokens: 0, contextControlTokens: 0,
          workspaceContextTokens: 0, entryManifestTokens: 0,
          totalOverheadTokens: 0, compressionSavings: 0,
          compressionCount: 0, roundCount: 0, cumulativeInputSaved: 0,
        },
      cacheMetrics: {
        sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
        sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
        lastRequestCachedTokens: undefined,
      },
    };
    }
    return { chatSessions: newSessions };
  }),
  
  // Note: Actual saving to database is done via useChatPersistence.saveSession()
  // This updates local state only - used for UI updates
  saveCurrentSession: () => set((state) => {
    if (state.messages.length === 0) return {};
    
    const now = new Date();
    const sessionId = state.currentSessionId || crypto.randomUUID();
    const currentSession: ChatSession = {
      id: sessionId,
      title: generateTitle(state.messages),
      messages: [], // Don't duplicate messages in session list
      createdAt: state.chatSessions.find(s => s.id === sessionId)?.createdAt || now,
      updatedAt: now,
      contextUsage: {
        inputTokens: state.contextUsage.inputTokens,
        outputTokens: state.contextUsage.outputTokens,
        totalTokens: state.contextUsage.totalTokens,
        costCents: state.contextUsage.costCents ?? 0,
      },
    };
    
    const existingIndex = state.chatSessions.findIndex(s => s.id === sessionId);
    let newSessions: ChatSession[];
    if (existingIndex >= 0) {
      newSessions = [...state.chatSessions];
      newSessions[existingIndex] = currentSession;
    } else {
      newSessions = [currentSession, ...state.chatSessions];
    }
    
    newSessions = newSessions.slice(0, 50);
    
    return {
      chatSessions: newSessions,
      currentSessionId: sessionId,
    };
  }),
  
  isGenerating: false,
  setIsGenerating: (generating) => set({ isGenerating: generating }),
  currentInput: '',
  setCurrentInput: (input) => set({ currentInput: input }),
  
  // Agent continuation
  agentCanContinue: false,
  setAgentCanContinue: (canContinue) => set({ agentCanContinue: canContinue }),
  
  // Agent progress tracking
  agentProgress: { ...DEFAULT_AGENT_PROGRESS },
  setAgentProgress: (progress) => set((state) => ({
    agentProgress: { ...state.agentProgress, ...progress },
  })),
  setAgentPendingAction: (pendingAction) => set((state) => ({
    agentProgress: {
      ...state.agentProgress,
      pendingAction,
      canTaskComplete: pendingAction.kind === 'none',
    },
  })),
  clearAgentPendingAction: () => set((state) => ({
    agentProgress: {
      ...state.agentProgress,
      pendingAction: { kind: 'none', source: 'system', summary: '' },
      canTaskComplete: true,
    },
  })),
  resetAgentProgress: () => set({ agentProgress: { ...DEFAULT_AGENT_PROGRESS } }),

  // Chat restore (edit-and-resend)
  restoreUndoStack: null,
  setRestoreUndoStack: (entry) => set({ restoreUndoStack: entry }),

  restoreToMessage: (messageId, editedContent) => {
    let truncated: Message[] = [];
    set((state) => {
      const idx = state.messages.findIndex(m => m.id === messageId);
      if (idx < 0) return state;
      // When editing, truncate *before* the target so handleSend can re-add it fresh.
      // When just restoring (no edit), keep the target message.
      if (editedContent !== undefined) {
        truncated = state.messages.slice(idx);
        return { messages: state.messages.slice(0, idx) };
      }
      truncated = state.messages.slice(idx + 1);
      return { messages: state.messages.slice(0, idx + 1) };
    });
    return truncated;
  },

  undoRestore: () => set((state) => {
    if (!state.restoreUndoStack) return state;
    return {
      messages: state.restoreUndoStack.messages,
      restoreUndoStack: null,
    };
  }),

  clearRestoreUndo: () => set({ restoreUndoStack: null }),

  // Chat session tracking - incremented on new chat, checked before UI updates
  chatSessionId: 0,
  incrementChatSession: () => {
    let newId = 0;
    set((state) => {
      newId = state.chatSessionId + 1;
      return { chatSessionId: newId };
    });
    return newId;
  },
  
  // Tool calls
  toolCalls: [],
  addToolCall: (call) => {
    const id = call.id || crypto.randomUUID();
    set((state) => {
      const existingCalls = state.toolCalls.slice(-19);
      const raw = call as unknown as Record<string, unknown>;
      const startTime = raw.startTime !== undefined ? rehydrateDate(raw.startTime) : new Date();
      return {
        toolCalls: [...existingCalls, {
          ...call,
          id,
          startTime,
        }]
      };
    });
    return id;
  },
  updateToolCall: (id, update) => set((state) => ({
    toolCalls: state.toolCalls.map((tc) => {
      if (tc.id !== id) return tc;
      const merged = { ...tc, ...update };
      if (update.startTime !== undefined) {
        merged.startTime = rehydrateDate(update.startTime);
      }
      return merged;
    })
  })),
  upsertToolCall: (id, call) => {
    set((state) => {
      const exists = state.toolCalls.some(tc => tc.id === id);
      const startTime = call.startTime !== undefined ? rehydrateDate(call.startTime) : new Date();
      if (exists) {
        return {
          toolCalls: state.toolCalls.map((tc) =>
            tc.id === id ? { ...tc, ...call, startTime: call.startTime !== undefined ? startTime : tc.startTime } : tc
          )
        };
      }
      const MAX_TOOL_CALLS = 20;
      const startTime2 = call.startTime !== undefined ? rehydrateDate(call.startTime) : new Date();
      const newCall: ToolCall = {
        ...call,
        id,
        name: call.name || 'unknown',
        status: call.status || 'pending',
        startTime: startTime2,
      } as ToolCall;
      const calls = [...state.toolCalls, newCall];
      return {
        toolCalls: calls.length > MAX_TOOL_CALLS ? calls.slice(-MAX_TOOL_CALLS) : calls,
      };
    });
    // Note: Auto-removal disabled to prevent setTimeout pile-up
    // Tool calls are cleared by clearToolCalls() after chat completes
  },
  clearToolCalls: () => set({ toolCalls: [] }),
  
  // Context usage
  contextUsage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxTokens: 200000, // Claude default
    percentage: 0,
  },
  setContextUsage: (usage) => set((state) => {
    const newUsage = { ...state.contextUsage, ...usage };
    newUsage.totalTokens = newUsage.inputTokens + newUsage.outputTokens;
    // percentage based on input tokens only — output tokens don't consume context window
    newUsage.percentage = Math.min(100, (newUsage.inputTokens / newUsage.maxTokens) * 100);
    return { contextUsage: newUsage };
  }),
  
  // Prompt overhead metrics
  promptMetrics: {
    modePromptTokens: 0,
    toolRefTokens: 0,
    shellGuideTokens: 0,
    nativeToolTokens: 0,
    primerTokens: 0,
    contextControlTokens: 0,
    workspaceContextTokens: 0,
    totalOverheadTokens: 0,
    compressionSavings: 0,
    compressionCount: 0,
    roundCount: 0,
    cumulativeInputSaved: 0,
  },
  setPromptMetrics: (metrics) => set((state) => {
    const updated = { ...state.promptMetrics, ...metrics };
    updated.totalOverheadTokens = updated.modePromptTokens + updated.toolRefTokens
      + updated.shellGuideTokens
      + (updated.nativeToolTokens ?? 0) + (updated.primerTokens ?? 0)
      + updated.contextControlTokens
      + updated.workspaceContextTokens
      + (updated.entryManifestTokens ?? 0);
    return { promptMetrics: updated };
  }),
  addCompressionSavings: (tokensSaved, count) => set((state) => ({
    promptMetrics: {
      ...state.promptMetrics,
      compressionSavings: state.promptMetrics.compressionSavings + tokensSaved,
      compressionCount: state.promptMetrics.compressionCount + count,
    },
  })),
  recordRound: () => set((state) => {
    const { compressionSavings } = state.promptMetrics;
    const freedTokens = useContextStore.getState().freedTokens;
    const perRoundSavings = compressionSavings + freedTokens;
    return {
      promptMetrics: {
        ...state.promptMetrics,
        roundCount: state.promptMetrics.roundCount + 1,
        cumulativeInputSaved: state.promptMetrics.cumulativeInputSaved + perRoundSavings,
      },
    };
  }),
  
  // Provider cache metrics
  cacheMetrics: {
    sessionCacheWrites: 0,
    sessionCacheReads: 0,
    sessionUncached: 0,
    sessionRequests: 0,
    lastRequestHitRate: 0,
    sessionHitRate: 0,
  },
  addCacheMetrics: ({ cacheWrite, cacheRead, uncached, lastRequestCachedTokens }) => set((state) => {
    const newWrites = state.cacheMetrics.sessionCacheWrites + cacheWrite;
    const newReads = state.cacheMetrics.sessionCacheReads + cacheRead;
    const newUncached = state.cacheMetrics.sessionUncached + uncached;
    const newRequests = state.cacheMetrics.sessionRequests + 1;
    const totalInput = cacheWrite + cacheRead + uncached;
    const lastHit = totalInput > 0 ? cacheRead / totalInput : 0;
    const sessionTotal = newWrites + newReads + newUncached;
    const sessionHit = sessionTotal > 0 ? newReads / sessionTotal : 0;
    return {
      cacheMetrics: {
        sessionCacheWrites: newWrites,
        sessionCacheReads: newReads,
        sessionUncached: newUncached,
        sessionRequests: newRequests,
        lastRequestHitRate: lastHit,
        sessionHitRate: sessionHit,
        ...(lastRequestCachedTokens != null && { lastRequestCachedTokens }),
      },
    };
  }),
  resetCacheMetrics: () => set({
    cacheMetrics: {
      sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
      sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
      lastRequestCachedTokens: undefined,
    },
  }),
  
  // Settings - load from localStorage on init
  settings: (() => {
    const saved = typeof localStorage !== 'undefined' 
      ? localStorage.getItem('atls-studio-settings') 
      : null;
    const defaults: Settings = {
      disabledProviders: [],
      anthropicApiKey: '',
      openaiApiKey: '',
      googleApiKey: '',
      vertexAccessToken: '',
      vertexProjectId: '',
      vertexRegion: 'us-central1',
      lmstudioBaseUrl: 'http://localhost:1234',
      selectedModel: 'claude-sonnet-4-5',
      selectedProvider: 'anthropic',
      subagentModel: 'none',
      subagentProvider: '',
      maxTokens: 4096,
      temperature: 0.7,
      maxIterations: 0, // 0 = unlimited (like Cursor)
      fontSize: 13,
      autoSave: true,
      theme: 'dark' as const,
      modelFilters: {
        showReasoning: true,
        showFast: true,
        showHighContext: true,
        showToolCapableOnly: true,
      },
      extendedContext: {},
      entryManifestDepth: 'paths',
    };
    let parsed: Record<string, unknown> = {};
    try { parsed = saved ? JSON.parse(saved) : {}; } catch { /* corrupt settings — use defaults */ }
    const mf = parsed.modelFilters;
    const ec = parsed.extendedContext;
    const modelFiltersSpread = typeof mf === 'object' && mf !== null && !Array.isArray(mf)
      ? (mf as Record<string, boolean>)
      : {};
    const extendedContextSpread = typeof ec === 'object' && ec !== null && !Array.isArray(ec)
      ? (ec as Record<string, unknown>)
      : {};
    return {
      ...defaults,
      ...parsed,
      modelFilters: { ...defaults.modelFilters, ...modelFiltersSpread },
      extendedContext: { ...defaults.extendedContext, ...extendedContextSpread },
    };
  })(),
  setSettings: (newSettings) => set((state) => {
    const merged = { ...state.settings, ...newSettings };
    // Persist to localStorage
    localStorage.setItem('atls-studio-settings', JSON.stringify(merged));
    return { settings: merged };
  }),
  updateSettings: (newSettings) => set((state) => {
    const merged = { ...state.settings, ...newSettings };
    localStorage.setItem('atls-studio-settings', JSON.stringify(merged));
    return { settings: merged };
  }),
  
  // Available models
  availableModels: [],
  setAvailableModels: (models) => set({ availableModels: models }),
  modelsLoading: false,
  setModelsLoading: (loading) => set({ modelsLoading: loading }),
  
  // Chat mode and agents
  chatMode: 'agent',
  setChatMode: (mode) => set({ chatMode: mode }),
  selectedAgent: 'coder',
  designPreviewContent: '',
  designPreviewSessionId: null,
  setDesignPreview: (content, sessionId) => set({
    designPreviewContent: content,
    designPreviewSessionId: sessionId,
  }),
  clearDesignPreview: () => set({
    designPreviewContent: '',
    designPreviewSessionId: null,
  }),
  setSelectedAgent: (agentId) => set({ selectedAgent: agentId }),
  customAgents: [],
  addCustomAgent: (agent) => set((state) => {
    const newAgent: Agent = {
      ...agent,
      id: crypto.randomUUID(),
      isCustom: true,
    };
    const newAgents = [...state.customAgents, newAgent];
    localStorage.setItem('atls-studio-custom-agents', JSON.stringify(newAgents));
    return { customAgents: newAgents };
  }),
  removeCustomAgent: (id) => set((state) => {
    const newAgents = state.customAgents.filter((a) => a.id !== id);
    localStorage.setItem('atls-studio-custom-agents', JSON.stringify(newAgents));
    return { customAgents: newAgents };
  }),
  
  // Multi-root workspace
  rootFolders: [],
  activeRoot: null,
  workspaceFilePath: null,
  rootFileTrees: [],
  addRootFolder: (path) => set((state) => {
    if (state.rootFolders.includes(path)) return state;
    const newRoots = [...state.rootFolders, path];
    return {
      rootFolders: newRoots,
      activeRoot: state.activeRoot ?? path,
      projectPath: state.projectPath ?? path,
    };
  }),
  removeRootFolder: (path) => set((state) => {
    const newRoots = state.rootFolders.filter(r => r !== path);
    const newActive = state.activeRoot === path
      ? (newRoots[0] ?? null)
      : state.activeRoot;
    return {
      rootFolders: newRoots,
      activeRoot: newActive,
      projectPath: newRoots[0] ?? null,
      rootFileTrees: state.rootFileTrees.filter(t => t.root !== path),
    };
  }),
  setActiveRoot: (path) => set({ activeRoot: path }),
  setWorkspaceFilePath: (path) => set({ workspaceFilePath: path }),
  setRootFileTrees: (trees) => set({ rootFileTrees: trees }),
  clearWorkspace: () => set({
    rootFolders: [],
    activeRoot: null,
    workspaceFilePath: null,
    rootFileTrees: [],
    projectPath: null,
    atlsInitialized: false,
    files: [],
    issues: [],
    issueCounts: { high: 0, medium: 0, low: 0, total: 0 },
    projectProfile: null,
    languageHealth: null,
  }),

  // UI State - Modals/Panels
  quickActionsOpen: false,
  setQuickActionsOpen: (open) => set({ quickActionsOpen: open }),
  quickFindOpen: false,
  setQuickFindOpen: (open) => set({ quickFindOpen: open }),
  searchPanelOpen: false,
  setSearchPanelOpen: (open) => set({ searchPanelOpen: open }),
  terminalOpen: false,
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  explorerCollapsed: false,
  terminalCollapsed: false,
  toggleExplorerCollapsed: () => set((s) => ({ explorerCollapsed: !s.explorerCollapsed })),
  toggleTerminalCollapsed: () => set((s) => ({ terminalCollapsed: !s.terminalCollapsed })),
  
  // Toast notifications
  toasts: [],
  addToast: (toast) => set((state) => ({
    toasts: [...state.toasts, { ...toast, id: crypto.randomUUID() }],
  })),
  removeToast: (id) => set((state) => ({
    toasts: state.toasts.filter((t) => t.id !== id),
  })),
}));

// Deferred rehydration: load non-visual state after initial render to avoid blocking startup
queueMicrotask(() => {
  const history = loadProjectHistory();
  if (history.length > 0) {
    useAppStore.setState({ projectHistory: history });
  }

  try {
    const savedAgents = typeof localStorage !== 'undefined'
      ? localStorage.getItem('atls-studio-custom-agents')
      : null;
    if (savedAgents) {
      const parsed = JSON.parse(savedAgents);
      if (Array.isArray(parsed)) useAppStore.setState({ customAgents: parsed });
    }
  } catch { /* ignore corrupt data */ }
});

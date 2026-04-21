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
import type { SpinMode } from '../services/spinDetector';

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
        : s.type === 'reasoning'
          ? { type: 'reasoning' as const, content: s.content }
          : { type: 'tool' as const, toolCall: (s as Extract<MessageSegment, { type: 'tool' }>).toolCall },
    );
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    const parts: MessagePart[] = [];
    if (typeof msg.content === 'string' && msg.content.trim()) {
      parts.push({ type: 'text', content: msg.content });
    }
    for (const tc of msg.toolCalls) {
      parts.push({ type: 'tool' as const, toolCall: tc });
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
  if (typeof msg.content === 'string') {
    const trimmed = msg.content.trim();
    if (trimmed) return trimmed;
  }
  const parts = getMessageParts(msg);
  for (const p of parts) {
    if (p.type === 'text') {
      const trimmed = p.content.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

/** Maximum characters for auto-generated chat titles. */
const TITLE_MAX_LENGTH = 50;

// Generate chat title from first user message (handles multimodal/segmented)
export function generateTitle(messages: Message[]): string {
  // Find first user message with actual text content
  const userMsg = messages.find(m => m.role === 'user');
  if (!userMsg) return 'New Conversation';
  
  const text = extractFirstTextFromMessage(userMsg).trim();
  if (!text) return 'New Conversation';
  
  // Take first line, then truncate to reasonable length
  const firstLine = (text.split('\n')[0] || text).trim();
  const words = firstLine.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'New Conversation';

  const title = words.slice(0, 6).join(' ');
  return title.length > TITLE_MAX_LENGTH ? title.substring(0, TITLE_MAX_LENGTH - 3) + '...' : title;
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
  | { type: 'reasoning'; content: string }
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
  // Monotonic session counter: total input tokens not sent due to history/tool-result compression.
  compressionSavings: number;
  compressionCount: number;
  /** Monotonic session counter: tokens not sent because old rounds were removed into rolling summary. */
  rollingSavings: number;
  /** Rounds distilled into rolling summary this session */
  rolledRounds: number;
  roundCount: number;
  /**
   * ESTIMATED (not billed). Sum of one-time input-token savings events across
   * the session — i.e. deltas between rounds of compression/rolling/freed/input
   * compression counters. See `recordRound` for the formula.
   *
   * Interpretation: "tokens we avoided ever sending." Does not double-count
   * recurring saves across rounds; for that, see `recurringInputSaved`.
   */
  cumulativeInputSaved: number;
  /**
   * ESTIMATED (not billed). "Compounding" view of savings — assumes each round
   * re-sends the full history, so the current compression pool saves itself
   * every round. Sum over rounds of `compressionSavings + rollingSavings` at
   * end-of-round. Useful for "what would I have paid without compression?"
   * but ignores provider prompt caching discounts.
   */
  recurringInputSaved?: number;
  /** Cache composition estimates (for CacheCompositionSection) */
  bp2ToolDefTokens?: number;
  bp3PriorTurnsTokens?: number;
  /** Orphaned compressed rolling summary pointers removed */
  orphanSummaryRemovals: number;
  /**
   * Input-side tool-result compression savings (distinct from
   * `compressionSavings` which tracks history deflation). Cumulative across
   * the session. Populated by `formatResult` when the chat toggle is on.
   */
  inputCompressionSavings?: number;
  /** Number of tool results the input-compression encoder successfully
   *  produced a result for (returns null counts as zero). */
  inputCompressionCount?: number;
  /** Current FileView count in WM (observability only — not gating). */
  fileViewCount?: number;
  /**
   * ESTIMATED. Snapshot sum of skeleton+fill body tokens across all live
   * FileView blocks (what actually lands in the prompt). Use for the
   * "FileView replaced N chunks worth X tk with Y tk of view" line.
   */
  fileViewRenderedTokens?: number;
  /**
   * ESTIMATED. Snapshot sum of `c.tokens` for file-backed chunks that are
   * covered (and thus suppressed) by a FileView. Pairs with
   * `fileViewRenderedTokens` to show first-touch premium vs reuse.
   */
  fileViewCoveredChunkTokens?: number;
  /** Rounds a FileView rendered without a new fill — measures reuse efficiency. */
  fileViewReuseCount?: number;
  /** Cumulative auto-heal `shifted` rebases via freshnessJournal. */
  autoHealShiftedCount?: number;
  /** Cumulative content-change refetches completed. */
  autoRefetchCount?: number;
  /** Cumulative refetches deferred because the per-round cap was hit. */
  autoRefetchSkippedByCap?: number;
  /** Target zero: rounds where the model emitted a "let me re-read because stale" self-correction.
   *  Non-zero indicates an auto-heal bug, not a tuning parameter. */
  staleReadRounds?: number;
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

export interface LogicalCacheState {
  staticHit: boolean | null;
  bp3Hit: boolean | null;
  staticReason: string;
  bp3Reason: string;
  sessionStaticHits: number;
  sessionStaticMisses: number;
  sessionBp3Hits: number;
  sessionBp3Misses: number;
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
  status: 'pending' | 'running' | 'completed' | 'failed';
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

/**
 * Per-category gates for every `<<...>>` intervention message the app injects
 * into the model prompt (or surfaces in batch summaries as tool output).
 *
 * All default to `true` except `spin.tiers.halt`, which stays `false` so halt
 * behavior continues to require an explicit opt-in (matches the legacy
 * {@link Settings.spinCircuitBreakerHaltEnabled} flag). Disabling spin or
 * completion banners can let the model spin longer — this is the user's call.
 *
 * The SpinTrace UI in [`AtlsInternals`](../components/AtlsInternals) renders
 * these toggles; [`aiService.ts`](../services/aiService.ts) and
 * [`batch/executor.ts`](../services/batch/executor.ts) read them at the
 * injection sites. See `docs/intervention-toggles.md` in plan notes.
 */
export interface MessageToggles {
  spin: {
    /** Master switch; when false, `evaluateSpin` is skipped entirely. */
    enabled: boolean;
    /** Per-mode gate. Muted mode decays the tier FSM so re-enabling cannot latch into strong/halt. */
    modes: Record<Exclude<SpinMode, 'none'>, boolean>;
    /** Per-tier gate. Muted tier drops the message but preserves the FSM so escalation continues. */
    tiers: { nudge: boolean; strong: boolean; halt: boolean };
  };
  /** ASSESS pinned-working-memory hygiene nudge. */
  assess: boolean;
  /** Completion-blocker variants emitted in `buildDynamicContextBlock`. */
  completion: { verifyStale: boolean; continueImpl: boolean };
  /** Edit-status banners (`<<DAMAGED EDIT>>` / `<<RECENT EDITS>>` / `<<ESCALATED REPAIR>>`). */
  edits: { damaged: boolean; recent: boolean; escalatedRepair: boolean };
  /** `<<WARN: ... dry-run previewed Nx ...>>` injected into batch summaries. */
  batchReadSpinWarn: boolean;
}

/**
 * Deep-partial of {@link MessageToggles} accepted by
 * {@link AppState.updateMessageToggles}. Only the keys present in the patch
 * are overwritten; sibling keys are preserved.
 */
export interface MessageTogglesPatch {
  spin?: {
    enabled?: boolean;
    modes?: Partial<MessageToggles['spin']['modes']>;
    tiers?: Partial<MessageToggles['spin']['tiers']>;
  };
  assess?: boolean;
  completion?: Partial<MessageToggles['completion']>;
  edits?: Partial<MessageToggles['edits']>;
  batchReadSpinWarn?: boolean;
}

export const DEFAULT_MESSAGE_TOGGLES: MessageToggles = {
  spin: {
    enabled: true,
    modes: {
      context_loss: true,
      goal_drift: true,
      stuck_in_phase: true,
      tool_confusion: true,
      volatile_unpinned: true,
      completion_gate: true,
    },
    tiers: { nudge: true, strong: true, halt: false },
  },
  assess: true,
  completion: { verifyStale: true, continueImpl: true },
  edits: { damaged: true, recent: true, escalatedRepair: true },
  batchReadSpinWarn: true,
};

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/**
 * Deep-merge a persisted (possibly partial or stale) messageToggles payload
 * into the current defaults. Preserves any sibling defaults the user has not
 * overridden so newly added gates opt-in automatically on upgrade.
 *
 * `legacyHalt` is the deprecated {@link Settings.spinCircuitBreakerHaltEnabled}.
 * It wins only when the new-path value is absent.
 */
export function mergeMessageToggles(
  defaults: MessageToggles,
  raw: unknown,
  legacyHalt?: boolean,
): MessageToggles {
  const src = (typeof raw === 'object' && raw !== null && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  const spinSrc = (typeof src.spin === 'object' && src.spin !== null && !Array.isArray(src.spin))
    ? (src.spin as Record<string, unknown>)
    : {};
  const modesSrc = (typeof spinSrc.modes === 'object' && spinSrc.modes !== null && !Array.isArray(spinSrc.modes))
    ? (spinSrc.modes as Record<string, unknown>)
    : {};
  const tiersSrc = (typeof spinSrc.tiers === 'object' && spinSrc.tiers !== null && !Array.isArray(spinSrc.tiers))
    ? (spinSrc.tiers as Record<string, unknown>)
    : {};
  const completionSrc = (typeof src.completion === 'object' && src.completion !== null && !Array.isArray(src.completion))
    ? (src.completion as Record<string, unknown>)
    : {};
  const editsSrc = (typeof src.edits === 'object' && src.edits !== null && !Array.isArray(src.edits))
    ? (src.edits as Record<string, unknown>)
    : {};

  const haltFromSrc = isBool(tiersSrc.halt) ? tiersSrc.halt : undefined;
  const halt = haltFromSrc ?? (isBool(legacyHalt) ? legacyHalt : defaults.spin.tiers.halt);

  return {
    spin: {
      enabled: isBool(spinSrc.enabled) ? spinSrc.enabled : defaults.spin.enabled,
      modes: {
        context_loss: isBool(modesSrc.context_loss) ? modesSrc.context_loss : defaults.spin.modes.context_loss,
        goal_drift: isBool(modesSrc.goal_drift) ? modesSrc.goal_drift : defaults.spin.modes.goal_drift,
        stuck_in_phase: isBool(modesSrc.stuck_in_phase) ? modesSrc.stuck_in_phase : defaults.spin.modes.stuck_in_phase,
        tool_confusion: isBool(modesSrc.tool_confusion) ? modesSrc.tool_confusion : defaults.spin.modes.tool_confusion,
        volatile_unpinned: isBool(modesSrc.volatile_unpinned) ? modesSrc.volatile_unpinned : defaults.spin.modes.volatile_unpinned,
        completion_gate: isBool(modesSrc.completion_gate) ? modesSrc.completion_gate : defaults.spin.modes.completion_gate,
      },
      tiers: {
        nudge: isBool(tiersSrc.nudge) ? tiersSrc.nudge : defaults.spin.tiers.nudge,
        strong: isBool(tiersSrc.strong) ? tiersSrc.strong : defaults.spin.tiers.strong,
        halt,
      },
    },
    assess: isBool(src.assess) ? src.assess : defaults.assess,
    completion: {
      verifyStale: isBool(completionSrc.verifyStale) ? completionSrc.verifyStale : defaults.completion.verifyStale,
      continueImpl: isBool(completionSrc.continueImpl) ? completionSrc.continueImpl : defaults.completion.continueImpl,
    },
    edits: {
      damaged: isBool(editsSrc.damaged) ? editsSrc.damaged : defaults.edits.damaged,
      recent: isBool(editsSrc.recent) ? editsSrc.recent : defaults.edits.recent,
      escalatedRepair: isBool(editsSrc.escalatedRepair) ? editsSrc.escalatedRepair : defaults.edits.escalatedRepair,
    },
    batchReadSpinWarn: isBool(src.batchReadSpinWarn) ? src.batchReadSpinWarn : defaults.batchReadSpinWarn,
  };
}

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
  /** @deprecated Legacy: extended 1M per provider; use extendedContextByModelId */
  extendedContext: Partial<Record<AIProvider, boolean>>;
  /** Per-model extended 1M toggle (models with base &lt; 1M that support bump) */
  extendedContextByModelId: Record<string, boolean>;
  // Entry manifest depth: 'off' = skip, 'paths' = file list only, 'sigs' = signatures only, 'paths_sigs' = both
  entryManifestDepth: 'off' | 'paths' | 'sigs' | 'paths_sigs';
  // Model output speed / verbosity: controls brevity of model responses (maps to OpenAI verbosity for GPT-5)
  modelOutputSpeed: 'low' | 'medium' | 'high';
  // Model thinking / reasoning depth: controls extended thinking budget / reasoning effort
  modelThinking: 'off' | 'low' | 'medium' | 'high';
  /** Override output speed for subagent tool only; omit to use modelOutputSpeed */
  subagentOutputSpeed?: 'low' | 'medium' | 'high';
  /** Override thinking for subagent tool only; omit to use modelThinking */
  subagentThinking?: 'off' | 'low' | 'medium' | 'high';
  /** Override entry manifest depth for subagent system prompt; omit to use entryManifestDepth */
  subagentEntryManifestDepth?: 'off' | 'paths' | 'sigs' | 'paths_sigs';
  /**
   * @deprecated Superseded by {@link MessageToggles.spin.tiers.halt}. Kept for
   * one release so existing localStorage payloads do not silently flip the
   * halt behavior. On load, if the new path is missing, the loader copies
   * this value into `messageToggles.spin.tiers.halt`.
   */
  spinCircuitBreakerHaltEnabled?: boolean;
  /**
   * Per-category toggles for every `<<...>>` intervention message the app
   * injects into the model prompt (or surfaces in batch summaries). See
   * {@link MessageToggles}. Defaults: all `true` except halt (`false`).
   */
  messageToggles: MessageToggles;
  /**
   * Input-side tool-result compression. When true, `formatResult` routes
   * serialized tool output through the dictionary + ditto + key-abbreviation
   * encoder before returning it to handlers. Experimental; default false.
   * See `src/utils/toolResultCompression.ts` and `docs/input-compression-merit.md`.
   */
  compressToolResults?: boolean;
  /**
   * Slim successful-edit acks. When true, `recordEditSummary` skips the
   * embedded unified-diff preview in `edit:*` blackboard entries and keeps
   * only file + hash + line metadata + `diff:h:OLD..h:NEW` ref. The model
   * reads the post-edit state from the `## FILE VIEWS` block and can resolve
   * the ref on demand; humans still expand the chat `DiffRefPill`. Errors
   * stay verbose regardless. Experimental; default false to preserve today's
   * behavior. See `src/services/batch/handlers/change.ts` (`recordEditSummary`).
   */
  compressEditAcks?: boolean;
  /**
   * Auto-pin read results. When true, `read.shaped` / `read.lines` / `read.context`
   * auto-pin their FileView so the model's retention vocabulary collapses to
   * release-only (`pu` / `pc` / `dro`). Default true; the cognitive core prompt
   * is written assuming auto-pin, so turning this off decouples prompt from
   * runtime — intended purely as an emergency rollback lever, not a supported
   * configuration. See `docs/auto-pin-on-read.md`.
   */
  autoPinReads?: boolean;
  /**
   * Widen batch-executor rebase to cover all successful `change.*` steps.
   *
   * When true (default):
   *   - `captureHashAliases` runs for every successful `change.*` step (not just
   *     `change.edit`), so later steps citing the pre-mutation `h:OLD:…` on
   *     `f` / `file_path` can resolve to the new file path.
   *   - `rebaseSubsequentSteps` additionally rebases `read.lines` / `read.shaped`
   *     futures' `lines` / `sl` / `el` and hash-ref suffixes using the same
   *     `deltaMap` used for change futures.
   *
   * When false: legacy behavior — alias capture + rebase only fire for
   * `change.edit` → `change.*` chains; `read.*` futures are not rebased.
   *
   * Intended as an emergency rollback lever for regressions; flip without a
   * code change. See `src/services/batch/executor.ts`.
   */
  rebaseAllChangeOps?: boolean;
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

export interface PromptSnapshot {
  systemPrompt: string;
  messages: Array<{ role: string; content: unknown }>;
  model: string;
  provider: string;
  round: number;
  timestamp: number;
}

/**
 * Tool-loop counters/conditions exposed to the state block builder.
 * Updated by the tool loop imperatively; read by buildDynamicContextBlock
 * to emit conditional steering sections in the non-durable state preamble.
 */
export interface ToolLoopSteering {
  round: number;
  mode: string;
  consecutiveReadOnlyRounds: number;
  roundsInCurrentPhase: number;
  anyRoundHadMutations: boolean;
  hadVerification: boolean;
  hadProgressSinceLastAdvance: boolean;
  activeSubtaskId: string | null;
  completionBlocked: boolean;
  completionBlocker: string | null;
  /**
   * Current {@link import('../services/spinCircuitBreaker').CircuitBreakerTier}
   * from the auto-spin detector. Populated by the chat loop each round when
   * a high-confidence spin is detected; null otherwise. UI can read this to
   * show a circuit-breaker badge, and prompt builders can inject the
   * pre-computed steering message instead of re-running diagnosis.
   */
  spinCircuitBreaker?: {
    tier: 'nudge' | 'strong' | 'halt';
    mode: string;
    confidence: number;
    message: string;
    consecutiveSameMode: number;
  } | null;
  /**
   * Latest {@link import('../services/assessContext').AssessEvaluation} from the
   * pinned-working-memory hygiene detector. Populated by the chat loop each
   * round when an ASSESS block should be surfaced (single-fire per candidate
   * set + CTX bucket); null otherwise. Consumed in `buildDynamicContextBlock`
   * and usable by UI surfaces for a cleanup nudge.
   */
  assessContext?: {
    message: string;
    firedKey: string;
    candidateCount: number;
    ctxPct: number;
  } | null;
}

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
  toolLoopSteering: ToolLoopSteering | null;
  setToolLoopSteering: (steering: ToolLoopSteering | null) => void;

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
  addInputCompressionSavings: (tokensSaved: number) => void;
  /**
   * Observability counter bump for FileView telemetry.
   * `staleReadRounds` target is zero — non-zero is a bug, not a tuning parameter.
   */
  incFileViewCounter: (key: 'fileViewReuseCount' | 'autoHealShiftedCount' | 'autoRefetchCount' | 'autoRefetchSkippedByCap' | 'staleReadRounds', delta?: number) => void;
  /** Set the current FileView count (observational snapshot). */
  setFileViewCount: (count: number) => void;
  addRollingSavings: (tokensSaved: number, roundsRolled: number) => void;
  addOrphanRemovals: (count: number) => void;
  /**
   * Internal: prior-round snapshot of the monotonic savings counters.
   * Used by `recordRound` to compute per-round deltas. Reset via
   * `resetSavingsSnapshot` whenever the counters reset (new chat, session load).
   */
  _lastRoundSavingsSnapshot?: {
    compressionSavings: number;
    rollingSavings: number;
    freedTokens: number;
    inputCompressionSavings: number;
  };
  /** Clear the delta baseline used by `recordRound` (call alongside counter resets). */
  resetSavingsSnapshot: () => void;
  recordRound: () => void;
  cacheMetrics: CacheMetrics;
  /**
   * Record provider cache metrics for a single API round. Must be called
   * exactly once per usage event with inTokens > 0.
   * - cacheWrite: tokens written to cache (Anthropic `cache_creation_input_tokens`)
   * - cacheRead: tokens served from cache (Anthropic `cache_read_input_tokens`,
   *   OpenAI `openai_cached_tokens`, Gemini `cached_content_tokens`)
   * - uncached: tokens that were neither reads nor writes. For Anthropic this
   *   equals `input_tokens`; for OpenAI/Gemini it equals `input_tokens - cached`.
   */
  addCacheMetrics: (metrics: { cacheWrite: number; cacheRead: number; uncached: number; lastRequestCachedTokens?: number }) => void;
  resetCacheMetrics: () => void;
  lastPromptSnapshot: PromptSnapshot | null;
  setLastPromptSnapshot: (snapshot: PromptSnapshot) => void;
  /** Last N lines of raw provider stream chunks (debug). */
  streamWireLogLines: string[];
  pushStreamWireLogLine: (line: string) => void;
  clearStreamWireLog: () => void;
  logicalCache: LogicalCacheState;
  updateLogicalCache: (state: Partial<LogicalCacheState>) => void;
  resetLogicalCache: () => void;

  // Settings
  settings: Settings;
  setSettings: (settings: Partial<Settings>) => void;
  updateSettings: (settings: Partial<Settings>) => void;
  /** Deep-merge a partial `messageToggles` patch into current settings. Persists. */
  updateMessageToggles: (patch: MessageTogglesPatch) => void;
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
        return { selectedFiles: newSelected, lastSelectedFile: path, selectedFile: path };
      }
      // Target path not in visible list — fall through to single-select
      newSelected.clear();
      newSelected.add(path);
      return { selectedFiles: newSelected, lastSelectedFile: path, selectedFile: path };
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
      if (newOpenFiles.length === 0) {
        newActiveFile = null;
      } else {
        // Find position of closed tab in original array, pick neighbor in filtered array
        const closedIdx = state.openFiles.indexOf(path);
        // After removing the closed file, prefer the tab to its left (closedIdx - 1),
        // falling back to the tab that slid into its position (closedIdx), then null.
        const preferredIdx = Math.max(0, closedIdx - 1);
        const fallbackIdx = Math.min(closedIdx, newOpenFiles.length - 1);
        newActiveFile = newOpenFiles[preferredIdx] ?? newOpenFiles[fallbackIdx] ?? null;
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
    const newMessages = [...state.messages, newMessage];
    return { messages: newMessages };
  }),
  
  clearMessages: () => set({ messages: [], streamWireLogLines: [] }),
  
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
        workspaceContextTokens: 0, entryManifestTokens: 0,
        totalOverheadTokens: 0, compressionSavings: 0,
        compressionCount: 0, rollingSavings: 0, rolledRounds: 0, roundCount: 0, cumulativeInputSaved: 0,
        orphanSummaryRemovals: 0,
      },
      _lastRoundSavingsSnapshot: undefined,
      // Reset cache metrics for new session
      cacheMetrics: {
        sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
        sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
        lastRequestCachedTokens: undefined,
      },
      lastPromptSnapshot: null,
      streamWireLogLines: [],
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
          compressionCount: 0, rollingSavings: 0, rolledRounds: 0, roundCount: 0, cumulativeInputSaved: 0,
          orphanSummaryRemovals: 0,
        },
        _lastRoundSavingsSnapshot: undefined,
        cacheMetrics: {
          sessionCacheWrites: 0, sessionCacheReads: 0, sessionUncached: 0,
          sessionRequests: 0, lastRequestHitRate: 0, sessionHitRate: 0,
          lastRequestCachedTokens: undefined,
        },
        lastPromptSnapshot: null,
        streamWireLogLines: [],
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
  toolLoopSteering: null,
  setToolLoopSteering: (steering) => set({ toolLoopSteering: steering }),

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
      const MAX_TOOL_CALLS = 20;
      const existingCalls = state.toolCalls.length >= MAX_TOOL_CALLS
        ? state.toolCalls.slice(-(MAX_TOOL_CALLS - 1))
        : state.toolCalls;
      const raw = call as unknown as Record<string, unknown>;
      const startTime = raw.startTime !== undefined ? rehydrateDate(raw.startTime) : new Date();
      return {
        toolCalls: [...existingCalls, {
          ...call,
          id,
          startTime,
        } as ToolCall],
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
      const newCall: ToolCall = {
        ...call,
        id,
        name: call.name || 'unknown',
        status: call.status || 'pending',
        startTime,
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
    rollingSavings: 0,
    rolledRounds: 0,
    roundCount: 0,
    cumulativeInputSaved: 0,
    orphanSummaryRemovals: 0,
  },
  setPromptMetrics: (metrics) => set((state) => {
    const updated = { ...state.promptMetrics, ...metrics };
    // totalOverheadTokens = static system components only.
    // workspaceContextTokens is dynamic per-round state (task plan, BB, steering, WM)
    // and is tracked separately — not overhead.
    updated.totalOverheadTokens = updated.modePromptTokens + updated.toolRefTokens
      + updated.shellGuideTokens
      + (updated.nativeToolTokens ?? 0) + (updated.primerTokens ?? 0)
      + updated.contextControlTokens
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
  addInputCompressionSavings: (tokensSaved) => set((state) => ({
    promptMetrics: {
      ...state.promptMetrics,
      inputCompressionSavings: (state.promptMetrics.inputCompressionSavings ?? 0) + tokensSaved,
      inputCompressionCount: (state.promptMetrics.inputCompressionCount ?? 0) + 1,
    },
  })),
  incFileViewCounter: (key, delta = 1) => set((state) => ({
    promptMetrics: {
      ...state.promptMetrics,
      [key]: ((state.promptMetrics as unknown as Record<string, number | undefined>)[key] ?? 0) + delta,
    },
  })),
  setFileViewCount: (count) => set((state) => ({
    promptMetrics: { ...state.promptMetrics, fileViewCount: count },
  })),
  addRollingSavings: (tokensSaved, roundsRolled) => set((state) => ({
    promptMetrics: {
      ...state.promptMetrics,
      rollingSavings: state.promptMetrics.rollingSavings + tokensSaved,
      rolledRounds: state.promptMetrics.rolledRounds + roundsRolled,
    },
  })),
  addOrphanRemovals: (count) => set((state) => ({
    promptMetrics: {
      ...state.promptMetrics,
      orphanSummaryRemovals: state.promptMetrics.orphanSummaryRemovals + count,
    },
  })),
  _lastRoundSavingsSnapshot: undefined,
  resetSavingsSnapshot: () => set({ _lastRoundSavingsSnapshot: undefined }),
  /**
   * Advance one round and accumulate SAVINGS METRICS.
   *
   * Two views are maintained:
   *   1. `cumulativeInputSaved` — one-time savings events. Sum of deltas on
   *      `compressionSavings`, `rollingSavings`, `freedTokens`, and
   *      `inputCompressionSavings` since the previous `recordRound` call.
   *      This is the "tokens we never sent" total; it does NOT double-count.
   *   2. `recurringInputSaved` — compounding view. Adds the end-of-round
   *      `compressionSavings + rollingSavings` as if the full history was
   *      re-sent this round at full uncached rate. Kept for power-user UI.
   *
   * Previous bug: summed the cumulative counters each round, producing a
   * triangular over-count (specifically inflating `freedTokens` by N× in an
   * N-round session).
   */
  recordRound: () => set((state) => {
    const pm = state.promptMetrics;
    const compressionSavings = pm.compressionSavings;
    const rollingSavings = pm.rollingSavings;
    const inputCompressionSavings = pm.inputCompressionSavings ?? 0;
    const freedTokens = useContextStore.getState().freedTokens;
    const prev = state._lastRoundSavingsSnapshot ?? {
      compressionSavings: 0,
      rollingSavings: 0,
      freedTokens: 0,
      inputCompressionSavings: 0,
    };
    const deltaCompression = Math.max(0, compressionSavings - prev.compressionSavings);
    const deltaRolling = Math.max(0, rollingSavings - prev.rollingSavings);
    const deltaFreed = Math.max(0, freedTokens - prev.freedTokens);
    const deltaInputCompression = Math.max(0, inputCompressionSavings - prev.inputCompressionSavings);
    const savingsDelta = deltaCompression + deltaRolling + deltaFreed + deltaInputCompression;
    const recurringThisRound = compressionSavings + rollingSavings;
    return {
      promptMetrics: {
        ...pm,
        roundCount: pm.roundCount + 1,
        cumulativeInputSaved: pm.cumulativeInputSaved + savingsDelta,
        recurringInputSaved: (pm.recurringInputSaved ?? 0) + recurringThisRound,
      },
      _lastRoundSavingsSnapshot: {
        compressionSavings,
        rollingSavings,
        freedTokens,
        inputCompressionSavings,
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

  lastPromptSnapshot: null,
  setLastPromptSnapshot: (snapshot) => set({ lastPromptSnapshot: snapshot }),
  streamWireLogLines: [],
  pushStreamWireLogLine: (line) => set((s) => ({
    streamWireLogLines: [...s.streamWireLogLines, line].slice(-500),
  })),
  clearStreamWireLog: () => set({ streamWireLogLines: [] }),

  logicalCache: {
    staticHit: null, bp3Hit: null,
    staticReason: '', bp3Reason: '',
    sessionStaticHits: 0, sessionStaticMisses: 0,
    sessionBp3Hits: 0, sessionBp3Misses: 0,
  },
  updateLogicalCache: (update) => set((state) => ({
    logicalCache: { ...state.logicalCache, ...update },
  })),
  resetLogicalCache: () => set({
    logicalCache: {
      staticHit: null, bp3Hit: null,
      staticReason: '', bp3Reason: '',
      sessionStaticHits: 0, sessionStaticMisses: 0,
      sessionBp3Hits: 0, sessionBp3Misses: 0,
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
      extendedContextByModelId: {},
      entryManifestDepth: 'paths',
      modelOutputSpeed: 'medium',
      modelThinking: 'medium',
      compressToolResults: false,
      compressEditAcks: false,
      autoPinReads: true,
      rebaseAllChangeOps: true,
      messageToggles: DEFAULT_MESSAGE_TOGGLES,
    };
    let parsed: Record<string, unknown> = {};
    try { parsed = saved ? JSON.parse(saved) : {}; } catch { /* corrupt settings — use defaults */ }
    const mf = parsed.modelFilters;
    const ec = parsed.extendedContext;
    const ecm = parsed.extendedContextByModelId;
    const modelFiltersSpread = typeof mf === 'object' && mf !== null && !Array.isArray(mf)
      ? (mf as Record<string, boolean>)
      : {};
    const extendedContextSpread = typeof ec === 'object' && ec !== null && !Array.isArray(ec)
      ? (ec as Record<string, unknown>)
      : {};
    const extendedByModelSpread = typeof ecm === 'object' && ecm !== null && !Array.isArray(ecm)
      ? (ecm as Record<string, boolean>)
      : {};
    // Deep-merge messageToggles so existing installs pick up newly added gates
    // automatically (mirrors the modelFilters pattern above). Accepts partial
    // shapes without dropping sibling defaults.
    const messageToggles = mergeMessageToggles(
      DEFAULT_MESSAGE_TOGGLES,
      parsed.messageToggles,
      typeof parsed.spinCircuitBreakerHaltEnabled === 'boolean'
        ? parsed.spinCircuitBreakerHaltEnabled
        : undefined,
    );
    return {
      ...defaults,
      ...parsed,
      modelFilters: { ...defaults.modelFilters, ...modelFiltersSpread },
      extendedContext: { ...defaults.extendedContext, ...extendedContextSpread },
      extendedContextByModelId: { ...defaults.extendedContextByModelId, ...extendedByModelSpread },
      messageToggles,
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
  updateMessageToggles: (patch) => set((state) => {
    const cur = state.settings.messageToggles;
    const nextMessageToggles: MessageToggles = {
      spin: {
        enabled: patch.spin?.enabled ?? cur.spin.enabled,
        modes: { ...cur.spin.modes, ...(patch.spin?.modes ?? {}) },
        tiers: { ...cur.spin.tiers, ...(patch.spin?.tiers ?? {}) },
      },
      assess: patch.assess ?? cur.assess,
      completion: { ...cur.completion, ...(patch.completion ?? {}) },
      edits: { ...cur.edits, ...(patch.edits ?? {}) },
      batchReadSpinWarn: patch.batchReadSpinWarn ?? cur.batchReadSpinWarn,
    };
    // Mirror halt into the deprecated legacy flag so downstream code that
    // still reads `spinCircuitBreakerHaltEnabled` during the migration window
    // stays consistent. Removed when the legacy field is retired.
    const merged: Settings = {
      ...state.settings,
      messageToggles: nextMessageToggles,
      spinCircuitBreakerHaltEnabled: nextMessageToggles.spin.tiers.halt,
    };
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

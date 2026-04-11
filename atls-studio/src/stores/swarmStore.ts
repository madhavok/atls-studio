/**
 * Swarm Store
 * 
 * State management for multi-agent orchestration.
 * Handles task decomposition, agent coordination, and rate limiting.
 */

import { create } from 'zustand';
import type { AIProvider } from '../services/aiService';

// ============================================================================
// Types
// ============================================================================

export type TaskStatus = 'pending' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled';
export type SwarmStatus = 'idle' | 'researching' | 'planning' | 'running' | 'paused' | 'synthesizing' | 'completed' | 'failed';
export type AgentRole = 'orchestrator' | 'coder' | 'debugger' | 'reviewer' | 'tester' | 'documenter';

// Research results from the orchestrator
export interface ResearchResult {
  filesToModify: string[];
  filesForContext: string[];
  patterns: string[];
  dependencies: string[];
  considerations: string[];
  rawFindings: string;
  // Hash-addressed context stored in blackboard via contextStore
  smartHashes: Map<string, string>;  // filePath → shortHash (structural summary)
  rawHashes: Map<string, string>;    // filePath → shortHash (full file content)
  // Legacy: pre-loaded file contents (kept for backward compat during migration)
  fileContents: Map<string, string>;
  // Project context for agents
  projectContext: {
    cwd: string;
    os: string;
    shell: string;
  } | null;
  // Structured research digest with per-file symbols, deps, and edit targets
  digest?: import('../services/orchestrator').ResearchDigest;
}

export interface SwarmTask {
  id: string;
  parentTaskId?: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedModel: string;
  assignedProvider: AIProvider;
  assignedRole: AgentRole;
  contextHashes: string[];      // Blackboard entries this agent can see
  fileClaims: string[];         // Files this agent owns exclusively
  contextFiles: string[];       // Additional files for reference (read-only context)
  dependencies: string[];       // Task IDs that must complete first
  result?: string;
  error?: string;
  tokensUsed: number;
  costCents: number;
  startedAt?: Date;
  completedAt?: Date;
  retryCount: number;
  maxRetries: number;
  // Agent conversation log (expandable in UI)
  conversationLog: AgentMessage[];
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
  toolName?: string;
  toolResult?: string;
}

export interface AgentConfig {
  role: AgentRole;
  model: string;
  provider: AIProvider;
  maxConcurrent: number;
  systemPromptOverride?: string;
  /** Override output speed/verbosity for this agent; undefined = inherit from main settings */
  outputSpeed?: 'low' | 'medium' | 'high';
  /** Override thinking/reasoning depth for this agent; undefined = inherit from main settings */
  thinking?: 'off' | 'low' | 'medium' | 'high';
}

export interface RateLimiterState {
  providers: Record<string, ProviderLimits>;
}

export interface ProviderLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
  currentRequests: number;
  currentTokens: number;
  windowStart: number;
  queue: QueuedRequest[];
  lastError?: {
    code: number;
    message: string;
    retryAfter?: number;
  };
}

export interface QueuedRequest {
  id: string;
  taskId: string;
  estimatedTokens: number;
  queuedAt: Date;
  callback: () => Promise<void>;
}

export interface SwarmStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  pendingTasks: number;
  totalTokensUsed: number;
  totalCostCents: number;
  /** LLM usage for task planning (orchestrator model), not worker tasks */
  planPhaseTokens: number;
  planPhaseCostCents: number;
  /** LLM usage for post-run synthesis */
  synthesisPhaseTokens: number;
  synthesisPhaseCostCents: number;
  startedAt?: Date;
  completedAt?: Date;
  elapsedMs: number;
}

// Default rate limits per provider
const DEFAULT_RATE_LIMITS: Record<string, { rpm: number; tpm: number }> = {
  anthropic: { rpm: 50, tpm: 100000 },
  openai: { rpm: 60, tpm: 150000 },
  google: { rpm: 60, tpm: 1000000 },
  vertex: { rpm: 60, tpm: 1000000 },
  lmstudio: { rpm: 999, tpm: 10000000 },
};

// Default agent configurations - uses Claude 4.5 series (Feb 2026)
// These are initial defaults; actual models come from provider API once key is added
export const DEFAULT_AGENT_CONFIGS: AgentConfig[] = [
  { role: 'orchestrator', model: 'claude-opus-4-5', provider: 'anthropic', maxConcurrent: 1 },
  { role: 'coder', model: 'claude-sonnet-4-5', provider: 'anthropic', maxConcurrent: 3 },
  { role: 'debugger', model: 'claude-sonnet-4-5', provider: 'anthropic', maxConcurrent: 2 },
  { role: 'reviewer', model: 'claude-sonnet-4-5', provider: 'anthropic', maxConcurrent: 2 },
  { role: 'tester', model: 'claude-sonnet-4-5', provider: 'anthropic', maxConcurrent: 2 },
  { role: 'documenter', model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2 },
];

// ============================================================================
// Persistence - Save/Load Swarm Settings
// ============================================================================

const SWARM_SETTINGS_KEY = 'atls-studio-swarm-settings';

interface SwarmSettings {
  orchestratorModel: string;
  orchestratorProvider: AIProvider;
  agentConfigs: AgentConfig[];
  maxConcurrentAgents: number;
}

// Load swarm settings from localStorage
function loadSwarmSettings(): Partial<SwarmSettings> {
  try {
    const saved = typeof localStorage !== 'undefined' 
      ? localStorage.getItem(SWARM_SETTINGS_KEY) 
      : null;
    if (saved) {
      console.log('[SwarmStore] Loaded saved settings');
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load swarm settings:', e);
  }
  return {};
}

// Save swarm settings to localStorage
function saveSwarmSettings(settings: SwarmSettings) {
  try {
    localStorage.setItem(SWARM_SETTINGS_KEY, JSON.stringify(settings));
    console.log('[SwarmStore] Saved settings');
  } catch (e) {
    console.error('Failed to save swarm settings:', e);
  }
}

// Load saved settings on init
const savedSettings = loadSwarmSettings();

// ============================================================================
// Store Interface
// ============================================================================

interface SwarmStoreState {
  // State
  isActive: boolean;
  status: SwarmStatus;
  sessionId: string | null;
  userRequest: string | null;  // Original user request for context
  orchestratorModel: string;
  orchestratorProvider: AIProvider;
  tasks: SwarmTask[];
  agentConfigs: AgentConfig[];
  rateLimiter: RateLimiterState;
  stats: SwarmStats;
  maxConcurrentAgents: number;
  
  // Research phase results
  research: ResearchResult | null;
  researchLogs: string[];
  
  // Plan from orchestrator
  plan: string | null;
  planApproved: boolean;
  
  // Post-run synthesis from orchestrator
  synthesis: string | null;
  
  // Cancel handling
  cancelRequested: boolean;
  cancelMode: 'graceful' | 'immediate' | null;

  /** Cumulative plan-phase LLM usage (createPlan), separate from worker tasks */
  orchestrationPlanTokens: number;
  orchestrationPlanCostCents: number;
  orchestrationSynthesisTokens: number;
  orchestrationSynthesisCostCents: number;
  
  // Actions
  startSwarm: (sessionId: string, userRequest: string) => void;
  pauseSwarm: () => void;
  resumeSwarm: () => void;
  cancelSwarm: (mode: 'graceful' | 'immediate') => void;
  resetSwarm: () => void;
  
  // Task rehydration from persisted DB rows (session restore)
  rehydrateTasks: (sessionId: string, dbTasks: import('../services/chatDb').DbTask[]) => void;

  // Task management
  addTask: (task: Omit<SwarmTask, 'id' | 'status' | 'tokensUsed' | 'costCents' | 'retryCount' | 'maxRetries' | 'conversationLog'>) => string;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  updateTaskResult: (taskId: string, result: string) => void;
  updateTaskError: (taskId: string, error: string) => void;
  updateTaskStats: (taskId: string, tokensUsed: number, costCents: number) => void;
  addTaskMessage: (taskId: string, message: Omit<AgentMessage, 'id' | 'timestamp'>) => void;
  appendToTaskMessage: (taskId: string, text: string) => void;
  getReadyTasks: () => SwarmTask[];
  getRunningTasks: () => SwarmTask[];
  
  // Agent configuration
  setAgentConfig: (role: AgentRole, config: Partial<AgentConfig>) => void;
  setOrchestratorModel: (model: string, provider: AIProvider) => void;
  setMaxConcurrentAgents: (max: number) => void;
  
  // Research phase
  setResearch: (research: ResearchResult) => void;
  addResearchLog: (log: string) => void;
  setStatus: (status: SwarmStatus) => void;
  
  // Plan management
  setPlan: (plan: string) => void;
  approvePlan: () => void;
  
  // Synthesis
  setSynthesis: (synthesis: string) => void;
  
  // Rate limiting
  checkRateLimit: (provider: AIProvider, estimatedTokens: number) => boolean;
  recordApiCall: (provider: AIProvider, inputTokens: number, outputTokens: number) => void;
  getWaitTime: (provider: AIProvider) => number;
  handleRateLimitError: (provider: AIProvider, retryAfter?: number) => void;
  
  // Stats
  updateStats: () => void;
  getTasksByStatus: (status: TaskStatus) => SwarmTask[];

  recordOrchestrationPlanUsage: (inputTokens: number, outputTokens: number, costCents: number) => void;
  recordOrchestrationSynthesisUsage: (inputTokens: number, outputTokens: number, costCents: number) => void;
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useSwarmStore = create<SwarmStoreState>((set, get) => ({
  // Initial state
  isActive: false,
  status: 'idle',
  sessionId: null,
  userRequest: null,
  orchestratorModel: savedSettings.orchestratorModel || 'claude-opus-4-5',
  orchestratorProvider: savedSettings.orchestratorProvider || 'anthropic',
  tasks: [],
  agentConfigs: savedSettings.agentConfigs || [...DEFAULT_AGENT_CONFIGS],
  rateLimiter: {
    providers: Object.fromEntries(
      Object.entries(DEFAULT_RATE_LIMITS).map(([provider, limits]) => [
        provider,
        {
          requestsPerMinute: limits.rpm,
          tokensPerMinute: limits.tpm,
          currentRequests: 0,
          currentTokens: 0,
          windowStart: Date.now(),
          queue: [],
        },
      ])
    ),
  },
  stats: {
    totalTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    runningTasks: 0,
    pendingTasks: 0,
    totalTokensUsed: 0,
    totalCostCents: 0,
    planPhaseTokens: 0,
    planPhaseCostCents: 0,
    synthesisPhaseTokens: 0,
    synthesisPhaseCostCents: 0,
    elapsedMs: 0,
  },
  maxConcurrentAgents: savedSettings.maxConcurrentAgents || 2, // Default to 2 concurrent agents
  research: null,
  researchLogs: [],
  plan: null,
  planApproved: false,
  synthesis: null,
  cancelRequested: false,
  cancelMode: null,
  orchestrationPlanTokens: 0,
  orchestrationPlanCostCents: 0,
  orchestrationSynthesisTokens: 0,
  orchestrationSynthesisCostCents: 0,

  // ==========================================================================
  // Swarm Lifecycle
  // ==========================================================================

  startSwarm: (sessionId: string, userRequest: string) => {
    set({
      isActive: true,
      status: 'researching', // Start with research phase
      userRequest, // Store for agent context
      sessionId,
      tasks: [],
      research: null,
      researchLogs: [],
      plan: null,
      planApproved: false,
      cancelRequested: false,
      cancelMode: null,
      orchestrationPlanTokens: 0,
      orchestrationPlanCostCents: 0,
      orchestrationSynthesisTokens: 0,
      orchestrationSynthesisCostCents: 0,
      stats: {
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        runningTasks: 0,
        pendingTasks: 0,
        totalTokensUsed: 0,
        totalCostCents: 0,
        planPhaseTokens: 0,
        planPhaseCostCents: 0,
        synthesisPhaseTokens: 0,
        synthesisPhaseCostCents: 0,
        startedAt: new Date(),
        elapsedMs: 0,
      },
    });
  },

  pauseSwarm: () => {
    set({ status: 'paused' });
  },

  resumeSwarm: () => {
    const state = get();
    if (state.status === 'paused') {
      set({ status: 'running' });
    }
  },

  cancelSwarm: (mode: 'graceful' | 'immediate') => {
    set({ 
      cancelRequested: true, 
      cancelMode: mode,
      status: mode === 'immediate' ? 'failed' : get().status,
    });
    
    if (mode === 'immediate') {
      // Cancel all running tasks
      set(state => ({
        tasks: state.tasks.map(t => 
          t.status === 'running' 
            ? { ...t, status: 'cancelled' as TaskStatus, error: 'Cancelled by user' }
            : t
        ),
      }));
    }
  },

  resetSwarm: () => {
    set({
      isActive: false,
      status: 'idle',
      sessionId: null,
      userRequest: null,
      tasks: [],
      research: null,
      researchLogs: [],
      plan: null,
      planApproved: false,
      synthesis: null,
      cancelRequested: false,
      cancelMode: null,
      stats: {
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        runningTasks: 0,
        pendingTasks: 0,
        totalTokensUsed: 0,
        totalCostCents: 0,
        planPhaseTokens: 0,
        planPhaseCostCents: 0,
        synthesisPhaseTokens: 0,
        synthesisPhaseCostCents: 0,
        elapsedMs: 0,
      },
      orchestrationPlanTokens: 0,
      orchestrationPlanCostCents: 0,
      orchestrationSynthesisTokens: 0,
      orchestrationSynthesisCostCents: 0,
    });
  },

  rehydrateTasks: (sessionId, dbTasks) => {
    if (dbTasks.length === 0) return;
    const tasks: SwarmTask[] = dbTasks.map(t => ({
      id: t.id,
      parentTaskId: t.parent_task_id,
      title: t.title,
      description: t.description ?? '',
      status: t.status,
      assignedModel: t.assigned_model ?? '',
      assignedProvider: 'anthropic' as AIProvider,
      assignedRole: (t.assigned_role ?? 'coder') as AgentRole,
      contextHashes: t.context_hashes ?? [],
      fileClaims: t.file_claims ?? [],
      contextFiles: [],
      dependencies: [],
      result: t.result,
      error: t.error,
      tokensUsed: t.tokens_used,
      costCents: t.cost_cents,
      startedAt: t.started_at ? new Date(t.started_at) : undefined,
      completedAt: t.completed_at ? new Date(t.completed_at) : undefined,
      retryCount: 0,
      maxRetries: 10,
      conversationLog: [],
    }));
    const completed = tasks.filter(t => t.status === 'completed').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const running = tasks.filter(t => t.status === 'running').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    const totalTokens = tasks.reduce((sum, t) => sum + t.tokensUsed, 0);
    const totalCost = tasks.reduce((sum, t) => sum + t.costCents, 0);
    const allDone = running === 0 && pending === 0;
    set({
      sessionId,
      tasks,
      isActive: !allDone,
      status: allDone ? (failed > 0 && completed === 0 ? 'failed' : 'completed') : 'paused',
      stats: {
        totalTasks: tasks.length,
        completedTasks: completed,
        failedTasks: failed,
        runningTasks: 0,
        pendingTasks: pending,
        totalTokensUsed: totalTokens,
        totalCostCents: totalCost,
        planPhaseTokens: 0,
        planPhaseCostCents: 0,
        synthesisPhaseTokens: 0,
        synthesisPhaseCostCents: 0,
        elapsedMs: 0,
      },
    });
  },

  // ==========================================================================
  // Task Management
  // ==========================================================================

  addTask: (taskData) => {
    const id = crypto.randomUUID();
    const task: SwarmTask = {
      ...taskData,
      id,
      status: 'pending',
      tokensUsed: 0,
      costCents: 0,
      retryCount: 0,
      maxRetries: 10,
      conversationLog: [],
    };
    
    set(state => ({
      tasks: [...state.tasks, task],
    }));
    
    get().updateStats();
    return id;
  },

  updateTaskStatus: (taskId: string, status: TaskStatus) => {
    set(state => ({
      tasks: state.tasks.map(t => {
        if (t.id !== taskId) return t;
        return {
          ...t,
          status,
          startedAt: status === 'running' ? new Date() : t.startedAt,
          completedAt: ['completed', 'failed', 'cancelled'].includes(status) ? new Date() : t.completedAt,
        };
      }),
    }));
    get().updateStats();
  },

  updateTaskResult: (taskId: string, result: string) => {
    set(state => ({
      tasks: state.tasks.map(t => 
        t.id === taskId ? { ...t, result } : t
      ),
    }));
  },

  updateTaskError: (taskId: string, error: string) => {
    set(state => ({
      tasks: state.tasks.map(t => 
        t.id === taskId ? { ...t, error, retryCount: t.retryCount + 1 } : t
      ),
    }));
  },

  updateTaskStats: (taskId: string, tokensUsed: number, costCents: number) => {
    set(state => ({
      tasks: state.tasks.map(t => 
        t.id === taskId 
          ? { ...t, tokensUsed: t.tokensUsed + tokensUsed, costCents: t.costCents + costCents }
          : t
      ),
    }));
    get().updateStats();
  },

  addTaskMessage: (taskId: string, message) => {
    const msg: AgentMessage = {
      ...message,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    
    set(state => ({
      tasks: state.tasks.map(t => 
        t.id === taskId 
          ? { ...t, conversationLog: [...t.conversationLog, msg] }
          : t
      ),
    }));
  },

  // Append text to the last assistant message, or create new one if none exists
  appendToTaskMessage: (taskId: string, text: string) => {
    set(state => ({
      tasks: state.tasks.map(t => {
        if (t.id !== taskId) return t;
        
        const log = [...t.conversationLog];
        const lastMsg = log[log.length - 1];
        
        // If last message is assistant, append to it
        if (lastMsg && lastMsg.role === 'assistant') {
          log[log.length - 1] = { ...lastMsg, content: lastMsg.content + text };
        } else {
          // Create new assistant message
          log.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: text,
            timestamp: new Date(),
          });
        }
        
        return { ...t, conversationLog: log };
      }),
    }));
  },

  getReadyTasks: () => {
    const state = get();
    return state.tasks.filter(t => {
      if (t.status !== 'pending') return false;
      // Check if all dependencies are completed
      return t.dependencies.every(depId => {
        const dep = state.tasks.find(d => d.id === depId);
        return dep?.status === 'completed';
      });
    });
  },

  getRunningTasks: () => {
    return get().tasks.filter(t => t.status === 'running');
  },

  // ==========================================================================
  // Agent Configuration
  // ==========================================================================

  setAgentConfig: (role: AgentRole, config: Partial<AgentConfig>) => {
    set(state => {
      const newConfigs = state.agentConfigs.map(c => 
        c.role === role ? { ...c, ...config } : c
      );
      // Persist settings
      saveSwarmSettings({
        orchestratorModel: state.orchestratorModel,
        orchestratorProvider: state.orchestratorProvider,
        agentConfigs: newConfigs,
        maxConcurrentAgents: state.maxConcurrentAgents,
      });
      return { agentConfigs: newConfigs };
    });
  },

  setOrchestratorModel: (model: string, provider: AIProvider) => {
    set(state => {
      // Also update the orchestrator agent config
      const newConfigs = state.agentConfigs.map(c => 
        c.role === 'orchestrator' ? { ...c, model, provider } : c
      );
      // Persist settings
      saveSwarmSettings({
        orchestratorModel: model,
        orchestratorProvider: provider,
        agentConfigs: newConfigs,
        maxConcurrentAgents: state.maxConcurrentAgents,
      });
      return { 
        orchestratorModel: model, 
        orchestratorProvider: provider,
        agentConfigs: newConfigs,
      };
    });
  },

  setMaxConcurrentAgents: (max: number) => {
    set(state => {
      // Persist settings
      saveSwarmSettings({
        orchestratorModel: state.orchestratorModel,
        orchestratorProvider: state.orchestratorProvider,
        agentConfigs: state.agentConfigs,
        maxConcurrentAgents: max,
      });
      return { maxConcurrentAgents: max };
    });
  },

  // ==========================================================================
  // Research Phase
  // ==========================================================================

  setResearch: (research: ResearchResult) => {
    set({ research });
  },

  addResearchLog: (log: string) => {
    set(state => ({
      researchLogs: [...state.researchLogs, `[${new Date().toLocaleTimeString()}] ${log}`],
    }));
  },

  setStatus: (status: SwarmStatus) => {
    set({ status });
  },

  // ==========================================================================
  // Plan Management
  // ==========================================================================

  setPlan: (plan: string) => {
    set({ plan, status: 'planning' });
  },

  approvePlan: () => {
    set({ planApproved: true, status: 'running' });
  },

  setSynthesis: (synthesis: string) => {
    set({ synthesis });
  },

  // ==========================================================================
  // Rate Limiting
  // ==========================================================================

  checkRateLimit: (provider: AIProvider, estimatedTokens: number) => {
    const state = get();
    const limits = state.rateLimiter.providers[provider];
    if (!limits) return true; // Unknown provider, allow
    
    const now = Date.now();
    const windowMs = 60000; // 1 minute window
    
    // Reset window if expired
    if (now - limits.windowStart > windowMs) {
      set(s => ({
        rateLimiter: {
          ...s.rateLimiter,
          providers: {
            ...s.rateLimiter.providers,
            [provider]: {
              ...limits,
              currentRequests: 0,
              currentTokens: 0,
              windowStart: now,
            },
          },
        },
      }));
      return true;
    }
    
    // Check limits
    const withinRequestLimit = limits.currentRequests < limits.requestsPerMinute;
    const withinTokenLimit = limits.currentTokens + estimatedTokens < limits.tokensPerMinute;
    
    return withinRequestLimit && withinTokenLimit;
  },

  recordApiCall: (provider: AIProvider, inputTokens: number, outputTokens: number) => {
    const totalTokens = inputTokens + outputTokens;
    
    set(state => {
      const limits = state.rateLimiter.providers[provider];
      if (!limits) return state;
      
      return {
        rateLimiter: {
          ...state.rateLimiter,
          providers: {
            ...state.rateLimiter.providers,
            [provider]: {
              ...limits,
              currentRequests: limits.currentRequests + 1,
              currentTokens: limits.currentTokens + totalTokens,
            },
          },
        },
      };
    });
  },

  getWaitTime: (provider: AIProvider) => {
    const state = get();
    const limits = state.rateLimiter.providers[provider];
    if (!limits) return 0;
    
    const now = Date.now();
    const windowMs = 60000;
    const elapsed = now - limits.windowStart;
    
    if (elapsed >= windowMs) return 0;
    
    // If at limit, wait for window to reset
    if (limits.currentRequests >= limits.requestsPerMinute) {
      return windowMs - elapsed;
    }
    
    // If recent rate limit error, use retry-after
    if (limits.lastError?.retryAfter) {
      return limits.lastError.retryAfter * 1000;
    }
    
    return 0;
  },

  handleRateLimitError: (provider: AIProvider, retryAfter?: number) => {
    set(state => {
      const limits = state.rateLimiter.providers[provider];
      if (!limits) return state;
      
      return {
        rateLimiter: {
          ...state.rateLimiter,
          providers: {
            ...state.rateLimiter.providers,
            [provider]: {
              ...limits,
              lastError: {
                code: 429,
                message: 'Rate limit exceeded',
                retryAfter,
              },
            },
          },
        },
      };
    });
  },

  // ==========================================================================
  // Stats
  // ==========================================================================

  recordOrchestrationPlanUsage: (inputTokens: number, outputTokens: number, costCents: number) => {
    const tok = inputTokens + outputTokens;
    set(s => ({
      orchestrationPlanTokens: s.orchestrationPlanTokens + tok,
      orchestrationPlanCostCents: s.orchestrationPlanCostCents + costCents,
    }));
    get().updateStats();
  },

  recordOrchestrationSynthesisUsage: (inputTokens: number, outputTokens: number, costCents: number) => {
    const tok = inputTokens + outputTokens;
    set(s => ({
      orchestrationSynthesisTokens: s.orchestrationSynthesisTokens + tok,
      orchestrationSynthesisCostCents: s.orchestrationSynthesisCostCents + costCents,
    }));
    get().updateStats();
  },

  updateStats: () => {
    set(state => {
      const tasks = state.tasks;
      const completed = tasks.filter(t => t.status === 'completed');
      const failed = tasks.filter(t => t.status === 'failed');
      const running = tasks.filter(t => t.status === 'running');
      const pending = tasks.filter(t => t.status === 'pending' || t.status === 'awaiting_input');
      
      const taskTokens = tasks.reduce((sum, t) => sum + t.tokensUsed, 0);
      const taskCost = tasks.reduce((sum, t) => sum + t.costCents, 0);
      const planTok = state.orchestrationPlanTokens;
      const planCost = state.orchestrationPlanCostCents;
      const synthTok = state.orchestrationSynthesisTokens;
      const synthCost = state.orchestrationSynthesisCostCents;
      const totalTokens = taskTokens + planTok + synthTok;
      const totalCost = taskCost + planCost + synthCost;
      
      const rawStart = state.stats.startedAt;
      const parsed =
        rawStart instanceof Date
          ? rawStart
          : rawStart != null
            ? new Date(rawStart as unknown as string | number)
            : undefined;
      const startedAt =
        parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined;
      const startMs = startedAt ? startedAt.getTime() : NaN;
      const elapsedMs = Number.isFinite(startMs) ? Date.now() - startMs : 0;
      
      // Check if swarm is complete
      const allDone = tasks.length > 0 && pending.length === 0 && running.length === 0;
      // Do not clobber synthesizing — orchestrator sets final status after synthesis completes.
      const newStatus =
        allDone && state.status !== 'synthesizing'
          ? (failed.length > 0 ? 'failed' : 'completed')
          : state.status;
      
      return {
        status: newStatus,
        stats: {
          totalTasks: tasks.length,
          completedTasks: completed.length,
          failedTasks: failed.length,
          runningTasks: running.length,
          pendingTasks: pending.length,
          totalTokensUsed: totalTokens,
          totalCostCents: totalCost,
          planPhaseTokens: planTok,
          planPhaseCostCents: planCost,
          synthesisPhaseTokens: synthTok,
          synthesisPhaseCostCents: synthCost,
          startedAt: startedAt ?? state.stats.startedAt,
          completedAt: allDone ? new Date() : undefined,
          elapsedMs,
        },
      };
    });
  },

  getTasksByStatus: (status: TaskStatus) => {
    return get().tasks.filter(t => t.status === status);
  },
}));

// Re-export calculateCost from costStore for API compatibility
// Single source of truth for pricing - see costStore.ts
export { calculateCost } from './costStore';

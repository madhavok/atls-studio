/**
 * SwarmPanel Component
 * 
 * Displays swarm orchestration dashboard with:
 * - Task board showing all tasks and their status
 * - Agent cards with expandable conversation logs
 * - Stats summary (tokens, cost, time)
 * - Controls for pause/resume/cancel
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSwarmStore, type SwarmTask, type AgentRole, type TaskStatus } from '../../stores/swarmStore';
import { useAppStore } from '../../stores/appStore';
import { rateLimiter } from '../../services/rateLimiter';
import { orchestrator } from '../../services/orchestrator';
import { getProviderFromModel } from '../../services/aiService';

// ============================================================================
// Sub-Components
// ============================================================================

function formatLogTime(ts: Date | string | number | undefined): string {
  if (ts == null) return '??:??:??';
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : '??:??:??';
  } catch {
    return '??:??:??';
  }
}

interface AgentCardProps {
  task: SwarmTask;
  expanded: boolean;
  onToggleExpand: () => void;
}

function AgentCard({ task, expanded, onToggleExpand }: AgentCardProps) {
  const statusColors: Record<TaskStatus, string> = {
    pending: 'bg-gray-500',
    running: 'bg-blue-500 animate-pulse',
    awaiting_input: 'bg-amber-500',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
    cancelled: 'bg-yellow-500',
  };

  const roleIcons: Record<AgentRole, string> = {
    orchestrator: '🎯',
    coder: '💻',
    debugger: '🔧',
    reviewer: '👁️',
    tester: '🧪',
    documenter: '📝',
  };

  const formatCost = (cents: number) => {
    return `$${(cents / 100).toFixed(4)}`;
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
  };

  return (
    <div className="bg-studio-surface border border-studio-border rounded-lg p-3 mb-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{roleIcons[task.assignedRole] || '🤖'}</span>
          <span className="font-medium text-studio-text capitalize">{task.assignedRole} Agent</span>
          <span className={`w-2 h-2 rounded-full ${statusColors[task.status]}`} />
        </div>
        <span className="text-xs text-studio-muted">{task.assignedModel}</span>
      </div>

      {/* Task Info */}
      <div className="mb-2">
        <div className="text-sm font-medium text-studio-title">{task.title}</div>
        <div className="text-xs text-studio-muted truncate">{task.description}</div>
      </div>

      {/* Status Bar */}
      {task.status === 'running' && (
        <div className="mb-2">
          <div className="h-1 bg-studio-border rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 animate-pulse" style={{ width: '60%' }} />
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="flex items-center justify-between text-xs text-studio-muted mb-2">
        <span>Tokens: {formatTokens(task.tokensUsed)}</span>
        <span>Cost: {formatCost(task.costCents)}</span>
        {task.retryCount > 0 && (
          <span className="text-yellow-500">Retries: {task.retryCount}</span>
        )}
      </div>

      {/* Error */}
      {task.error && (
        <div className="text-xs text-red-400 bg-red-900/20 rounded p-2 mb-2">
          {task.error}
        </div>
      )}

      {/* File Claims */}
      {task.fileClaims.length > 0 && (
        <div className="text-xs text-studio-muted mb-2">
          <span className="text-studio-accent">Files: </span>
          {task.fileClaims.slice(0, 3).join(', ')}
          {task.fileClaims.length > 3 && ` +${task.fileClaims.length - 3} more`}
        </div>
      )}

      {/* Expand Button */}
      <button
        onClick={onToggleExpand}
        className="text-xs text-studio-title hover:text-studio-accent-bright flex items-center gap-1"
      >
        {expanded ? '▼' : '▶'} {expanded ? 'Hide' : 'Show'} Logs ({task.conversationLog.length})
      </button>

      {/* Expanded Logs */}
      {expanded && task.conversationLog.length > 0 && (
        <div className="mt-2 max-h-60 overflow-y-auto bg-studio-bg rounded p-2 text-xs font-mono">
          {task.conversationLog.map((msg) => (
            <div key={msg.id} className="mb-2">
              <div className="text-studio-muted">
                [{formatLogTime(msg.timestamp)}] {msg.role}
                {msg.toolName && ` (${msg.toolName})`}:
              </div>
              <div className="text-studio-text whitespace-pre-wrap pl-2">
                {msg.content.slice(0, 500)}
                {msg.content.length > 500 && '...'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface TaskBoardProps {
  tasks: SwarmTask[];
  expandedTasks: Set<string>;
  onToggleExpand: (taskId: string) => void;
}

function TaskBoard({ tasks, expandedTasks, onToggleExpand }: TaskBoardProps) {
  const columns: { status: TaskStatus; label: string; color: string; bgColor: string }[] = [
    { status: 'pending', label: 'Pending', color: 'border-gray-500', bgColor: 'bg-gray-500/10' },
    { status: 'running', label: 'Running', color: 'border-blue-500', bgColor: 'bg-blue-500/10' },
    { status: 'awaiting_input', label: 'Awaiting Input', color: 'border-amber-500', bgColor: 'bg-amber-500/10' },
    { status: 'completed', label: 'Completed', color: 'border-green-500', bgColor: 'bg-green-500/10' },
    { status: 'failed', label: 'Failed', color: 'border-red-500', bgColor: 'bg-red-500/10' },
  ];

  return (
    <div className="grid grid-cols-5 gap-3 h-full min-h-0">
      {columns.map((col) => {
        const columnTasks = tasks.filter((t) => t.status === col.status);
        return (
          <div key={col.status} className={`flex flex-col border-t-2 ${col.color} ${col.bgColor} rounded-lg overflow-hidden`}>
            {/* Column Header */}
            <div className="flex items-center justify-between px-3 py-2 bg-studio-surface/50 border-b border-studio-border">
              <span className="text-sm font-medium text-studio-text">{col.label}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                col.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                col.status === 'awaiting_input' ? 'bg-amber-500/20 text-amber-400' :
                col.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                col.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                'bg-studio-border text-studio-muted'
              }`}>
                {columnTasks.length}
              </span>
            </div>
            {/* Task List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {columnTasks.length === 0 ? (
                <div className="text-xs text-studio-muted text-center py-4 italic">
                  No tasks
                </div>
              ) : (
                columnTasks.map((task) => (
                  <AgentCard
                    key={task.id}
                    task={task}
                    expanded={expandedTasks.has(task.id)}
                    onToggleExpand={() => onToggleExpand(task.id)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface StatsBarProps {
  stats: ReturnType<typeof useSwarmStore.getState>['stats'];
}

function StatsBar({ stats }: StatsBarProps) {
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  const formatCost = (cents: number) => `$${(cents / 100).toFixed(4)}`;
  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return tokens.toString();
  };

  const progress = stats.totalTasks > 0 
    ? Math.round((stats.completedTasks / stats.totalTasks) * 100)
    : 0;

  return (
    <div className="flex items-center justify-between bg-studio-surface border border-studio-border rounded-lg px-4 py-2">
      {/* Progress */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-24 h-2 bg-studio-border rounded-full overflow-hidden">
            <div 
              className="h-full bg-green-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-sm text-studio-text">{progress}%</span>
        </div>
        
        <div className="text-xs text-studio-muted">
          {stats.completedTasks}/{stats.totalTasks} tasks
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-6 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-studio-muted">Running:</span>
          <span className="text-blue-400">{stats.runningTasks}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-studio-muted">Failed:</span>
          <span className="text-red-400">{stats.failedTasks}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-studio-muted">Tokens:</span>
          <span className="text-studio-text">{formatTokens(stats.totalTokensUsed)}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-studio-muted">Cost:</span>
          <span className="text-green-400">{formatCost(stats.totalCostCents)}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-studio-muted">Time:</span>
          <span className="text-studio-text">{formatTime(stats.elapsedMs)}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function SwarmPanel() {
  const {
    isActive,
    status,
    tasks,
    stats,
    plan,
    planApproved,
    cancelRequested,
    sessionId,
    agentConfigs,
    maxConcurrentAgents,
    setMaxConcurrentAgents,
    pauseSwarm,
    resumeSwarm,
    cancelSwarm,
    approvePlan,
    research,
    researchLogs,
  } = useSwarmStore();

  // Get project path and settings from app store
  const projectPath = useAppStore(state => state.projectPath);
  const settings = useAppStore(state => state.settings);

  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [rateLimitInfo, setRateLimitInfo] = useState<Record<string, any>>({});
  const [isApproving, setIsApproving] = useState(false);

  // Handle plan approval - calls orchestrator to resume execution
  const handleApprovePlan = useCallback(async () => {
    if (!projectPath || !sessionId || isApproving) return;
    
    setIsApproving(true);
    try {
      // Get orchestrator config from agent configs
      const orchestratorConfig = agentConfigs.find(c => c.role === 'orchestrator');
      
      // Call orchestrator to resume after approval
      await orchestrator.resumeAfterApproval(
        sessionId,
        projectPath,
        {
          model: orchestratorConfig?.model || settings.selectedModel,
          provider: orchestratorConfig?.provider || settings.selectedProvider || getProviderFromModel(settings.selectedModel),
          maxConcurrentAgents: useSwarmStore.getState().maxConcurrentAgents, // Use store value
          autoApprove: true, // Already approved now
        }
      );
      
      console.log('[SwarmPanel] Plan approved and execution started');
    } catch (error) {
      console.error('[SwarmPanel] Failed to resume after approval:', error);
      // Still mark plan as approved in store even if execution fails
      approvePlan();
    } finally {
      setIsApproving(false);
    }
  }, [projectPath, sessionId, agentConfigs, settings.selectedModel, isApproving, approvePlan]);

  // Update stats periodically (only triggers re-render on actual data change)
  const prevRateLimitRef = useRef<string>('');
  useEffect(() => {
    if (!isActive) return;
    
    const interval = setInterval(() => {
      useSwarmStore.getState().updateStats();
      const next = rateLimiter.getAllStates();
      const serialized = JSON.stringify(next);
      if (serialized !== prevRateLimitRef.current) {
        prevRateLimitRef.current = serialized;
        setRateLimitInfo(next);
      }
    }, 1000);
    
    return () => clearInterval(interval);
  }, [isActive]);

  const toggleTaskExpand = (taskId: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  if (!isActive) {
    return null;
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-studio-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-studio-border">
        <div className="flex items-center gap-3">
          <span className="text-lg">🐝</span>
          <span className="font-medium text-studio-title">Swarm Orchestration</span>
          <span className={`px-2 py-0.5 rounded text-xs ${
            status === 'researching' ? 'bg-purple-500/20 text-purple-400' :
            status === 'planning' ? 'bg-indigo-500/20 text-indigo-400' :
            status === 'running' ? 'bg-blue-500/20 text-blue-400' :
            status === 'paused' ? 'bg-yellow-500/20 text-yellow-400' :
            status === 'completed' ? 'bg-green-500/20 text-green-400' :
            status === 'failed' ? 'bg-red-500/20 text-red-400' :
            'bg-gray-500/20 text-gray-400'
          }`}>
            {status === 'researching' ? '🔍 RESEARCHING' : status.toUpperCase()}
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {/* Concurrent Agents Selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-studio-muted">Agents:</span>
            <select
              value={maxConcurrentAgents}
              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) setMaxConcurrentAgents(v); }}
              disabled={status === 'running'}
              className="bg-studio-surface border border-studio-border rounded px-2 py-0.5 text-xs text-studio-text disabled:opacity-50 disabled:cursor-not-allowed"
              title={status === 'running' ? 'Cannot change while running' : 'Max concurrent agents'}
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </div>

          <div className="w-px h-4 bg-studio-border" />

          {status === 'planning' && !planApproved && (
            <button
              onClick={handleApprovePlan}
              disabled={isApproving}
              className={`px-3 py-1 text-white text-sm rounded ${
                isApproving 
                  ? 'bg-green-800 cursor-wait' 
                  : 'bg-green-600 hover:bg-green-500'
              }`}
            >
              {isApproving ? 'Starting...' : 'Approve Plan'}
            </button>
          )}
          
          {status === 'running' && (
            <button
              onClick={pauseSwarm}
              className="px-3 py-1 bg-yellow-600 hover:bg-yellow-500 text-white text-sm rounded"
            >
              Pause
            </button>
          )}
          
          {status === 'paused' && (
            <button
              onClick={resumeSwarm}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded"
            >
              Resume
            </button>
          )}
          
          {(status === 'running' || status === 'paused') && !cancelRequested && (
            <button
              onClick={() => setShowCancelModal(true)}
              className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white text-sm rounded"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Research Phase Display */}
      {status === 'researching' && (
        <div className="p-4 border-b border-studio-border bg-purple-900/10">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm font-medium text-purple-400">Researching Codebase...</span>
          </div>
          <div className="text-xs text-studio-muted mb-2">
            Analyzing your project to find relevant files and understand existing patterns.
          </div>
          {researchLogs.length > 0 && (
            <div className="bg-studio-bg rounded p-2 max-h-32 overflow-y-auto font-mono text-xs">
              {researchLogs.map((log, i) => (
                <div key={i} className="text-studio-muted">{log}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Research Results Display (after research, before/during planning) */}
      {research && (status === 'planning' || status === 'running') && (
        <div className="p-4 border-b border-studio-border bg-studio-surface">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-studio-title">📊 Research Results</span>
            <span className="text-xs text-studio-muted">
              {research.filesToModify.length} files to modify, {research.filesForContext.length} for context
            </span>
          </div>
          
          {/* Files to Modify */}
          {research.filesToModify.length > 0 && (
            <div className="mb-2">
              <div className="text-xs text-green-400 mb-1">Files to Modify:</div>
              <div className="flex flex-wrap gap-1">
                {research.filesToModify.slice(0, 8).map((file, i) => (
                  <span key={i} className="px-2 py-0.5 bg-green-500/10 text-green-400 text-xs rounded">
                    {file.split('/').pop()}
                  </span>
                ))}
                {research.filesToModify.length > 8 && (
                  <span className="px-2 py-0.5 text-studio-muted text-xs">
                    +{research.filesToModify.length - 8} more
                  </span>
                )}
              </div>
            </div>
          )}
          
          {/* Context Files */}
          {research.filesForContext.length > 0 && (
            <div className="mb-2">
              <div className="text-xs text-blue-400 mb-1">Context/Reference:</div>
              <div className="flex flex-wrap gap-1">
                {research.filesForContext.slice(0, 6).map((file, i) => (
                  <span key={i} className="px-2 py-0.5 bg-blue-500/10 text-blue-400 text-xs rounded">
                    {file.split('/').pop()}
                  </span>
                ))}
                {research.filesForContext.length > 6 && (
                  <span className="px-2 py-0.5 text-studio-muted text-xs">
                    +{research.filesForContext.length - 6} more
                  </span>
                )}
              </div>
            </div>
          )}
          
          {/* Patterns Found */}
          {research.patterns.length > 0 && (
            <div className="text-xs text-studio-muted">
              <span className="text-yellow-400">Patterns: </span>
              {research.patterns.slice(0, 3).join(' | ')}
            </div>
          )}
        </div>
      )}

      {/* Plan Display (when waiting for approval) */}
      {status === 'planning' && plan && !planApproved && (
        <div className="p-4 border-b border-studio-border bg-indigo-900/10">
          <div className="text-sm font-medium text-studio-title mb-2">📋 Plan Summary</div>
          <div className="text-sm text-studio-text whitespace-pre-wrap bg-studio-bg rounded p-3">{plan}</div>
          <div className="mt-2 text-xs text-studio-muted">
            {tasks.length} tasks planned. Review and approve to start execution.
          </div>
        </div>
      )}

      {/* Stats Bar */}
      <div className="px-4 py-2 border-b border-studio-border">
        <StatsBar stats={stats} />
      </div>

      {/* Rate Limit Warnings */}
      {Object.entries(rateLimitInfo).some(([_, info]) => info?.isLimited) && (
        <div className="px-4 py-2 bg-yellow-900/20 border-b border-yellow-600/30">
          <div className="flex items-center gap-2 text-xs text-yellow-400">
            <span>⚠️</span>
            <span>Rate limiting active:</span>
            {Object.entries(rateLimitInfo)
              .filter(([_, info]) => info?.isLimited)
              .map(([provider, info]) => {
                const backoffSecs = Math.ceil((info?.backoffRemaining || 0) / 1000);
                const activeReqs = info?.activeRequests || 0;
                const queueLen = info?.queueLength || 0;
                // Show backoff time if > 0, otherwise show concurrent/queue info
                const displayText = backoffSecs > 0 
                  ? `${backoffSecs}s wait`
                  : queueLen > 0 
                    ? `${queueLen} queued`
                    : `${activeReqs} active`;
                return (
                  <span key={provider} className="bg-yellow-900/30 px-2 py-0.5 rounded">
                    {provider}: {displayText}
                  </span>
                );
              })}
          </div>
        </div>
      )}

      {/* Task Board */}
      <div className="flex-1 p-4 overflow-hidden min-h-0">
        <TaskBoard
          tasks={tasks}
          expandedTasks={expandedTasks}
          onToggleExpand={toggleTaskExpand}
        />
      </div>

      {/* Cancel Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-studio-surface border border-studio-border rounded-lg p-4 max-w-md">
            <div className="text-lg font-medium text-studio-title mb-4">Cancel Swarm?</div>
            <div className="text-sm text-studio-text mb-4">
              Choose how to handle running agents:
            </div>
            <div className="flex flex-col gap-2 mb-4">
              <button
                onClick={() => {
                  cancelSwarm('graceful');
                  setShowCancelModal(false);
                }}
                className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded text-sm text-left"
              >
                <div className="font-medium">Graceful Stop</div>
                <div className="text-xs opacity-80">Let running agents finish their current task</div>
              </button>
              <button
                onClick={() => {
                  cancelSwarm('immediate');
                  setShowCancelModal(false);
                }}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded text-sm text-left"
              >
                <div className="font-medium">Abort All</div>
                <div className="text-xs opacity-80">Stop all agents immediately</div>
              </button>
            </div>
            <button
              onClick={() => setShowCancelModal(false)}
              className="w-full px-4 py-2 bg-studio-border hover:bg-studio-muted text-studio-text rounded text-sm"
            >
              Keep Running
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default SwarmPanel;

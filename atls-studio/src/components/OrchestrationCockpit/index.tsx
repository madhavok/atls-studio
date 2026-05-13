import { useMemo, useState, type ReactNode } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useContextStore } from '../../stores/contextStore';
import { useOrchestrationUiStore } from '../../stores/orchestrationUiStore';
import { useRoundHistoryStore } from '../../stores/roundHistoryStore';
import { useSwarmStore, type AgentRole, type SwarmTask, type TaskStatus } from '../../stores/swarmStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { formatCost } from '../../stores/costStore';
import { orchestrator } from '../../services/orchestrator';
import { getProviderFromModel } from '../../services/aiService';
import { AgentTerminalView } from '../Terminal/AgentTerminalView';
import { SwarmExecutionProgress, SwarmResearchProgress } from './SwarmProgress';
import { SWARM_ORCHESTRATION_TAB_ID } from '../../constants/swarmOrchestrationTab';

const ROLE_LABELS: Record<AgentRole, string> = {
  orchestrator: 'OR',
  coder: 'CD',
  debugger: 'DB',
  reviewer: 'RV',
  tester: 'TS',
  documenter: 'DC',
};

const STATUS_TONE: Record<TaskStatus, string> = {
  pending: 'border-studio-border text-studio-muted bg-studio-surface/70',
  running: 'border-blue-500/40 text-blue-300 bg-blue-500/10',
  awaiting_input: 'border-yellow-500/40 text-yellow-300 bg-yellow-500/10',
  completed: 'border-green-500/40 text-green-300 bg-green-500/10',
  failed: 'border-red-500/40 text-red-300 bg-red-500/10',
  cancelled: 'border-studio-border text-studio-muted bg-studio-border/20',
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function roleMark(role: AgentRole) {
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded border border-studio-title/30 bg-studio-title/10 font-mono text-[10px] text-studio-title">
      {ROLE_LABELS[role]}
    </span>
  );
}

function CockpitPanel({
  id,
  title,
  children,
  className = '',
}: {
  id: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const focusedWindowId = useOrchestrationUiStore((s) => s.focusedWindowId);
  const focusWindow = useOrchestrationUiStore((s) => s.focusWindow);
  const toggleMinimized = useOrchestrationUiStore((s) => s.toggleMinimized);
  const togglePinned = useOrchestrationUiStore((s) => s.togglePinned);
  const win = useOrchestrationUiStore((s) => s.windows.find((w) => w.id === id));
  const focused = focusedWindowId === id;
  const minimized = win?.minimized ?? false;

  return (
    <section
      className={`min-h-0 rounded border bg-studio-surface/80 ${focused ? 'border-studio-title/60' : 'border-studio-border'} ${className}`}
      onMouseDown={() => focusWindow(id)}
      data-testid={`cockpit-panel-${id}`}
    >
      <div className="flex items-center gap-2 border-b border-studio-border px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-studio-title/70" />
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-studio-title">{title}</h3>
        <div className="ml-auto flex items-center gap-1">
          {win?.pinned && <span className="font-mono text-[10px] text-studio-muted">PIN</span>}
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-studio-muted hover:bg-studio-border/40 hover:text-studio-text"
            onClick={(e) => { e.stopPropagation(); togglePinned(id); }}
          >
            {win?.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-studio-muted hover:bg-studio-border/40 hover:text-studio-text"
            onClick={(e) => { e.stopPropagation(); toggleMinimized(id); }}
          >
            {minimized ? 'Open' : 'Min'}
          </button>
        </div>
      </div>
      {!minimized && <div className="min-h-0 p-3">{children}</div>}
    </section>
  );
}

function MissionControl() {
  const status = useSwarmStore((s) => s.status);
  const sessionId = useSwarmStore((s) => s.sessionId);
  const userRequest = useSwarmStore((s) => s.userRequest);
  const plan = useSwarmStore((s) => s.plan);
  const planApproved = useSwarmStore((s) => s.planApproved);
  const tasks = useSwarmStore((s) => s.tasks);
  const stats = useSwarmStore((s) => s.stats);
  const agentConfigs = useSwarmStore((s) => s.agentConfigs);
  const maxConcurrentAgents = useSwarmStore((s) => s.maxConcurrentAgents);
  const setMaxConcurrentAgents = useSwarmStore((s) => s.setMaxConcurrentAgents);
  const pauseSwarm = useSwarmStore((s) => s.pauseSwarm);
  const resumeSwarm = useSwarmStore((s) => s.resumeSwarm);
  const cancelSwarm = useSwarmStore((s) => s.cancelSwarm);
  const setStatus = useSwarmStore((s) => s.setStatus);
  const settings = useAppStore((s) => s.settings);
  const projectPath = useAppStore((s) => s.projectPath);
  const [approving, setApproving] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const resumeExecution = useResumeSwarmExecution();

  const readyToApprove = status === 'planning' && Boolean(plan) && !planApproved && Boolean(sessionId && projectPath);
  const hasRecoverableTasks = tasks.some((task) => task.status === 'pending' || task.status === 'awaiting_input' || task.status === 'failed');

  const approve = async () => {
    if (!sessionId || !projectPath || approving) return;
    setApproving(true);
    try {
      const orchestratorConfig = agentConfigs.find((c) => c.role === 'orchestrator');
      await orchestrator.resumeAfterApproval(sessionId, projectPath, {
        model: orchestratorConfig?.model || settings.selectedModel,
        provider: orchestratorConfig?.provider || settings.selectedProvider || getProviderFromModel(settings.selectedModel),
        maxConcurrentAgents,
        autoApprove: true,
      });
    } finally {
      setApproving(false);
    }
  };

  const resumeDispatch = async () => {
    if (resuming) return;
    setResumeError(null);
    setResuming(true);
    setStatus('running');
    try {
      const resumed = await resumeExecution();
      if (!resumed) {
        setStatus('paused');
        setResumeError('Cannot resume dispatch until a swarm session and project are active.');
      }
    } catch (error) {
      setStatus('paused');
      setResumeError(error instanceof Error ? error.message : String(error));
    } finally {
      setResuming(false);
    }
  };

  return (
    <CockpitPanel id="mission" title="Mission Control" className="col-span-12 xl:col-span-5">
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded border border-studio-title/30 bg-studio-title/10 px-2 py-0.5 font-mono text-[10px] uppercase text-studio-title">
              {status}
            </span>
            <span className="text-xs text-studio-muted">Concurrency {maxConcurrentAgents}</span>
          </div>
          <p className="mt-2 line-clamp-3 text-sm text-studio-text">
            {userRequest || 'No active mission request.'}
          </p>
        </div>

        <div className="grid grid-cols-4 gap-2">
          <Metric label="Tasks" value={`${stats.completedTasks}/${stats.totalTasks}`} />
          <Metric label="Running" value={`${stats.runningTasks}`} tone="text-blue-300" />
          <Metric label="Tokens" value={formatTokens(stats.totalTokensUsed)} />
          <Metric label="Cost" value={formatCost(stats.totalCostCents)} tone="text-green-300" />
        </div>

        <div className="h-2 overflow-hidden rounded-full bg-studio-bg">
          <div
            className="h-full bg-studio-title transition-all"
            style={{ width: `${stats.totalTasks ? (stats.completedTasks / stats.totalTasks) * 100 : 0}%` }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={maxConcurrentAgents}
            onChange={(e) => setMaxConcurrentAgents(Number(e.target.value))}
            disabled={status === 'running'}
            className="rounded border border-studio-border bg-studio-bg px-2 py-1 text-xs text-studio-text"
            title="Max concurrent agents"
          >
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} agents</option>)}
          </select>
          {readyToApprove && (
            <button
              type="button"
              onClick={() => { void approve(); }}
              disabled={approving}
              className="rounded bg-studio-title px-3 py-1 text-xs font-semibold text-black disabled:opacity-60"
            >
              {approving ? 'Starting' : 'Approve Plan'}
            </button>
          )}
          {status === 'running' && (
            <button type="button" onClick={pauseSwarm} className="rounded border border-yellow-500/40 px-3 py-1 text-xs text-yellow-300">
              Pause
            </button>
          )}
          {status === 'paused' && (
            <button type="button" onClick={resumeSwarm} className="rounded border border-blue-500/40 px-3 py-1 text-xs text-blue-300">
              Resume
            </button>
          )}
          {(status === 'paused' || status === 'failed' || status === 'completed') && hasRecoverableTasks && (
            <button
              type="button"
              onClick={() => { void resumeDispatch(); }}
              disabled={resuming}
              className="rounded border border-studio-title/50 px-3 py-1 text-xs text-studio-title disabled:opacity-60"
            >
              {resuming ? 'Dispatching' : 'Resume Dispatch'}
            </button>
          )}
          {(status === 'running' || status === 'paused') && (
            <button type="button" onClick={() => cancelSwarm('graceful')} className="rounded border border-red-500/40 px-3 py-1 text-xs text-red-300">
              Graceful Stop
            </button>
          )}
          {(status === 'running' || status === 'paused') && (
            <button type="button" onClick={() => cancelSwarm('immediate')} className="rounded border border-red-500/60 px-3 py-1 text-xs text-red-200">
              Stop Now
            </button>
          )}
        </div>

        {resumeError && (
          <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
            {resumeError}
          </div>
        )}

        {plan && (
          <div className="rounded border border-studio-border bg-studio-bg/60 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-studio-muted">Plan</div>
            <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-studio-text">{plan}</p>
          </div>
        )}

        {tasks.length === 0 && (
          <div className="rounded border border-studio-border bg-studio-bg/40 p-3 text-xs text-studio-muted">
            Task windows will appear after research and planning complete.
          </div>
        )}
      </div>
    </CockpitPanel>
  );
}

function Metric({ label, value, tone = 'text-studio-text' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded border border-studio-border bg-studio-bg/50 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-[0.16em] text-studio-muted">{label}</div>
      <div className={`font-mono text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function useResumeSwarmExecution() {
  const sessionId = useSwarmStore((s) => s.sessionId);
  const agentConfigs = useSwarmStore((s) => s.agentConfigs);
  const maxConcurrentAgents = useSwarmStore((s) => s.maxConcurrentAgents);
  const settings = useAppStore((s) => s.settings);
  const projectPath = useAppStore((s) => s.projectPath);

  return async (): Promise<boolean> => {
    if (!sessionId || !projectPath) return false;
    const orchestratorConfig = agentConfigs.find((c) => c.role === 'orchestrator');
    await orchestrator.resumeAfterApproval(sessionId, projectPath, {
      model: orchestratorConfig?.model || settings.selectedModel,
      provider: orchestratorConfig?.provider || settings.selectedProvider || getProviderFromModel(settings.selectedModel),
      maxConcurrentAgents,
      autoApprove: true,
    });
    return true;
  };
}

function AgentWindows() {
  const tasks = useSwarmStore((s) => s.tasks);
  const selectedTaskId = useOrchestrationUiStore((s) => s.selectedTaskId);
  const selectTask = useOrchestrationUiStore((s) => s.selectTask);
  const updateTaskStatus = useSwarmStore((s) => s.updateTaskStatus);
  const setTaskFailureReason = useSwarmStore((s) => s.setTaskFailureReason);
  const setStatus = useSwarmStore((s) => s.setStatus);
  const resumeExecution = useResumeSwarmExecution();
  const [recoveringTaskId, setRecoveringTaskId] = useState<string | null>(null);

  const recoverTask = async (task: SwarmTask) => {
    selectTask(task.id);
    setRecoveringTaskId(task.id);
    setTaskFailureReason(task.id, '');
    updateTaskStatus(task.id, 'pending');
    setStatus('running');
    try {
      const resumed = await resumeExecution();
      if (!resumed) {
        setStatus('paused');
        setTaskFailureReason(task.id, 'Recovery queued, but no active swarm session/project was available to dispatch it.');
      }
    } catch (error) {
      setStatus('paused');
      setTaskFailureReason(task.id, error instanceof Error ? error.message : String(error));
    } finally {
      setRecoveringTaskId(null);
    }
  };

  return (
    <CockpitPanel id="agents" title="Agent Windows" className="col-span-12 xl:col-span-7">
      <div className="grid max-h-[520px] grid-cols-1 gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
        {tasks.length === 0 ? (
          <div className="rounded border border-dashed border-studio-border p-6 text-center text-xs text-studio-muted lg:col-span-2">
            No agents allocated yet.
          </div>
        ) : tasks.map((task) => (
          <AgentWindow
            key={task.id}
            task={task}
            selected={selectedTaskId === task.id}
            onSelect={() => selectTask(task.id)}
            onRecover={() => { void recoverTask(task); }}
            recovering={recoveringTaskId === task.id}
          />
        ))}
      </div>
    </CockpitPanel>
  );
}

function AgentWindow({
  task,
  selected,
  onSelect,
  onRecover,
  recovering,
}: {
  task: SwarmTask;
  selected: boolean;
  onSelect: () => void;
  onRecover: () => void;
  recovering: boolean;
}) {
  const lastMessage = task.conversationLog[task.conversationLog.length - 1];
  const canRecover = task.status === 'failed' || task.status === 'cancelled' || task.status === 'awaiting_input';

  return (
    <article
      className={`rounded border bg-studio-bg/70 p-3 transition-colors ${selected ? 'border-studio-title/70' : 'border-studio-border hover:border-studio-title/30'}`}
      onClick={onSelect}
      data-testid={`agent-window-${task.id}`}
    >
      <div className="flex items-start gap-3">
        {roleMark(task.assignedRole)}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-sm font-semibold text-studio-text">{task.title}</h4>
            <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${STATUS_TONE[task.status]}`}>
              {task.status}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-studio-muted">{task.description}</p>
        </div>
      </div>

      {canRecover && (
        <div className="mt-3 flex items-center gap-2 rounded border border-yellow-500/30 bg-yellow-500/10 p-2">
          <div className="min-w-0 flex-1 text-xs text-yellow-200">
            {task.status === 'awaiting_input'
              ? 'This agent is blocked awaiting input. Continue requeues it with the current context.'
              : 'This agent stopped before completion. Retry requeues the task and resumes dispatch.'}
          </div>
          <button
            type="button"
            disabled={recovering}
            onClick={(e) => {
              e.stopPropagation();
              onRecover();
            }}
            className="rounded border border-yellow-500/40 px-2 py-1 text-xs font-medium text-yellow-200 hover:bg-yellow-500/10 disabled:opacity-60"
          >
            {recovering ? 'Queuing' : task.status === 'awaiting_input' ? 'Continue' : 'Retry'}
          </button>
        </div>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Metric label="Tokens" value={formatTokens(task.tokensUsed)} />
        <Metric label="Cost" value={formatCost(task.costCents)} tone="text-green-300" />
        <Metric label="Retries" value={`${task.retryCount}`} />
      </div>

      {task.fileClaims.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {task.fileClaims.slice(0, 4).map((file) => (
            <span key={file} className="rounded border border-studio-border bg-studio-surface px-1.5 py-0.5 text-[10px] text-studio-muted" title={file}>
              {file.split(/[/\\]/).pop()}
            </span>
          ))}
          {task.fileClaims.length > 4 && <span className="text-[10px] text-studio-muted">+{task.fileClaims.length - 4}</span>}
        </div>
      )}

      {task.error && (
        <div className="mt-3 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
          {task.error}
        </div>
      )}

      {lastMessage && (
        <div className="mt-3 rounded border border-studio-border bg-studio-surface/60 p-2">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-studio-muted">
            <span>{lastMessage.role}</span>
            {lastMessage.toolName && <span>{lastMessage.toolName}</span>}
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap text-xs text-studio-text">{lastMessage.content}</p>
        </div>
      )}
    </article>
  );
}

function WorkbenchWindow() {
  const openFiles = useAppStore((s) => s.openFiles);
  const activeFile = useAppStore((s) => s.activeFile);
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const closeFile = useAppStore((s) => s.closeFile);
  const workbenchFiles = openFiles.filter((file) => file !== SWARM_ORCHESTRATION_TAB_ID);

  return (
    <CockpitPanel id="workbench" title="Workbench" className="col-span-12 lg:col-span-4">
      <div className="space-y-2">
        <div className="text-xs text-studio-muted">
          The cockpit keeps files visible as operational artifacts. Open a file from the explorer to focus it in the editor workspace.
        </div>
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {workbenchFiles.length === 0 ? (
            <div className="rounded border border-dashed border-studio-border p-4 text-center text-xs text-studio-muted">
              No workbench files open.
            </div>
          ) : workbenchFiles.map((file) => (
            <div
              key={file}
              className={`flex items-center gap-2 rounded border px-2 py-1 text-xs ${activeFile === file ? 'border-studio-title/50 bg-studio-title/10 text-studio-title' : 'border-studio-border bg-studio-bg/50 text-studio-muted'}`}
            >
              <button
                type="button"
                onClick={() => setActiveFile(file)}
                className="min-w-0 flex-1 truncate text-left hover:text-studio-text"
                title={file}
              >
                {file}
              </button>
              <button
                type="button"
                onClick={() => closeFile(file)}
                className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-studio-muted hover:bg-studio-border/40 hover:text-studio-text"
                title={`Close ${file}`}
              >
                Close
              </button>
            </div>
          ))}
        </div>
      </div>
    </CockpitPanel>
  );
}

function RuntimeContextWindow() {
  const chunks = useContextStore((s) => s.chunks);
  const bbEntries = useContextStore((s) => s.blackboardEntries);
  const maxTokens = useContextStore((s) => s.maxTokens);
  const getPromptTokens = useContextStore((s) => s.getPromptTokens);
  const getBlackboardTokenCount = useContextStore((s) => s.getBlackboardTokenCount);
  const wmTokens = getPromptTokens();
  const bbTokens = getBlackboardTokenCount();
  const pinned = useMemo(() => Array.from(chunks.values()).filter((c) => c.pinned), [chunks]);

  return (
    <CockpitPanel id="context" title="Runtime Context" className="col-span-12 lg:col-span-4">
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Metric label="WM" value={formatTokens(wmTokens)} />
          <Metric label="BB" value={formatTokens(bbTokens)} />
          <Metric label="CTX" value={`${Math.round(((wmTokens + bbTokens) / maxTokens) * 100)}%`} />
        </div>
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-[0.16em] text-studio-muted">Pinned FileViews and engrams</div>
          {pinned.slice(0, 6).map((chunk) => (
            <div key={chunk.hash} className="flex items-center gap-2 rounded border border-studio-border bg-studio-bg/50 px-2 py-1 text-xs">
              <span className="font-mono text-studio-title">{chunk.shortHash}</span>
              <span className="text-studio-muted">{chunk.type}</span>
              <span className="ml-auto truncate text-studio-muted">{chunk.source}</span>
            </div>
          ))}
          {pinned.length === 0 && <div className="text-xs text-studio-muted">No pinned context yet.</div>}
        </div>
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-[0.16em] text-studio-muted">Blackboard</div>
          {Array.from(bbEntries.entries()).slice(0, 5).map(([key, entry]) => (
            <div key={key} className="rounded border border-studio-border bg-studio-bg/50 px-2 py-1 text-xs">
              <div className="font-mono text-studio-title">{key}</div>
              <div className="truncate text-studio-muted">{entry.content.split('\n')[0]}</div>
            </div>
          ))}
          {bbEntries.size === 0 && <div className="text-xs text-studio-muted">No blackboard entries yet.</div>}
        </div>
      </div>
    </CockpitPanel>
  );
}

function TelemetryWindow() {
  const stats = useSwarmStore((s) => s.stats);
  const snapshots = useRoundHistoryStore((s) => s.snapshots);
  const swarmSnapshots = useMemo(() => snapshots.filter((s) => s.isSwarmRound), [snapshots]);
  const latest = swarmSnapshots[swarmSnapshots.length - 1];

  return (
    <CockpitPanel id="telemetry" title="Telemetry" className="col-span-12 lg:col-span-4">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Elapsed" value={formatElapsed(stats.elapsedMs)} />
          <Metric label="Rounds" value={`${swarmSnapshots.length}`} />
          <Metric label="Plan Cost" value={formatCost(stats.planPhaseCostCents)} />
          <Metric label="Synthesis" value={formatCost(stats.synthesisPhaseCostCents)} />
        </div>
        <div className="rounded border border-studio-border bg-studio-bg/50 p-2">
          <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-studio-muted">Latest worker round</div>
          {latest ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <span className="text-studio-muted">Input</span>
              <span className="text-right font-mono">{formatTokens(latest.inputTokens)}</span>
              <span className="text-studio-muted">Output</span>
              <span className="text-right font-mono">{formatTokens(latest.outputTokens)}</span>
              <span className="text-studio-muted">Latency</span>
              <span className="text-right font-mono">{latest.roundLatencyMs ? `${Math.round(latest.roundLatencyMs)}ms` : 'n/a'}</span>
              <span className="text-studio-muted">Cost</span>
              <span className="text-right font-mono text-green-300">{formatCost(latest.costCents)}</span>
            </div>
          ) : (
            <div className="text-xs text-studio-muted">No swarm round snapshots yet.</div>
          )}
        </div>
      </div>
    </CockpitPanel>
  );
}

function AgentTerminalWindow() {
  const selectedTaskId = useOrchestrationUiStore((s) => s.selectedTaskId);
  const selectedTask = useSwarmStore((s) => s.tasks.find((t) => t.id === selectedTaskId));
  const terminalMap = useTerminalStore((s) => s.terminals);
  const activeAgentTerminalId = useTerminalStore((s) => s.activeAgentTerminalId);
  const setActiveAgentTerminal = useTerminalStore((s) => s.setActiveAgentTerminal);
  const terminals = useMemo(
    () => Array.from(terminalMap.values()).filter((t) => t.isAgent),
    [terminalMap],
  );
  const matchedTerminal = useMemo(() => {
    if (!selectedTask) return activeAgentTerminalId;
    const idFragment = selectedTask.id.slice(0, 6);
    return terminals.find((t) => t.name.includes(idFragment))?.id ?? activeAgentTerminalId;
  }, [activeAgentTerminalId, selectedTask, terminals]);

  return (
    <CockpitPanel id="terminal" title="Agent Terminal" className="col-span-12">
      <div className="mb-2 flex items-center gap-2 overflow-x-auto">
        {terminals.map((terminal) => (
          <button
            key={terminal.id}
            type="button"
            className={`rounded border px-2 py-1 text-xs ${terminal.id === matchedTerminal ? 'border-studio-title/50 bg-studio-title/10 text-studio-title' : 'border-studio-border text-studio-muted'}`}
            onClick={() => setActiveAgentTerminal(terminal.id)}
          >
            {terminal.name}
          </button>
        ))}
      </div>
      <div className="h-72 overflow-hidden rounded border border-studio-border bg-studio-bg">
        {matchedTerminal ? (
          <AgentTerminalView terminalId={matchedTerminal} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-studio-muted">
            No agent terminal is attached yet.
          </div>
        )}
      </div>
    </CockpitPanel>
  );
}

function CockpitToolbar() {
  const density = useOrchestrationUiStore((s) => s.density);
  const focusMode = useOrchestrationUiStore((s) => s.focusMode);
  const setDensity = useOrchestrationUiStore((s) => s.setDensity);
  const setFocusMode = useOrchestrationUiStore((s) => s.setFocusMode);
  const resetLayout = useOrchestrationUiStore((s) => s.resetLayout);

  return (
    <div className="flex items-center gap-2 border-b border-studio-border bg-studio-surface/80 px-3 py-2">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-studio-title">ATLS Cognitive Runtime</h2>
        <p className="text-[10px] text-studio-muted">Multi-agent orchestration cockpit</p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
          className="rounded border border-studio-border px-2 py-1 text-xs text-studio-muted hover:text-studio-text"
        >
          Density: {density}
        </button>
        <button
          type="button"
          onClick={() => setFocusMode(!focusMode)}
          className={`rounded border px-2 py-1 text-xs ${focusMode ? 'border-studio-title/50 text-studio-title' : 'border-studio-border text-studio-muted'}`}
        >
          Focus {focusMode ? 'on' : 'off'}
        </button>
        <button
          type="button"
          onClick={resetLayout}
          className="rounded border border-studio-border px-2 py-1 text-xs text-studio-muted hover:text-studio-text"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export function OrchestrationCockpit() {
  const density = useOrchestrationUiStore((s) => s.density);
  const focusMode = useOrchestrationUiStore((s) => s.focusMode);
  const status = useSwarmStore((s) => s.status);

  return (
    <div
      className="h-full min-h-0 overflow-hidden bg-studio-bg text-studio-text"
      data-testid="orchestration-cockpit"
    >
      <CockpitToolbar />
      <div className={`h-[calc(100%-49px)] overflow-y-auto ${density === 'compact' ? 'p-3' : 'p-5'}`}>
        <div className="mb-3">
          <SwarmResearchProgress />
          <SwarmExecutionProgress />
        </div>
        <div className={`grid grid-cols-12 gap-3 ${focusMode ? 'xl:grid-cols-12' : ''}`}>
          <MissionControl />
          <AgentWindows />
          {status !== 'researching' && (
            <>
              <WorkbenchWindow />
              <RuntimeContextWindow />
              <TelemetryWindow />
              <AgentTerminalWindow />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default OrchestrationCockpit;

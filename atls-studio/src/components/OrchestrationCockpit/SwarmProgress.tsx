import { memo, useEffect, useMemo, useRef } from 'react';
import { useSwarmStore } from '../../stores/swarmStore';

const ThinkingSpinner = memo(function ThinkingSpinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-studio-title" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.18" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
});

function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`;
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export const SwarmResearchProgress = memo(function SwarmResearchProgress() {
  const status = useSwarmStore((state) => state.status);
  const researchLogs = useSwarmStore((state) => state.researchLogs);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [researchLogs]);

  if (status !== 'researching' && status !== 'planning') return null;

  return (
    <div className="flex gap-3 mb-4">
      <div className="w-8 h-8 rounded border border-studio-title/30 bg-studio-title/10 flex items-center justify-center shrink-0">
        <ThinkingSpinner />
      </div>
      <div className="flex-1 max-w-[80%]">
        <div className="p-3 rounded bg-studio-surface border border-studio-border">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-studio-title">
              {status === 'researching' ? 'Researching codebase' : 'Compiling orchestration plan'}
            </span>
            <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-studio-muted">
              {status}
            </span>
          </div>
          {researchLogs.length > 0 && (
            <div className="max-h-48 overflow-y-auto font-mono text-xs space-y-0.5 bg-studio-bg/50 rounded p-2">
              {researchLogs.slice(-15).map((log, i) => (
                <div key={`${i}-${log}`} className="text-studio-muted">{log}</div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export const SwarmExecutionProgress = memo(function SwarmExecutionProgress() {
  const status = useSwarmStore((state) => state.status);
  const tasks = useSwarmStore((state) => state.tasks);
  const stats = useSwarmStore((state) => state.stats);

  const summary = useMemo(() => {
    const pending = tasks.filter((t) => t.status === 'pending');
    const running = tasks.filter((t) => t.status === 'running');
    const completed = tasks.filter((t) => t.status === 'completed');
    const failed = tasks.filter((t) => t.status === 'failed');
    const total = tasks.length;
    return {
      pending,
      running,
      completed,
      failed,
      progress: total > 0 ? Math.round((completed.length / total) * 100) : 0,
    };
  }, [tasks]);

  if (status !== 'running') return null;

  return (
    <div className="flex gap-3 mb-4">
      <div className="w-8 h-8 rounded border border-studio-title/30 bg-studio-title/10 flex items-center justify-center shrink-0">
        <span className="font-mono text-xs text-studio-title">SW</span>
      </div>
      <div className="flex-1 max-w-[80%]">
        <div className="p-3 rounded bg-studio-surface border border-studio-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-studio-title">Swarm executing</span>
            <span className="text-xs text-studio-muted">
              {summary.progress}% | {formatTime(stats.elapsedMs)}
            </span>
          </div>

          <div className="h-2 bg-studio-bg rounded-full mb-3 overflow-hidden">
            <div
              className="h-full bg-studio-title transition-all duration-300"
              style={{ width: `${summary.progress}%` }}
            />
          </div>

          <div className="grid grid-cols-4 gap-2 text-xs mb-3">
            <span className="text-studio-muted">Pending {summary.pending.length}</span>
            <span className="text-blue-400">Running {summary.running.length}</span>
            <span className="text-green-400">Done {summary.completed.length}</span>
            <span className={summary.failed.length > 0 ? 'text-red-400' : 'text-studio-muted'}>
              Failed {summary.failed.length}
            </span>
          </div>

          {summary.running.length > 0 && (
            <div className="space-y-1 mb-2">
              <div className="text-xs text-studio-muted font-medium">Active agents</div>
              {summary.running.map((task) => (
                <div key={task.id} className="flex items-center gap-2 text-xs bg-studio-bg/50 rounded px-2 py-1">
                  <ThinkingSpinner />
                  <span className="text-studio-title truncate flex-1">{task.title}</span>
                  <span className="text-studio-muted shrink-0 uppercase">{task.assignedRole}</span>
                </div>
              ))}
            </div>
          )}

          {stats.totalCostCents > 0 && (
            <div className="mt-2 pt-2 border-t border-studio-border/50 text-xs text-studio-muted">
              Total: {formatCost(stats.totalCostCents)} | {stats.totalTokensUsed.toLocaleString()} tokens
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

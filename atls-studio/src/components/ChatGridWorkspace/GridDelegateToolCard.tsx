import { memo } from 'react';
import type { MessageToolCall } from '../../stores/appStore';

const ROLE_LABELS: Record<string, string> = {
  code: 'Coder',
  test: 'Tester',
  retrieve: 'Researcher',
  design: 'Designer',
};

function delegateRole(name: string): string {
  const raw = name.startsWith('delegate.') ? name.slice('delegate.'.length) : name;
  return ROLE_LABELS[raw] ?? `${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;
}

function statusClass(status: MessageToolCall['status']): string {
  switch (status) {
    case 'running':
    case 'pending':
      return 'border-teal-400/40 bg-teal-500/10 text-teal-100';
    case 'completed':
      return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100';
    case 'failed':
      return 'border-red-400/35 bg-red-500/10 text-red-200';
    default:
      return 'border-studio-border/50 bg-studio-bg/40 text-studio-muted';
  }
}

function summarizeTask(args: Record<string, unknown>): string {
  for (const key of ['goal', 'query', 'task', 'q']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  }
  return '';
}

export function isDelegateToolCall(name: string): boolean {
  return name.startsWith('delegate.');
}

export const GridDelegateToolCard = memo(function GridDelegateToolCard({ toolCall }: { toolCall: MessageToolCall }) {
  const args = toolCall.args ?? {};
  const task = summarizeTask(args);
  const role = delegateRole(toolCall.name);
  const isRunning = toolCall.status === 'running' || toolCall.status === 'pending';

  return (
    <div
      className={`rounded-lg border px-2 py-1.5 ${statusClass(toolCall.status)}`}
      data-testid={`grid-delegate-tool-${toolCall.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.12em]">
          {role} delegate
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isRunning && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300" />}
          <span className="text-[9px] uppercase tracking-wide opacity-80">{toolCall.status}</span>
        </div>
      </div>
      {task && (
        <div className="mt-1 truncate text-[10px] opacity-90" title={task}>
          {task}
        </div>
      )}
      {toolCall.result && (
        <div className="mt-1 max-h-20 overflow-hidden whitespace-pre-wrap break-words text-[10px] opacity-75 [overflow-wrap:anywhere]">
          {toolCall.result.slice(0, 320)}
        </div>
      )}
    </div>
  );
});

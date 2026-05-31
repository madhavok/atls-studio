import type { MessageToolCall } from '../../stores/appStore';

function statusClass(status: MessageToolCall['status']): string {
  switch (status) {
    case 'running':
      return 'border-cyan-400/35 bg-cyan-500/10 text-cyan-100';
    case 'completed':
      return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100';
    case 'failed':
      return 'border-red-400/35 bg-red-500/10 text-red-200';
    default:
      return 'border-studio-border/50 bg-studio-bg/40 text-studio-muted';
  }
}

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  const goal = args.goal;
  if (typeof goal === 'string' && goal.trim()) return goal.trim().slice(0, 120);
  const filePath = args.file_path ?? args.path;
  if (typeof filePath === 'string' && filePath.trim()) return filePath.trim();
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  return keys.slice(0, 3).join(', ');
}

export function AgentToolTrace({ toolCalls }: { toolCalls: MessageToolCall[] }) {
  if (toolCalls.length === 0) return null;

  return (
    <div className="mt-2 space-y-1" data-testid="agent-tool-trace">
      {toolCalls.map((toolCall) => (
        <div
          key={toolCall.id}
          className={`rounded border px-2 py-1 font-mono text-[10px] ${statusClass(toolCall.status)}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{toolCall.name}</span>
            <span className="shrink-0 uppercase tracking-wide opacity-80">{toolCall.status}</span>
          </div>
          {summarizeArgs(toolCall.args) && (
            <div className="mt-0.5 truncate opacity-80">{summarizeArgs(toolCall.args)}</div>
          )}
          {toolCall.result && (
            <div className="mt-1 max-h-16 overflow-hidden whitespace-pre-wrap break-words opacity-75 [overflow-wrap:anywhere]">
              {toolCall.result.slice(0, 240)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

import type { MessageToolCall } from '../../stores/appStore';
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore';
import { isBatchCall } from '../AiChat/aiChatToolDisplayPure';
import { GridBatchToolCalls } from './GridBatchToolCalls';
import { GridDelegateToolCard, isDelegateToolCall } from './GridDelegateToolCard';

function delegateProgressTrace(
  toolCall: MessageToolCall,
  progressByStep?: Record<string, import('../../services/batch/types').SubAgentProgressEvent[]>,
): import('../../services/batch/types').SubAgentProgressEvent[] | undefined {
  if (!progressByStep) return undefined;
  const stepId = typeof toolCall.args?.step_id === 'string' ? toolCall.args.step_id.trim() : '';
  if (stepId) return progressByStep[stepId];
  const sep = '::';
  const idx = toolCall.id.indexOf(sep);
  if (idx >= 0) return progressByStep[toolCall.id.slice(idx + sep.length)];
  return undefined;
}

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

export function AgentToolTrace({ toolCalls, windowId }: { toolCalls: MessageToolCall[]; windowId?: string }) {
  if (toolCalls.length === 0) return null;
  const progressByStep = useAgentRuntimeStore((state) => (
    windowId ? state.runtimesByWindow[windowId]?.subagentProgressByStep : undefined
  ));

  return (
    <div className="mt-2 space-y-1" data-testid="agent-tool-trace">
      {toolCalls.map((toolCall) => (
        isBatchCall(toolCall) ? (
          <GridBatchToolCalls key={toolCall.id} toolCall={toolCall} windowId={windowId} />
        ) : isDelegateToolCall(toolCall.name) ? (
          <GridDelegateToolCard
            key={toolCall.id}
            toolCall={toolCall}
            liveTrace={delegateProgressTrace(toolCall, progressByStep)}
          />
        ) : (
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
        )
      ))}
    </div>
  );
}

import { memo, useMemo } from 'react';
import type { MessageToolCall } from '../../stores/appStore';
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore';
import {
  batchStepSubagentLookupKey,
  expandBatchToolCall,
  isBatchCall,
} from '../AiChat/aiChatToolDisplayPure';
import { AgentToolTrace } from './AgentToolTrace';
import { GridDelegateToolCard } from './GridDelegateToolCard';

function BatchGroupLabel({ stepCount }: { stepCount: number }) {
  return (
    <div className="px-0.5 pb-0.5">
      <span className="inline-flex items-center rounded-full border border-studio-accent/20 bg-studio-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-studio-accent">
        ATLS {stepCount > 1 ? `• ${stepCount} steps` : ''}
      </span>
    </div>
  );
}

export const GridBatchToolCalls = memo(function GridBatchToolCalls({
  toolCall,
  windowId,
}: {
  toolCall: MessageToolCall;
  windowId?: string;
}) {
  const childCalls = useMemo(() => expandBatchToolCall(toolCall), [toolCall]);
  const progressByStep = useAgentRuntimeStore((state) => (
    windowId ? state.runtimesByWindow[windowId]?.subagentProgressByStep : undefined
  ));

  if (!isBatchCall(toolCall) || childCalls.length === 0) {
    return <AgentToolTrace toolCalls={[toolCall]} windowId={windowId} />;
  }

  return (
    <div className="space-y-1" data-testid="grid-batch-tool-calls">
      <BatchGroupLabel stepCount={childCalls.length} />
      {childCalls.map((childCall) => {
        const stepKey = batchStepSubagentLookupKey(childCall);
        const progressTrace = progressByStep?.[stepKey];
        const lastProgress = progressTrace?.length ? progressTrace[progressTrace.length - 1] : undefined;
        const childToolCall: MessageToolCall = {
          id: childCall.id,
          name: childCall.name,
          args: childCall.args,
          result: childCall.result,
          status: childCall.status,
          thoughtSignature: childCall.thoughtSignature,
        };

        if (childCall.name.startsWith('delegate.')) {
          return (
            <div key={childCall.id} className="space-y-0.5">
              <GridDelegateToolCard toolCall={childToolCall} liveTrace={progressTrace} />
              {lastProgress && !lastProgress.done && (
                <div className="ml-2 flex items-center gap-2 text-[10px] text-teal-300/85">
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-teal-400" />
                  <span className="shrink-0 font-mono text-[9px] text-studio-muted">R{lastProgress.round}</span>
                  <span className="truncate">{lastProgress.status}</span>
                </div>
              )}
            </div>
          );
        }

        return <AgentToolTrace key={childCall.id} toolCalls={[childToolCall]} windowId={windowId} />;
      })}
    </div>
  );
});

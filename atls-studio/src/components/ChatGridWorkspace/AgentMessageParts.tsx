import { memo } from 'react';
import { getMessageParts, type MessagePart, type MessageSegment } from '../../stores/appStore';
import { MarkdownMessage } from '../AiChat/MarkdownMessage';
import { ReasoningBlock } from '../AiChat/ReasoningBlock';
import { AgentToolTrace } from './AgentToolTrace';
import { GridDelegateToolCard, isDelegateToolCall } from './GridDelegateToolCard';

function PartBlock({ part, index }: { part: MessagePart; index: number }) {
  if (part.type === 'text') {
    if (!part.content.trim()) return null;
    return (
      <div key={`text-${index}`} className="markdown-message text-xs leading-relaxed text-studio-text [overflow-wrap:anywhere]">
        <MarkdownMessage content={part.content} />
      </div>
    );
  }
  if (part.type === 'reasoning') {
    if (!part.content.trim()) return null;
    return (
      <div key={`reasoning-${index}`} className="rounded-lg border border-violet-400/20 bg-violet-500/6 p-2">
        <ReasoningBlock content={part.content} isStreaming={false} />
      </div>
    );
  }
  if (part.type === 'tool') {
    return (
      <div key={`tool-${part.toolCall.id}`}>
        {isDelegateToolCall(part.toolCall.name)
          ? <GridDelegateToolCard toolCall={part.toolCall} />
          : <AgentToolTrace toolCalls={[part.toolCall]} />}
      </div>
    );
  }
  if (part.type === 'step-boundary') {
    return (
      <div key={`step-${index}`} className="my-1 border-t border-dashed border-studio-border/50 pt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-studio-muted">
        next round
      </div>
    );
  }
  if (part.type === 'error') {
    return (
      <div key={`error-${index}`} className="rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
        {part.errorText}
      </div>
    );
  }
  return null;
}

export const AgentMessageParts = memo(function AgentMessageParts({
  content,
  parts,
  segments,
  toolCalls,
}: {
  content: string;
  parts?: MessagePart[];
  segments?: MessageSegment[];
  toolCalls?: Parameters<typeof getMessageParts>[0]['toolCalls'];
}) {
  const resolvedParts = getMessageParts({ content, parts, segments, toolCalls });
  if (resolvedParts.length === 0) {
    if (!content.trim()) return null;
    return (
      <div className="markdown-message text-xs leading-relaxed text-studio-text [overflow-wrap:anywhere]">
        <MarkdownMessage content={content} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {resolvedParts.map((part, index) => (
        <PartBlock key={`${part.type}-${index}`} part={part} index={index} />
      ))}
    </div>
  );
});

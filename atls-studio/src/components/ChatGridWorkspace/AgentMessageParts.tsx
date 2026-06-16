import { memo } from 'react';
import { getMessageParts, type MessagePart, type MessageSegment } from '../../stores/appStore';
import { MarkdownMessage } from '../AiChat/MarkdownMessage';
import { ReasoningBlock } from '../AiChat/ReasoningBlock';
import { AgentToolTrace } from './AgentToolTrace';
import { GridDelegateToolCard, isDelegateToolCall } from './GridDelegateToolCard';
import { RoundHeader } from './AgentStreamingSegments';

function PartBlock({ part }: { part: MessagePart }) {
  if (part.type === 'text') {
    if (!part.content.trim()) return null;
    return (
      <div className="markdown-message text-xs leading-relaxed text-studio-text [overflow-wrap:anywhere]">
        <MarkdownMessage content={part.content} />
      </div>
    );
  }
  if (part.type === 'reasoning') {
    if (!part.content.trim()) return null;
    return (
      <div className="rounded-lg border border-violet-400/20 bg-violet-500/[0.06] p-2">
        <ReasoningBlock content={part.content} isStreaming={false} />
      </div>
    );
  }
  if (part.type === 'tool') {
    return isDelegateToolCall(part.toolCall.name)
      ? <GridDelegateToolCard toolCall={part.toolCall} />
      : <AgentToolTrace toolCalls={[part.toolCall]} />;
  }
  if (part.type === 'error') {
    return (
      <div className="rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
        {part.errorText}
      </div>
    );
  }
  return null;
}

interface PartRoundGroup {
  round: number;
  parts: MessagePart[];
}

/**
 * Split finalized parts into rounds at each `step-boundary` marker. Persisted
 * parts carry no `round` field, so the boundary count is the canonical round
 * index. The header replaces the old dashed "next round" divider.
 */
function groupPartsByRound(parts: MessagePart[]): PartRoundGroup[] {
  const groups: PartRoundGroup[] = [{ round: 0, parts: [] }];
  for (const part of parts) {
    if (part.type === 'step-boundary') {
      groups.push({ round: groups.length, parts: [] });
      continue;
    }
    groups[groups.length - 1].parts.push(part);
  }
  return groups.filter((group) => group.parts.length > 0);
}

/** Stable per-part key within a round group. Tools key on id; others on round+index. */
function partKey(part: MessagePart, round: number, index: number): string {
  if (part.type === 'tool') return `tool-${part.toolCall.id}`;
  return `${part.type}-${round}-${index}`;
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
  const rounds = groupPartsByRound(resolvedParts);
  const showHeaders = rounds.length > 1;
  return (
    <div className="space-y-2">
      {rounds.map((group) => (
        <div key={`round-${group.round}`} className="space-y-2">
          {showHeaders && <RoundHeader round={group.round} />}
          {group.parts.map((part, index) => (
            <PartBlock key={partKey(part, group.round, index)} part={part} />
          ))}
        </div>
      ))}
    </div>
  );
});

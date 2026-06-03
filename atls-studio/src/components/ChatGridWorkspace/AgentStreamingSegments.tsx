import { memo, useEffect, useRef, useState, useTransition } from 'react';
import type { StreamSegment } from '../../types/streamSegments';
import {
  getAgentWindowStreamRefs,
} from '../../services/agentWindowStreamRefs';
import { cleanStreamingContent } from '../AiChat/aiChatPure';
import { MarkdownMessage } from '../AiChat/MarkdownMessage';
import { ReasoningBlock } from '../AiChat/ReasoningBlock';
import { AgentToolTrace } from './AgentToolTrace';
import { GridBatchToolCalls } from './GridBatchToolCalls';
import { GridDelegateToolCard, isDelegateToolCall } from './GridDelegateToolCard';
import { isBatchCall } from '../AiChat/aiChatToolDisplayPure';

function SegmentBlock({ segment, windowId }: { segment: StreamSegment; windowId: string }) {
  if (segment.type === 'text') {
    const content = cleanStreamingContent(segment.content);
    if (!content) return null;
    return (
      <div className="min-w-0 overflow-hidden rounded-lg border border-cyan-400/30 bg-cyan-500/8 p-2">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-300">
          {segment.state === 'streaming' ? 'streaming' : 'response'}
        </div>
        <div className="markdown-message text-xs leading-relaxed text-studio-text [overflow-wrap:anywhere]">
          <MarkdownMessage content={content} />
        </div>
      </div>
    );
  }

  if (segment.type === 'reasoning') {
    if (!segment.content) return null;
    return (
      <div className="min-w-0 overflow-hidden rounded-lg border border-violet-400/25 bg-violet-500/8 p-2">
        <ReasoningBlock content={segment.content} isStreaming={segment.state === 'streaming'} />
      </div>
    );
  }

  if (segment.type === 'tool') {
    if (isBatchCall(segment.toolCall)) {
      return <GridBatchToolCalls toolCall={segment.toolCall} windowId={windowId} />;
    }
    return isDelegateToolCall(segment.toolCall.name)
      ? <GridDelegateToolCard toolCall={segment.toolCall} />
      : <AgentToolTrace toolCalls={[segment.toolCall]} windowId={windowId} />;
  }

  if (segment.type === 'step-boundary') {
    return (
      <div className="my-1 border-t border-dashed border-studio-border/50 pt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-studio-muted">
        next round
      </div>
    );
  }

  if (segment.type === 'status') {
    return (
      <div className="rounded border border-amber-400/25 bg-amber-500/8 px-2 py-1 text-[10px] text-amber-100/90">
        {segment.message}
      </div>
    );
  }

  if (segment.type === 'error') {
    return (
      <div className="rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
        {segment.errorText}
      </div>
    );
  }

  return null;
}

export const AgentStreamingSegments = memo(function AgentStreamingSegments({
  windowId,
  isGenerating,
  fallbackText = '',
  fallbackReasoning = '',
}: {
  windowId: string;
  isGenerating: boolean;
  fallbackText?: string;
  fallbackReasoning?: string;
}) {
  const refs = getAgentWindowStreamRefs(windowId);
  const [segments, setSegments] = useState<StreamSegment[]>([]);
  const [, startTransition] = useTransition();
  const rafRef = useRef<number | null>(null);
  const lastRevisionRef = useRef(0);

  useEffect(() => {
    if (!isGenerating) {
      setSegments([]);
      lastRevisionRef.current = 0;
      return;
    }

    let mounted = true;

    const tick = () => {
      if (!mounted) return;
      const revision = refs.segmentsRevisionRef.current;
      if (revision !== lastRevisionRef.current) {
        lastRevisionRef.current = revision;
        const combined = [
          ...refs.accumulatedSegmentsRef.current,
          ...refs.streamingSegmentsRef.current,
        ];
        startTransition(() => {
          setSegments(combined.map((segment) => (
            segment.type === 'tool'
              ? { ...segment, toolCall: { ...segment.toolCall } }
              : { ...segment }
          )));
        });
      }
      if (isGenerating) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isGenerating, refs]);

  if (!isGenerating) return null;

  const hasSegments = segments.length > 0;
  if (!hasSegments && !fallbackText && !fallbackReasoning) return null;

  return (
    <div className="space-y-2" data-testid="agent-stream-segments">
      {segments.map((segment, index) => (
        <SegmentBlock key={`${segment.type}-${index}`} segment={segment} windowId={windowId} />
      ))}
      {!hasSegments && fallbackReasoning && (
        <div className="min-w-0 overflow-hidden rounded-lg border border-violet-400/25 bg-violet-500/8 p-2">
          <ReasoningBlock content={fallbackReasoning} isStreaming />
        </div>
      )}
      {!hasSegments && fallbackText && (
        <div className="min-w-0 overflow-hidden rounded-lg border border-cyan-400/30 bg-cyan-500/8 p-2">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-300">streaming</div>
          <div className="markdown-message text-xs leading-relaxed text-studio-text [overflow-wrap:anywhere]">
            <MarkdownMessage content={cleanStreamingContent(fallbackText)} />
          </div>
        </div>
      )}
    </div>
  );
});

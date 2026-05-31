import { memo, useEffect, useRef, useState, useTransition } from 'react';
import type { StreamSegment } from '../../types/streamSegments';
import {
  getAgentWindowStreamRefs,
} from '../../services/agentWindowStreamRefs';
import { AgentToolTrace } from './AgentToolTrace';

function SegmentBlock({ segment }: { segment: StreamSegment }) {
  if (segment.type === 'text') {
    if (!segment.content) return null;
    return (
      <div className="min-w-0 overflow-hidden rounded-lg border border-cyan-400/30 bg-cyan-500/8 p-2">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-300">
          {segment.state === 'streaming' ? 'streaming' : 'response'}
        </div>
        <div className="whitespace-pre-wrap break-words leading-relaxed text-studio-text [overflow-wrap:anywhere]">
          {segment.content}
        </div>
      </div>
    );
  }

  if (segment.type === 'reasoning') {
    if (!segment.content) return null;
    return (
      <div className="min-w-0 overflow-hidden rounded-lg border border-violet-400/25 bg-violet-500/8 p-2">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-violet-300">reasoning</div>
        <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-violet-100/90 [overflow-wrap:anywhere]">
          {segment.content}
        </div>
      </div>
    );
  }

  if (segment.type === 'tool') {
    return <AgentToolTrace toolCalls={[segment.toolCall]} />;
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
        <SegmentBlock key={`${segment.type}-${index}`} segment={segment} />
      ))}
      {!hasSegments && fallbackReasoning && (
        <div className="min-w-0 overflow-hidden rounded-lg border border-violet-400/25 bg-violet-500/8 p-2">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-violet-300">reasoning</div>
          <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-violet-100/90 [overflow-wrap:anywhere]">
            {fallbackReasoning}
          </div>
        </div>
      )}
      {!hasSegments && fallbackText && (
        <div className="min-w-0 overflow-hidden rounded-lg border border-cyan-400/30 bg-cyan-500/8 p-2">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-300">streaming</div>
          <div className="whitespace-pre-wrap break-words leading-relaxed text-studio-text [overflow-wrap:anywhere]">
            {fallbackText}
          </div>
        </div>
      )}
    </div>
  );
});

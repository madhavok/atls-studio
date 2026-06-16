import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../stores/appStore';
import {
  advanceRound,
  appendReasoningToSegments,
  appendTextToSegments,
  clearStreamingState,
  closeBlockById,
  resetStreamingState,
  stampSegment,
  type StreamingRefs,
  upsertToolSegment,
} from './streamingHelpers';

function makeRefs(): StreamingRefs {
  return {
    streamingSegmentsRef: { current: [] },
    segmentsRevisionRef: { current: 0 },
    seenToolCallIds: { current: new Set() },
    accumulatedSegmentsRef: { current: [] },
    isStreamingRef: { current: false },
    seqRef: { current: 0 },
    roundRef: { current: 0 },
  };
}

function toolCall(partial: Partial<ToolCall> & Pick<ToolCall, 'id' | 'name'>): ToolCall {
  return {
    status: 'pending',
    startTime: new Date(0),
    ...partial,
  };
}

describe('streamingHelpers', () => {
  it('appendTextToSegments merges into last text segment when blockId matches', () => {
    const refs = makeRefs();
    appendTextToSegments(refs, 'a', 'b1');
    expect(refs.segmentsRevisionRef.current).toBe(1);
    appendTextToSegments(refs, 'b', 'b1');
    expect(refs.streamingSegmentsRef.current).toHaveLength(1);
    expect(refs.streamingSegmentsRef.current[0]).toMatchObject({ type: 'text', id: 'b1', content: 'ab' });
    expect(refs.segmentsRevisionRef.current).toBe(2);
  });

  it('appendTextToSegments starts new segment when blockId differs', () => {
    const refs = makeRefs();
    appendTextToSegments(refs, 'x', 'b1');
    appendTextToSegments(refs, 'y', 'b2');
    expect(refs.streamingSegmentsRef.current).toHaveLength(2);
  });

  it('appendReasoningToSegments merges for same reasoning block id', () => {
    const refs = makeRefs();
    appendReasoningToSegments(refs, 'r1', 'think');
    appendReasoningToSegments(refs, 'r2', 'think');
    expect(refs.streamingSegmentsRef.current).toHaveLength(1);
    expect(refs.streamingSegmentsRef.current[0]).toMatchObject({ type: 'reasoning', content: 'r1r2' });
  });

  it('appendReasoningToSegments coalesces adjacent reasoning even when block ids change', () => {
    const refs = makeRefs();
    appendReasoningToSegments(refs, 'a', 'think-1');
    appendReasoningToSegments(refs, 'b', 'think-2');
    expect(refs.streamingSegmentsRef.current).toHaveLength(1);
    expect(refs.streamingSegmentsRef.current[0]).toMatchObject({ type: 'reasoning', content: 'ab' });
  });

  it('closeBlockById marks the latest matching block done', () => {
    const refs = makeRefs();
    appendTextToSegments(refs, 't', 'blk');
    closeBlockById(refs, 'blk', 'text');
    expect(refs.streamingSegmentsRef.current[0]).toMatchObject({ state: 'done' });
  });

  it('upsertToolSegment appends new tool then updates same id', () => {
    const refs = makeRefs();
    const t1 = toolCall({ id: 'tc1', name: 'grep', status: 'running' });
    upsertToolSegment(refs, t1);
    expect(refs.streamingSegmentsRef.current).toHaveLength(1);
    const t2 = toolCall({ id: 'tc1', name: 'grep', status: 'completed', result: 'ok' });
    upsertToolSegment(refs, t2);
    expect(refs.streamingSegmentsRef.current).toHaveLength(1);
    expect(refs.streamingSegmentsRef.current[0].type).toBe('tool');
    if (refs.streamingSegmentsRef.current[0].type === 'tool') {
      expect(refs.streamingSegmentsRef.current[0].toolCall.status).toBe('completed');
      expect(refs.streamingSegmentsRef.current[0].toolCall.result).toBe('ok');
    }
  });

  it('stamps new segments with a monotonic seq and the current round', () => {
    const refs = makeRefs();
    appendTextToSegments(refs, 'a', 'b1');
    advanceRound(refs);
    appendReasoningToSegments(refs, 'r', 'think');
    upsertToolSegment(refs, toolCall({ id: 'tc1', name: 'grep' }));

    const [text, reasoning, tool] = refs.streamingSegmentsRef.current;
    expect(text.seq).toBe(0);
    expect(text.round).toBe(0);
    expect(reasoning.seq).toBe(1);
    expect(reasoning.round).toBe(1);
    expect(tool.seq).toBe(2);
    expect(tool.round).toBe(1);
  });

  it('appending to an existing block does not consume a new seq', () => {
    const refs = makeRefs();
    appendTextToSegments(refs, 'a', 'b1');
    appendTextToSegments(refs, 'b', 'b1');
    expect(refs.streamingSegmentsRef.current).toHaveLength(1);
    expect(refs.streamingSegmentsRef.current[0].seq).toBe(0);
    expect(refs.seqRef.current).toBe(1);
  });

  it('stampSegment and advanceRound assign stable, increasing ordering metadata', () => {
    const refs = makeRefs();
    const first = stampSegment(refs, { type: 'step-boundary' });
    advanceRound(refs);
    const second = stampSegment(refs, { type: 'error', errorText: 'boom' });
    expect(first.seq).toBe(0);
    expect(first.round).toBe(0);
    expect(second.seq).toBe(1);
    expect(second.round).toBe(1);
  });

  it('resetStreamingState clears segments and sets streaming flag', () => {
    const refs = makeRefs();
    appendTextToSegments(refs, 'x');
    refs.accumulatedSegmentsRef.current = [{ type: 'text', content: 'acc' }];
    refs.seenToolCallIds.current.add('a');
    advanceRound(refs);
    resetStreamingState(refs);
    expect(refs.streamingSegmentsRef.current).toEqual([]);
    expect(refs.accumulatedSegmentsRef.current).toEqual([]);
    expect(refs.seenToolCallIds.current.size).toBe(0);
    expect(refs.isStreamingRef.current).toBe(true);
    expect(refs.segmentsRevisionRef.current).toBeGreaterThan(0);
    expect(refs.seqRef.current).toBe(0);
    expect(refs.roundRef.current).toBe(0);
  });

  it('clearStreamingState clears segments and ends streaming', () => {
    const refs = makeRefs();
    appendTextToSegments(refs, 'x');
    refs.isStreamingRef.current = true;
    clearStreamingState(refs);
    expect(refs.streamingSegmentsRef.current).toEqual([]);
    expect(refs.isStreamingRef.current).toBe(false);
  });
});

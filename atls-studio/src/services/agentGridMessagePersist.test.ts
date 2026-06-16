import { describe, expect, it } from 'vitest';
import type { StreamingRefs } from '../components/AiChat/streamingHelpers';
import { finalizeStreamSegmentsToParts, partsToPersistableSegments } from './agentGridMessagePersist';

function makeRefs(segments: StreamingRefs['streamingSegmentsRef']['current']): StreamingRefs {
  return {
    streamingSegmentsRef: { current: segments },
    accumulatedSegmentsRef: { current: [] },
    segmentsRevisionRef: { current: 0 },
    seenToolCallIds: { current: new Set() },
    isStreamingRef: { current: false },
    seqRef: { current: 0 },
    roundRef: { current: 0 },
  };
}

describe('agentGridMessagePersist', () => {
  it('finalizes text, reasoning, tool, and step segments into parts', () => {
    const refs = makeRefs([
      { type: 'reasoning', content: 'plan', state: 'done' },
      { type: 'text', content: 'Done.', state: 'done' },
      { type: 'tool', toolCall: { id: 't1', name: 'grep', status: 'completed', startTime: new Date(), result: 'ok' } },
      { type: 'step-boundary' },
    ]);
    const { parts, content } = finalizeStreamSegmentsToParts(refs, new Map());
    expect(content).toContain('Done.');
    expect(parts.some((part) => part.type === 'reasoning')).toBe(true);
    expect(parts.some((part) => part.type === 'tool')).toBe(true);
    expect(parts.some((part) => part.type === 'step-boundary')).toBe(true);
  });

  it('maps parts to persistable segments including errors', () => {
    const segments = partsToPersistableSegments([
      { type: 'text', content: 'hello' },
      { type: 'error', errorText: 'boom' },
    ]);
    expect(segments).toEqual([
      { type: 'text', content: 'hello' },
      { type: 'error', content: 'boom' },
    ]);
  });
});

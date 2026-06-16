import { describe, expect, it } from 'vitest';
import type { StreamSegment } from '../../types/streamSegments';
import { groupSegmentsByRound } from './AgentStreamingSegments';

function text(content: string, round: number, seq: number): StreamSegment {
  return { type: 'text', content, state: 'done', round, seq };
}

describe('groupSegmentsByRound', () => {
  it('splits contiguous segments by round and drops step boundaries', () => {
    const segments: StreamSegment[] = [
      text('round0-a', 0, 0),
      text('round0-b', 0, 1),
      { type: 'step-boundary', round: 0, seq: 2 },
      text('round1-a', 1, 3),
    ];
    const groups = groupSegmentsByRound(segments);
    expect(groups).toHaveLength(2);
    expect(groups[0].round).toBe(0);
    expect(groups[0].segments).toHaveLength(2);
    expect(groups[1].round).toBe(1);
    expect(groups[1].segments).toHaveLength(1);
  });

  it('treats legacy segments without a round stamp as round 0', () => {
    const segments: StreamSegment[] = [
      { type: 'text', content: 'a', state: 'done' },
      { type: 'reasoning', content: 'b', state: 'done' },
    ];
    const groups = groupSegmentsByRound(segments);
    expect(groups).toHaveLength(1);
    expect(groups[0].round).toBe(0);
    expect(groups[0].segments).toHaveLength(2);
  });

  it('produces no empty groups when only boundaries are present', () => {
    const segments: StreamSegment[] = [{ type: 'step-boundary', round: 0, seq: 0 }];
    expect(groupSegmentsByRound(segments)).toHaveLength(0);
  });
});

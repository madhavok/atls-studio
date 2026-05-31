import { describe, expect, it } from 'vitest';
import {
  beginAgentWindowStreamRun,
  clearAllAgentWindowStreamRefs,
  endAgentWindowStreamRun,
  getAgentWindowStreamRefs,
} from './agentWindowStreamRefs';
import { appendTextToSegments, appendReasoningToSegments } from '../components/AiChat/streamingHelpers';

describe('agentWindowStreamRefs', () => {
  it('beginAgentWindowStreamRun resets per-window refs', () => {
    clearAllAgentWindowStreamRefs();
    const refs = beginAgentWindowStreamRun('win-a');
    appendTextToSegments(refs, 'hello');
    appendReasoningToSegments(refs, 'think');

    beginAgentWindowStreamRun('win-a');
    expect(refs.streamingSegmentsRef.current).toEqual([]);
    expect(refs.accumulatedSegmentsRef.current).toEqual([]);
    expect(refs.isStreamingRef.current).toBe(true);
  });

  it('keeps refs isolated per window id', () => {
    clearAllAgentWindowStreamRefs();
    const refsA = beginAgentWindowStreamRun('win-a');
    const refsB = beginAgentWindowStreamRun('win-b');
    appendTextToSegments(refsA, 'a');
    appendTextToSegments(refsB, 'b');

    expect(getAgentWindowStreamRefs('win-a').streamingSegmentsRef.current[0]).toMatchObject({ content: 'a' });
    expect(getAgentWindowStreamRefs('win-b').streamingSegmentsRef.current[0]).toMatchObject({ content: 'b' });
  });

  it('endAgentWindowStreamRun clears streaming flag', () => {
    clearAllAgentWindowStreamRefs();
    const refs = beginAgentWindowStreamRun('win-a');
    appendTextToSegments(refs, 'x');
    endAgentWindowStreamRun('win-a');
    expect(refs.isStreamingRef.current).toBe(false);
    expect(refs.streamingSegmentsRef.current).toEqual([]);
  });
});

import {
  clearStreamingState,
  resetStreamingState,
  type StreamingRefs,
} from '../components/AiChat/streamingHelpers';

function createRefs(): StreamingRefs {
  return {
    streamingSegmentsRef: { current: [] },
    segmentsRevisionRef: { current: 0 },
    seenToolCallIds: { current: new Set() },
    accumulatedSegmentsRef: { current: [] },
    isStreamingRef: { current: false },
  };
}

const refsByWindow = new Map<string, StreamingRefs>();

export function getAgentWindowStreamRefs(windowId: string): StreamingRefs {
  let refs = refsByWindow.get(windowId);
  if (!refs) {
    refs = createRefs();
    refsByWindow.set(windowId, refs);
  }
  return refs;
}

export function beginAgentWindowStreamRun(windowId: string): StreamingRefs {
  const refs = getAgentWindowStreamRefs(windowId);
  resetStreamingState(refs);
  return refs;
}

export function endAgentWindowStreamRun(windowId: string): void {
  const refs = refsByWindow.get(windowId);
  if (refs) clearStreamingState(refs);
}

export function evictAgentWindowStreamRefs(windowId: string): void {
  refsByWindow.delete(windowId);
}

export function clearAllAgentWindowStreamRefs(): void {
  refsByWindow.clear();
}

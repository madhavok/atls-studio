import type React from 'react';
/**
 * Shared streaming segment helpers.
 * Used by both handleSend and handleContinue to avoid code duplication.
 */
import type { ToolCall } from '../../stores/appStore';
import type { StreamSegment } from './index';

export interface StreamingRefs {
  streamingSegmentsRef: React.MutableRefObject<StreamSegment[]>;
  segmentsRevisionRef: React.MutableRefObject<number>;
  seenToolCallIds: React.MutableRefObject<Set<string>>;
  /** Ordered archive of segments from prior tool-loop rounds (append-only). */
  accumulatedSegmentsRef: React.MutableRefObject<StreamSegment[]>;
  isStreamingRef: React.MutableRefObject<boolean>;
}

/**
 * Append text to the current text segment or create a new one.
 */
export function appendTextToSegments(
  refs: StreamingRefs,
  text: string,
  blockId?: string,
): void {
  const segments = refs.streamingSegmentsRef.current;
  const lastSegment = segments[segments.length - 1];

  if (lastSegment && lastSegment.type === 'text' && (!blockId || lastSegment.id === blockId)) {
    lastSegment.content += text;
  } else {
    segments.push({ type: 'text', id: blockId, content: text, state: 'streaming' });
  }
  refs.segmentsRevisionRef.current++;
}

/**
 * Append reasoning text to the current reasoning segment or create a new one.
 */
export function appendReasoningToSegments(
  refs: StreamingRefs,
  text: string,
  blockId?: string,
): void {
  const segments = refs.streamingSegmentsRef.current;
  const lastSegment = segments[segments.length - 1];

  if (lastSegment && lastSegment.type === 'reasoning' && (!blockId || lastSegment.id === blockId)) {
    lastSegment.content += text;
  } else {
    segments.push({ type: 'reasoning', id: blockId, content: text, state: 'streaming' });
  }
  refs.segmentsRevisionRef.current++;
}

/**
 * Close a text or reasoning block by ID (mark state = 'done').
 */
export function closeBlockById(
  refs: StreamingRefs,
  blockId: string,
  blockType: 'text' | 'reasoning',
): void {
  const segments = refs.streamingSegmentsRef.current;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.type === blockType && seg.id === blockId) {
      seg.state = 'done';
      break;
    }
  }
  refs.segmentsRevisionRef.current++;
}

/**
 * Add or update a tool segment in the streaming segments array.
 */
export function upsertToolSegment(
  refs: StreamingRefs,
  toolCall: ToolCall,
): void {
  const segments = refs.streamingSegmentsRef.current;

  if (!refs.seenToolCallIds.current.has(toolCall.id)) {
    refs.seenToolCallIds.current.add(toolCall.id);
    segments.push({ type: 'tool', toolCall });
  } else {
    // Search live segments first, then archived segments (tool may have been
    // moved to the archive by onClear before a late status update arrived).
    let found = false;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg.type === 'tool' && seg.toolCall.id === toolCall.id) {
        seg.toolCall = { ...seg.toolCall, ...toolCall };
        found = true;
        break;
      }
    }
    if (!found) {
      const archived = refs.accumulatedSegmentsRef.current;
      for (let i = archived.length - 1; i >= 0; i--) {
        const seg = archived[i];
        if (seg.type === 'tool' && seg.toolCall.id === toolCall.id) {
          seg.toolCall = { ...seg.toolCall, ...toolCall };
          break;
        }
      }
    }
  }
  refs.segmentsRevisionRef.current++;
}

/**
 * Reset streaming state before starting a new stream.
 */
export function resetStreamingState(refs: StreamingRefs): void {
  refs.streamingSegmentsRef.current = [];
  refs.accumulatedSegmentsRef.current = [];
  refs.seenToolCallIds.current.clear();
  refs.isStreamingRef.current = true;
}

/**
 * Clean up streaming state after stream ends.
 */
export function clearStreamingState(refs: StreamingRefs): void {
  refs.streamingSegmentsRef.current = [];
  refs.accumulatedSegmentsRef.current = [];
  refs.seenToolCallIds.current.clear();
}

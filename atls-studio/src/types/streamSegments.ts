import type { ToolCall } from '../stores/appStore';

/**
 * Ordering metadata stamped on every segment at emit time.
 *
 * `seq` is a monotonic per-run counter (assigned when the segment is first
 * created, never reused). It is the canonical ordering + React key, replacing
 * fragile array-index keys that reshuffle when segments are inserted/archived.
 *
 * `round` is the 0-based tool-loop round the segment belongs to, used purely
 * for visual grouping. Both are client-only and never sent to the model.
 */
export interface SegmentOrder {
  seq?: number;
  round?: number;
}

export type StreamSegment =
  | ({ type: 'text'; id?: string; content: string; state?: 'streaming' | 'done' } & SegmentOrder)
  | ({ type: 'reasoning'; id?: string; content: string; state?: 'streaming' | 'done' } & SegmentOrder)
  | ({ type: 'tool'; toolCall: ToolCall } & SegmentOrder)
  | ({ type: 'step-boundary' } & SegmentOrder)
  | ({ type: 'error'; errorText: string } & SegmentOrder)
  | ({ type: 'status'; message: string } & SegmentOrder);

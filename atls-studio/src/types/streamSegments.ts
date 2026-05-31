import type { ToolCall } from '../stores/appStore';

export type StreamSegment =
  | { type: 'text'; id?: string; content: string; state?: 'streaming' | 'done' }
  | { type: 'reasoning'; id?: string; content: string; state?: 'streaming' | 'done' }
  | { type: 'tool'; toolCall: ToolCall }
  | { type: 'step-boundary' }
  | { type: 'error'; errorText: string }
  | { type: 'status'; message: string };

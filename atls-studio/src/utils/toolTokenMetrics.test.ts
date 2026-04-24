import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/appStore';
import type { DbSegment } from '../services/chatDb';
import {
  analyzeDbSegments,
  analyzeToolTokens,
  formatTokens,
  formatToolDisplayName,
  mergeReports,
} from './toolTokenMetrics';

function msg(m: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    timestamp: new Date(),
    ...m,
  } as Message;
}

describe('toolTokenMetrics', () => {
  it('analyzeToolTokens counts user and batch synthetic tool_name', () => {
    const messages: Message[] = [
      msg({ id: 'u1', role: 'user', content: 'hi there' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool',
            toolCall: {
              id: 't1',
              name: 'batch',
              args: { tool_name: 'read_file', path: '/x' },
              result: 'file contents',
              status: 'completed',
            },
          },
        ],
      }),
    ];
    const r = analyzeToolTokens(messages);
    expect(r.totalToolCalls).toBe(1);
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].toolName).toBe('read_file');
    expect(r.userMessageTokens).toBeGreaterThan(0);
    expect(r.grandTotalTokens).toBeGreaterThan(0);
  });

  it('formatToolDisplayName strips functions prefix', () => {
    expect(formatToolDisplayName('functions.foo')).toBe('foo');
    expect(formatToolDisplayName('batch')).toBe('batch (no step detail)');
  });

  it('formatTokens abbreviates', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_000_000)).toBe('2.0M');
  });

  it('mergeReports sums entries', () => {
    const a = analyzeToolTokens([
      msg({
        id: 'a',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool',
            toolCall: {
              id: '1',
              name: 'grep',
              args: {},
              result: 'a',
              status: 'completed',
            },
          },
        ],
      }),
    ]);
    const merged = mergeReports([a, a]);
    expect(merged.totalToolCalls).toBe(2);
    expect(merged.entries[0].callCount).toBe(2);
  });

  it('analyzeToolTokens expands syntheticChildren on tool calls', () => {
    const messages: Message[] = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool',
            toolCall: {
              id: 'p1',
              name: 'parent',
              args: {},
              result: '',
              status: 'completed',
              syntheticChildren: [
                { id: 'c1', name: 'deduped_name', args: { a: 1 }, result: 'out' },
              ],
            } as never,
          },
        ],
      }),
    ];
    const r = analyzeToolTokens(messages);
    expect(r.entries.some((e) => e.toolName === 'deduped_name')).toBe(true);
  });

  it('analyzeDbSegments reads tool rows and synthetic children in JSON', () => {
    const dbMessages = [
      { id: 'm1', role: 'user', content: 'u' },
      { id: 'm2', role: 'assistant', content: '' },
    ];
    const toolArgs = JSON.stringify({
      __syntheticChildren: [{ id: 'x', name: 'from_db', args: {}, result: 'z' }],
    });
    const segments = new Map<string, DbSegment[]>([
      [
        'm2',
        [
          {
            id: 1,
            message_id: 'm2',
            seq: 0,
            type: 'tool',
            content: '',
            tool_name: 'batch',
            tool_args: toolArgs,
          },
        ],
      ],
    ]);
    const r = analyzeDbSegments(dbMessages, segments);
    expect(r.entries.some((e) => e.toolName === 'from_db')).toBe(true);
  });

  it('mergeReports keeps larger maxResultTokens across reports', () => {
    const small = analyzeToolTokens([
      msg({
        id: 'a',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool',
            toolCall: { id: '1', name: 't', args: {}, result: 'x', status: 'completed' },
          },
        ],
      }),
    ]);
    const big = analyzeToolTokens([
      msg({
        id: 'b',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool',
            toolCall: {
              id: '2',
              name: 't',
              args: {},
              result: 'x'.repeat(5000),
              status: 'completed',
            },
          },
        ],
      }),
    ]);
    const m = mergeReports([small, big]);
    const e = m.entries.find((x) => x.toolName === 't');
    expect(e?.maxResultTokens).toBe(big.entries[0].maxResultTokens);
  });
});

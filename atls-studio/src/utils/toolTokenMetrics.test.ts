import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/appStore';
import {
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
});

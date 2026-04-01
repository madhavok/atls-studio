import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/tokenCounter', () => ({
  countTokensSync: (s: string) => Math.max(1, Math.ceil(s.length / 4)),
}));

vi.mock('./promptMemory', () => ({
  CONVERSATION_HISTORY_BUDGET_TOKENS: 100_000,
}));

import { selectRecentHistory } from './historySelector';

describe('selectRecentHistory', () => {

  it('returns empty for empty input', () => {
    expect(selectRecentHistory([])).toEqual([]);
  });

  it('returns all messages when count is at or below MIN_RECENT_MESSAGES (10)', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }));
    const out = selectRecentHistory(msgs as { role: string; content: string }[], 50_000);
    expect(out.length).toBe(10);
  });

  it('preserves first user message when it would fall outside the recent tail', () => {
    const messages: Array<{ role: string; content: string }> = [];
    messages.push({ role: 'user', content: 'task-root' });
    for (let i = 0; i < 20; i++) {
      messages.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: `fill-${i}` });
    }
    const out = selectRecentHistory(messages, 500_000);
    expect(out[0]?.content).toBe('task-root');
    expect(out.length).toBeGreaterThan(10);
  });

  it('keeps tool_result paired with preceding assistant tool_use when splitting', () => {
    const assistantTool = {
      role: 'assistant' as const,
      content: [
        { type: 'tool_use', id: 't1', name: 'x', input: {} },
      ],
    };
    const userToolResult = {
      role: 'user' as const,
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    };
    const filler = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `x${i}`,
    }));
    const messages = [
      { role: 'user' as const, content: 'start' },
      ...filler,
      assistantTool,
      userToolResult,
    ];
    const out = selectRecentHistory(messages, 800_000);
    const hasAssistant = out.some(
      m => m.role === 'assistant' && Array.isArray(m.content) && JSON.stringify(m.content).includes('tool_use'),
    );
    const hasUserResult = out.some(
      m => m.role === 'user' && Array.isArray(m.content) && JSON.stringify(m.content).includes('tool_result'),
    );
    if (hasAssistant) {
      expect(hasUserResult).toBe(true);
    }
  });
});

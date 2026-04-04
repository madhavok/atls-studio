import { describe, expect, it } from 'vitest';
import { extractFirstTextFromMessage, generateTitle, getMessageParts } from './appStore';
import type { Message } from './appStore';

describe('getMessageParts / extractFirstTextFromMessage', () => {
  it('maps segments to parts', () => {
    const msg = {
      segments: [
        { type: 'text' as const, content: ' Hello ' },
        { type: 'reasoning' as const, content: 'think' },
      ],
    };
    const parts = getMessageParts(msg);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', content: ' Hello ' });
  });

  it('extracts first text from plain content', () => {
    const msg: Message = {
      id: '1',
      role: 'user',
      content: '  Title me  ',
      timestamp: new Date(),
    };
    expect(extractFirstTextFromMessage(msg)).toBe('Title me');
  });

  it('generateTitle uses first user line up to six words', () => {
    const messages: Message[] = [
      {
        id: '1',
        role: 'user',
        content: 'hello world from the test suite today extra',
        timestamp: new Date(),
      },
    ];
    expect(generateTitle(messages)).toBe('hello world from the test suite');
  });

  it('generateTitle falls back when no user text', () => {
    expect(generateTitle([])).toBe('New Conversation');
  });
});

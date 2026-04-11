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

  it('getMessageParts prefers parts over segments and toolCalls', () => {
    const msg = {
      parts: [{ type: 'text' as const, content: 'from parts' }],
      segments: [{ type: 'text' as const, content: 'from segments' }],
    };
    expect(getMessageParts(msg)).toEqual([{ type: 'text', content: 'from parts' }]);
  });

  it('getMessageParts maps toolCalls with leading text content', () => {
    const msg = {
      content: 'intro',
      toolCalls: [
        { id: '1', name: 'x', status: 'completed' as const },
      ],
    };
    const parts = getMessageParts(msg);
    expect(parts[0]).toEqual({ type: 'text', content: 'intro' });
    expect(parts[1]).toMatchObject({ type: 'tool', toolCall: expect.objectContaining({ name: 'x' }) });
  });

  it('getMessageParts returns empty for empty message', () => {
    expect(getMessageParts({ content: '' })).toEqual([]);
  });

  it('extractFirstTextFromMessage reads first text part when content blank', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      parts: [
        { type: 'reasoning', content: 'r' },
        { type: 'text', content: '  body  ' },
      ],
    };
    expect(extractFirstTextFromMessage(msg)).toBe('body');
  });

  it('generateTitle truncates long titles', () => {
    const long = 'abcdefghij '.repeat(8).trim();
    const messages: Message[] = [
      { id: '1', role: 'user', content: long, timestamp: new Date() },
    ];
    const title = generateTitle(messages);
    expect(title.length).toBeLessThanOrEqual(50);
    expect(title.endsWith('...')).toBe(true);
  });

  it('generateTitle falls back when user message has no text', () => {
    const messages: Message[] = [
      {
        id: '1',
        role: 'user',
        content: '',
        timestamp: new Date(),
        parts: [{ type: 'tool', toolCall: { id: 'x', name: 'n', status: 'completed' } }],
      },
    ];
    expect(generateTitle(messages)).toBe('New Conversation');
  });
});

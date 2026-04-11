import { describe, expect, it } from 'vitest';
import {
  cleanStreamingContent,
  coerceStringArray,
  dialogSelectedPath,
  getTaskCompleteArgs,
  getTaskCompleteSummaryFromParts,
  isTaskCompleteCall,
} from './aiChatPure';

describe('aiChatPure', () => {
  it('isTaskCompleteCall matches task_complete', () => {
    expect(isTaskCompleteCall({ name: 'task_complete' })).toBe(true);
    expect(isTaskCompleteCall({ name: 'read_file' })).toBe(false);
  });

  it('coerceStringArray normalizes strings and arrays', () => {
    expect(coerceStringArray(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(coerceStringArray('x')).toEqual(['x']);
    expect(coerceStringArray(null)).toEqual([]);
  });

  it('dialogSelectedPath handles string and object shapes', () => {
    expect(dialogSelectedPath('/tmp/a')).toBe('/tmp/a');
    expect(dialogSelectedPath({ path: 'C:\\x' })).toBe('C:\\x');
    expect(dialogSelectedPath({ path: 1 })).toBeNull();
    expect(dialogSelectedPath(null)).toBeNull();
  });

  it('getTaskCompleteArgs merges legacy files_changed', () => {
    expect(
      getTaskCompleteArgs({
        args: { summary: 'done', files_changed: ['a.ts', 'b.ts'] },
      }),
    ).toEqual({ summary: 'done', filesChanged: ['a.ts', 'b.ts'] });
  });

  it('getTaskCompleteSummaryFromParts prefers text parts', () => {
    const s = getTaskCompleteSummaryFromParts([
      { type: 'text', content: 'Hello' },
      { type: 'tool', toolCall: { id: '1', name: 'task_complete', args: { summary: 'ignored' }, status: 'completed' } },
    ]);
    expect(s).toBe('Hello');
  });

  it('cleanStreamingContent strips tiny JSON wire fragments', () => {
    expect(cleanStreamingContent('[{')).toBe('');
    expect(cleanStreamingContent('plain prose')).toBe('plain prose');
  });
});

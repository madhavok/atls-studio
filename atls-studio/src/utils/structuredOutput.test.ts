import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  parseTaskCompleteArgs,
  parseToolArgs,
  safeParseToolArgs,
  taskCompleteArgsSchema,
} from './structuredOutput';

describe('parseTaskCompleteArgs', () => {
  it('returns validated result for valid input', () => {
    const input = { summary: 'Done', files_changed: ['a.ts', 'b.ts'] };
    expect(parseTaskCompleteArgs(input)).toEqual({
      summary: 'Done',
      filesChanged: ['a.ts', 'b.ts'],
    });
  });

  it('unwraps params when nested', () => {
    const input = {
      params: { summary: 'Task done', filesChanged: ['src/foo.ts'] },
    };
    expect(parseTaskCompleteArgs(input)).toEqual({
      summary: 'Task done',
      filesChanged: ['src/foo.ts'],
    });
  });

  it('prefers files_changed when both present', () => {
    const input = {
      summary: 'Ok',
      files_changed: ['a'],
      filesChanged: ['b'],
    };
    expect(parseTaskCompleteArgs(input)).toEqual({
      summary: 'Ok',
      filesChanged: ['a'],
    });
  });

  it('filters non-string entries from files arrays', () => {
    const input = {
      summary: 'Ok',
      files_changed: ['a', 1, null, 'b', undefined],
    };
    expect(parseTaskCompleteArgs(input)).toEqual({
      summary: 'Ok',
      filesChanged: ['a', 'b'],
    });
  });

  it('returns safe default when parse fails', () => {
    const input = {};
    expect(parseTaskCompleteArgs(input)).toEqual({
      summary: 'Task completed',
      filesChanged: [],
    });
  });

  it('repairs partial input when parse fails', () => {
    const input = { summary: 123, files_changed: ['x'] };
    expect(parseTaskCompleteArgs(input)).toEqual({
      summary: 'Task completed',
      filesChanged: ['x'],
    });
  });

  it('repairs filesChanged (camelCase) when parse fails', () => {
    const input = { summary: 123, filesChanged: ['a', 'b'] };
    expect(parseTaskCompleteArgs(input)).toEqual({
      summary: 'Task completed',
      filesChanged: ['a', 'b'],
    });
  });

  it('trims summary', () => {
    expect(parseTaskCompleteArgs({ summary: '  trimmed  ' })).toEqual({
      summary: 'trimmed',
      filesChanged: [],
    });
  });
});

describe('parseToolArgs', () => {
  const schema = z.object({ name: z.string(), count: z.number() });

  it('returns parsed value for valid input', () => {
    expect(parseToolArgs({ name: 'x', count: 3 }, schema)).toEqual({ name: 'x', count: 3 });
  });

  it('throws ZodError for invalid input', () => {
    expect(() => parseToolArgs({ name: 'x', count: 'not-a-number' }, schema)).toThrow();
    expect(() => parseToolArgs(null, schema)).toThrow();
  });
});

describe('safeParseToolArgs', () => {
  const schema = z.object({ value: z.number() });

  it('returns success + data when valid', () => {
    const result = safeParseToolArgs({ value: 42 }, schema);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ value: 42 });
  });

  it('returns success: false + error when invalid', () => {
    const result = safeParseToolArgs({ value: 'nope' }, schema);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(z.ZodError);
  });
});

describe('taskCompleteArgsSchema', () => {
  it('transforms output shape', () => {
    const parsed = taskCompleteArgsSchema.parse({ summary: 'x' });
    expect(parsed).toEqual({ summary: 'x', filesChanged: [] });
  });
});

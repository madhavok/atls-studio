import { describe, expect, it } from 'vitest';
import { TOOL_RESULT_CHAR_LIMIT, truncateToolResult } from './toolResultLimits';

describe('truncateToolResult', () => {
  it('returns input unchanged when under limit', () => {
    const s = 'hello';
    expect(truncateToolResult(s)).toBe(s);
  });

  it('returns input unchanged when length equals limit', () => {
    const s = 'a'.repeat(TOOL_RESULT_CHAR_LIMIT);
    expect(truncateToolResult(s)).toBe(s);
    expect(truncateToolResult(s).length).toBe(TOOL_RESULT_CHAR_LIMIT);
  });

  it('truncates with marker when over limit', () => {
    const s = 'a'.repeat(TOOL_RESULT_CHAR_LIMIT + 50);
    const out = truncateToolResult(s);
    expect(out.length).toBe(TOOL_RESULT_CHAR_LIMIT + '\n[truncated]'.length);
    expect(out.startsWith('a'.repeat(TOOL_RESULT_CHAR_LIMIT))).toBe(true);
    expect(out.endsWith('\n[truncated]')).toBe(true);
  });
});

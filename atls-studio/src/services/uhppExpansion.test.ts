import { describe, expect, it, vi } from 'vitest';
import { expandFilePathRefs, expandSetRefsInHashes, stripGitLabelPrefix } from './uhppExpansion';
import type { HashLookup, SetRefLookup } from '../utils/hashResolver';

describe('uhppExpansion', () => {
  it('strips git labels from source paths', () => {
    expect(stripGitLabelPrefix('HEAD:src/demo.ts')).toBe('src/demo.ts');
    expect(stripGitLabelPrefix('v1.2.3:src/demo.ts')).toBe('src/demo.ts');
    expect(stripGitLabelPrefix('src/demo.ts')).toBe('src/demo.ts');
  });

  it('expands set refs in hashes through the canonical parser', () => {
    const setLookup: SetRefLookup = vi.fn().mockReturnValue({
      hashes: ['abc12345', 'def67890'],
      entries: [
        { content: 'a', source: 'src/a.ts' },
        { content: 'b', source: 'src/b.ts' },
      ],
    });

    const result = expandSetRefsInHashes(['h:@file=src/*.ts'], setLookup);

    expect(result.expanded).toEqual(['abc12345', 'def67890']);
    expect(result.notes[0]).toMatch(/2 matched/);
  });

  it('expands file refs via canonical set semantics and disk glob dedupe', async () => {
    const hashLookup: HashLookup = vi.fn().mockResolvedValue(null);
    const setLookup: SetRefLookup = vi.fn().mockReturnValue({
      hashes: ['abc12345', 'def67890'],
      entries: [
        { content: 'a', source: 'HEAD:src/a.ts' },
        { content: 'b', source: 'src/b.ts' },
      ],
    });

    const result = await expandFilePathRefs(
      ['h:@file=src/*.ts'],
      hashLookup,
      setLookup,
      {
        projectPath: 'F:/source/atls-studio/atls-studio',
        expandFileGlob: async () => ['src/b.ts', 'src/c.ts'],
      },
    );

    expect(result.items).toEqual([
      { kind: 'path', path: 'src/a.ts' },
      { kind: 'path', path: 'src/b.ts' },
      { kind: 'path', path: 'src/c.ts' },
    ]);
    expect(result.notes[0]).toMatch(/3 files/);
  });

  it('falls back to backend hash resolution when local lookup misses', async () => {
    const hashLookup: HashLookup = vi.fn().mockResolvedValue(null);
    const setLookup: SetRefLookup = vi.fn();

    const result = await expandFilePathRefs(
      ['h:abc12345'],
      hashLookup,
      setLookup,
      {
        sessionId: 'session-1',
        resolveHashRef: async (rawRef, sessionId) => ({
          source: `${sessionId}:${rawRef}:src/demo.ts`,
          content: 'demo',
        }),
      },
    );

    expect(result.items).toEqual([{ kind: 'path', path: 'session-1:h:abc12345:src/demo.ts' }]);
    expect(result.notes[0]).toMatch(/backend resolved/);
  });
});

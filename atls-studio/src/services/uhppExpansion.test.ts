import { describe, expect, it, vi } from 'vitest';
import { expandFilePathRefs, expandSetRefsInHashes, stripGitLabelPrefix, stripTrailingLineSpan } from './uhppExpansion';
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

  it('strips trailing line-range suffix from plain file paths', async () => {
    const hashLookup: HashLookup = vi.fn().mockResolvedValue(null);
    const setLookup: SetRefLookup = vi.fn();

    const result = await expandFilePathRefs(
      ['go/gin/doc.go:1-3', 'src/lib.rs:15-30', 'src/utils.ts:42-'],
      hashLookup,
      setLookup,
    );

    expect(result.items.map(i => i.path)).toEqual([
      'go/gin/doc.go',
      'src/lib.rs',
      'src/utils.ts',
    ]);
  });

  it('does not strip Windows drive letters', async () => {
    const hashLookup: HashLookup = vi.fn().mockResolvedValue(null);
    const setLookup: SetRefLookup = vi.fn();

    const result = await expandFilePathRefs(
      ['C:\\foo\\bar.ts'],
      hashLookup,
      setLookup,
    );

    expect(result.items[0].path).toBe('C:\\foo\\bar.ts');
  });
});

describe('stripTrailingLineSpan', () => {
  it('strips line range suffixes', () => {
    expect(stripTrailingLineSpan('go/gin/doc.go:1-3')).toBe('go/gin/doc.go');
    expect(stripTrailingLineSpan('src/lib.rs:15-30')).toBe('src/lib.rs');
    expect(stripTrailingLineSpan('src/utils.ts:42-')).toBe('src/utils.ts');
  });

  it('strips line range with trailing shape modifier', () => {
    expect(stripTrailingLineSpan('src/lib.rs:15-30:dedent')).toBe('src/lib.rs');
  });

  it('preserves Windows drive letters', () => {
    expect(stripTrailingLineSpan('C:\\foo\\bar.ts')).toBe('C:\\foo\\bar.ts');
  });

  it('preserves plain paths', () => {
    expect(stripTrailingLineSpan('src/components/App.tsx')).toBe('src/components/App.tsx');
  });
});

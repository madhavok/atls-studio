import { describe, expect, it } from 'vitest';
import { mergeDefinitionsAndReferencesUnique } from './codeViewerSymbolRefs';

describe('codeViewerSymbolRefs', () => {
  it('dedupes by file, line, and kind', () => {
    const defs = [{ file: 'a.ts', line: 1, kind: 'fn' }];
    const refs = [
      { file: 'a.ts', line: 1, kind: 'fn' },
      { file: 'b.ts', line: 2 },
    ];
    expect(mergeDefinitionsAndReferencesUnique(defs, refs)).toEqual([
      { file: 'a.ts', line: 1, kind: 'fn' },
      { file: 'b.ts', line: 2 },
    ]);
  });

  it('keeps same line when kind differs', () => {
    const out = mergeDefinitionsAndReferencesUnique(
      [{ file: 'a.ts', line: 1, kind: 'a' }],
      [{ file: 'a.ts', line: 1, kind: 'b' }],
    );
    expect(out).toHaveLength(2);
  });

  it('preserves definition order before references', () => {
    const out = mergeDefinitionsAndReferencesUnique(
      [{ file: 'z.ts', line: 1 }],
      [{ file: 'a.ts', line: 1 }],
    );
    expect(out.map((e) => e.file)).toEqual(['z.ts', 'a.ts']);
  });

  it('handles empty inputs', () => {
    expect(mergeDefinitionsAndReferencesUnique([], [])).toEqual([]);
  });
});

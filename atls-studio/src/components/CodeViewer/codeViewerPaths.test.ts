import { describe, expect, it } from 'vitest';
import { normalizeEditorPath } from './codeViewerPaths';

describe('codeViewerPaths', () => {
  it('normalizeEditorPath converts backslashes', () => {
    expect(normalizeEditorPath('a\\b\\c.ts')).toBe('a/b/c.ts');
  });
});

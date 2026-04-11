import { describe, expect, it } from 'vitest';
import { normalizeEditorPath } from './codeViewerPaths';

describe('codeViewerPaths', () => {
  it('normalizeEditorPath converts backslashes', () => {
    expect(normalizeEditorPath('a\\b\\c.ts')).toBe('a/b/c.ts');
  });

  it('leaves forward slashes unchanged', () => {
    expect(normalizeEditorPath('already/ok.ts')).toBe('already/ok.ts');
  });

  it('handles empty string', () => {
    expect(normalizeEditorPath('')).toBe('');
  });
});

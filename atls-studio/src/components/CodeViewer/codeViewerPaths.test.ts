import { describe, expect, it } from 'vitest';
import { normalizeEditorPath, toEditorModelPath } from './codeViewerPaths';

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

  it('toEditorModelPath creates a file URI for project-relative paths', () => {
    expect(toEditorModelPath('src/__tests__/edit-actions.test.ts')).toBe(
      'file:///src/__tests__/edit-actions.test.ts',
    );
  });

  it('toEditorModelPath normalizes Windows paths before creating the URI', () => {
    expect(toEditorModelPath('F:\\source\\atls-studio\\src\\app.tsx')).toBe(
      'file:///F:/source/atls-studio/src/app.tsx',
    );
  });

  it('toEditorModelPath preserves existing URI paths', () => {
    expect(toEditorModelPath('file:///src/app.tsx')).toBe('file:///src/app.tsx');
  });
});

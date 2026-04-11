import { describe, expect, it } from 'vitest';
import type { WorkspaceEntry } from '../../stores/appStore';
import {
  effectiveContextMenuPaths,
  parentPathForRename,
  pathsToRelativeClipboardText,
  resolveRootFolderForMenuPath,
  workspaceEntryAbsPath,
} from './fileExplorerPaths';

describe('fileExplorerPaths', () => {
  describe('resolveRootFolderForMenuPath', () => {
    it('returns matching root for nested path', () => {
      expect(
        resolveRootFolderForMenuPath('C:\\a\\b\\c', '', ['C:\\a', 'D:\\z']),
      ).toBe('C:\\a');
    });

    it('returns root when path equals root', () => {
      expect(resolveRootFolderForMenuPath('/proj', '', ['/proj', '/other'])).toBe('/proj');
    });

    it('normalizes separators when matching', () => {
      expect(
        resolveRootFolderForMenuPath('C:/a/b', '', ['C:\\a']),
      ).toBe('C:\\a');
    });

    it('falls back to projectPath then first root', () => {
      expect(resolveRootFolderForMenuPath('/orphan/x', '/fallback', [])).toBe('/fallback');
      expect(resolveRootFolderForMenuPath('/orphan/x', '', ['/first'])).toBe('/first');
      expect(resolveRootFolderForMenuPath('/orphan/x', '', [])).toBe('');
    });
  });

  describe('effectiveContextMenuPaths', () => {
    it('returns full selection when menu path is part of a multi-select', () => {
      const sel = new Set(['/a', '/b']);
      expect(effectiveContextMenuPaths('/a', sel)).toEqual(['/a', '/b']);
    });

    it('returns single path when menu path not in multi-select', () => {
      const sel = new Set(['/x', '/y']);
      expect(effectiveContextMenuPaths('/a', sel)).toEqual(['/a']);
    });

    it('returns single path when only one selected', () => {
      const sel = new Set(['/a']);
      expect(effectiveContextMenuPaths('/a', sel)).toEqual(['/a']);
    });
  });

  describe('pathsToRelativeClipboardText', () => {
    it('strips project prefix and leading separators', () => {
      expect(pathsToRelativeClipboardText(['/proj/src/a.ts', '/proj/b.ts'], '/proj')).toBe('src/a.ts\nb.ts');
      expect(pathsToRelativeClipboardText(['C:\\proj\\x'], 'C:\\proj')).toBe('x');
    });
  });

  describe('parentPathForRename', () => {
    it('handles unix paths', () => {
      expect(parentPathForRename('/a/b/c.ts')).toBe('/a/b');
    });

    it('handles windows-style paths', () => {
      expect(parentPathForRename('C:\\a\\b.txt')).toBe('C:\\a');
    });

    it('handles root-only path', () => {
      expect(parentPathForRename('/')).toBe('/');
    });

    it('handles drive root file', () => {
      expect(parentPathForRename('C:\\file.txt')).toBe('C:');
    });
  });

  describe('workspaceEntryAbsPath', () => {
    const ws = (partial: Partial<WorkspaceEntry>): WorkspaceEntry => ({
      name: 'w',
      path: '.',
      types: [],
      build_files: [],
      group: null,
      source: 'auto',
      ...partial,
    });

    it('uses abs_path when present', () => {
      expect(workspaceEntryAbsPath(ws({ abs_path: 'Z:\\abs' }), '/any')).toBe('Z:\\abs');
    });

    it('joins under unix project root', () => {
      expect(workspaceEntryAbsPath(ws({ path: 'crates/foo' }), '/proj')).toBe('/proj/crates/foo');
    });

    it('uses project root only when path is dot', () => {
      expect(workspaceEntryAbsPath(ws({ path: '.' }), '/proj/')).toBe('/proj');
    });

    it('uses backslash when project root is windows', () => {
      expect(workspaceEntryAbsPath(ws({ path: 'pkg/sub' }), 'C:\\repo')).toBe('C:\\repo\\pkg\\sub');
    });

    it('returns empty when no project root', () => {
      expect(workspaceEntryAbsPath(ws({ path: 'x' }), undefined)).toBe('');
    });
  });
});

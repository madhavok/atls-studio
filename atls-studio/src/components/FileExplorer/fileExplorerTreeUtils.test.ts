import { describe, expect, it } from 'vitest';
import type { FileNode } from '../../stores/appStore';
import {
  filterFileNodesByQuery,
  flattenVisiblePaths,
  isImageFile,
} from './fileExplorerTreeUtils';

describe('fileExplorerTreeUtils', () => {
  describe('filterFileNodesByQuery', () => {
    const tree: FileNode[] = [
      {
        name: 'src',
        path: '/p/src',
        type: 'directory',
        children: [
          { name: 'App.tsx', path: '/p/src/App.tsx', type: 'file' },
          { name: 'util.ts', path: '/p/src/util.ts', type: 'file' },
        ],
      },
      { name: 'README.md', path: '/p/README.md', type: 'file' },
    ];

    it('returns same nodes when query is empty', () => {
      expect(filterFileNodesByQuery(tree, '')).toBe(tree);
    });

    it('matches case-insensitively on name', () => {
      const out = filterFileNodesByQuery(tree, 'readme');
      expect(out).toEqual([{ name: 'README.md', path: '/p/README.md', type: 'file' }]);
    });

    it('includes parent directory when only children match', () => {
      const out = filterFileNodesByQuery(tree, 'app');
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe('src');
      expect(out[0].expanded).toBe(true);
      expect(out[0].children).toEqual([
        { name: 'App.tsx', path: '/p/src/App.tsx', type: 'file' },
      ]);
    });

    it('returns empty when nothing matches', () => {
      expect(filterFileNodesByQuery(tree, 'zzz')).toEqual([]);
    });
  });

  describe('flattenVisiblePaths', () => {
    it('respects expanded set', () => {
      const nodes: FileNode[] = [
        { name: 'a', path: '/a', type: 'directory', children: [{ name: 'b.ts', path: '/a/b.ts', type: 'file' }] },
      ];
      expect(flattenVisiblePaths(nodes, new Set())).toEqual(['/a']);
      expect(flattenVisiblePaths(nodes, new Set(['/a']))).toEqual(['/a', '/a/b.ts']);
    });

    it('walks multiple siblings and nesting', () => {
      const nodes: FileNode[] = [
        {
          name: 'a',
          path: '/a',
          type: 'directory',
          children: [
            { name: 'b', path: '/a/b', type: 'directory', children: [{ name: 'c', path: '/a/b/c', type: 'file' }] },
          ],
        },
        { name: 'd', path: '/d', type: 'file' },
      ];
      const expanded = new Set(['/a', '/a/b']);
      expect(flattenVisiblePaths(nodes, expanded)).toEqual(['/a', '/a/b', '/a/b/c', '/d']);
    });

    it('skips children when folder not expanded', () => {
      const nodes: FileNode[] = [
        { name: 'a', path: '/a', type: 'directory', children: [{ name: 'b', path: '/a/b', type: 'file' }] },
      ];
      expect(flattenVisiblePaths(nodes, new Set())).toEqual(['/a']);
    });

    it('does not descend when expanded but children missing', () => {
      const nodes: FileNode[] = [{ name: 'a', path: '/a', type: 'directory' }];
      expect(flattenVisiblePaths(nodes, new Set(['/a']))).toEqual(['/a']);
    });
  });

  describe('isImageFile', () => {
    it('detects common extensions', () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']) {
        expect(isImageFile(`x.${ext}`)).toBe(true);
        expect(isImageFile(`X.${ext.toUpperCase()}`)).toBe(true);
      }
    });

    it('returns false for non-images', () => {
      expect(isImageFile('x.ts')).toBe(false);
      expect(isImageFile('Makefile')).toBe(false);
    });

    it('treats extension-looking basename as that extension (no dot)', () => {
      expect(isImageFile('png')).toBe(true);
    });

    it('treats missing or empty extension as non-image', () => {
      expect(isImageFile('noext')).toBe(false);
      expect(isImageFile('file.')).toBe(false);
    });
  });
});

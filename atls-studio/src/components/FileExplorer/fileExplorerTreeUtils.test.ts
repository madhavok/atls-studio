import { describe, expect, it } from 'vitest';
import type { FileNode } from '../../stores/appStore';
import { flattenVisiblePaths, isImageFile } from './fileExplorerTreeUtils';

describe('fileExplorerTreeUtils', () => {
  it('flattenVisiblePaths respects expanded set', () => {
    const nodes: FileNode[] = [
      { name: 'a', path: '/a', type: 'directory', children: [{ name: 'b.ts', path: '/a/b.ts', type: 'file' }] },
    ];
    expect(flattenVisiblePaths(nodes, new Set())).toEqual(['/a']);
    expect(flattenVisiblePaths(nodes, new Set(['/a']))).toEqual(['/a', '/a/b.ts']);
  });

  it('isImageFile detects common extensions', () => {
    expect(isImageFile('x.png')).toBe(true);
    expect(isImageFile('x.ts')).toBe(false);
  });
});

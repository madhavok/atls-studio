import { describe, expect, it } from 'vitest';
import { normPath } from './useAtlsPaths';

describe('normPath', () => {
  it('normalizes backslashes to forward slashes', () => {
    expect(normPath('C:\\Users\\proj\\src\\a.ts')).toBe('C:/Users/proj/src/a.ts');
  });

  it('leaves posix paths unchanged', () => {
    expect(normPath('/home/foo/bar')).toBe('/home/foo/bar');
  });
});

import { describe, expect, it } from 'vitest';
import { detectFileType } from './attachments';

describe('attachments detectFileType', () => {
  it('classifies code extensions', () => {
    expect(detectFileType('foo.ts')).toBe('code');
    expect(detectFileType('x.RS')).toBe('code');
  });

  it('classifies image extensions', () => {
    expect(detectFileType('a.png')).toBe('image');
    expect(detectFileType('b.JPEG')).toBe('image');
  });

  it('returns unknown for other or missing extension', () => {
    expect(detectFileType('README')).toBe('unknown');
    expect(detectFileType('file.xyz')).toBe('unknown');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOwnWrite, registerOwnWrite } from './useAtls';

describe('own-write tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers paths and matches case-insensitive normalized keys', () => {
    registerOwnWrite(['C:\\foo\\Bar.ts']);
    expect(isOwnWrite('c:/foo/bar.ts')).toBe(true);
  });

  it('drops entries after TTL', () => {
    registerOwnWrite(['/tmp/x.ts']);
    expect(isOwnWrite('/tmp/x.ts')).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(isOwnWrite('/tmp/x.ts')).toBe(false);
  });
});

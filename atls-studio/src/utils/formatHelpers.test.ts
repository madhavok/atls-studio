import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAge } from './formatHelpers';

describe('formatAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats seconds for recent timestamps', () => {
    const created = new Date('2026-01-15T11:59:30Z');
    expect(formatAge(created)).toMatch(/30s/);
  });

  it('formats minutes between 60s and 24h', () => {
    const created = new Date('2026-01-15T11:30:00Z');
    expect(formatAge(created)).toBe('30m');
  });

  it('formats whole hours below 24h', () => {
    const created = new Date('2026-01-15T11:00:00Z');
    expect(formatAge(created)).toBe('1h');
  });

  it('formats days for old timestamps', () => {
    const created = new Date('2026-01-10T12:00:00Z');
    expect(formatAge(created)).toMatch(/\d+d/);
  });
});

import { describe, it, expect } from 'vitest';
import { formatStatsLine, formatSuspectHint } from './contextFormatter';

describe('formatStatsLine round count', () => {
  it('includes round:{N} when roundCount > 0', () => {
    const line = formatStatsLine(50000, 200000, 10, 3, 500, 0, undefined, undefined, undefined, undefined, undefined, undefined, 4);
    expect(line).toContain('round:4');
  });

  it('omits round when roundCount is 0', () => {
    const line = formatStatsLine(50000, 200000, 10, 3, 500, 0, undefined, undefined, undefined, undefined, undefined, undefined, 0);
    expect(line).not.toContain('round:');
  });

  it('omits round when roundCount is undefined', () => {
    const line = formatStatsLine(50000, 200000, 10, 3, 500, 0);
    expect(line).not.toContain('round:');
  });
});

describe('formatSuspectHint', () => {
  it('returns empty for no freshness state', () => {
    expect(formatSuspectHint()).toBe('');
    expect(formatSuspectHint(undefined, undefined, undefined)).toBe('');
  });

  it('returns empty for fresh/shifted/forwarded (non-blocking states)', () => {
    expect(formatSuspectHint(undefined, 'fresh')).toBe('');
    expect(formatSuspectHint(undefined, 'shifted', 'same_file_prior_edit')).toBe('');
    expect(formatSuspectHint(undefined, 'forwarded', 'hash_forward')).toBe('');
  });

  it('returns unified STALE label for suspect regardless of cause', () => {
    const causes = ['same_file_prior_edit', 'external_file_change', 'watcher_event', 'unknown', 'session_restore'];
    for (const cause of causes) {
      const hint = formatSuspectHint(Date.now(), 'suspect', cause);
      expect(hint).toBe(' [STALE: re-read before edit]');
    }
  });

  it('returns STALE for changed freshness', () => {
    expect(formatSuspectHint(undefined, 'changed')).toBe(' [STALE: re-read before edit]');
  });

  it('returns STALE when suspectSince is set even without freshness field', () => {
    expect(formatSuspectHint(Date.now())).toBe(' [STALE: re-read before edit]');
  });
});

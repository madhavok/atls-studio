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

  it('returns hard failure for suspect + same_file_prior_edit (real refresh failure)', () => {
    const hint = formatSuspectHint(Date.now(), 'suspect', 'same_file_prior_edit');
    expect(hint).toContain('edit refresh failed');
  });

  it('returns neutral wording for shifted (rebaseable post-edit reconcile)', () => {
    const hint = formatSuspectHint(undefined, 'shifted', 'same_file_prior_edit');
    expect(hint).toContain('revision shifted');
    expect(hint).not.toContain('edit refresh failed');
  });

  it('returns external change warning for watcher_event suspect', () => {
    const hint = formatSuspectHint(Date.now(), 'suspect', 'watcher_event');
    expect(hint).toContain('external file change');
  });

  it('returns generic suspect for unknown cause', () => {
    const hint = formatSuspectHint(Date.now(), 'suspect', 'unknown');
    expect(hint).toContain('suspect');
  });
});

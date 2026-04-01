import { describe, it, expect } from 'vitest';
import { formatStatsLine } from './contextFormatter';

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

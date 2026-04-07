import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRefs: unknown[] = [];

vi.mock('./hashProtocol', () => ({
  collectRefsWhere: (pred: (r: unknown) => boolean) => mockRefs.filter(pred),
}));

import { getActiveRefs } from './hashProtocolQuery';

describe('getActiveRefs', () => {
  beforeEach(() => {
    mockRefs.length = 0;
  });

  it('filters out evicted refs', () => {
    mockRefs.push(
      { visibility: 'active' },
      { visibility: 'evicted' },
      { visibility: undefined },
    );
    const out = getActiveRefs();
    expect(out).toHaveLength(2);
    expect(out.every(r => r.visibility !== 'evicted')).toBe(true);
  });

  it('returns empty when no refs', () => {
    expect(getActiveRefs()).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAllRefs = vi.fn();

vi.mock('./hashProtocol', () => ({
  getAllRefs: () => mockGetAllRefs(),
}));

import { getActiveRefs } from './hashProtocolQuery';

describe('getActiveRefs', () => {
  beforeEach(() => {
    mockGetAllRefs.mockReset();
  });

  it('filters out evicted refs', () => {
    mockGetAllRefs.mockReturnValue([
      { visibility: 'active' },
      { visibility: 'evicted' },
      { visibility: undefined },
    ]);
    const out = getActiveRefs();
    expect(out).toHaveLength(2);
    expect(out.every(r => r.visibility !== 'evicted')).toBe(true);
  });

  it('returns empty when no refs', () => {
    mockGetAllRefs.mockReturnValue([]);
    expect(getActiveRefs()).toEqual([]);
  });
});

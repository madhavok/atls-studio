import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetRef = vi.fn();

vi.mock('./hashProtocol', () => ({
  getRef: (h: string) => mockGetRef(h),
}));

import {
  setRoundRefreshHook,
  getRoundRefreshHook,
  setPinned,
} from './hashProtocolState';

describe('hashProtocolState', () => {
  beforeEach(() => {
    mockGetRef.mockReset();
    setRoundRefreshHook(null);
  });

  it('round refresh hook round-trips', () => {
    const fn = vi.fn();
    setRoundRefreshHook(fn);
    expect(getRoundRefreshHook()).toBe(fn);
    setRoundRefreshHook(null);
    expect(getRoundRefreshHook()).toBeNull();
  });

  it('setPinned updates ref when getRef returns a ref', () => {
    const ref = { pinned: false as boolean, pinnedShape: undefined as string | undefined };
    mockGetRef.mockReturnValue(ref);
    setPinned('abc', true, 'shape1');
    expect(ref.pinned).toBe(true);
    expect(ref.pinnedShape).toBe('shape1');
  });

  it('setPinned is a no-op when ref missing', () => {
    mockGetRef.mockReturnValue(undefined);
    expect(() => setPinned('missing', true)).not.toThrow();
  });
});

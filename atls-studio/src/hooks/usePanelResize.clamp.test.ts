import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampBottom, clampLeft, clampRight } from './usePanelResize';

describe('panel clamp helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      innerWidth: 2000,
      innerHeight: 1200,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clamps left width into bounds', () => {
    expect(clampLeft(50)).toBe(160);
    expect(clampLeft(10_000)).toBe(500);
  });

  it('clamps right and bottom', () => {
    expect(clampRight(100)).toBe(360);
    expect(clampBottom(50)).toBe(100);
  });
});

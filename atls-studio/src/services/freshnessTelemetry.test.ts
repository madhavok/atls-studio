import { describe, expect, it } from 'vitest';
import { freshnessTelemetry } from './freshnessTelemetry';
import { useContextStore } from '../stores/contextStore';

describe('freshnessTelemetry', () => {
  it('resets with resetSession', () => {
    freshnessTelemetry.fileTreeChangedWithPaths = 3;
    freshnessTelemetry.fileTreeChangedCoarseNoPaths = 2;
    useContextStore.getState().resetSession();
    expect(freshnessTelemetry.fileTreeChangedWithPaths).toBe(0);
    expect(freshnessTelemetry.fileTreeChangedCoarseNoPaths).toBe(0);
  });
});

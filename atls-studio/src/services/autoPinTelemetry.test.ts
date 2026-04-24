import { afterEach, describe, expect, it } from 'vitest';
import {
  drainAutoPinMetrics,
  peekAutoPinMetrics,
  recordAutoPinCreated,
  recordAutoPinReleasedUnused,
  resetAutoPinTelemetry,
} from './autoPinTelemetry';

describe('autoPinTelemetry', () => {
  afterEach(() => {
    resetAutoPinTelemetry();
  });

  it('drain returns counts and clears', () => {
    recordAutoPinCreated();
    recordAutoPinCreated();
    recordAutoPinReleasedUnused();
    expect(drainAutoPinMetrics()).toEqual({ created: 2, releasedUnused: 1 });
    expect(drainAutoPinMetrics()).toEqual({ created: 0, releasedUnused: 0 });
  });

  it('peek does not clear', () => {
    recordAutoPinCreated();
    expect(peekAutoPinMetrics()).toEqual({ created: 1, releasedUnused: 0 });
    expect(peekAutoPinMetrics()).toEqual({ created: 1, releasedUnused: 0 });
    drainAutoPinMetrics();
  });

  it('reset zeroes', () => {
    recordAutoPinCreated();
    resetAutoPinTelemetry();
    expect(peekAutoPinMetrics()).toEqual({ created: 0, releasedUnused: 0 });
  });
});

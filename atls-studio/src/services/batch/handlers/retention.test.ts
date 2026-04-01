import { describe, it, expect, beforeEach } from 'vitest';
import { useRetentionStore } from '../../../stores/retentionStore';
import { checkRetention } from './retention';

describe('checkRetention', () => {
  beforeEach(() => {
    useRetentionStore.getState().reset();
  });

  it('returns reused false when op is not fingerprinted', () => {
    const r = checkRetention('change.edit', {}, 'content', true, 'raw', 'label');
    expect(r.reused).toBe(false);
  });

  it('keeps first result then collapses identical search.code outcome', () => {
    const params = { queries: ['alpha'] };
    const body = 'search result text';
    const first = checkRetention('search.code', params, body, true, 'raw', 'search');
    expect(first.reused).toBe(false);

    const second = checkRetention('search.code', params, body, true, 'raw', 'search');
    expect(second.reused).toBe(true);
    if (second.reused) {
      expect(second.output.summary).toMatch(/reusing h:/);
      expect(second.output.refs.length).toBeGreaterThan(0);
    }
  });
});

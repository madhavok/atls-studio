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

  it('after repeated identical outcomes returns distillSummary with empty refs', () => {
    const params = { queries: ['beta'] };
    const body = 'same body';
    expect(checkRetention('search.code', params, body, true, 'search_results', 'lbl').reused).toBe(false);
    expect(checkRetention('search.code', params, body, true, 'search_results', 'lbl').reused).toBe(true);
    const third = checkRetention('search.code', params, body, true, 'search_results', 'lbl');
    expect(third.reused).toBe(true);
    if (third.reused) {
      expect(third.output.refs).toEqual([]);
      expect(third.output.summary).toMatch(/Repeated search\.code/);
      expect(third.output.summary).toMatch(/3x/);
    }
  });
});

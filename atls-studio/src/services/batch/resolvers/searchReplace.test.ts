import { describe, expect, it } from 'vitest';
import { resolveSearchReplace } from './searchReplace';
import type { IntentContext } from '../types';

function emptyContext(): IntentContext {
  return {
    staged: new Map(),
    pinned: new Set(),
    pinnedSources: new Set(),
    bbKeys: new Map(),
    awareness: new Map(),
    priorOutputs: new Map(),
  };
}

describe('resolveSearchReplace', () => {
  it('emits search.code and change.edit steps', () => {
    const ctx = emptyContext();
    const { steps } = resolveSearchReplace(
      {
        old_text: 'foo',
        new_text: 'bar',
        search_query: 'foo',
        max_matches: 2,
      },
      ctx,
    );
    expect(steps.length).toBeGreaterThan(2);
    expect(steps[0].use).toBe('search.code');
    expect(steps[1].use).toBe('change.edit');
  });

  it('returns no steps when bb cache hit', () => {
    const ctx = emptyContext();
    const bbKeys = new Map<string, { tokens: number }>();
    bbKeys.set('search_replace:foo', { tokens: 1 });
    const { steps } = resolveSearchReplace(
      { old_text: 'foo', new_text: 'bar', search_query: 'foo' },
      { ...ctx, bbKeys },
    );
    expect(steps).toEqual([]);
  });
});

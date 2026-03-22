import { beforeEach, describe, expect, it } from 'vitest';
import { useRetentionStore } from './retentionStore';

describe('retentionStore', () => {
  beforeEach(() => {
    useRetentionStore.getState().reset();
  });

  it('collapses same-outcome reruns', () => {
    const store = useRetentionStore.getState();
    const a1 = store.recordResult('verify:verify.build', 'hash1', true);
    expect(a1.action).toBe('keep');

    const a2 = store.recordResult('verify:verify.build', 'hash2', true);
    expect(a2.action).toBe('collapse');
  });

  it('keeps when outcome changes', () => {
    const store = useRetentionStore.getState();
    store.recordResult('verify:verify.build', 'hash1', true);
    const a2 = store.recordResult('verify:verify.build', 'hash2', false);
    expect(a2.action).toBe('keep');
    expect(a2.reason).toBe('outcome_changed');
  });

  it('evictByPrefix removes matching entries', () => {
    const store = useRetentionStore.getState();
    store.recordResult('verify:verify.build', 'h1', true);
    store.recordResult('verify:verify.typecheck', 'h2', true);
    store.recordResult('exec:npm run build', 'h3', true);

    const evicted = useRetentionStore.getState().evictByPrefix('verify:');
    expect(evicted).toBe(2);
    expect(useRetentionStore.getState().getEntry('verify:verify.build')).toBeNull();
    expect(useRetentionStore.getState().getEntry('exec:npm run build')).not.toBeNull();
  });

  it('evictMutationSensitive removes verify, exec, search.issues, and analyze entries', () => {
    const store = useRetentionStore.getState();
    store.recordResult('verify:verify.build', 'h1', true);
    store.recordResult('verify:verify.typecheck', 'h2', true);
    store.recordResult('exec:npm run build', 'h3', true);
    store.recordResult('exec:npx tsc --noEmit', 'h4', true);
    store.recordResult('search.issues', 'h5', true);
    store.recordResult('analyze:analyze.deps:src/a.ts', 'h6', true);
    store.recordResult('search.code:auth', 'h7', true);

    const evicted = useRetentionStore.getState().evictMutationSensitive();
    expect(evicted).toBe(6);

    expect(useRetentionStore.getState().getEntry('verify:verify.build')).toBeNull();
    expect(useRetentionStore.getState().getEntry('exec:npm run build')).toBeNull();
    expect(useRetentionStore.getState().getEntry('exec:npx tsc --noEmit')).toBeNull();
    expect(useRetentionStore.getState().getEntry('search.issues')).toBeNull();
    expect(useRetentionStore.getState().getEntry('analyze:analyze.deps:src/a.ts')).toBeNull();
    // search.code should survive — not mutation-sensitive
    expect(useRetentionStore.getState().getEntry('search.code:auth')).not.toBeNull();
  });

  it('evictMutationSensitive returns 0 when no matching entries', () => {
    const store = useRetentionStore.getState();
    store.recordResult('search.code:auth', 'h1', true);
    store.recordResult('search.symbol:foo', 'h2', true);

    const evicted = useRetentionStore.getState().evictMutationSensitive();
    expect(evicted).toBe(0);
  });
});

/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../stores/contextStore';
import { materialize, getRef } from './hashProtocol';
import {
  activateContextSession,
  evictContextPartition,
  getActiveContextSessionId,
  isContextSessionLocked,
  withContextSession,
} from './contextSessionPartition';

vi.mock('./chatDb', () => ({
  chatDb: {
    isInitialized: () => false,
    getMemorySnapshot: vi.fn(),
    saveMemorySnapshot: vi.fn(),
  },
}));

describe('contextSessionPartition', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    evictContextPartition('session-a');
    evictContextPartition('session-b');
  });

  it('activates fresh session partition', async () => {
    await activateContextSession('session-a', { fresh: true });
    expect(getActiveContextSessionId()).toBe('session-a');
  });

  it('swaps partitions and preserves cognitive rules per session', async () => {
    await activateContextSession('session-a', { fresh: true });
    useContextStore.getState().setRule('rule-a', 'Always validate imports');

    await activateContextSession('session-b', { fresh: true });
    useContextStore.getState().setRule('rule-b', 'Prefer batch tools');

    await activateContextSession('session-a', { loadFromDb: false, lite: true });
    expect(useContextStore.getState().cognitiveRules.has('rule-a')).toBe(true);
    expect(useContextStore.getState().cognitiveRules.has('rule-b')).toBe(false);

    await activateContextSession('session-b', { loadFromDb: false, lite: true });
    expect(useContextStore.getState().cognitiveRules.has('rule-b')).toBe(true);
  });

  it('withContextSession locks during execution', async () => {
    let lockedDuringRun = false;
    await withContextSession('session-a', async () => {
      lockedDuringRun = isContextSessionLocked();
    }, { fresh: true });
    expect(lockedDuringRun).toBe(true);
    expect(isContextSessionLocked()).toBe(false);
  });

  it('preserves HPP refs across session swap', async () => {
    await activateContextSession('session-a', { fresh: true });
    materialize('abc1234567890abcd', 'file', 'src/a.ts', 50, 10, 'd1');

    await activateContextSession('session-b', { fresh: true });
    materialize('def1234567890abcd', 'file', 'src/b.ts', 60, 12, 'd2');

    await activateContextSession('session-a', { loadFromDb: false, lite: true });
    expect(getRef('abc1234567890abcd')?.source).toBe('src/a.ts');
    expect(getRef('def1234567890abcd')).toBeUndefined();
  });

  it('isolates blackboard entries across session swaps', async () => {
    await activateContextSession('session-a', { fresh: true });
    useContextStore.getState().setBlackboardEntry('plan', 'Session A plan');

    await activateContextSession('session-b', { fresh: true });
    useContextStore.getState().setBlackboardEntry('plan', 'Session B plan');

    await activateContextSession('session-a', { loadFromDb: false, lite: true });
    expect(useContextStore.getState().blackboardEntries.get('plan')?.content).toBe('Session A plan');

    await activateContextSession('session-b', { loadFromDb: false, lite: true });
    expect(useContextStore.getState().blackboardEntries.get('plan')?.content).toBe('Session B plan');
  });

  it('restores prior session blackboard after withContextSession', async () => {
    await activateContextSession('session-a', { fresh: true });
    useContextStore.getState().setBlackboardEntry('memo', 'Parent memo');

    await withContextSession('session-b', async () => {
      useContextStore.getState().setBlackboardEntry('memo', 'Child memo');
      expect(useContextStore.getState().blackboardEntries.get('memo')?.content).toBe('Child memo');
    }, { fresh: true });

    expect(useContextStore.getState().blackboardEntries.get('memo')?.content).toBe('Parent memo');
  });

  it('serializes concurrent withContextSession without cross-contamination', async () => {
    const readMemo = async (sessionId: string, value: string, delayMs: number) => withContextSession(sessionId, async () => {
      useContextStore.getState().setBlackboardEntry('memo', value);
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
      return useContextStore.getState().blackboardEntries.get('memo')?.content;
    }, { fresh: true });

    const [a, b] = await Promise.all([
      readMemo('session-a', 'Memo A', 15),
      readMemo('session-b', 'Memo B', 5),
    ]);

    expect(new Set([a, b])).toEqual(new Set(['Memo A', 'Memo B']));
  });
});

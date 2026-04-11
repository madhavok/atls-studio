/**
 * Working memory / HPP integration — store pin state must drive ChunkRef.pinned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { formatWorkingMemory } from './contextFormatter';
import { advanceTurn, getRef, shouldMaterialize } from './hashProtocol';
import { useContextStore } from '../stores/contextStore';

function resetStore() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [] });
}

function wmInput() {
  const state = useContextStore.getState();
  return {
    chunks: state.chunks,
    blackboardEntries: state.blackboardEntries,
    cognitiveRules: state.cognitiveRules,
    droppedManifest: state.droppedManifest,
    stagedSnippets: state.stagedSnippets,
    taskPlan: state.taskPlan,
    maxTokens: state.maxTokens,
    freedTokens: state.freedTokens,
    usedTokens: state.getUsedTokens(),
    pinnedCount: state.getPinnedCount(),
    bbTokens: state.getBlackboardTokenCount(),
  };
}

describe('syncHppPinsWithStore (via formatWorkingMemory)', () => {
  beforeEach(() => resetStore());

  it('keeps pinned chunks materialized across advanceTurn when pin preceded first ref', async () => {
    const hash = useContextStore.getState().addChunk('line1\nline2', 'search', 'qs');
    useContextStore.getState().pinChunks([hash]);

    let ref = getRef(hash);
    expect(ref).toBeUndefined();

    formatWorkingMemory(wmInput());
    ref = getRef(hash);
    expect(ref).toBeDefined();
    expect(ref?.pinned).toBe(true);
    expect(shouldMaterialize(ref!)).toBe(true);

    await advanceTurn();
    ref = getRef(hash);
    expect(ref?.visibility).toBe('materialized');
    expect(ref?.pinned).toBe(true);
    expect(shouldMaterialize(ref!)).toBe(true);
  });

  it('clears HPP pin when store chunk is unpinned', async () => {
    const hash = useContextStore.getState().addChunk('x', 'file', 'a.ts');
    useContextStore.getState().pinChunks([hash]);
    formatWorkingMemory(wmInput());
    expect(getRef(hash)?.pinned).toBe(true);

    useContextStore.getState().unpinChunks([hash]);
    formatWorkingMemory(wmInput());
    expect(getRef(hash)?.pinned).toBe(false);
  });
});

/**
 * Working memory / HPP integration — store pin state must drive ChunkRef.pinned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { formatWorkingMemory } from './contextFormatter';
import { advanceTurn, dematerialize, getRef, materialize, shouldMaterialize } from './hashProtocol';
import { useContextStore } from '../stores/contextStore';
import { hashContentSync } from '../utils/contextHash';

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

  it('applies pinnedShape from store when pin ran before first ref', () => {
    const short = useContextStore.getState().addChunk('line', 'search', 'q');
    useContextStore.getState().pinChunks([short], 'sig');
    expect(getRef(short)).toBeUndefined();

    formatWorkingMemory(wmInput());
    const ref = getRef(short);
    expect(ref?.pinned).toBe(true);
    expect(ref?.pinnedShape).toBe('sig');
  });

  it('emit-style materialize+dematerialize registers a referenced ref', () => {
    const body = 'snippet';
    useContextStore.getState().addChunk(body, 'result', 'lbl');
    const fullKey = hashContentSync(body);
    const chunk = useContextStore.getState().chunks.get(fullKey)!;
    materialize(chunk.hash, 'result', 'lbl', chunk.tokens, 1, '');
    dematerialize(chunk.hash);
    expect(getRef(chunk.hash)?.visibility).toBe('referenced');
  });
});

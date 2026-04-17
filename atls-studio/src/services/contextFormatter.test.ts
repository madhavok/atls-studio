/**
 * Working memory / HPP integration — store pin state must drive ChunkRef.pinned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { formatWorkingMemory, formatSuspectHint, formatTaskLine } from './contextFormatter';
import type { TaskPlan } from '../stores/contextStore';
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
    const hash = useContextStore.getState().addChunk('x', 'search', 'a.ts');
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
    materialize(chunk.hash, 'result', 'lbl', chunk.tokens, 1, '', chunk.shortHash);
    dematerialize(chunk.hash);
    expect(getRef(chunk.hash)?.visibility).toBe('referenced');
  });

  it('user-message boundary: unpinned chunks dematerialize on stream-start advanceTurn, pinned stay materialized', async () => {
    const store = useContextStore.getState();
    const unpinnedHash = store.addChunk('search hit A line1\nsearch hit A line2', 'search', 'src/a.ts');
    const pinnedHash = store.addChunk('search hit B line1\nsearch hit B line2', 'search', 'src/b.ts');
    store.pinChunks([pinnedHash]);

    formatWorkingMemory(wmInput());

    const unpinnedRefBefore = getRef(unpinnedHash);
    const pinnedRefBefore = getRef(pinnedHash);
    expect(unpinnedRefBefore?.visibility).toBe('materialized');
    expect(unpinnedRefBefore?.pinned).toBeFalsy();
    expect(pinnedRefBefore?.visibility).toBe('materialized');
    expect(pinnedRefBefore?.pinned).toBe(true);
    expect(shouldMaterialize(unpinnedRefBefore!)).toBe(true);
    expect(shouldMaterialize(pinnedRefBefore!)).toBe(true);

    await advanceTurn();

    const unpinnedRefAfter = getRef(unpinnedHash);
    const pinnedRefAfter = getRef(pinnedHash);
    expect(unpinnedRefAfter?.visibility).toBe('referenced');
    expect(shouldMaterialize(unpinnedRefAfter!)).toBe(false);
    expect(pinnedRefAfter?.visibility).toBe('materialized');
    expect(pinnedRefAfter?.pinned).toBe(true);
    expect(shouldMaterialize(pinnedRefAfter!)).toBe(true);

    const wmAfter = formatWorkingMemory(wmInput());
    expect(wmAfter).toContain('src/b.ts');
    expect(wmAfter).not.toContain('search hit A line1\nsearch hit A line2');
  });
});

describe('formatSuspectHint / formatTaskLine (golden)', () => {
  it('formatSuspectHint matches stable literals', () => {
    expect(formatSuspectHint(undefined, undefined)).toMatchInlineSnapshot('""');
    expect(formatSuspectHint(Date.now(), undefined)).toMatchInlineSnapshot('" [STALE: re-read before edit]"');
    expect(formatSuspectHint(undefined, 'suspect')).toMatchInlineSnapshot('" [STALE: re-read before edit]"');
  });

  it('formatTaskLine matches stable multi-line plan text', () => {
    const plan: TaskPlan = {
      id: 'plan-1',
      goal: 'Fix login',
      subtasks: [
        { id: 'a', title: 'Read auth', status: 'done' },
        { id: 'b', title: 'Patch bug', status: 'active' },
        { id: 'c', title: 'Verify', status: 'pending' },
      ],
      activeSubtaskId: 'b',
      status: 'active',
      createdAt: 0,
      retryCount: 0,
      evidenceRefs: [],
    };
    expect(formatTaskLine(null)).toMatchInlineSnapshot('""');
    expect(formatTaskLine({ ...plan, subtasks: [] })).toMatchInlineSnapshot('"<<TASK: Fix login>>"');
    expect(formatTaskLine(plan)).toMatchInlineSnapshot(`
      "<<TASK: Fix login>>
      <<PLAN: [1/3 done] Read auth(done) -> Patch bug(active) -> Verify>>"
    `);
  });
});

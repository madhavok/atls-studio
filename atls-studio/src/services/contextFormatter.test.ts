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

describe('formatWorkingMemory — FileView block rendering', () => {
  beforeEach(() => resetStore());

  it('renders a ## FILE VIEWS block when a populated pinned FileView exists', () => {
    const store = useContextStore.getState();
    const rev = 'rev-fv-1';
    store.applyFullBodyFromChunk({
      filePath: 'src/toon.ts',
      sourceRevision: rev,
      content: 'line 1\nline 2\nline 3',
      chunkHash: 'h-toon-full',
      totalLines: 3,
    });
    // Unpinned views are dormant (roll out of prompt). Pin to assert render.
    useContextStore.getState().setFileViewPinned('src/toon.ts', true);

    const state = useContextStore.getState();
    const output = formatWorkingMemory({
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
      fileViews: state.fileViews,
      currentRound: 1,
    });

    expect(output).toContain('## FILE VIEWS');
    expect(output).toContain('src/toon.ts');
    expect(output).toMatch(/=== .*src\/toon\.ts @h:/);
  });

  it('filters out file-backed chunks that a pinned FileView already covers', () => {
    const store = useContextStore.getState();
    const rev = 'rev-cover';
    // Install a chunk with a readSpan so addChunk auto-populates the FileView
    store.addChunk(
      'the whole body',
      'raw',
      'src/cover.ts',
      undefined, undefined, 'h-cover',
      {
        sourceRevision: rev,
        viewKind: 'latest',
        readSpan: { filePath: 'src/cover.ts', sourceRevision: rev, contextType: 'full' },
      },
    );
    // Coverage only applies when the view is pinned — dormant views let their
    // constituent chunks re-surface in ACTIVE ENGRAMS.
    useContextStore.getState().setFileViewPinned('src/cover.ts', true);

    const state = useContextStore.getState();
    const output = formatWorkingMemory({
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
      fileViews: state.fileViews,
      currentRound: 1,
    });

    // FileView renders the file
    expect(output).toContain('## FILE VIEWS');
    // But the raw chunk is NOT duplicated in ACTIVE ENGRAMS (its hash is covered by the view)
    const activeEngramsIndex = output.indexOf('ACTIVE ENGRAMS');
    if (activeEngramsIndex >= 0) {
      const activeSection = output.slice(activeEngramsIndex);
      // The covered chunk hash should not be re-rendered as an active engram
      expect(activeSection).not.toContain('h-cover');
    }
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

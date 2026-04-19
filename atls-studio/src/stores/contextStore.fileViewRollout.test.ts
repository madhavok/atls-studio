/**
 * FileView unpin rollout — regression coverage for the fix that aligns
 * FileView lifecycle with the `Active -> Dormant -> Archived -> Evicted`
 * model documented in docs/engrams.md. Unpinned views must not render,
 * must not suppress constituent chunks from ACTIVE ENGRAMS, and must not
 * charge prompt tokens. TTL-archived backing chunks must also prune
 * dormant view regions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from './contextStore';
import {
  renderAllFileViewBlocks,
  collectFileViewChunkHashes,
} from '../services/fileViewRender';
import {
  summarizeFileViewTokens,
  clearFileViewTokenCache,
} from '../services/fileViewTokens';
import { clearFreshnessJournal } from '../services/freshnessJournal';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function reset(): void {
  useContextStore.getState().resetSession();
  clearFreshnessJournal();
  clearFileViewTokenCache();
}

function row(line: number, content: string): string {
  return `${String(line).padStart(4)}|${content}`;
}

describe('FileView rollout — unpinned views exit the prompt surface', () => {
  beforeEach(reset);

  it('renderAllFileViewBlocks emits 0 blocks when view is unpinned, N when pinned', () => {
    const store = useContextStore.getState();
    const rev = 'rev-rollout-1';
    store.addChunk(
      [row(10, 'a'), row(11, 'b')].join('\n'),
      'smart',
      'src/rollout.ts',
      undefined, undefined, 'h-rollout-1',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/rollout.ts', sourceRevision: rev, startLine: 10, endLine: 11 },
      },
    );
    const views = [...useContextStore.getState().fileViews.values()];
    expect(views).toHaveLength(1);
    expect(views[0].pinned).toBe(false);
    expect(views[0].filledRegions).toHaveLength(1);

    // Unpinned → zero blocks rendered.
    expect(renderAllFileViewBlocks(views, { currentRound: 1 })).toHaveLength(0);

    // Pin it → block renders.
    useContextStore.getState().setFileViewPinned('src/rollout.ts', true);
    const pinned = [...useContextStore.getState().fileViews.values()];
    const pinnedBlocks = renderAllFileViewBlocks(pinned, { currentRound: 1 });
    expect(pinnedBlocks).toHaveLength(1);
    expect(pinnedBlocks[0]).toContain('src/rollout.ts');
  });

  it('unpinned view does NOT suppress its constituent chunks from ACTIVE ENGRAMS', () => {
    const store = useContextStore.getState();
    const rev = 'rev-rollout-2';
    store.addChunk(
      row(5, 'unpinned chunk body'),
      'smart',
      'src/cover.ts',
      undefined, undefined, 'aaaaaaaaaaaaaaaa',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/cover.ts', sourceRevision: rev, startLine: 5, endLine: 5 },
      },
    );
    const views = [...useContextStore.getState().fileViews.values()];
    expect(views).toHaveLength(1);
    expect(views[0].pinned).toBe(false);

    // Coverage set MUST be empty for unpinned views — chunks remain visible
    // to ACTIVE ENGRAMS under normal HPP rules.
    const cover = collectFileViewChunkHashes(views);
    expect(cover.size).toBe(0);

    // Pin → coverage set now contains the constituent chunk.
    useContextStore.getState().setFileViewPinned('src/cover.ts', true);
    const coverPinned = collectFileViewChunkHashes([...useContextStore.getState().fileViews.values()]);
    expect(coverPinned.has('aaaaaaaaaaaaaaaa')).toBe(true);
  });

  it('summarizeFileViewTokens charges 0 tokens for unpinned views, >0 when pinned', () => {
    const store = useContextStore.getState();
    const rev = 'rev-rollout-3';
    const payload = [row(1, 'line one'), row(2, 'line two'), row(3, 'line three')].join('\n');
    store.addChunk(
      payload,
      'smart',
      'src/tokens.ts',
      undefined, undefined, 'bbbbbbbbbbbbbbbb',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/tokens.ts', sourceRevision: rev, startLine: 1, endLine: 3 },
      },
    );
    const unpinnedSummary = summarizeFileViewTokens(
      useContextStore.getState().fileViews.values(),
    );
    expect(unpinnedSummary.totalRenderedTokens).toBe(0);
    expect(unpinnedSummary.viewCount).toBe(0);

    useContextStore.getState().setFileViewPinned('src/tokens.ts', true);
    clearFileViewTokenCache();
    const pinnedSummary = summarizeFileViewTokens(
      useContextStore.getState().fileViews.values(),
    );
    expect(pinnedSummary.totalRenderedTokens).toBeGreaterThan(0);
    expect(pinnedSummary.viewCount).toBe(1);
  });

  it('getPromptTokens: unpinned view → 0 view cost, chunk tokens still counted', () => {
    const store = useContextStore.getState();
    const rev = 'rev-rollout-4';
    const shortHash = store.addChunk(
      row(10, 'covered body for get-prompt-tokens'),
      'smart',
      'src/prompt.ts',
      undefined, undefined, 'cccccccccccccccc',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/prompt.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    const chunk = Array.from(useContextStore.getState().chunks.values())
      .find(c => c.shortHash === shortHash);
    expect(chunk).toBeDefined();
    const chunkTokens = chunk!.tokens;
    expect(chunkTokens).toBeGreaterThan(0);

    // Unpinned view: getPromptTokens ≈ chunk tokens (chunk is NOT suppressed).
    const unpinnedPrompt = useContextStore.getState().getPromptTokens();
    expect(unpinnedPrompt).toBe(chunkTokens);

    // Pin → chunk suppressed, view rendered; total reflects view instead.
    useContextStore.getState().setFileViewPinned('src/prompt.ts', true);
    clearFileViewTokenCache();
    const pinnedPrompt = useContextStore.getState().getPromptTokens();
    const viewSummary = summarizeFileViewTokens(
      useContextStore.getState().fileViews.values(),
    );
    expect(pinnedPrompt).toBe(viewSummary.totalRenderedTokens);
    expect(pinnedPrompt).not.toBe(chunkTokens);
  });

  it('unpin -> repin round-trip restores the rendered view with existing fills (no re-read)', () => {
    const store = useContextStore.getState();
    const rev = 'rev-rollout-5';
    store.addChunk(
      [row(42, 'fn bar() {'), row(43, '  return 1;'), row(44, '}')].join('\n'),
      'smart',
      'src/repin.ts',
      undefined, undefined, 'dddddddddddddddd',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/repin.ts', sourceRevision: rev, startLine: 42, endLine: 44 },
      },
    );
    useContextStore.getState().setFileViewPinned('src/repin.ts', true);
    const pinnedView = useContextStore.getState().getFileView('src/repin.ts')!;
    expect(pinnedView.filledRegions).toHaveLength(1);
    expect(pinnedView.filledRegions[0].start).toBe(42);

    // Unpin: state must remain warm, regions intact.
    useContextStore.getState().setFileViewPinned('src/repin.ts', false);
    const dormantView = useContextStore.getState().getFileView('src/repin.ts')!;
    expect(dormantView.pinned).toBe(false);
    expect(dormantView.filledRegions).toHaveLength(1);
    expect(dormantView.filledRegions[0].start).toBe(42);

    // While unpinned, nothing renders.
    const dormantBlocks = renderAllFileViewBlocks(
      useContextStore.getState().fileViews.values(),
      { currentRound: 1 },
    );
    expect(dormantBlocks).toHaveLength(0);

    // Repin: view renders immediately with its pre-existing fills — no re-read.
    useContextStore.getState().setFileViewPinned('src/repin.ts', true);
    const restored = renderAllFileViewBlocks(
      useContextStore.getState().fileViews.values(),
      { currentRound: 1 },
    );
    expect(restored).toHaveLength(1);
    expect(restored[0]).toContain('src/repin.ts');
    expect(restored[0]).toContain('fn bar()');
  });
});

describe('FileView rollout — TTL archive prunes view regions', () => {
  beforeEach(reset);

  it('TTL-expired chunk drops the region it backs in any FileView', async () => {
    const store = useContextStore.getState();
    const rev = 'rev-ttl-fv';
    const shortHash = store.addChunk(
      row(10, 'region body'),
      'smart',
      'src/ttl-view.ts',
      undefined, undefined, 'eeeeeeeeeeeeeeee',
      {
        sourceRevision: rev,
        viewKind: 'latest',
        ttl: 1,
        readSpan: { filePath: 'src/ttl-view.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    // Precondition: view has the region.
    const viewBefore = useContextStore.getState().getFileView('src/ttl-view.ts');
    expect(viewBefore).toBeDefined();
    expect(viewBefore!.filledRegions).toHaveLength(1);
    expect(viewBefore!.filledRegions[0].chunkHashes).toContain('eeeeeeeeeeeeeeee');

    // One refresh round: TTL=1 decrements to 0, chunk archives, prune fires.
    await store.refreshRoundEnd({
      paths: ['src/ttl-view.ts'],
      getRevisionForPath: async () => rev,
    });

    // Chunk should have been archived.
    const active = Array.from(useContextStore.getState().chunks.values())
      .find(c => c.shortHash === shortHash);
    expect(active).toBeUndefined();
    const archived = Array.from(useContextStore.getState().archivedChunks.values())
      .find(c => c.shortHash === shortHash);
    expect(archived?.freshnessCause).toBe('ttl_expired');

    // View region backed by the TTL'd chunk is pruned.
    const viewAfter = useContextStore.getState().getFileView('src/ttl-view.ts');
    expect(viewAfter).toBeDefined();
    expect(viewAfter!.filledRegions).toHaveLength(0);
  });

  it('TTL archive does not touch regions whose backing chunks survive', async () => {
    const store = useContextStore.getState();
    const rev = 'rev-ttl-mixed';
    store.addChunk(
      row(10, 'dies soon'),
      'smart',
      'src/ttl-mixed.ts',
      undefined, undefined, 'ffffffffffffffff',
      {
        sourceRevision: rev,
        viewKind: 'latest',
        ttl: 1,
        readSpan: { filePath: 'src/ttl-mixed.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    store.addChunk(
      row(50, 'survives'),
      'smart',
      'src/ttl-mixed.ts',
      undefined, undefined, '1111111111111111',
      {
        sourceRevision: rev,
        viewKind: 'latest',
        // No ttl → survives refresh.
        readSpan: { filePath: 'src/ttl-mixed.ts', sourceRevision: rev, startLine: 50, endLine: 50 },
      },
    );
    expect(useContextStore.getState().getFileView('src/ttl-mixed.ts')!.filledRegions).toHaveLength(2);

    await store.refreshRoundEnd({
      paths: ['src/ttl-mixed.ts'],
      getRevisionForPath: async () => rev,
    });

    const view = useContextStore.getState().getFileView('src/ttl-mixed.ts');
    expect(view).toBeDefined();
    // Only the surviving region remains.
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].start).toBe(50);
    expect(view!.filledRegions[0].chunkHashes).toContain('1111111111111111');
  });
});

describe('FileView rollout — pinned-only parity regression', () => {
  beforeEach(reset);

  it('a pinned-only session renders the same blocks and charges the same tokens as before', () => {
    const store = useContextStore.getState();
    const rev = 'rev-parity';
    store.addChunk(
      [row(10, 'alpha'), row(11, 'beta')].join('\n'),
      'smart',
      'src/parity-a.ts',
      undefined, undefined, 'parityaaaaaaaaaa',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/parity-a.ts', sourceRevision: rev, startLine: 10, endLine: 11 },
      },
    );
    store.addChunk(
      [row(20, 'gamma'), row(21, 'delta')].join('\n'),
      'smart',
      'src/parity-b.ts',
      undefined, undefined, 'paritybbbbbbbbbb',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/parity-b.ts', sourceRevision: rev, startLine: 20, endLine: 21 },
      },
    );
    useContextStore.getState().setFileViewPinned('src/parity-a.ts', true);
    useContextStore.getState().setFileViewPinned('src/parity-b.ts', true);

    clearFileViewTokenCache();
    const views = [...useContextStore.getState().fileViews.values()];
    const blocks = renderAllFileViewBlocks(views, { currentRound: 1 });
    expect(blocks).toHaveLength(2);
    // Both expected paths rendered.
    const joined = blocks.join('\n');
    expect(joined).toContain('src/parity-a.ts');
    expect(joined).toContain('src/parity-b.ts');

    const summary = summarizeFileViewTokens(views);
    expect(summary.viewCount).toBe(2);
    expect(summary.totalRenderedTokens).toBeGreaterThan(0);

    // Coverage set reports both constituent chunks (so ACTIVE ENGRAMS dedups).
    const cover = collectFileViewChunkHashes(views);
    expect(cover.has('parityaaaaaaaaaa')).toBe(true);
    expect(cover.has('paritybbbbbbbbbb')).toBe(true);

    // getPromptTokens should equal the summary's rendered total (no chunk
    // tokens added on top; both chunks are covered).
    const prompt = useContextStore.getState().getPromptTokens();
    expect(prompt).toBe(summary.totalRenderedTokens);
  });
});

describe('FileView rollout — single retention hash trace replay', () => {
  // Mirrors the real session where the runtime was silently duplicating
  // content across chunks + staged + FileView. Under the new contract:
  //   - N file reads → N pinned FileViews, 0 pinned non-file chunks, 0 staged.
  //   - One wildcard unpin → 0 pinned state, prompt tokens drop to baseline.
  beforeEach(reset);

  it('9 file reads + 9 pins → 9 pinned views, 0 pinned chunks, 0 staged snippets', () => {
    const store = useContextStore.getState();
    const rev = 'trace-rev';
    const paths = [
      'src/a.ts', 'src/b.ts', 'src/c.ts',
      'src/d.ts', 'src/e.ts', 'src/f.ts',
      'src/g.ts', 'src/h.ts', 'src/i.ts',
    ];
    const refs: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const chunkHash = `tracechunk${i}000000`;
      store.addChunk(
        row(10, `line in ${p}`),
        'smart',
        p,
        undefined, undefined, chunkHash,
        {
          sourceRevision: rev,
          readSpan: { filePath: p, sourceRevision: rev, startLine: 10, endLine: 10 },
        },
      );
      // Read handler would return the view's `h:<short>`; for the test we call ensureFileView directly.
      refs.push(store.ensureFileView(p, rev));
    }
    store.pinChunks(refs);

    // 9 pinned views.
    const pinnedViews = [...useContextStore.getState().fileViews.values()].filter(v => v.pinned);
    expect(pinnedViews).toHaveLength(9);
    // 0 pinned non-file chunks (retention routed to views).
    const pinnedChunks = [...useContextStore.getState().chunks.values()].filter(c => c.pinned);
    expect(pinnedChunks).toHaveLength(0);
    // 0 staged snippets (read handlers no longer auto-stage).
    expect(useContextStore.getState().stagedSnippets.size).toBe(0);

    // Wildcard unpin → all views unpinned in one shot.
    const { count } = useContextStore.getState().unpinChunks(['*']);
    expect(count).toBe(9);
    const stillPinned = [...useContextStore.getState().fileViews.values()].filter(v => v.pinned);
    expect(stillPinned).toHaveLength(0);
  });

  it('pinning a slice hash of a file routes to the view (no slice-chunk pin)', () => {
    const store = useContextStore.getState();
    const rev = 'route-rev';
    const shortHash = store.addChunk(
      row(10, 'payload'),
      'smart',
      'src/route.ts',
      undefined, undefined, 'routechunk00000000',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/route.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    // Pin the SLICE hash (legacy contract) — should land on the view.
    store.pinChunks([`h:${shortHash}`]);

    const view = useContextStore.getState().getFileView('src/route.ts');
    expect(view?.pinned).toBe(true);
    // Look up by source — the chunk stays in the map, unpinned.
    const chunk = Array.from(useContextStore.getState().chunks.values())
      .find(c => c.source === 'src/route.ts');
    expect(chunk).toBeDefined();
    expect(chunk!.pinned).toBeFalsy();
  });

  it('ensureFileView returns the same h:<short> regardless of fill progression', () => {
    // Stable identity — the ref the model pins on first read stays valid as
    // regions get filled and fullBody lands.
    const store = useContextStore.getState();
    const rev = 'stable-rev';
    const ref1 = store.ensureFileView('src/stable.ts', rev);
    expect(ref1).toMatch(/^h:[0-9a-f]{6}$/);

    // Fill a region — view's identity unchanged.
    store.addChunk(
      row(10, 'line'),
      'smart',
      'src/stable.ts',
      undefined, undefined, 'stablechunk00000000',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/stable.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    const ref2 = useContextStore.getState().getFileView('src/stable.ts')!.hash;
    expect(ref2).toBe(ref1);

    // Promote to fullBody — identity still unchanged.
    store.applyFullBodyFromChunk({
      filePath: 'src/stable.ts',
      sourceRevision: rev,
      content: 'full body',
      chunkHash: 'stablefullbody00000',
    });
    const ref3 = useContextStore.getState().getFileView('src/stable.ts')!.hash;
    expect(ref3).toBe(ref1);

    // Only a revision bump changes identity.
    const ref4 = store.ensureFileView('src/stable.ts', 'different-rev');
    expect(ref4).not.toBe(ref1);
  });
});

/**
 * Regression tests for the HASH MANIFEST filter that suppresses file-backed
 * chunks whose source matches a pinned FileView. Without this filter, after
 * a `vb` compact the post-edit file chunk shows up as a `dormant` row in the
 * manifest next to the fresh pinned `fv` row for the same path — the model
 * sees two rows for one file and re-reads "to be safe".
 *
 * Context: `## ACTIVE ENGRAMS` already filters these via `contextFormatter`;
 * HASH MANIFEST used to NOT filter, leaking dormant rows that read as
 * staleness cues.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildDynamicContextBlock } from './aiService';
import { useContextStore } from '../stores/contextStore';
import { hashContentSync } from '../utils/contextHash';
import { materialize, dematerialize } from './hashProtocol';

function resetStore() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [], fileViews: new Map() });
}

function rowLine(n: number, content: string): string {
  return `${String(n).padStart(4)}|${content}`;
}

describe('HASH MANIFEST — pinned-FileView coverage filter', () => {
  beforeEach(resetStore);

  it('suppresses a file-backed chunk row when a pinned FileView covers the same path', () => {
    // Simulate the post-edit state: a file-backed chunk for the same path as
    // a pinned FileView. Before the filter, this chunk would render as an
    // active `file` row in the manifest alongside the pinned `fv` row —
    // two rows for one file, which the model reads as staleness.
    const path = 'src/widget/panel.tsx';
    const rev = 'rev-post-edit';
    useContextStore.getState().addChunk(
      rowLine(1, 'updated content'),
      'file',
      path,
      undefined, undefined, hashContentSync('updated content').slice(0, 12),
      {
        sourceRevision: rev,
        viewKind: 'latest',
        // Simulates an `rl`-style read that creates the pinned view:
        readSpan: { filePath: path, sourceRevision: rev, startLine: 1, endLine: 1 },
      },
    );
    // Confirm the view was auto-created.
    const view = useContextStore.getState().getFileView(path);
    expect(view).toBeDefined();
    // Pin it (auto-pin may not fire in test setup; setFileViewPinned is the
    // explicit equivalent).
    useContextStore.getState().setFileViewPinned(path, true);

    const block = buildDynamicContextBlock();
    // The manifest must show the `fv` row for the pinned view.
    expect(block).toContain(`h:${view!.shortHash}`);
    expect(block).toMatch(/fv\s+/);
    // The manifest must NOT show a second `file` row for the SAME path.
    // Count manifest rows whose source matches the path (normalized):
    const pathRe = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const manifestLines = block.split('\n').filter(l => l.startsWith('h:') && pathRe.test(l));
    expect(manifestLines).toHaveLength(1);
  });

  it('does NOT suppress a chunk whose source matches an UNPINNED view', () => {
    // Only pinned views claim retention-level ownership of their path. An
    // unpinned view is dormant by design (zero tokens, no render), so any
    // file-backed chunk for that path should surface normally.
    const path = 'src/other/unpinned.tsx';
    const rev = 'rev-unpinned';
    useContextStore.getState().addChunk(
      rowLine(1, 'body'),
      'file',
      path,
      undefined, undefined, hashContentSync('body').slice(0, 12),
      {
        sourceRevision: rev,
        viewKind: 'latest',
        readSpan: { filePath: path, sourceRevision: rev, startLine: 1, endLine: 1 },
      },
    );
    // Intentionally do not pin the view.
    const view = useContextStore.getState().getFileView(path);
    expect(view).toBeDefined();
    expect(view!.pinned).toBe(false);

    const block = buildDynamicContextBlock();
    // Chunk row must appear — unpinned view doesn't suppress it.
    const pathRe = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const manifestLines = block.split('\n').filter(l => l.startsWith('h:') && pathRe.test(l));
    expect(manifestLines.length).toBeGreaterThanOrEqual(1);
  });

  it('with NO pinned views, manifest behavior is unchanged (filter is a no-op)', () => {
    // Sanity: the filter only activates when at least one view is pinned.
    // With no pinned views, the manifest renders the same rows it always did.
    const path = 'src/noPinned.tsx';
    const rev = 'rev-np';
    useContextStore.getState().addChunk(
      rowLine(1, 'body'),
      'file',
      path,
      undefined, undefined, hashContentSync('body').slice(0, 12),
      { sourceRevision: rev, viewKind: 'latest', readSpan: { filePath: path, sourceRevision: rev, startLine: 1, endLine: 1 } },
    );
    const view = useContextStore.getState().getFileView(path);
    expect(view?.pinned ?? false).toBe(false);

    const block = buildDynamicContextBlock();
    // Unpinned view still appears as a fileview row (unpinned views render
    // in the manifest for routing even though they don't render in WM).
    // The row must be present regardless of the filter.
    expect(block).toContain(`h:${view!.shortHash}`);
  });
});

/**
 * Self-referential batch-envelope filter — see `isBatchEnvelopeRow` in
 * buildDynamicContextBlock. History compression's tool_use and tool_result
 * deflation creates `call`/`result` chunks whose "source" is the model's own
 * batch envelope (`batch`, `batch:...`, `result:toolu_...`). Surfacing these
 * as engrams is self-referential telemetry — the runtime logging its own
 * actions into the memory it's trying to economize. They're suppressed from
 * the manifest (hashes still resolvable by HPP).
 */
describe('HASH MANIFEST — batch-envelope self-ref filter', () => {
  beforeEach(resetStore);

  /**
   * Seed a chunk and register it in HPP as materialized.
   * `addChunk` returns the short hash; we locate the full chunk by short hash.
   */
  function seedMaterialized(content: string, type: 'call' | 'result' | 'search' | 'smart', source: string): { fullHash: string; shortHash: string } {
    const shortHash = useContextStore.getState().addChunk(content, type, source);
    const chunk = Array.from(useContextStore.getState().chunks.values()).find(c => c.shortHash === shortHash)!;
    materialize(chunk.hash, chunk.type, chunk.source, chunk.tokens, chunk.content.split('\n').length, chunk.digest || '', chunk.shortHash);
    return { fullHash: chunk.hash, shortHash };
  }

  function seedDematerialized(content: string, type: 'call' | 'result' | 'search' | 'smart', source: string): { fullHash: string; shortHash: string } {
    const refs = seedMaterialized(content, type, source);
    dematerialize(refs.fullHash);
    return refs;
  }

  it('suppresses a dematerialized `call` chunk with source "batch"', () => {
    const { shortHash } = seedDematerialized('1 steps: session×1', 'call', 'batch');
    const block = buildDynamicContextBlock();
    expect(block).not.toContain(`h:${shortHash}`);
  });

  it('suppresses a dematerialized `call` chunk with source "batch:..." (extractToolDescription shape)', () => {
    const { shortHash } = seedDematerialized(
      '{"_stubbed":"1 steps: session×1","_compressed":true}',
      'call',
      'batch:1 steps: session×1',
    );
    const block = buildDynamicContextBlock();
    expect(block).not.toContain(`h:${shortHash}`);
  });

  it('suppresses a dematerialized `result` chunk with source "result:toolu_..." (deflate fallback)', () => {
    const { shortHash } = seedDematerialized('[OK] c1 ...', 'result', 'result:toolu_abc123');
    const block = buildDynamicContextBlock();
    expect(block).not.toContain(`h:${shortHash}`);
  });

  it('suppresses a dematerialized `result` chunk with source "batch:..." (buildCompressionDescription shape)', () => {
    const { shortHash } = seedDematerialized(
      '[OK] r1 (read.context): ...\n[ATLS] 1 steps: 1 pass | ok',
      'result',
      'batch:read.context:src/foo.ts',
    );
    const block = buildDynamicContextBlock();
    expect(block).not.toContain(`h:${shortHash}`);
  });

  it('does NOT suppress non-batch `result` chunks (e.g. search results)', () => {
    // A real search result chunk with a legitimate query-based source should
    // still render. Only batch envelopes are filtered.
    const { shortHash } = seedDematerialized('hit 1: src/app.ts:42', 'search', 'query:auth');
    const block = buildDynamicContextBlock();
    expect(block).toContain(`h:${shortHash}`);
  });

  it('does NOT suppress a `call` chunk whose source merely contains "batch" but does not start with it', () => {
    // Word-boundary anchored at start — `preflight-batch` is not filtered.
    const { shortHash } = seedDematerialized('payload', 'call', 'preflight-batch:rules');
    const block = buildDynamicContextBlock();
    expect(block).toContain(`h:${shortHash}`);
  });

  it('also filters `call` chunks in the materialized branch (not just dematRefs)', () => {
    // Materialize a `call` chunk without dematerializing — it sits in the
    // activeChunks branch. The filter should still suppress it.
    const { shortHash } = seedMaterialized(
      '1 steps: read×1',
      'call',
      'batch:read.context:src/a.ts',
    );
    const block = buildDynamicContextBlock();
    expect(block).not.toContain(`h:${shortHash}`);
  });
});

/**
 * Template bodies (`tpl:*`) are seeded into BB at session init but documented
 * once in the static system prompt. Emitting all eight bodies into every
 * dynamic-tail BB block is ~0.3k tokens of redundancy per turn.
 */
describe('BLACKBOARD — tpl:* bodies are not re-emitted in dynamic tail', () => {
  beforeEach(resetStore);

  it('emits no tpl:* lines even though templates are seeded', () => {
    // resetSession in beforeEach already seeds all eight tpl:* templates.
    const bb = useContextStore.getState().blackboardEntries;
    expect([...bb.keys()].some(k => k.startsWith('tpl:'))).toBe(true);

    const block = buildDynamicContextBlock();
    // No `tpl:` preamble lines should land in the assembled block.
    const tplLines = block.split('\n').filter(l => /^tpl:/.test(l));
    expect(tplLines).toHaveLength(0);
  });

  it('still emits non-tpl BB entries (regression guard)', () => {
    useContextStore.getState().setBlackboardEntry('finding:auth', 'root cause is X');
    const block = buildDynamicContextBlock();
    expect(block).toContain('finding:auth: root cause is X');
  });
});

/**
 * INTERNALS_TAB_ID is the sentinel for the ATLS Internals dev panel —
 * NOT a workspace path. buildContextTOON must omit `file:` when this is
 * the active tab so the model doesn't see `Ctx:{file:__atls_internals__}`
 * as a real target.
 */
describe('Ctx: TOON — INTERNALS_TAB_ID is not surfaced as a file', () => {
  beforeEach(resetStore);

  it('omits `file` when activeFile is the internals sentinel', () => {
    const block = buildDynamicContextBlock({
      activeFile: '__atls_internals__',
      cursorLine: 42,
    } as any);
    expect(block).not.toContain('__atls_internals__');
    // Line number is editor state that belongs to the missing file — drop it too.
    expect(block).not.toMatch(/\bln:\s*42/);
  });

  it('surfaces `file` for a real path (regression guard)', () => {
    const block = buildDynamicContextBlock({
      activeFile: 'src/widget/panel.tsx',
    } as any);
    expect(block).toContain('src/widget/panel.tsx');
  });
});

describe('Ctx: TOON — SWARM_ORCHESTRATION_TAB_ID is not surfaced as a file', () => {
  beforeEach(resetStore);

  it('omits `file` when activeFile is the swarm orchestration sentinel', () => {
    const block = buildDynamicContextBlock({
      activeFile: '__swarm_orchestration__',
      cursorLine: 10,
    } as any);
    expect(block).not.toContain('__swarm_orchestration__');
    expect(block).not.toMatch(/\bln:\s*10/);
  });
});

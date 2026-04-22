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

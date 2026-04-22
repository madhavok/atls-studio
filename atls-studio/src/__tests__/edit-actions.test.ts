/**
 * Deterministic edit-action orchestration tests.
 *
 * Tests the TypeScript-side logic that wraps Rust edit calls:
 * - SnapshotTracker read-coverage gating for bracket-heavy files
 * - Intra-step line-edit rebasing (multi-entry `le` within one step)
 * - Hash chain consistency through sequential edit simulations
 * - edit_outside_read_range rejection via executeUnifiedBatch
 *
 * These are pure-logic tests — no Tauri backend, no file I/O.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SnapshotTracker,
  AwarenessLevel,
  mergeRanges,
  canonicalizeSnapshotHash,
} from '../services/batch/snapshotTracker';
import type { OpHandler, OperationKind, StepOutput } from '../services/batch/types';

// ---------------------------------------------------------------------------
// Executor mocking (same pattern as executor.test.ts)
// ---------------------------------------------------------------------------
const handlers = new Map<string, OpHandler>();

vi.mock('../services/batch/opMap', () => ({
  getHandler: (op: OperationKind) => handlers.get(op),
  isReadonlyOp: () => false,
  isMutatingOp: (op: OperationKind) => op.startsWith('change.'),
}));

vi.mock('../services/batch/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/batch/policy')>();
  return {
    isStepAllowed: () => ({ allowed: true }),
    getAutoVerifySteps: () => [],
    isStepCountExceeded: (idx: number, pol?: { max_steps?: number }) =>
      Boolean(pol?.max_steps) && idx >= pol.max_steps,
    evaluateCondition: actual.evaluateCondition,
    isBlockedForSwarm: () => false,
  };
});

vi.mock('../services/batch/handlers/session', () => ({
  resetRecallBudget: () => {},
}));

import { executeUnifiedBatch } from '../services/batch/executor';

function makeCtx() {
  const awarenessCache = new Map();
  return {
    store: () => ({
      recordManageOps: () => {},
      recordToolCall: () => {},
      recordBatchRead: () => {},
      recordBatchBbWrite: () => {},
      recordCoveragePath: () => {},
      recordFileReadSpin: () => null,
      resetFileReadSpin: () => {},
      getPriorReadRanges: () => [],
      forwardStagedHash: () => 0,
      rebaseStagedLineNumbers: () => 0,
      addVerifyArtifact: () => {},
      getCurrentRev: () => 0,
      recordMemoryEvent: () => {},
      getAwareness: () => undefined,
      setAwareness: (entry: Record<string, unknown>) => {
        awarenessCache.set((entry.filePath as string).replace(/\\/g, '/').toLowerCase(), entry);
      },
      invalidateAwareness: () => {},
      invalidateAwarenessForPaths: () => {},
      getAwarenessCache: () => awarenessCache,
      getStagedEntries: () => new Map(),
      chunks: new Map(),
      listBlackboardEntries: () => [],
      getBlackboardEntryWithMeta: () => null,
      getUsedTokens: () => 0,
      maxTokens: 100000,
      getStagedSnippetsForRefresh: () => [],
      markEngramsSuspect: () => {},
      recordRevisionAdvance: () => {},
      registerEditHash: () => ({ registered: true }),
      bumpWorkspaceRev: () => {},
      invalidateArtifactsForPaths: () => {},
    }),
    getProjectPath: () => null,
    resolveSearchRefs: async () => ({}),
    expandSetRefsInHashes: (hashes: string[]) => ({ expanded: hashes, notes: [] }),
    expandFilePathRefs: async () => ({ items: [], notes: [] }),
    atlsBatchQuery: async () => ({}),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function raw(summary: string, content: Record<string, unknown>, ok = true): StepOutput {
  return { kind: 'raw', ok, refs: [], summary, content };
}

// ---------------------------------------------------------------------------
// bracket_stress.ts region map (1-based lines matching the fixture)
// ---------------------------------------------------------------------------
const REGIONS = {
  generics: { start: 12, end: 27 },
  templateLiterals: { start: 31, end: 38 },
  regex: { start: 42, end: 49 },
  destructuring: { start: 53, end: 91 },
  utilityTypes: { start: 95, end: 111 },
  stringEscapes: { start: 115, end: 129 },
  classBody: { start: 133, end: 171 },
};

// ---------------------------------------------------------------------------
// SnapshotTracker: read-coverage for bracket-heavy file regions
// ---------------------------------------------------------------------------
describe('SnapshotTracker bracket-stress region coverage', () => {
  let tracker: SnapshotTracker;
  const FILE = 'src/__tests__/bracket_stress.ts';

  beforeEach(() => {
    tracker = new SnapshotTracker();
  });

  it('partial read of regex section does not cover destructuring edits', () => {
    tracker.record(FILE, 'abc123', 'lines', { readRegion: REGIONS.regex });
    expect(tracker.hasReadCoverage(FILE, REGIONS.destructuring.start, REGIONS.destructuring.end))
      .toBe(false);
  });

  it('reading two separate regions leaves a gap uncovered', () => {
    tracker.record(FILE, 'abc123', 'lines', { readRegion: REGIONS.generics });
    tracker.record(FILE, 'abc123', 'lines', { readRegion: REGIONS.classBody });
    expect(tracker.hasReadCoverage(FILE, REGIONS.generics.start, REGIONS.generics.end)).toBe(true);
    expect(tracker.hasReadCoverage(FILE, REGIONS.classBody.start, REGIONS.classBody.end)).toBe(true);
    expect(tracker.hasReadCoverage(FILE, REGIONS.regex.start, REGIONS.regex.end)).toBe(false);
    expect(tracker.hasReadCoverage(FILE, 1, 175)).toBe(false);
  });

  it('reading full file range covers all regions', () => {
    tracker.record(FILE, 'abc123', 'lines', { readRegion: { start: 1, end: 175 } });
    for (const region of Object.values(REGIONS)) {
      expect(tracker.hasReadCoverage(FILE, region.start, region.end)).toBe(true);
    }
  });

  it('overlapping reads merge to cover combined span', () => {
    tracker.record(FILE, 'abc123', 'lines', { readRegion: { start: 42, end: 70 } });
    tracker.record(FILE, 'abc123', 'lines', { readRegion: { start: 60, end: 91 } });
    expect(tracker.hasReadCoverage(FILE, 42, 91)).toBe(true);
    expect(tracker.hasReadCoverage(FILE, 41, 91)).toBe(false);
  });

  it('canonical read always passes canonical gate even without regions', () => {
    tracker.record(FILE, 'abc123', 'canonical');
    expect(tracker.hasCanonicalRead(FILE)).toBe(true);
    expect(tracker.getAwarenessLevel(FILE)).toBe(AwarenessLevel.CANONICAL);
  });

  it('lines-only read with matching region returns TARGETED awareness', () => {
    tracker.record(FILE, 'abc123', 'lines', { readRegion: REGIONS.classBody });
    const level = tracker.getAwarenessLevel(FILE, REGIONS.classBody);
    expect(level).toBe(AwarenessLevel.TARGETED);
  });

  it('lines-only read with non-matching region returns SHAPED awareness', () => {
    tracker.record(FILE, 'abc123', 'lines', { readRegion: REGIONS.classBody });
    const level = tracker.getAwarenessLevel(FILE, REGIONS.generics);
    expect(level).toBe(AwarenessLevel.SHAPED);
  });
});

// ---------------------------------------------------------------------------
// Hash chain: simulated sequential edits
// ---------------------------------------------------------------------------
describe('hash chain through simulated sequential edits', () => {
  let tracker: SnapshotTracker;
  const FILE = 'src/__tests__/bracket_stress.ts';

  beforeEach(() => {
    tracker = new SnapshotTracker();
  });

  it('tracks hash progression through read → edit → edit', () => {
    tracker.record(FILE, 'h:aaa11111', 'canonical');
    expect(tracker.getHash(FILE)).toBe('aaa11111');

    tracker.invalidateAndRerecord(FILE, 'h:bbb22222');
    expect(tracker.getHash(FILE)).toBe('bbb22222');
    expect(tracker.isStale(FILE, 'aaa11111')).toBe(true);
    expect(tracker.isStale(FILE, 'bbb22222')).toBe(false);

    tracker.invalidateAndRerecord(FILE, 'ccc33333');
    expect(tracker.getHash(FILE)).toBe('ccc33333');
    expect(tracker.isStale(FILE, 'bbb22222')).toBe(true);
    expect(tracker.isStale(FILE, 'ccc33333')).toBe(false);
  });

  it('invalidateAndRerecord clears read regions (file content changed)', () => {
    tracker.record(FILE, 'aaa', 'lines', { readRegion: REGIONS.classBody });
    expect(tracker.hasReadCoverage(FILE, REGIONS.classBody.start, REGIONS.classBody.end)).toBe(true);

    tracker.invalidateAndRerecord(FILE, 'bbb');
    expect(tracker.hasReadCoverage(FILE, REGIONS.classBody.start, REGIONS.classBody.end)).toBe(false);
    expect(tracker.hasCanonicalRead(FILE)).toBe(true);
  });

  it('findFilePathForSnapshotHash resolves after mutation chain', () => {
    tracker.record(FILE, 'h:aaa11111', 'canonical');
    expect(tracker.findFilePathForSnapshotHash('h:aaa11111')).toBe(FILE);
    tracker.invalidateAndRerecord(FILE, 'bbb22222');
    expect(tracker.findFilePathForSnapshotHash('bbb22222')).toBe(FILE);
    expect(tracker.findFilePathForSnapshotHash('aaa11111')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// canonicalizeSnapshotHash edge cases
// ---------------------------------------------------------------------------
describe('canonicalizeSnapshotHash with line-range modifiers', () => {
  it('strips h: prefix and line range', () => {
    expect(canonicalizeSnapshotHash('h:deadbeef:1-100')).toBe('deadbeef');
  });

  it('strips h: prefix with nested colon modifiers', () => {
    expect(canonicalizeSnapshotHash('h:abc123:42-42')).toBe('abc123');
  });

  it('handles bare 16-char hash', () => {
    expect(canonicalizeSnapshotHash('abc123def4567890')).toBe('abc123def4567890');
  });

  it('handles short prefixes used in ATLS refs', () => {
    expect(canonicalizeSnapshotHash('h:fe6efb42')).toBe('fe6efb42');
  });
});

// ---------------------------------------------------------------------------
// mergeRanges: complex bracket-stress region merging
// ---------------------------------------------------------------------------
describe('mergeRanges with bracket-stress regions', () => {
  it('preserves disjoint fixture regions without false merging', () => {
    const allRegions = Object.values(REGIONS);
    const merged = mergeRanges(allRegions);
    expect(merged).toHaveLength(allRegions.length);
    for (const region of allRegions) {
      const covered = merged.some(m => m.start <= region.start && m.end >= region.end);
      expect(covered, `region ${region.start}-${region.end} should be covered`).toBe(true);
    }
  });

  it('merges when regions are extended to overlap', () => {
    const extended = Object.values(REGIONS).map(r => ({ start: r.start, end: r.end + 5 }));
    const merged = mergeRanges(extended);
    expect(merged.length).toBeLessThan(extended.length);
  });

  it('adjacent regions merge into one', () => {
    const merged = mergeRanges([
      { start: 42, end: 49 },
      { start: 50, end: 91 },
    ]);
    expect(merged).toEqual([{ start: 42, end: 91 }]);
  });

  it('non-overlapping regions stay separate', () => {
    const merged = mergeRanges([
      { start: 12, end: 27 },
      { start: 133, end: 171 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ start: 12, end: 27 });
    expect(merged[1]).toEqual({ start: 133, end: 171 });
  });
});

// ---------------------------------------------------------------------------
// executeUnifiedBatch: edit_outside_read_range with bracket-stress regions
// ---------------------------------------------------------------------------
describe('edit_outside_read_range with bracket-stress regions', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('rejects edit targeting class body when only generics region was read', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));

    handlers.set('read.lines', async () => raw('read_lines', {
      file: 'src/__tests__/bracket_stress.ts',
      content_hash: 'fixture_hash',
      content: 'x',
      actual_range: [[REGIONS.generics.start, REGIONS.generics.end]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'read',
          use: 'read.lines',
          with: {
            file_path: 'src/__tests__/bracket_stress.ts',
            lines: `${REGIONS.generics.start}-${REGIONS.generics.end}`,
          },
        },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/__tests__/bracket_stress.ts',
            line_edits: [{
              line: REGIONS.classBody.start + 10,
              action: 'replace',
              content: '    return { valid: true };',
            }],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    const step = result.step_results.find(s => s.id === 'edit');
    expect(step?.error).toContain('target region not yet read');
    expect((step?.artifacts as { _internal?: { error_class?: string } } | undefined)?._internal?.error_class).toBe(
      'edit_outside_read_range',
    );
  });

  it('allows edit when read region covers the target line', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));

    handlers.set('read.lines', async () => raw('read_lines', {
      file: 'src/__tests__/bracket_stress.ts',
      content_hash: 'fixture_hash',
      content: 'x',
      actual_range: [[REGIONS.regex.start, REGIONS.regex.end]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'read',
          use: 'read.lines',
          with: {
            file_path: 'src/__tests__/bracket_stress.ts',
            lines: `${REGIONS.regex.start}-${REGIONS.regex.end}`,
          },
        },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/__tests__/bracket_stress.ts',
            line_edits: [{
              line: 44,
              action: 'replace',
              content: '  brackets: /[{}]/g,',
            }],
          },
        },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('rejects multi-entry edit when one entry falls outside read range', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));

    handlers.set('read.lines', async () => raw('read_lines', {
      file: 'src/__tests__/bracket_stress.ts',
      content_hash: 'fixture_hash',
      content: 'x',
      actual_range: [[REGIONS.regex.start, REGIONS.regex.end]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'read',
          use: 'read.lines',
          with: {
            file_path: 'src/__tests__/bracket_stress.ts',
            lines: `${REGIONS.regex.start}-${REGIONS.regex.end}`,
          },
        },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/__tests__/bracket_stress.ts',
            line_edits: [
              { line: 44, action: 'replace', content: '  brackets: /[{}]/g,' },
              { line: REGIONS.destructuring.start, action: 'delete' },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('bypasses gate for hash-ref file paths (h:...)', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));
    handlers.set('read.lines', async () => raw('read_lines', {
      file: 'src/__tests__/bracket_stress.ts',
      content_hash: 'fixture_hash',
      content: 'x',
      actual_range: [[1, 10]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'read',
          use: 'read.lines',
          with: { file_path: 'src/__tests__/bracket_stress.ts', lines: '1-10' },
        },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'h:fixture_hash:1-175',
            line_edits: [{ line: 150, action: 'insert_before', content: '// marker' }],
          },
        },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(editSpy).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      settings: {
        selectedProvider: 'anthropic',
        selectedModel: 'claude-3-5-sonnet-20241022',
      },
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

import {
  type AssessSnapshotInput,
  type EvaluateAssessOptions,
  DEFAULT_ROUND_MS,
  evaluateAssess,
  formatAssessMessage,
  resetAssessContext,
  selectCandidates,
} from './assessContext';
import type { FileView } from './fileViewStore';
import type { ContextChunk } from '../stores/contextStore';
import { countTokensSync } from '../utils/tokenCounter';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = 1_000_000_000;

function makeView(opts: {
  path: string;
  hash?: string;
  revision?: string;
  pinned?: boolean;
  filledTokens?: number;
  lastAccessed?: number;
  freshness?: FileView['freshness'];
} = { path: 'src/a.ts' }): FileView {
  const filledTokens = opts.filledTokens ?? 2000;
  return {
    filePath: opts.path,
    sourceRevision: opts.revision ?? 'rev1',
    observedRevision: opts.revision ?? 'rev1',
    totalLines: 100,
    skeletonRows: [],
    sigLevel: 'sig',
    filledRegions: filledTokens > 0
      ? [{
          start: 1,
          end: 50,
          content: 'xxx',
          chunkHashes: [`chunk:${opts.path}`],
          tokens: filledTokens,
          origin: 'read',
        }]
      : [],
    hash: opts.hash ?? `h:fv:${opts.path.replace(/[^a-z0-9]/gi, '').slice(0, 8)}`,
    lastAccessed: opts.lastAccessed ?? (NOW - 5 * DEFAULT_ROUND_MS),
    pinned: opts.pinned ?? true,
    freshness: opts.freshness ?? 'fresh',
  };
}

function makeChunk(opts: {
  hash: string;
  type?: ContextChunk['type'];
  pinned?: boolean;
  tokens?: number;
  source?: string;
  lastAccessed?: number;
  freshness?: ContextChunk['freshness'];
} = { hash: 'h:abc123' }): ContextChunk {
  return {
    hash: opts.hash,
    shortHash: opts.hash.slice(-6),
    type: (opts.type ?? 'search') as ContextChunk['type'],
    source: opts.source ?? 'sc("tokenizer")',
    content: 'dummy content',
    tokens: opts.tokens ?? 2000,
    createdAt: new Date(NOW - 10 * DEFAULT_ROUND_MS),
    lastAccessed: opts.lastAccessed ?? (NOW - 5 * DEFAULT_ROUND_MS),
    pinned: opts.pinned ?? true,
    freshness: opts.freshness,
  } as ContextChunk;
}

function makeInput(overrides: Partial<AssessSnapshotInput> = {}): AssessSnapshotInput {
  return {
    fileViews: overrides.fileViews ?? new Map<string, FileView>(),
    chunks: overrides.chunks ?? new Map<string, ContextChunk>(),
    fileViewCoveredChunkHashes: overrides.fileViewCoveredChunkHashes ?? new Set<string>(),
    recentlyCitedChunkHashes: overrides.recentlyCitedChunkHashes,
    suspectChunkHashes: overrides.suspectChunkHashes,
    ctxUsedTokens: overrides.ctxUsedTokens ?? 100_000,
    ctxMaxTokens: overrides.ctxMaxTokens ?? 200_000,
    round: overrides.round ?? 1,
    turnId: overrides.turnId ?? 1,
    taskPlanFilePaths: overrides.taskPlanFilePaths,
    now: overrides.now ?? NOW,
    roundMs: overrides.roundMs ?? DEFAULT_ROUND_MS,
  };
}

function asMap<T extends { hash?: string; filePath?: string }>(
  key: 'hash' | 'filePath',
  items: T[],
): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) {
    const k = (it as Record<'hash' | 'filePath', string | undefined>)[key];
    if (k) m.set(k, it);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

describe('assessContext — selectCandidates', () => {
  beforeEach(() => resetAssessContext());

  it('includes pinned FileViews with idleRounds >= idleRoundsMin', () => {
    const v = makeView({
      path: 'src/a.ts',
      lastAccessed: NOW - 4 * DEFAULT_ROUND_MS,
      filledTokens: 3000,
    });
    const cands = selectCandidates(makeInput({
      fileViews: asMap('filePath', [v]),
    }));
    expect(cands).toHaveLength(1);
    expect(cands[0].kind).toBe('fileview');
    expect(cands[0].label).toBe('src/a.ts');
    expect(cands[0].idleRounds).toBe(4);
    expect(cands[0].tokens).toBe(3000);
  });

  it('excludes unpinned FileViews', () => {
    const v = makeView({ path: 'src/a.ts', pinned: false });
    const cands = selectCandidates(makeInput({
      fileViews: asMap('filePath', [v]),
    }));
    expect(cands).toHaveLength(0);
  });

  it('excludes suspect FileViews (rec path, not cleanup)', () => {
    const v = makeView({ path: 'src/a.ts', freshness: 'suspect' });
    const cands = selectCandidates(makeInput({
      fileViews: asMap('filePath', [v]),
    }));
    expect(cands).toHaveLength(0);
  });

  it('excludes FileViews below idleRoundsMin when in scope', () => {
    const v = makeView({
      path: 'src/a.ts',
      lastAccessed: NOW - 1 * DEFAULT_ROUND_MS,
    });
    const cands = selectCandidates(
      makeInput({ fileViews: asMap('filePath', [v]) }),
      { idleRoundsMin: 2 },
    );
    expect(cands).toHaveLength(0);
  });

  it('includes fresh FileViews when they fall outside the task plan scope', () => {
    const v = makeView({
      path: 'src/a.ts',
      lastAccessed: NOW - 0 * DEFAULT_ROUND_MS,
    });
    const cands = selectCandidates(makeInput({
      fileViews: asMap('filePath', [v]),
      taskPlanFilePaths: new Set(['src/b.ts']),
    }));
    expect(cands).toHaveLength(1);
    expect(cands[0].reasons.some(r => /out of subtask scope/i.test(r))).toBe(true);
  });

  it('includes pinned non-FV artifact chunks that are large and idle', () => {
    const c = makeChunk({
      hash: 'h:bigsearch',
      type: 'search',
      tokens: 3000,
      lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
    });
    const cands = selectCandidates(makeInput({
      chunks: asMap('hash', [c]),
    }));
    expect(cands).toHaveLength(1);
    expect(cands[0].kind).toBe('artifact');
    expect(cands[0].hash).toBe('h:bigsearch');
  });

  it('excludes small pinned artifacts below artifactMinTokens', () => {
    const c = makeChunk({
      hash: 'h:small',
      tokens: 500,
      lastAccessed: NOW - 10 * DEFAULT_ROUND_MS,
    });
    const cands = selectCandidates(makeInput({ chunks: asMap('hash', [c]) }));
    expect(cands).toHaveLength(0);
  });

  it('excludes artifact chunks already covered by a pinned FileView', () => {
    const c = makeChunk({
      hash: 'h:covered',
      tokens: 2000,
      lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
    });
    const cands = selectCandidates(makeInput({
      chunks: asMap('hash', [c]),
      fileViewCoveredChunkHashes: new Set(['h:covered']),
    }));
    expect(cands).toHaveLength(0);
  });

  it('excludes artifact chunks recently cited by BB findings', () => {
    const c = makeChunk({
      hash: 'h:cited',
      tokens: 2000,
      lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
    });
    const cands = selectCandidates(makeInput({
      chunks: asMap('hash', [c]),
      recentlyCitedChunkHashes: new Set(['h:cited']),
    }));
    expect(cands).toHaveLength(0);
  });

  it('ranks larger-idle above smaller-fresh', () => {
    const big = makeView({
      path: 'big.ts',
      hash: 'h:fv:big',
      lastAccessed: NOW - 6 * DEFAULT_ROUND_MS,
      filledTokens: 5000,
    });
    const small = makeView({
      path: 'small.ts',
      hash: 'h:fv:sm',
      lastAccessed: NOW - 2 * DEFAULT_ROUND_MS,
      filledTokens: 1000,
    });
    const cands = selectCandidates(makeInput({
      fileViews: asMap('filePath', [small, big]),
    }));
    expect(cands.map(c => c.hash)).toEqual(['h:fv:big', 'h:fv:sm']);
  });

  it('honors maxCandidates cap', () => {
    const views = [1, 2, 3, 4, 5, 6, 7].map(i =>
      makeView({
        path: `src/f${i}.ts`,
        hash: `h:fv:f${i}`,
        lastAccessed: NOW - (5 + i) * DEFAULT_ROUND_MS,
        filledTokens: 1000 + i * 100,
      }),
    );
    const cands = selectCandidates(
      makeInput({ fileViews: asMap('filePath', views) }),
      { maxCandidates: 3 },
    );
    expect(cands).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Edit-forwarding booster (survivedEditsWhileIdle)
// ---------------------------------------------------------------------------

describe('assessContext — survivedEditsWhileIdle tracking', () => {
  beforeEach(() => resetAssessContext());

  it('increments forwards when revision changes without a lastAccessed bump', () => {
    const path = 'src/a.ts';
    const base = {
      path,
      hash: 'h:fv:a',
      lastAccessed: NOW - 4 * DEFAULT_ROUND_MS,
      filledTokens: 2000,
    };
    // First observation at rev1 — baseline.
    selectCandidates(makeInput({
      fileViews: asMap('filePath', [makeView({ ...base, revision: 'rev1' })]),
    }));
    // Revision bumped to rev2; lastAccessed UNCHANGED — counts as a forward.
    selectCandidates(makeInput({
      fileViews: asMap('filePath', [makeView({ ...base, revision: 'rev2' })]),
    }));
    // Third call: revision rev3, still no access — two forwards now.
    const cands = selectCandidates(makeInput({
      fileViews: asMap('filePath', [makeView({ ...base, revision: 'rev3' })]),
    }));
    expect(cands[0].survivedEditsWhileIdle).toBe(2);
    expect(cands[0].reasons.some(r => /survived 2 edits/.test(r))).toBe(true);
  });

  it('resets forwards when lastAccessed bumps', () => {
    const path = 'src/a.ts';
    selectCandidates(makeInput({
      fileViews: asMap('filePath', [makeView({
        path, hash: 'h:fv:a',
        revision: 'rev1',
        lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
      })]),
    }));
    selectCandidates(makeInput({
      fileViews: asMap('filePath', [makeView({
        path, hash: 'h:fv:a',
        revision: 'rev2',
        lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
      })]),
    }));
    // Access advances — forwards reset to 0.
    const cands = selectCandidates(makeInput({
      fileViews: asMap('filePath', [makeView({
        path, hash: 'h:fv:a',
        revision: 'rev2',
        lastAccessed: NOW - 2 * DEFAULT_ROUND_MS,
      })]),
    }));
    expect(cands[0].survivedEditsWhileIdle).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

describe('assessContext — triggers', () => {
  beforeEach(() => resetAssessContext());

  const view = () => makeView({
    path: 'src/a.ts',
    hash: 'h:fv:a',
    lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
    filledTokens: 3000,
  });

  it('fires on user-turn boundary (round===0) when pinned tokens exceed threshold', () => {
    const ev = evaluateAssess(makeInput({
      round: 0,
      fileViews: asMap('filePath', [view()]),
      ctxUsedTokens: 20_000, // well below mid-loop CTX threshold
    }));
    expect(ev.fired).toBe(true);
    expect(ev.message).toMatch(/<<ASSESS:/);
  });

  it('does NOT fire on user-turn boundary when total candidate tokens < boundaryMinTokens', () => {
    const tiny = makeView({
      path: 'src/a.ts',
      hash: 'h:fv:a',
      lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
      filledTokens: 200,
    });
    const ev = evaluateAssess(makeInput({
      round: 0,
      fileViews: asMap('filePath', [tiny]),
      ctxUsedTokens: 20_000,
    }), { boundaryMinTokens: 1000 });
    expect(ev.fired).toBe(false);
  });

  it('does NOT fire mid-loop when CTX is below the threshold and no new forwards', () => {
    const ev = evaluateAssess(makeInput({
      round: 3,
      fileViews: asMap('filePath', [view()]),
      ctxUsedTokens: 100_000,  // 50% of 200k
      ctxMaxTokens: 200_000,
    }));
    expect(ev.fired).toBe(false);
  });

  it('fires mid-loop when CTX crosses midLoopCtxThreshold', () => {
    const ev = evaluateAssess(makeInput({
      round: 3,
      fileViews: asMap('filePath', [view()]),
      ctxUsedTokens: 170_000,
      ctxMaxTokens: 200_000,
    }));
    expect(ev.fired).toBe(true);
    expect(ev.ctxPct).toBeGreaterThanOrEqual(80);
  });

  it('fires mid-loop when a new edit-forwarded pin appears even under CTX threshold', () => {
    const path = 'src/a.ts';
    // Seed observation at rev1.
    selectCandidates(makeInput({
      round: 1,
      fileViews: asMap('filePath', [makeView({
        path, hash: 'h:fv:a',
        revision: 'rev1',
        lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
        filledTokens: 3000,
      })]),
    }));
    // Mid-loop: revision bumped without access → new forward.
    const ev = evaluateAssess(makeInput({
      round: 3,
      fileViews: asMap('filePath', [makeView({
        path, hash: 'h:fv:a',
        revision: 'rev2',
        lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
        filledTokens: 3000,
      })]),
      ctxUsedTokens: 60_000,
      ctxMaxTokens: 200_000,
    }));
    expect(ev.fired).toBe(true);
    expect(ev.candidates[0].survivedEditsWhileIdle).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

describe('assessContext — single-fire dedupe', () => {
  beforeEach(() => resetAssessContext());

  const view = () => makeView({
    path: 'src/a.ts',
    hash: 'h:fv:a',
    lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
    filledTokens: 3000,
  });

  it('does not re-fire when candidates + bucket are unchanged', () => {
    const input = makeInput({
      round: 0,
      fileViews: asMap('filePath', [view()]),
    });
    const first = evaluateAssess(input);
    expect(first.fired).toBe(true);
    const second = evaluateAssess({ ...input, round: 1 });
    expect(second.fired).toBe(false);
    expect(second.firedKey).toBe(first.firedKey);
  });

  it('re-fires when a new candidate is added', () => {
    const first = evaluateAssess(makeInput({
      round: 0,
      fileViews: asMap('filePath', [view()]),
    }));
    expect(first.fired).toBe(true);
    const v2 = makeView({
      path: 'src/b.ts',
      hash: 'h:fv:b',
      lastAccessed: NOW - 4 * DEFAULT_ROUND_MS,
      filledTokens: 2000,
    });
    const second = evaluateAssess(makeInput({
      round: 0,
      fileViews: asMap('filePath', [view(), v2]),
    }));
    expect(second.fired).toBe(true);
    expect(second.firedKey).not.toBe(first.firedKey);
  });

  it('re-fires when CTX climbs from mid to hi bucket even with same candidates', () => {
    const input = makeInput({
      round: 0,
      fileViews: asMap('filePath', [view()]),
      ctxUsedTokens: 100_000,
      ctxMaxTokens: 200_000,
    });
    const first = evaluateAssess(input);
    expect(first.fired).toBe(true);
    const second = evaluateAssess({
      ...input,
      round: 3,
      ctxUsedTokens: 170_000, // crosses 80% into hi bucket
    });
    expect(second.fired).toBe(true);
  });

  it('does NOT re-fire when CTX descends from hi back to mid with same candidates', () => {
    const v = view();
    // Start in hi bucket mid-loop
    const first = evaluateAssess(makeInput({
      round: 3,
      fileViews: asMap('filePath', [v]),
      ctxUsedTokens: 170_000,
      ctxMaxTokens: 200_000,
    }));
    expect(first.fired).toBe(true);
    // Descend back to mid bucket — no re-fire
    const second = evaluateAssess(makeInput({
      round: 4,
      fileViews: asMap('filePath', [v]),
      ctxUsedTokens: 100_000,
      ctxMaxTokens: 200_000,
    }));
    expect(second.fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Turn boundary reset
// ---------------------------------------------------------------------------

describe('assessContext — turn boundary reset', () => {
  beforeEach(() => resetAssessContext());

  it('re-fires in a new turnId even with identical candidate set', () => {
    const v = makeView({
      path: 'src/a.ts',
      hash: 'h:fv:a',
      lastAccessed: NOW - 5 * DEFAULT_ROUND_MS,
      filledTokens: 3000,
    });
    const first = evaluateAssess(makeInput({
      turnId: 1,
      round: 0,
      fileViews: asMap('filePath', [v]),
    }));
    expect(first.fired).toBe(true);
    const repeatSameTurn = evaluateAssess(makeInput({
      turnId: 1,
      round: 1,
      fileViews: asMap('filePath', [v]),
    }));
    expect(repeatSameTurn.fired).toBe(false);

    // New turn: dedupe resets.
    const newTurn = evaluateAssess(makeInput({
      turnId: 2,
      round: 0,
      fileViews: asMap('filePath', [v]),
    }));
    expect(newTurn.fired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Message format
// ---------------------------------------------------------------------------

describe('assessContext — formatAssessMessage', () => {
  beforeEach(() => resetAssessContext());

  it('produces a block that starts with <<ASSESS: and ends with Per row:', () => {
    const v = makeView({
      path: 'src/a.ts',
      hash: 'h:fv:a',
      lastAccessed: NOW - 4 * DEFAULT_ROUND_MS,
      filledTokens: 2500,
    });
    const ev = evaluateAssess(makeInput({
      round: 0,
      fileViews: asMap('filePath', [v]),
    }));
    const msg = ev.message!;
    expect(msg.startsWith('<<ASSESS:')).toBe(true);
    expect(msg).toMatch(/Per row: release .* \| compact .* \| hold .*\.>>/);
    expect(msg).toContain('src/a.ts');
    expect(msg).toContain('h:fv:a');
  });

  it('token formatting uses k-suffix for 1000+', () => {
    const v = makeView({
      path: 'src/a.ts',
      hash: 'h:fv:a',
      lastAccessed: NOW - 4 * DEFAULT_ROUND_MS,
      filledTokens: 3400,
    });
    const ev = evaluateAssess(makeInput({
      round: 0,
      fileViews: asMap('filePath', [v]),
    }));
    expect(ev.message).toMatch(/3\.4k/);
  });

  it('direct call returns a stable string shape', () => {
    const v = makeView({
      path: 'x.ts',
      hash: 'h:fv:x',
      lastAccessed: NOW - 4 * DEFAULT_ROUND_MS,
      filledTokens: 1200,
    });
    const cands = selectCandidates(makeInput({
      fileViews: asMap('filePath', [v]),
    }));
    const msg = formatAssessMessage(cands, makeInput({
      fileViews: asMap('filePath', [v]),
      ctxUsedTokens: 128_000,
      ctxMaxTokens: 200_000,
    }));
    expect(msg).toContain('CTX 64%');
    expect(msg).toContain('(128k/200k)');
  });
});

// ---------------------------------------------------------------------------
// Options edge cases
// ---------------------------------------------------------------------------

describe('assessContext — options', () => {
  beforeEach(() => resetAssessContext());

  it('custom EvaluateAssessOptions propagate into selection', () => {
    const c = makeChunk({
      hash: 'h:big',
      tokens: 1200,
      lastAccessed: NOW - 4 * DEFAULT_ROUND_MS,
    });
    const opts: EvaluateAssessOptions = {
      artifactMinTokens: 5000, // above chunk tokens — should exclude
      artifactIdleRoundsMin: 1,
    };
    const cands = selectCandidates(makeInput({ chunks: asMap('hash', [c]) }), opts);
    expect(cands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Token budget — measurement gate (atls-pillars.mdc)
// ---------------------------------------------------------------------------

describe('assessContext — token budget', () => {
  beforeEach(() => resetAssessContext());

  it('max-K=5 ASSESS block stays under 300 BPE tokens', () => {
    // Worst-case realistic fixture: 5 candidates with long paths and
    // forward-survived reasons. Caps the per-fire cost we'd surface in the
    // state preamble. Target per pillars: overhead <= 10% of the window it
    // covers. With a ~3-5k dynamic context block, 300 tokens is ~6-10%.
    const views = [1, 2, 3, 4, 5].map(i => makeView({
      path: `src/services/very/deeply/nested/directory/module-${i}.ts`,
      hash: `h:fv:abcdef${i}${i}${i}${i}`,
      lastAccessed: NOW - (3 + i) * DEFAULT_ROUND_MS,
      filledTokens: 1000 + i * 500,
      revision: `rev${i}`,
    }));

    // Seed prior revisions so forwards accumulate.
    selectCandidates(makeInput({
      fileViews: asMap('filePath', views.map(v => ({ ...v, sourceRevision: 'old' } as FileView))),
    }));

    const ev = evaluateAssess(makeInput({
      round: 0,
      fileViews: asMap('filePath', views),
      ctxUsedTokens: 128_000,
      ctxMaxTokens: 200_000,
    }));
    expect(ev.fired).toBe(true);
    const tokens = countTokensSync(ev.message!);
    expect(tokens).toBeLessThan(300);
  });

  it('single-candidate ASSESS block stays under 100 BPE tokens', () => {
    const v = makeView({
      path: 'src/a.ts',
      hash: 'h:fv:a',
      lastAccessed: NOW - 4 * DEFAULT_ROUND_MS,
      filledTokens: 2500,
    });
    const ev = evaluateAssess(makeInput({
      round: 0,
      fileViews: asMap('filePath', [v]),
    }));
    expect(ev.fired).toBe(true);
    const tokens = countTokensSync(ev.message!);
    expect(tokens).toBeLessThan(100);
  });
});

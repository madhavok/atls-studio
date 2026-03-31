/**
 * Tests for ATLS efficiency enforcement:
 * - BB hygiene: auto-delete superseded entries on bb_write
 * - Manifest-first: search results note when paths overlap entry manifest
 * - Stats line: round count display
 * - Convergence guard constants
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useContextStore } from '../../../stores/contextStore';
import { useAppStore } from '../../../stores/appStore';
import { handleBbWrite, handleBbList } from './blackboard';
import { handleSearchCode } from './query';
import { formatStatsLine } from '../../contextFormatter';
import { TOTAL_ROUND_SOFT_BUDGET, TOTAL_ROUND_ESCALATION } from '../../promptMemory';

vi.mock('../../chatDb', () => ({
  chatDb: {
    isInitialized: () => false,
    setBlackboardNote: vi.fn(),
    deleteBlackboardNote: vi.fn(),
  },
}));

function createMockCtx(overrides?: Record<string, unknown>) {
  return {
    store: () => useContextStore.getState(),
    sessionId: null as string | null,
    atlsBatchQuery: vi.fn().mockResolvedValue({ results: [] }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BB Hygiene
// ---------------------------------------------------------------------------

describe('BB hygiene: auto-delete superseded entries', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('auto-deletes entries marked superseded when a new bb_write lands', async () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('finding:old', 'stale finding');

    useContextStore.setState(state => {
      const newBb = new Map(state.blackboardEntries);
      const entry = newBb.get('finding:old');
      if (entry) {
        newBb.set('finding:old', { ...entry, state: 'superseded', supersededAt: Date.now() });
      }
      return { blackboardEntries: newBb };
    });

    const before = useContextStore.getState().listBlackboardEntries();
    expect(before.find(e => e.key === 'finding:old')?.state).toBe('superseded');

    const result = await handleBbWrite(
      { key: 'finding:new', content: 'fresh finding' },
      createMockCtx() as unknown as Parameters<typeof handleBbWrite>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('auto-cleaned 1 superseded');
    expect(result.summary).toContain('finding:old');

    const after = useContextStore.getState().listBlackboardEntries();
    expect(after.find(e => e.key === 'finding:old')).toBeUndefined();
    expect(after.find(e => e.key === 'finding:new')).toBeDefined();
  });

  it('does not delete active entries', async () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('plan:current', 'active plan');
    store.setBlackboardEntry('status:progress', 'on track');

    const result = await handleBbWrite(
      { key: 'finding:x', content: 'new finding' },
      createMockCtx() as unknown as Parameters<typeof handleBbWrite>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).not.toContain('auto-cleaned');

    const entries = useContextStore.getState().listBlackboardEntries();
    const activeEntries = entries.filter(e => e.state === 'active');
    expect(activeEntries.length).toBeGreaterThanOrEqual(3);
    expect(activeEntries.find(e => e.key === 'plan:current')).toBeDefined();
    expect(activeEntries.find(e => e.key === 'status:progress')).toBeDefined();
    expect(activeEntries.find(e => e.key === 'finding:x')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Manifest-first
// ---------------------------------------------------------------------------

describe('manifest-first: search result manifest note', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('prepends MANIFEST note when search results overlap entry manifest', async () => {
    useAppStore.setState(state => ({
      ...state,
      projectProfile: {
        ...state.projectProfile,
        entryManifest: [
          { path: 'src/main.ts', sig: 'function main()', tokens: 50, lines: 10, importance: 1, method: 'naming', tier: 'full' },
        ],
      } as typeof state.projectProfile,
    }));

    const mockResult = {
      results: [
        { file: 'src/main.ts', line: 1, matches: [{ text: 'function main()' }] },
        { file: 'src/other.ts', line: 5, matches: [{ text: 'import main' }] },
      ],
    };
    const ctx = createMockCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue(mockResult),
    });

    const result = await handleSearchCode(
      { queries: ['main'] },
      ctx as unknown as Parameters<typeof handleSearchCode>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('MANIFEST');
    expect(result.summary).toContain('src/main.ts');
    expect(result.summary).toContain('entry manifest');
  });

  it('does not add note when no manifest overlap', async () => {
    useAppStore.setState(state => ({
      ...state,
      projectProfile: {
        ...state.projectProfile,
        entryManifest: [
          { path: 'src/app.ts', sig: 'class App', tokens: 50, lines: 10, importance: 1, method: 'naming', tier: 'full' },
        ],
      } as typeof state.projectProfile,
    }));

    const mockResult = {
      results: [
        { file: 'src/other.ts', line: 5, matches: [{ text: 'something' }] },
      ],
    };
    const ctx = createMockCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue(mockResult),
    });

    const result = await handleSearchCode(
      { queries: ['something'] },
      ctx as unknown as Parameters<typeof handleSearchCode>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).not.toContain('MANIFEST');
  });
});

// ---------------------------------------------------------------------------
// Stats line round count
// ---------------------------------------------------------------------------

describe('formatStatsLine round count', () => {
  it('includes round:{N} when roundCount > 0', () => {
    const line = formatStatsLine(50000, 200000, 10, 3, 500, 0, undefined, undefined, undefined, undefined, undefined, undefined, 4);
    expect(line).toContain('round:4');
  });

  it('omits round when roundCount is 0', () => {
    const line = formatStatsLine(50000, 200000, 10, 3, 500, 0, undefined, undefined, undefined, undefined, undefined, undefined, 0);
    expect(line).not.toContain('round:');
  });

  it('omits round when roundCount is undefined', () => {
    const line = formatStatsLine(50000, 200000, 10, 3, 500, 0);
    expect(line).not.toContain('round:');
  });
});

// ---------------------------------------------------------------------------
// Convergence guard constants
// ---------------------------------------------------------------------------

describe('convergence guard constants', () => {
  it('TOTAL_ROUND_SOFT_BUDGET is 6', () => {
    expect(TOTAL_ROUND_SOFT_BUDGET).toBe(6);
  });

  it('TOTAL_ROUND_ESCALATION is 8', () => {
    expect(TOTAL_ROUND_ESCALATION).toBe(8);
  });

  it('escalation > soft budget', () => {
    expect(TOTAL_ROUND_ESCALATION).toBeGreaterThan(TOTAL_ROUND_SOFT_BUDGET);
  });
});

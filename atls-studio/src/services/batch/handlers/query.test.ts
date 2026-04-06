import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  handleSearchCode,
  handleSearchSymbol,
  handleSearchMemory,
} from './query';
import { useRetentionStore } from '../../../stores/retentionStore';

describe('query handlers', () => {
  beforeEach(() => {
    useRetentionStore.getState().reset();
  });

  it('exports search handlers', () => {
    expect(typeof handleSearchCode).toBe('function');
    expect(typeof handleSearchSymbol).toBe('function');
    expect(typeof handleSearchMemory).toBe('function');
  });

  it('handleSearchCode structured content has one path per hit (duplicate files)', async () => {
    const ctx = {
      atlsBatchQuery: vi.fn(async () => ({
        results: [{
          query: 'q',
          results: [
            { file: 'src/a.ts', line: 1 },
            { file: 'src/a.ts', line: 10 },
          ],
        }],
      })),
      store: () => ({
        addChunk: () => 'hash123',
        recordManageOps: () => {},
        recordToolCall: () => {},
        recordBatchRead: () => {},
        recordCoveragePath: () => {},
        recordFileReadSpin: () => null,
        resetFileReadSpin: () => {},
        getPriorReadRanges: () => [],
        forwardStagedHash: () => 0,
        addVerifyArtifact: () => {},
        getCurrentRev: () => 0,
        recordMemoryEvent: () => {},
        getAwareness: () => undefined,
        setAwareness: () => {},
        invalidateAwareness: () => {},
        invalidateAwarenessForPaths: () => {},
        getAwarenessCache: () => new Map(),
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
    } as any;

    const out = await handleSearchCode({ queries: ['__per_hit_struct_test__'] }, ctx);
    expect(out.ok).toBe(true);
    expect(out.content).toMatchObject({
      file_paths: ['src/a.ts', 'src/a.ts'],
      lines: [1, 10],
    });
  });

  it('handleSearchCode uses literal line scan when FTS returns no rows but file is scoped', async () => {
    const calls: string[] = [];
    const ctx = {
      atlsBatchQuery: vi.fn(async (op: string) => {
        calls.push(op);
        if (op === 'code_search') {
          return { results: [{ query: 'return a + b', results: [] }] };
        }
        if (op === 'context') {
          return {
            results: [{
              file: '_test/a.py',
              content: 'def add():\n    return a + b\n',
            }],
          };
        }
        return {};
      }),
      store: () => ({
        addChunk: () => 'hash123',
        recordManageOps: () => {},
        recordToolCall: () => {},
        recordBatchRead: () => {},
        recordCoveragePath: () => {},
        recordFileReadSpin: () => null,
        resetFileReadSpin: () => {},
        getPriorReadRanges: () => [],
        forwardStagedHash: () => 0,
        addVerifyArtifact: () => {},
        getCurrentRev: () => 0,
        recordMemoryEvent: () => {},
        getAwareness: () => undefined,
        setAwareness: () => {},
        invalidateAwareness: () => {},
        invalidateAwarenessForPaths: () => {},
        getAwarenessCache: () => new Map(),
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
    } as any;

    const out = await handleSearchCode(
      { queries: ['return a + b'], file_paths: ['_test/a.py'] },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.content).toMatchObject({
      file_paths: ['_test/a.py'],
      lines: [2],
    });
    expect(calls).toEqual(['code_search', 'context']);
  });
});

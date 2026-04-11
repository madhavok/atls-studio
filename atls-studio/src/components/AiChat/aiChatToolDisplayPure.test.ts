import { describe, expect, it } from 'vitest';
import {
  batchStepSubagentLookupKey,
  expandBatchToolCall,
  getBatchDisplayDetail,
  getBatchSteps,
  getFriendlyToolName,
  getToolDetail,
  getToolDisplayInfo,
  isBatchCall,
  mapSyntheticStepStatus,
  parseStatusMarkers,
  truncateToolResult,
  type ToolCallLike,
} from './aiChatToolDisplayPure';

describe('aiChatToolDisplayPure', () => {
  describe('batchStepSubagentLookupKey', () => {
    it('prefers args.step_id', () => {
      expect(
        batchStepSubagentLookupKey({
          id: 'batch:1:ignored:tail',
          name: 'x',
          status: 'pending',
          args: { step_id: '  my-step ' },
        }),
      ).toBe('my-step');
    });

    it('uses segment after :: in id', () => {
      expect(
        batchStepSubagentLookupKey({
          id: 'parent::child-step',
          name: 'x',
          status: 'pending',
        }),
      ).toBe('child-step');
    });

    it('parses batch: prefix ids', () => {
      expect(
        batchStepSubagentLookupKey({
          id: 'batch:a:b:c',
          name: 'x',
          status: 'pending',
        }),
      ).toBe('b');
    });
  });

  describe('getFriendlyToolName', () => {
    it('maps batch and task_complete', () => {
      expect(getFriendlyToolName('batch')).toBe('\u26A1 ATLS');
      expect(getFriendlyToolName('task_complete')).toBe('\u2705 Task Complete');
    });

    it('formats dotted tool names with family icon when registered', () => {
      const s = getFriendlyToolName('discover.search_code');
      expect(s).toContain('Discover');
      expect(s).toContain('Search Code');
    });

    it('falls back to wrench for unknown dotted family', () => {
      expect(getFriendlyToolName('zzz.unknown_op')).toMatch(/^\uD83D\uDD27 Zzz Unknown Op$/u);
    });
  });

  describe('getToolDetail', () => {
    it('picks file_paths, file_path, path, query, etc.', () => {
      expect(getToolDetail('x', { file_paths: ['/a', '/b'] })).toBe('/a');
      expect(getToolDetail('x', { file_path: 'f.ts' })).toBe('f.ts');
      expect(getToolDetail('x', { path: '/p' })).toBe('/p');
      expect(getToolDetail('x', { symbol_names: ['A', 'B'] })).toBe('A, B');
      expect(getToolDetail('x', { queries: ['q1'] })).toBe('q1');
      expect(getToolDetail('x', { query: 'why' })).toBe('why');
      expect(getToolDetail('x', { operation: 'read' })).toBe('read');
      expect(getToolDetail('x', { action: 'go' })).toBe('go');
      expect(getToolDetail('x', {})).toBe('');
    });
  });

  describe('getBatchSteps', () => {
    it('normalizes step records and defaults id/use', () => {
      const steps = getBatchSteps({
        steps: [
          { id: 's1', use: 'discover.search_code', with: { query: 'x' } },
          { with: {} },
        ],
      });
      expect(steps).toHaveLength(2);
      expect(steps[0].id).toBe('s1');
      expect(steps[0].use).toContain('discover');
      expect(steps[0].with).toEqual({ query: 'x' });
      expect(steps[1].id).toBe('step-2');
      expect(steps[1].use).toBe('step.2');
    });
  });

  describe('truncateToolResult', () => {
    it('returns short text unchanged', () => {
      expect(truncateToolResult('  hi  ')).toBe('hi');
      expect(truncateToolResult('')).toBe('');
    });

    it('truncates long output with head and tail', () => {
      const long = 'x'.repeat(400);
      const out = truncateToolResult(long, 200);
      expect(out).toContain('…[truncated');
      expect(out.length).toBeLessThan(long.length);
    });
  });

  describe('isBatchCall', () => {
    it('detects batch name', () => {
      expect(isBatchCall({ name: 'batch' })).toBe(true);
      expect(isBatchCall({ name: 'read_file' })).toBe(false);
    });
  });

  describe('mapSyntheticStepStatus', () => {
    it('maps synthetic child status strings', () => {
      expect(mapSyntheticStepStatus('failed')).toBe('failed');
      expect(mapSyntheticStepStatus('running')).toBe('running');
      expect(mapSyntheticStepStatus('pending')).toBe('pending');
      expect(mapSyntheticStepStatus(undefined)).toBe('completed');
      expect(mapSyntheticStepStatus('weird')).toBe('completed');
    });
  });

  describe('expandBatchToolCall', () => {
    it('returns [] for non-batch', () => {
      expect(expandBatchToolCall(baseLike({ name: 'read_file' }))).toEqual([]);
    });

    it('expands syntheticChildren', () => {
      const rows = expandBatchToolCall(
        baseLike({
          syntheticChildren: [
            { id: 'c1', name: 'DELEGATE.RUN', status: 'running', args: { a: 1 } },
          ],
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('c1');
      expect(rows[0].status).toBe('running');
      expect(rows[0].name).toContain('delegate');
    });

    it('derives step rows from args and result lines', () => {
      const rows = expandBatchToolCall(
        baseLike({
          args: {
            steps: [{ id: 'alpha', use: 'discover.search_code', with: { query: 'q' } }],
          },
          result: '[OK] alpha done',
          status: 'completed',
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('bid::alpha');
      expect(rows[0].status).toBe('completed');
      expect(rows[0].result).toContain('[OK] alpha');
    });

    it('marks unrun steps failed when batch failed', () => {
      const rows = expandBatchToolCall(
        baseLike({
          args: {
            steps: [
              { id: 'a', use: 'step.1', with: {} },
              { id: 'b', use: 'step.2', with: {} },
            ],
          },
          status: 'failed',
          result: '',
        }),
      );
      expect(rows[1].status).toBe('failed');
      expect(rows[1].result).toContain('Not executed');
    });
  });

  describe('getBatchDisplayDetail', () => {
    it('prefers goal then first step detail', () => {
      expect(getBatchDisplayDetail({ goal: '  ship it  ' })).toBe('ship it');
      expect(
        getBatchDisplayDetail({
          steps: [{ id: 's', use: 'read_file', with: { file_path: '/x' } }],
        }),
      ).toBe('/x');
    });
  });

  describe('getToolDisplayInfo', () => {
    it('unwraps args.tool and args.params', () => {
      const i = getToolDisplayInfo({
        name: 'wrapper',
        args: { tool: 'batch', params: { goal: 'g' } },
      });
      expect(i.detail).toBe('g');
      expect(i.friendly).toContain('ATLS');
    });
  });

  describe('parseStatusMarkers', () => {
    it('splits text and status objects', () => {
      const parts = parseStatusMarkers('before «st:working|step:1» after');
      expect(parts[0]).toBe('before ');
      expect(parts[1]).toEqual({ type: 'status', status: 'working', step: '1' });
      expect(parts[2]).toBe(' after');
    });
  });
});

function baseLike(partial: Partial<ToolCallLike>): ToolCallLike {
  return {
    id: 'bid',
    name: 'batch',
    status: 'running',
    ...partial,
  } as ToolCallLike;
}

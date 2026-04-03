import { describe, expect, it } from 'vitest';
import { coerceBatchSteps } from './coerceBatchSteps';

describe('coerceBatchSteps', () => {
  it('returns empty array for undefined, null, number, or invalid JSON string', () => {
    expect(coerceBatchSteps(undefined)).toEqual([]);
    expect(coerceBatchSteps(null)).toEqual([]);
    expect(coerceBatchSteps(42)).toEqual([]);
    expect(coerceBatchSteps('not json')).toEqual([]);
    expect(coerceBatchSteps('{}')).toEqual([]);
  });

  it('returns array of object steps unchanged (filters non-objects)', () => {
    expect(
      coerceBatchSteps([
        { id: 'a', use: 'search.code' },
        { id: 'b', use: 'read.context', with: { file_paths: ['x.ts'] } },
      ]),
    ).toEqual([
      { id: 'a', use: 'search.code' },
      { id: 'b', use: 'read.context', with: { file_paths: ['x.ts'] } },
    ]);
    expect(coerceBatchSteps([{ id: 'x', use: 'y' }, null, 'skip', [1, 2]])).toEqual([{ id: 'x', use: 'y' }]);
  });

  it('parses JSON string of step array', () => {
    const json = JSON.stringify([
      { id: 's1', use: 'search.code', with: { queries: ['a'] } },
      { id: 'r1', use: 'read.context', with: { file_paths: ['src/a.ts'] } },
    ]);
    expect(coerceBatchSteps(json)).toEqual([
      { id: 's1', use: 'search.code', with: { queries: ['a'] } },
      { id: 'r1', use: 'read.context', with: { file_paths: ['src/a.ts'] } },
    ]);
  });

  it('parses stringified steps like models sometimes emit', () => {
    const s =
      '[{"id":"read_test_file","use":"read.context","with":{"type":"smart","file_paths":["test.ts"]}}]';
    const steps = coerceBatchSteps(s);
    expect(steps).toHaveLength(1);
    expect(steps[0].use).toBe('read.context');
    expect((steps[0].with as Record<string, unknown>).file_paths).toEqual(['test.ts']);
  });

  it('expands string `if` from JSON steps (same as if:e1.ok in line-per-step)', () => {
    const steps = coerceBatchSteps([
      { id: 'e1', use: 'change.edit', with: {} },
      { id: 'v1', use: 'verify.build', if: 'e1.ok' },
    ]);
    expect(steps[1].if).toEqual({ step_ok: 'e1' });
  });

  it('normalizes op shorthand codes in JSON steps', () => {
    const steps = coerceBatchSteps([
      { id: 'r1', use: 'sc', with: { queries: ['auth'] } },
      { id: 'e1', use: 'ce', with: { file_path: 'a.ts' } },
      { id: 'v1', use: 'vk' },
    ]);
    expect(steps[0].use).toBe('search.code');
    expect(steps[1].use).toBe('change.edit');
    expect(steps[2].use).toBe('verify.typecheck');
  });

  it('normalizes shorthand in JSON-stringified steps', () => {
    const json = JSON.stringify([
      { id: 'r1', use: 'rc', with: { type: 'smart', file_paths: ['x.ts'] } },
    ]);
    const steps = coerceBatchSteps(json);
    expect(steps[0].use).toBe('read.context');
  });

  it('leaves canonical op names unchanged', () => {
    const steps = coerceBatchSteps([
      { id: 'r1', use: 'search.code' },
    ]);
    expect(steps[0].use).toBe('search.code');
  });
});

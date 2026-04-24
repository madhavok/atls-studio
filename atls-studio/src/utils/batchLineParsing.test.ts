import { describe, expect, it } from 'vitest';
import { parseBatchStepLines, indexStepLinesById } from './batchLineParsing';

describe('parseBatchStepLines', () => {
  it('returns empty for undefined input', () => {
    expect(parseBatchStepLines(undefined)).toEqual([]);
    expect(parseBatchStepLines('')).toEqual([]);
  });

  it('parses simple OK/FAIL lines', () => {
    const result = [
      '[OK] s1 (search.code): found 3 matches (42ms)',
      '[FAIL] s2 (change.edit): ERROR file not found',
    ].join('\n');

    const lines = parseBatchStepLines(result);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ stepId: 's1', text: '[OK] s1 (search.code): found 3 matches (42ms)', failed: false });
    expect(lines[1]).toEqual({ stepId: 's2', text: '[FAIL] s2 (change.edit): ERROR file not found', failed: true });
  });

  it('skips delegate continuation lines (indented refs, BB, explanatory)', () => {
    const result = [
      '[OK] d1 (delegate.retrieve): retriever: 4 refs (1.2k tk), 2 rounds',
      '  refs: h:abc123 h:def456',
      '  BB: h:bb:retriever_findings',
      '  (Blackboard bodies are inlined in the step summary when present.)',
      '[OK] s2 (read.context): loaded src/foo.ts',
    ].join('\n');

    const lines = parseBatchStepLines(result);
    expect(lines).toHaveLength(2);
    expect(lines[0].stepId).toBe('d1');
    expect(lines[1].stepId).toBe('s2');
  });

  it('skips ATLS footer lines', () => {
    const result = [
      '[OK] s1 (search.code): done',
      '[ATLS] 1 steps: 1 pass (50ms) | ok',
    ].join('\n');

    const lines = parseBatchStepLines(result);
    expect(lines).toHaveLength(1);
    expect(lines[0].stepId).toBe('s1');
  });

  it('skips non-status lines that do not match the step pattern', () => {
    const result = [
      'Some plain text without brackets',
      '[OK] s1 (read.context): loaded file',
    ].join('\n');
    const lines = parseBatchStepLines(result);
    expect(lines).toHaveLength(1);
    expect(lines[0].stepId).toBe('s1');
  });

  it('skips volatile nudge lines', () => {
    const result = [
      '[OK] s1 (read.context): loaded file',
      '⚠ VOLATILE — WILL BE LOST NEXT ROUND. PIN NOW in this batch or write to BB. Add: `pi h:abc`',
      '[ATLS] 1 steps: 1 pass (10ms) | ok',
    ].join('\n');

    const lines = parseBatchStepLines(result);
    expect(lines).toHaveLength(1);
  });

  it('handles all status tags', () => {
    const result = [
      '[PASS] v1 (verify.build): passed',
      '[WARN] v2 (verify.lint): warnings found',
      '[SKIP] s3 (change.delete): skipped',
      '[TOOL-ERROR] v3 (verify.test): command not found',
    ].join('\n');

    const lines = parseBatchStepLines(result);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ stepId: 'v1', failed: false });
    expect(lines[1]).toMatchObject({ stepId: 'v2', failed: false });
    expect(lines[2]).toMatchObject({ stepId: 's3', failed: false });
    expect(lines[3]).toMatchObject({ stepId: 'v3', failed: true });
  });

  it('skips interruption lines', () => {
    const result = [
      '[OK] s1 (read.context): done',
      '[FAIL] s2 (change.edit): rebased but confidence low',
      '[ATLS] BATCH INTERRUPTED at s2: auto-rebased with low confidence',
      '[ATLS] 2 steps: 1 pass, 1 fail (200ms) | interrupted',
    ].join('\n');

    const lines = parseBatchStepLines(result);
    expect(lines).toHaveLength(2);
    expect(lines[0].stepId).toBe('s1');
    expect(lines[1].stepId).toBe('s2');
  });

  it('handles realistic multi-step batch with delegate', () => {
    const result = [
      '[OK] r1 (search.code): 5 matches in 3 files',
      '[OK] r2 (read.shaped): src/api.ts h:ab12 (sig, 24 lines)',
      '[OK] d1 (delegate.retrieve): retriever: 8 refs (3.1k tk), 3 rounds | BB: retriever_findings',
      '  refs: h:aaa111 h:bbb222 h:ccc333',
      '  BB: h:bb:retriever_findings',
      '  (Blackboard bodies are inlined in the step summary when present.)',
      '[OK] e1 (change.edit): applied 2 edits to src/api.ts',
      '⚠ VOLATILE — WILL BE LOST NEXT ROUND. PIN NOW in this batch or write to BB. Add: `pi h:aaa111 h:bbb222`',
      '[ATLS] 4 steps: 4 pass (1200ms) | ok',
    ].join('\n');

    const lines = parseBatchStepLines(result);
    expect(lines).toHaveLength(4);
    expect(lines.map(l => l.stepId)).toEqual(['r1', 'r2', 'd1', 'e1']);
    expect(lines.every(l => !l.failed)).toBe(true);
  });
});

describe('indexStepLinesById', () => {
  it('builds a map keyed by stepId', () => {
    const lines = parseBatchStepLines(
      '[OK] s1 (search.code): done\n[FAIL] s2 (change.edit): ERROR',
    );
    const map = indexStepLinesById(lines);
    expect(map.size).toBe(2);
    expect(map.get('s1')?.failed).toBe(false);
    expect(map.get('s2')?.failed).toBe(true);
    expect(map.get('s3')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { transformIssues } from './useAtlsTransforms';

describe('transformIssues', () => {
  it('maps API fields and coerces severity', () => {
    // Wire payloads use snake_case pattern_id (see Rust IPC); cast for the mapper.
    const raw = [
      {
        id: '1',
        pattern_id: 'p1',
        file: 'a.ts',
        line: 2,
        message: 'm',
        severity: 'high',
        category: 'bug',
      },
    ] as any;
    const out = transformIssues(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: '1',
      patternId: 'p1',
      file: 'a.ts',
      line: 2,
      message: 'm',
      severity: 'high',
      category: 'bug',
    });
  });
});

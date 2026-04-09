import { describe, expect, it } from 'vitest';

import {
  subagentToolResultIndicatesExploration,
  subagentToolResultIndicatesProgress,
} from './subagentProgress';

describe('subagentToolResultIndicatesProgress', () => {
  it('recognizes handler-style pin / bb_write / staged summaries', () => {
    expect(subagentToolResultIndicatesProgress('[OK] p1: pin: 2 chunks pinned')).toBe(true);
    expect(subagentToolResultIndicatesProgress('[OK] bw: bb_write: h:bb:design:research (120tk) — use h:bb:design:research in response')).toBe(true);
    expect(subagentToolResultIndicatesProgress('[OK] s1: staged [src/foo.ts] (500tk). Total staged: 12.0k. Visible in staged next round.')).toBe(true);
    expect(subagentToolResultIndicatesProgress('[OK] s2: staged lines:10 ctx:2 (400tk, src/bar.ts). Total: 15.0k. Visible next round.')).toBe(true);
  });

  it('recognizes formatBatchResult lines with (step.use)', () => {
    const formatted = '[OK] r1 (read.shaped): file digest here\n[ATLS] 1 steps: 1 pass (10ms) | ok';
    expect(subagentToolResultIndicatesProgress(formatted)).toBe(true);
    expect(subagentToolResultIndicatesExploration(formatted)).toBe(true);
  });

  it('treats analyze.* as progress', () => {
    expect(subagentToolResultIndicatesProgress('[OK] a1 (analyze.deps): graph summary')).toBe(true);
  });

  it('keeps legacy canonical op name substrings', () => {
    expect(subagentToolResultIndicatesProgress('session.pin something')).toBe(true);
    expect(subagentToolResultIndicatesProgress('verify.test output')).toBe(true);
  });

  it('returns false for blocked or error-only tool text', () => {
    expect(subagentToolResultIndicatesProgress('BLOCKED: policy')).toBe(false);
    expect(subagentToolResultIndicatesProgress('Error: no API key')).toBe(false);
    expect(subagentToolResultIndicatesProgress('ERROR missing path')).toBe(false);
  });
});

describe('subagentToolResultIndicatesExploration', () => {
  it('is true for successful read/search/intent/analyze with [OK]', () => {
    expect(subagentToolResultIndicatesExploration('[OK] x (read.context): body')).toBe(true);
    expect(subagentToolResultIndicatesExploration('[OK] x (search.code): hits')).toBe(true);
    expect(subagentToolResultIndicatesExploration('[OK] x (intent.survey): staged')).toBe(true);
    expect(subagentToolResultIndicatesExploration('[OK] x (analyze.structure): tree')).toBe(true);
  });

  it('matches op names in summary when formatter omits step.use (legacy)', () => {
    expect(subagentToolResultIndicatesExploration('[OK] s1: read.shaped returned digest')).toBe(true);
  });

  it('is false without [OK]', () => {
    expect(subagentToolResultIndicatesExploration('[FAIL] x (read.lines): oops')).toBe(false);
  });
});

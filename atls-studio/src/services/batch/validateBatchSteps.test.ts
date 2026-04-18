import { describe, expect, it } from 'vitest';
import { validateBatchSteps } from './validateBatchSteps';

describe('validateBatchSteps', () => {
  it('accepts valid ids and canonical ops', () => {
    expect(
      validateBatchSteps([
        { id: 'r1', use: 'read.context' },
        { id: 'p1', use: 'session.pin', with: { hashes: ['h:abc123'] } },
      ]),
    ).toEqual({ ok: true });
  });

  it('accepts short op codes after normalization', () => {
    expect(
      validateBatchSteps([{ id: 's1', use: 'sc', with: { queries: ['x'] } }]),
    ).toEqual({ ok: true });
  });

  it('rejects markdown-like step ids', () => {
    const r = validateBatchSteps([{ id: '`export_statement`', use: 'search.code' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('invalid step id');
  });

  it('rejects unknown operations', () => {
    const r = validateBatchSteps([{ id: 'x1', use: 'placeholder' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown operation');
  });

  it('hints at session.advance when use looks like subtask:*', () => {
    const r = validateBatchSteps([{ id: 'sa', use: 'subtask:trace' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('unknown operation');
      expect(r.error).toContain('session.advance');
    }
  });

  it('hints at session.advance for bare "subtask" use', () => {
    const r = validateBatchSteps([{ id: 'sa', use: 'subtask' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('session.advance');
  });
});

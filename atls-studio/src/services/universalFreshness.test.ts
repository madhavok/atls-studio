import { describe, it, expect } from 'vitest';
import {
  canSteerExecution,
  isExecutionAuthoritative,
  validateSourceIdentity,
} from './universalFreshness';

// ---------------------------------------------------------------------------
// canSteerExecution
// ---------------------------------------------------------------------------
describe('canSteerExecution', () => {
  it('returns true for { state: "active" }', () => {
    expect(canSteerExecution({ state: 'active' })).toBe(true);
  });

  it('returns true for empty object', () => {
    expect(canSteerExecution({})).toBe(true);
  });

  it('returns false for { state: "superseded" }', () => {
    expect(canSteerExecution({ state: 'superseded' })).toBe(false);
  });

  it('returns false for { state: "historical" }', () => {
    expect(canSteerExecution({ state: 'historical' })).toBe(false);
  });

  it('returns false for { state: "duplicate" }', () => {
    expect(canSteerExecution({ state: 'duplicate' })).toBe(false);
  });

  it('returns false for { state: "distilled" }', () => {
    expect(canSteerExecution({ state: 'distilled' })).toBe(false);
  });

  it('returns false for { stageState: "stale" }', () => {
    expect(canSteerExecution({ stageState: 'stale' })).toBe(false);
  });

  it('returns false for { stageState: "superseded" }', () => {
    expect(canSteerExecution({ stageState: 'superseded' })).toBe(false);
  });

  it('returns true for { stageState: "current" }', () => {
    expect(canSteerExecution({ stageState: 'current' })).toBe(true);
  });

  it('returns false for { traceState: "duplicate" }', () => {
    expect(canSteerExecution({ traceState: 'duplicate' })).toBe(false);
  });

  it('returns false for { traceState: "distilled" }', () => {
    expect(canSteerExecution({ traceState: 'distilled' })).toBe(false);
  });

  it('returns true for { traceState: "active_exemplar" }', () => {
    expect(canSteerExecution({ traceState: 'active_exemplar' })).toBe(true);
  });

  it('returns false for { freshness: "suspect" }', () => {
    expect(canSteerExecution({ freshness: 'suspect' })).toBe(false);
  });

  it('returns false for { freshness: "changed" }', () => {
    expect(canSteerExecution({ freshness: 'changed' })).toBe(false);
  });

  it('returns true for { freshness: "fresh" }', () => {
    expect(canSteerExecution({ freshness: 'fresh' })).toBe(true);
  });

  it('returns true for { freshness: "shifted" } (rebaseable, not blocked)', () => {
    expect(canSteerExecution({ freshness: 'shifted' })).toBe(true);
  });

  it('returns false when suspect freshness overrides active state', () => {
    expect(canSteerExecution({ state: 'active', freshness: 'suspect' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExecutionAuthoritative
// ---------------------------------------------------------------------------
describe('isExecutionAuthoritative', () => {
  it('returns true for { state: "active" }', () => {
    expect(isExecutionAuthoritative({ state: 'active' })).toBe(true);
  });

  it('returns false for { state: "superseded" }', () => {
    expect(isExecutionAuthoritative({ state: 'superseded' })).toBe(false);
  });

  it('returns false for { state: "historical" }', () => {
    expect(isExecutionAuthoritative({ state: 'historical' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateSourceIdentity
// ---------------------------------------------------------------------------
describe('validateSourceIdentity', () => {
  it('returns normalized path for valid forward-slash paths', () => {
    expect(validateSourceIdentity('src/foo.ts')).toBe('src/foo.ts');
  });

  it('returns normalized path for backslash paths', () => {
    expect(validateSourceIdentity('src\\foo.ts')).toBe('src/foo.ts');
  });

  it('returns undefined for empty string', () => {
    expect(validateSourceIdentity('')).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(validateSourceIdentity(undefined)).toBeUndefined();
  });

  it('returns undefined for "."', () => {
    expect(validateSourceIdentity('.')).toBeUndefined();
  });

  it('returns undefined for "/"', () => {
    expect(validateSourceIdentity('/')).toBeUndefined();
  });

  it('returns undefined for bogus pattern results.0.file_path', () => {
    expect(validateSourceIdentity('results.0.file_path')).toBeUndefined();
  });

  it('returns undefined for bogus pattern content.file_paths.0', () => {
    expect(validateSourceIdentity('content.file_paths.0')).toBeUndefined();
  });

  it('returns undefined for template patterns like {{variable}}', () => {
    expect(validateSourceIdentity('{{variable}}')).toBeUndefined();
  });

  it('returns undefined for strings with no separator and no extension', () => {
    expect(validateSourceIdentity('foobar')).toBeUndefined();
  });

  it('returns the path for simple filenames with extension', () => {
    expect(validateSourceIdentity('foo.ts')).toBe('foo.ts');
  });
});

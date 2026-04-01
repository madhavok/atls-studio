import { describe, it, expect } from 'vitest';
import { buildRetentionFingerprint } from './retentionFingerprint';

describe('buildRetentionFingerprint', () => {
  it('returns null for mutation and session-like prefixes', () => {
    expect(buildRetentionFingerprint('change.edit', {})).toBeNull();
    expect(buildRetentionFingerprint('session.plan', {})).toBeNull();
    expect(buildRetentionFingerprint('annotate.note', {})).toBeNull();
    expect(buildRetentionFingerprint('read.context', {})).toBeNull();
    expect(buildRetentionFingerprint('delegate.code', {})).toBeNull();
  });

  it('fingerprints search.code from sorted queries', () => {
    const a = buildRetentionFingerprint('search.code', { queries: ['z', 'a'] });
    const b = buildRetentionFingerprint('search.code', { queries: ['a', 'z'] });
    expect(a?.fingerprint).toBe(b?.fingerprint);
    expect(a?.fingerprint).toMatch(/^search\.code:a,z$/);
  });

  it('fingerprints search.symbol from symbol_names', () => {
    const r = buildRetentionFingerprint('search.symbol', { symbol_names: ['Foo', 'Bar'] });
    expect(r?.fingerprint).toBe('search.symbol:Bar,Foo');
  });

  it('returns stable search.similar fingerprint', () => {
    const r = buildRetentionFingerprint('search.similar', { type: 'code', query: 'fn' });
    expect(r?.fingerprint).toBe('search.similar:code:fn');
  });

  it('fingerprints analyze ops with file_paths', () => {
    const r = buildRetentionFingerprint('analyze.deps', { file_paths: ['/b', '/a'] });
    expect(r?.fingerprint).toBe('analyze:analyze.deps:/a,/b');
  });

  it('returns null for verify and system.exec', () => {
    expect(buildRetentionFingerprint('verify.test', {})).toBeNull();
    expect(buildRetentionFingerprint('system.exec', {})).toBeNull();
    expect(buildRetentionFingerprint('system.help', {})).toBeNull();
  });

  it('fingerprints system.workspaces', () => {
    const r = buildRetentionFingerprint('system.workspaces', {});
    expect(r?.fingerprint).toBe('system.workspaces');
  });
});

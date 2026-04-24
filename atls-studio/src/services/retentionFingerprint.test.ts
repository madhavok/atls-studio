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

  it('fingerprints search.symbol from name or query when symbol_names missing', () => {
    const byName = buildRetentionFingerprint('search.symbol', { name: 'N' });
    const byQuery = buildRetentionFingerprint('search.symbol', { query: 'Q' });
    expect(byName?.fingerprint).toBe('search.symbol:N');
    expect(byQuery?.fingerprint).toBe('search.symbol:Q');
  });

  it('fingerprints search.usage, search.issues, and search.patterns', () => {
    const u = buildRetentionFingerprint('search.usage', { symbol_names: ['A', 'B'] });
    expect(u?.fingerprint).toBe('search.usage:A,B');
    expect(buildRetentionFingerprint('search.issues', {})?.fingerprint).toBe('search.issues');
    expect(buildRetentionFingerprint('search.patterns', {})?.fingerprint).toBe('search.patterns');
  });

  it('returns stable search.similar fingerprint', () => {
    const r = buildRetentionFingerprint('search.similar', { type: 'code', query: 'fn' });
    expect(r?.fingerprint).toBe('search.similar:code:fn');
  });

  it('fingerprints analyze ops with file_paths', () => {
    const r = buildRetentionFingerprint('analyze.deps', { file_paths: ['/b', '/a'] });
    expect(r?.fingerprint).toBe('analyze:analyze.deps:/a,/b');
  });

  it('fingerprints analyze.extract_plan per file_path (singular f), not one key for all files', () => {
    const a = buildRetentionFingerprint('analyze.extract_plan', { file_path: 'src/a.ts' });
    const b = buildRetentionFingerprint('analyze.extract_plan', { file_path: 'src/b.ts' });
    expect(a?.fingerprint).toBe('analyze:analyze.extract_plan:src/a.ts');
    expect(b?.fingerprint).toBe('analyze:analyze.extract_plan:src/b.ts');
    expect(a?.fingerprint).not.toBe(b?.fingerprint);
    expect(a?.semanticSignature.targetFiles).toEqual(['src/a.ts']);
  });

  it('returns null for verify, system.exec, and system.git', () => {
    expect(buildRetentionFingerprint('verify.test', {})).toBeNull();
    expect(buildRetentionFingerprint('system.exec', {})).toBeNull();
    expect(buildRetentionFingerprint('system.git', {})).toBeNull();
    expect(buildRetentionFingerprint('system.help', {})).toBeNull();
  });

  it('fingerprints system.workspaces', () => {
    const r = buildRetentionFingerprint('system.workspaces', {});
    expect(r?.fingerprint).toBe('system.workspaces');
  });

  it('returns null for unknown op kinds outside analyze prefix', () => {
    expect(buildRetentionFingerprint('custom.unknown', {})).toBeNull();
  });

  it('fingerprints analyze.graph and analyze.calls with defaults', () => {
    const g = buildRetentionFingerprint('analyze.graph', { symbol_names: ['S1'] });
    expect(g?.fingerprint).toBe('analyze.graph:callees:3:S1');
    const c = buildRetentionFingerprint('analyze.calls', { symbol_names: [] });
    expect(c?.fingerprint).toBe('analyze.calls:2:');
  });
});

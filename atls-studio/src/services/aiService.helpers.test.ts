import { describe, expect, it } from 'vitest';
import { getProviderFromModel, mergeCompletionBlockers, formatEntryManifestSection } from './aiService';

describe('getProviderFromModel', () => {
  it('maps known model id prefixes', () => {
    expect(getProviderFromModel('gpt-4o')).toBe('openai');
    expect(getProviderFromModel('gemini-2.0')).toBe('google');
    expect(getProviderFromModel('claude-3-5')).toBe('anthropic');
    expect(getProviderFromModel('unknown-model')).toBe('anthropic');
  });
});

describe('mergeCompletionBlockers', () => {
  it('returns first non-null blocker', () => {
    expect(
      mergeCompletionBlockers([
        { toolName: 'a', blocker: null },
        { toolName: 'b', blocker: 'stop' },
        { toolName: 'c', blocker: 'ignored' },
      ]),
    ).toBe('stop');
  });

  it('returns null when all clear', () => {
    expect(mergeCompletionBlockers([{ toolName: 'a', blocker: undefined }])).toBeNull();
  });
});

describe('formatEntryManifestSection (golden)', () => {
  it('paths depth emits stable Entry Points block', () => {
    expect(
      formatEntryManifestSection(
        [{ path: 'src/a.ts', method: 'export', lines: 42, tokens: 0 }],
        'paths',
      ),
    ).toBe('\n\n## Entry Points\nsrc/a.ts (export, 42L)');
  });

  it('returns empty when depth off or no entries', () => {
    expect(formatEntryManifestSection(undefined, 'off')).toBe('');
    expect(formatEntryManifestSection([], 'paths')).toBe('');
  });

  it('sigs depth groups signatures under file path headers', () => {
    const entries = [
      { path: 'src/a.ts', method: 'export', lines: 42, tokens: 50, sig: '  10|export function foo(): void', importance: 1, tier: 'full' },
      { path: 'src/b.ts', method: 'graph', lines: 100, tokens: 80, sig: '   5|export class Bar {', importance: 1.5, tier: 'full' },
    ];
    const result = formatEntryManifestSection(entries, 'sigs');
    expect(result).toContain('src/a.ts | 42L\n');
    expect(result).toContain('src/b.ts | 100L | importance:1.5\n');
    expect(result).toContain('export function foo');
    expect(result).toContain('export class Bar');
    // importance:1 (default) is omitted from header
    expect(result).not.toContain('42L | importance');
  });

  it('paths_sigs depth includes file headers in sig blocks', () => {
    const result = formatEntryManifestSection(
      [{ path: 'src/a.ts', method: 'export', lines: 42, tokens: 50, sig: '  10|fn()', importance: 1, tier: 'full' }],
      'paths_sigs',
    );
    expect(result).toContain('src/a.ts | 42L');
    expect(result).toContain('fn()');
  });

  it('sigs with no sig content returns empty', () => {
    expect(
      formatEntryManifestSection(
        [{ path: 'src/a.ts', method: 'export', lines: 42, tokens: 0 }],
        'sigs',
      ),
    ).toBe('');
  });
});

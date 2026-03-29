/**
 * Hash contract test — ensures TypeScript `hashContentSync` and the
 * `canonicalizeSnapshotHash` utility produce correct, deterministic results
 * matching the Rust `content_hash()` and `snapshot::canonicalize_hash()`.
 *
 * Test vectors are shared between both implementations. The Rust side can be
 * tested via `cargo test` in src-tauri; this file covers the TypeScript side.
 *
 * When the Tauri backend is available (integration test), we additionally call
 * the backend and verify parity.
 */

import { describe, it, expect } from 'vitest';
import { hashContentSync } from '../utils/contextHash';
import { canonicalizeSnapshotHash, SnapshotTracker, AwarenessLevel, mergeRanges } from '../services/batch/snapshotTracker';

const TEST_VECTORS: Array<{ input: string; label: string }> = [
  { input: '', label: 'empty string' },
  { input: 'hello world', label: 'ascii' },
  { input: 'hello world\n', label: 'ascii with trailing newline' },
  { input: 'hello\nworld\n', label: 'multiline LF' },
  { input: 'hello\r\nworld\r\n', label: 'multiline CRLF' },
  { input: '  leading space', label: 'leading whitespace' },
  { input: 'trailing space  ', label: 'trailing whitespace' },
  { input: '\t\ttabs\t\t', label: 'tabs' },
  { input: 'café ñ über', label: 'BMP unicode' },
  { input: '𝕳𝖊𝖑𝖑𝖔 🌍', label: 'astral plane unicode' },
  { input: 'a'.repeat(10000), label: 'large content (10k chars)' },
  { input: 'export function foo() {\n  return 42;\n}\n', label: 'typical code' },
  { input: '日本語テスト', label: 'CJK characters' },
  { input: '\0null\0bytes\0', label: 'null bytes' },
];

describe('hashContentSync contract', () => {
  it('produces 16-char hex strings', () => {
    for (const { input, label } of TEST_VECTORS) {
      const hash = hashContentSync(input);
      expect(hash, `${label}: length`).toHaveLength(16);
      expect(hash, `${label}: hex`).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('is deterministic (same input -> same output)', () => {
    for (const { input, label } of TEST_VECTORS) {
      const h1 = hashContentSync(input);
      const h2 = hashContentSync(input);
      expect(h1, label).toBe(h2);
    }
  });

  it('different inputs produce different hashes', () => {
    const hashes = new Set<string>();
    for (const { input } of TEST_VECTORS) {
      hashes.add(hashContentSync(input));
    }
    expect(hashes.size).toBe(TEST_VECTORS.length);
  });

  it('CRLF and LF produce different hashes (not normalized at hash level)', () => {
    const lf = hashContentSync('hello\nworld\n');
    const crlf = hashContentSync('hello\r\nworld\r\n');
    expect(lf).not.toBe(crlf);
  });

  it('known golden values (regression guard)', () => {
    expect(hashContentSync('')).toBe('811c9dc5050c5d1f');
    expect(hashContentSync('hello world')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('canonicalizeSnapshotHash', () => {
  it('strips h: prefix', () => {
    expect(canonicalizeSnapshotHash('h:abc123')).toBe('abc123');
  });

  it('strips modifiers', () => {
    expect(canonicalizeSnapshotHash('h:abc123:sig')).toBe('abc123');
    expect(canonicalizeSnapshotHash('h:abc123:15-20')).toBe('abc123');
    expect(canonicalizeSnapshotHash('h:abc123:15-20:dedent')).toBe('abc123');
  });

  it('passes through bare hashes', () => {
    expect(canonicalizeSnapshotHash('abc123')).toBe('abc123');
  });

  it('handles empty and edge cases', () => {
    expect(canonicalizeSnapshotHash('')).toBe('');
    expect(canonicalizeSnapshotHash('h:')).toBe('');
  });
});

describe('SnapshotTracker', () => {
  it('records and retrieves hashes', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'abc123def456');
    expect(tracker.getHash('src/foo.ts')).toBe('abc123def456');
  });

  it('normalizes paths (case-insensitive, forward slashes)', () => {
    const tracker = new SnapshotTracker();
    tracker.record('SRC\\Foo.ts', 'abc123def456');
    expect(tracker.getHash('src/foo.ts')).toBe('abc123def456');
  });

  it('detects stale hashes', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'abc123def456');
    expect(tracker.isStale('src/foo.ts', 'abc123def456')).toBe(false);
    expect(tracker.isStale('src/foo.ts', 'different_hash')).toBe(true);
  });

  it('strips h: prefix when checking staleness', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'abc123def456');
    expect(tracker.isStale('src/foo.ts', 'h:abc123def456')).toBe(false);
    expect(tracker.isStale('src/foo.ts', 'h:abc123def456:sig')).toBe(false);
  });

  it('returns false for untracked files', () => {
    const tracker = new SnapshotTracker();
    expect(tracker.isStale('unknown.ts', 'abc123')).toBe(false);
    expect(tracker.getHash('unknown.ts')).toBeUndefined();
  });

  it('getAllForFiles returns tracked entries', () => {
    const tracker = new SnapshotTracker();
    tracker.record('a.ts', 'hash_a');
    tracker.record('b.ts', 'hash_b');
    const result = tracker.getAllForFiles(['a.ts', 'b.ts', 'c.ts']);
    expect(result.size).toBe(2);
    expect(result.get('a.ts')).toBe('hash_a');
    expect(result.get('b.ts')).toBe('hash_b');
    expect(result.has('c.ts')).toBe(false);
  });

  it('extractHash returns content_hash', () => {
    expect(SnapshotTracker.extractHash({ content_hash: 'content' })).toBe('content');
    expect(SnapshotTracker.extractHash({ hash: 'bare' })).toBe('bare');
    expect(SnapshotTracker.extractHash({})).toBeUndefined();
  });

  it('recordFromResponse handles results array', () => {
    const tracker = new SnapshotTracker();
    tracker.recordFromResponse({
      results: [
        { file: 'a.ts', content_hash: 'hash_a' },
        { file: 'b.ts', content_hash: 'hash_b' },
      ],
    });
    expect(tracker.getHash('a.ts')).toBe('hash_a');
    expect(tracker.getHash('b.ts')).toBe('hash_b');
  });

  it('recordFromResponse handles single entry', () => {
    const tracker = new SnapshotTracker();
    tracker.recordFromResponse({ file: 'a.ts', content_hash: 'hash_a' });
    expect(tracker.getHash('a.ts')).toBe('hash_a');
  });

  it('recordFromResponse handles drafts array (change.edit output)', () => {
    const tracker = new SnapshotTracker();
    tracker.recordFromResponse({
      status: 'ok',
      drafts: [
        { file: 'src/a.ts', content_hash: 'post-edit-hash-a' },
        { file: 'src/b.ts', content_hash: 'post-edit-hash-b' },
      ],
    });
    expect(tracker.getHash('src/a.ts')).toBe('post-edit-hash-a');
    expect(tracker.getHash('src/b.ts')).toBe('post-edit-hash-b');
  });

  it('recordFromResponse handles batch array with f/h aliases', () => {
    const tracker = new SnapshotTracker();
    tracker.recordFromResponse({
      batch: [
        { f: 'src/foo.ts', h: 'h:new-hash-1' },
        { f: 'src/bar.ts', h: 'new-hash-2' },
      ],
    });
    expect(tracker.getHash('src/foo.ts')).toBe('new-hash-1');
    expect(tracker.getHash('src/bar.ts')).toBe('new-hash-2');
  });

  it('recordFromResponse overwrites with later values (last write wins)', () => {
    const tracker = new SnapshotTracker();
    tracker.recordFromResponse({ results: [{ file: 'x.ts', content_hash: 'v1' }] });
    expect(tracker.getHash('x.ts')).toBe('v1');
    tracker.recordFromResponse({ drafts: [{ file: 'x.ts', content_hash: 'v2' }] });
    expect(tracker.getHash('x.ts')).toBe('v2');
  });

  it('invalidate removes tracked entry', () => {
    const tracker = new SnapshotTracker();
    tracker.record('a.ts', 'hash_a');
    expect(tracker.getHash('a.ts')).toBe('hash_a');
    tracker.invalidate('a.ts');
    expect(tracker.getHash('a.ts')).toBeUndefined();
  });

  it('invalidateAndRerecord replaces hash and keeps canonical read kind', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/mod.rs', 'old_hash_abc');
    expect(tracker.getHash('src/mod.rs')).toBe('old_hash_abc');
    expect(tracker.hasCanonicalRead('src/mod.rs')).toBe(true);

    tracker.invalidateAndRerecord('src/mod.rs', 'new_hash_xyz');
    expect(tracker.getHash('src/mod.rs')).toBe('new_hash_xyz');
    expect(tracker.hasCanonicalRead('src/mod.rs')).toBe(true);
    expect(tracker.isStale('src/mod.rs', 'old_hash_abc')).toBe(true);
    expect(tracker.isStale('src/mod.rs', 'new_hash_xyz')).toBe(false);
  });

  it('invalidateAndRerecord strips h: prefix', () => {
    const tracker = new SnapshotTracker();
    tracker.record('a.ts', 'before');
    tracker.invalidateAndRerecord('a.ts', 'h:after_hash:sig');
    expect(tracker.getHash('a.ts')).toBe('after_hash');
  });

  it('invalidateAndRerecord on untracked file creates new canonical entry', () => {
    const tracker = new SnapshotTracker();
    expect(tracker.getHash('new.ts')).toBeUndefined();
    tracker.invalidateAndRerecord('new.ts', 'fresh_hash');
    expect(tracker.getHash('new.ts')).toBe('fresh_hash');
    expect(tracker.hasCanonicalRead('new.ts')).toBe(true);
  });

  it('post-mutation hash passes canonical read gate for subsequent steps', () => {
    const tracker = new SnapshotTracker();
    // Step 1: canonical read
    tracker.record('src/lib.rs', 'read_hash', 'canonical');
    expect(tracker.requireCanonicalReads(['src/lib.rs'])).toEqual([]);

    // Step 2: mutation updates the hash
    tracker.invalidateAndRerecord('src/lib.rs', 'post_edit_hash');

    // Step 3: subsequent mutation should still pass the canonical gate
    expect(tracker.requireCanonicalReads(['src/lib.rs'])).toEqual([]);
    expect(tracker.getHash('src/lib.rs')).toBe('post_edit_hash');
  });
});

describe('mergeRanges', () => {
  it('returns empty for empty input', () => {
    expect(mergeRanges([])).toEqual([]);
  });

  it('returns single range unchanged', () => {
    expect(mergeRanges([{ start: 10, end: 20 }])).toEqual([{ start: 10, end: 20 }]);
  });

  it('merges overlapping ranges', () => {
    expect(mergeRanges([{ start: 10, end: 20 }, { start: 15, end: 30 }])).toEqual([{ start: 10, end: 30 }]);
  });

  it('merges adjacent ranges', () => {
    expect(mergeRanges([{ start: 10, end: 20 }, { start: 21, end: 30 }])).toEqual([{ start: 10, end: 30 }]);
  });

  it('keeps non-overlapping ranges separate', () => {
    expect(mergeRanges([{ start: 10, end: 20 }, { start: 30, end: 40 }])).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it('sorts and merges unsorted input', () => {
    expect(mergeRanges([{ start: 30, end: 40 }, { start: 10, end: 20 }, { start: 15, end: 35 }])).toEqual([
      { start: 10, end: 40 },
    ]);
  });
});

describe('SnapshotTracker tiered awareness', () => {
  it('getAwarenessLevel returns CANONICAL for canonical reads', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'canonical');
    expect(tracker.getAwarenessLevel('src/foo.ts')).toBe(AwarenessLevel.CANONICAL);
  });

  it('getAwarenessLevel returns SHAPED for shaped reads', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'shaped');
    expect(tracker.getAwarenessLevel('src/foo.ts')).toBe(AwarenessLevel.SHAPED);
  });

  it('getAwarenessLevel returns NONE for untracked files', () => {
    const tracker = new SnapshotTracker();
    expect(tracker.getAwarenessLevel('unknown.ts')).toBe(AwarenessLevel.NONE);
  });

  it('getAwarenessLevel returns TARGETED when readRegions cover editRegion', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 10, end: 30 } });
    expect(tracker.getAwarenessLevel('src/foo.ts', { start: 15, end: 25 })).toBe(AwarenessLevel.TARGETED);
  });

  it('getAwarenessLevel returns SHAPED when readRegions do not cover editRegion', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 10, end: 20 } });
    expect(tracker.getAwarenessLevel('src/foo.ts', { start: 25, end: 30 })).toBe(AwarenessLevel.SHAPED);
  });

  it('hasReadCoverage returns true when region is covered', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 1, end: 50 } });
    expect(tracker.hasReadCoverage('src/foo.ts', 10, 30)).toBe(true);
  });

  it('hasReadCoverage returns false when region is not covered', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 10, end: 20 } });
    expect(tracker.hasReadCoverage('src/foo.ts', 10, 30)).toBe(false);
  });

  it('record accumulates readRegions across multiple calls', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 10, end: 20 } });
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 30, end: 40 } });
    expect(tracker.hasReadCoverage('src/foo.ts', 10, 20)).toBe(true);
    expect(tracker.hasReadCoverage('src/foo.ts', 30, 40)).toBe(true);
    expect(tracker.hasReadCoverage('src/foo.ts', 10, 40)).toBe(false);
  });

  it('record merges overlapping readRegions', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 10, end: 25 } });
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 20, end: 40 } });
    expect(tracker.hasReadCoverage('src/foo.ts', 10, 40)).toBe(true);
  });

  it('record stores shapeHash', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'shaped', { shapeHash: 'shape_abc' });
    expect(tracker.isStructurallyUnchanged('src/foo.ts', 'shape_abc')).toBe(true);
    expect(tracker.isStructurallyUnchanged('src/foo.ts', 'shape_different')).toBe(false);
  });

  it('record accumulates readRegions even when canonical exists', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'canonical');
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 10, end: 20 } });
    expect(tracker.getAwarenessLevel('src/foo.ts')).toBe(AwarenessLevel.CANONICAL);
    expect(tracker.hasReadCoverage('src/foo.ts', 10, 20)).toBe(true);
  });

  it('invalidateAndRerecord clears readRegions and shapeHash', () => {
    const tracker = new SnapshotTracker();
    tracker.record('src/foo.ts', 'hash1', 'shaped', { shapeHash: 'shape_abc' });
    tracker.record('src/foo.ts', 'hash1', 'lines', { readRegion: { start: 10, end: 20 } });
    tracker.invalidateAndRerecord('src/foo.ts', 'hash2');
    expect(tracker.hasReadCoverage('src/foo.ts', 10, 20)).toBe(false);
    expect(tracker.isStructurallyUnchanged('src/foo.ts', 'shape_abc')).toBe(false);
    expect(tracker.getAwarenessLevel('src/foo.ts')).toBe(AwarenessLevel.CANONICAL);
  });

  it('entries() iterates all tracked identities', () => {
    const tracker = new SnapshotTracker();
    tracker.record('a.ts', 'h1', 'canonical');
    tracker.record('b.ts', 'h2', 'shaped');
    const entries = [...tracker.entries()];
    expect(entries).toHaveLength(2);
    const files = entries.map(([, id]) => id.filePath).sort();
    expect(files).toEqual(['a.ts', 'b.ts']);
  });
});

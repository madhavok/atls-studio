/**
 * Contract / golden payload tests for the collapsed batch-only tool surface.
 * Validates that resolveHashRefsWithMeta and resolveHashRefsInParams produce
 * payloads that match the backend's expected shape (without invoking Tauri).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveHashRefsWithMeta,
  resolveHashRefsInParams,
  type HashLookup,
  type SetRefLookup,
} from '../utils/hashResolver';
import { getHandler } from '../services/batch/opMap';

const mockHashLookup: HashLookup = async (hash) => {
  const store: Record<string, { content: string; source?: string }> = {
    aabb1122: { content: 'fn foo() {}', source: 'src/foo.ts' },
    ccdd3344: { content: 'fn bar() {}', source: 'src/bar.ts' },
    eeff5566: { content: 'fn baz() {}', source: 'src/baz.ts' },
  };
  const h = hash.startsWith('h:') ? hash.slice(2) : hash;
  const key = Object.keys(store).find((k) => h.startsWith(k) || k.startsWith(h.slice(0, 8)));
  return key ? store[key] : null;
};

const mockSetLookup: SetRefLookup = (selector) => {
  if (selector.kind === 'edited') {
    return {
      hashes: ['aabb1122', 'ccdd3344'],
      entries: [
        { content: 'fn foo() {}', source: 'src/foo.ts' },
        { content: 'fn bar() {}', source: 'src/bar.ts' },
      ],
    };
  }
  if (selector.kind === 'pinned') {
    return {
      hashes: ['ccdd3344', 'eeff5566'],
      entries: [
        { content: 'fn bar() {}', source: 'src/bar.ts' },
        { content: 'fn baz() {}', source: 'src/baz.ts' },
      ],
    };
  }
  return { hashes: [], entries: [] };
};

describe('Contract: resolveHashRefsWithMeta golden payloads', () => {
  it('read op: file_paths with h:refs resolves to paths', async () => {
    const input = {
      file_paths: ['h:aabb1122:source', 'h:ccdd3344:source'],
    };
    const { params } = await resolveHashRefsWithMeta(input, mockHashLookup);
    const fp = (params as Record<string, string[]>).file_paths;
    expect(fp).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('context op: type + file_paths shape', async () => {
    const input = {
      type: 'sig',
      file_paths: ['h:aabb1122:source'],
    };
    const { params } = await resolveHashRefsWithMeta(input, mockHashLookup);
    expect(params).toMatchObject({
      type: 'sig',
      file_paths: ['src/foo.ts'],
    });
  });

  it('read op: single hash resolves to content', async () => {
    const input = { content: 'h:aabb1122:content' };
    const { params } = await resolveHashRefsWithMeta(input, mockHashLookup);
    expect((params as Record<string, string>).content).toBe('fn foo() {}');
  });
});

describe('Contract: batch-style h:@edited expansion', () => {
  it('file_paths h:@edited expands via SetRefLookup', async () => {
    const input = { file_paths: ['h:@edited'] };
    const resolved = await resolveHashRefsInParams(
      input,
      mockHashLookup,
      undefined,
      mockSetLookup
    );
    const fp = (resolved as Record<string, string[]>).file_paths;
    expect(Array.isArray(fp)).toBe(true);
    expect(fp).toContain('src/foo.ts');
    expect(fp).toContain('src/bar.ts');
    expect(fp).toHaveLength(2);
  });

  it('file_paths mixed h:ref and set selector', async () => {
    const input = {
      file_paths: ['h:@edited', 'h:eeff5566:source'],
    };
    const resolved = await resolveHashRefsInParams(
      input,
      mockHashLookup,
      undefined,
      mockSetLookup
    );
    const fp = (resolved as Record<string, string[]>).file_paths;
    expect(fp).toContain('src/foo.ts');
    expect(fp).toContain('src/bar.ts');
    expect(fp).toContain('src/baz.ts');
    expect(fp.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Contract: atlsBatchQuery payload shape', () => {
  it('context operation expects type + file_paths (string[])', async () => {
    const input = {
      type: 'sig',
      file_paths: ['h:aabb1122:source'],
    };
    const resolved = await resolveHashRefsInParams(input, mockHashLookup);
    expect(resolved).toMatchObject({
      type: 'sig',
      file_paths: expect.any(Array),
    });
    expect((resolved as Record<string, unknown>).file_paths).toEqual(['src/foo.ts']);
  });

  it('read_lines operation expects hash or file_path + lines', async () => {
    const input = {
      hash: 'h:aabb1122',
      lines: '1-10',
      context_lines: 3,
    };
    const resolved = await resolveHashRefsInParams(input, mockHashLookup);
    expect(resolved).toHaveProperty('hash');
    expect(resolved).toHaveProperty('lines', '1-10');
    expect(resolved).toHaveProperty('context_lines', 3);
  });

  it('deletes with h:refs resolves to paths', async () => {
    const input = { deletes: ['h:aabb1122', 'h:ccdd3344'] };
    const resolved = await resolveHashRefsInParams(input, mockHashLookup);
    const d = (resolved as Record<string, string[]>).deletes;
    expect(d).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('hashes with h:refs pass-through for session.pin', async () => {
    const input = { hashes: ['h:aabb1122', 'h:ccdd3344'] };
    const resolved = await resolveHashRefsInParams(input, mockHashLookup);
    const h = (resolved as Record<string, string[]>).hashes;
    expect(h).toEqual(['aabb1122', 'ccdd3344']);
  });
});

describe('Contract: collapsed batch registry coverage', () => {
  it('registers newly unified operations', () => {
    expect(getHandler('analyze.extract_plan')).toBeTypeOf('function');
    expect(getHandler('change.split_match')).toBeTypeOf('function');
    expect(getHandler('delegate.retrieve')).toBeTypeOf('function');
    expect(getHandler('delegate.design')).toBeTypeOf('function');
    expect(getHandler('system.exec')).toBeTypeOf('function');
    expect(getHandler('system.git')).toBeTypeOf('function');
    expect(getHandler('system.help')).toBeTypeOf('function');
    expect(getHandler('system.workspaces')).toBeTypeOf('function');
  });
});

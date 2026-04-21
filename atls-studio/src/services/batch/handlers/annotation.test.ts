import { describe, it, expect, vi } from 'vitest';
import { handleRule, handleAnnotate } from './annotation';

function makeCtx(store: ReturnType<typeof vi.fn>) {
  return { store: () => store } as never;
}

describe('annotation handlers', () => {
  it('rule list returns empty message when no rules', async () => {
    const store = {
      listRules: vi.fn().mockReturnValue([]),
      removeRule: vi.fn(),
      setRule: vi.fn(),
    };
    const out = await handleRule({ action: 'list' }, makeCtx(store));
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/no cognitive rules set/);
  });

  it('rule set accepts hash as alias for key', async () => {
    const setRule = vi.fn().mockReturnValue({ tokens: 5, warning: undefined });
    const store = {
      listRules: vi.fn(),
      removeRule: vi.fn(),
      setRule,
    };
    const out = await handleRule({ hash: 'h:42a831', content: 'note text' }, makeCtx(store));
    expect(out.ok).toBe(true);
    expect(setRule).toHaveBeenCalledWith('h:42a831', 'note text');
  });

  it('rule delete returns not found when missing key', async () => {
    const store = {
      listRules: vi.fn(),
      removeRule: vi.fn().mockReturnValue(false),
      setRule: vi.fn(),
    };
    const out = await handleRule({ action: 'delete', key: 'missing' }, makeCtx(store));
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/not found/);
  });

  it('rule list works without key param', async () => {
    const store = {
      listRules: vi.fn().mockReturnValue([{ key: 'a', content: 'x', tokens: 1 }]),
      removeRule: vi.fn(),
      setRule: vi.fn(),
    };
    const out = await handleRule({ action: 'list' }, makeCtx(store));
    expect(out.ok).toBe(true);
    expect(out.summary).toContain('a: x');
  });

  it('annotate requires hash param', async () => {
    const store = { addAnnotation: vi.fn() };
    const out = await handleAnnotate({} as never, makeCtx(store as never));
    expect(out.ok).toBe(false);
    expect(out.summary).toMatch(/annotate: missing hash/);
  });

  it('annotate requires either note or fields', async () => {
    const store = { addAnnotation: vi.fn(), editEngram: vi.fn() };
    const out = await handleAnnotate({ hash: 'h:abc123' } as never, makeCtx(store as never));
    expect(out.ok).toBe(false);
    expect(out.summary).toMatch(/note.*and\/or.*fields/);
  });

  it('annotate with note only calls addAnnotation', async () => {
    const addAnnotation = vi.fn().mockReturnValue({ ok: true, id: 'ann_x' });
    const store = {
      addAnnotation,
      editEngram: vi.fn(),
      chunks: new Map(),
      archivedChunks: new Map(),
      fileViews: undefined,
    };
    const out = await handleAnnotate({ hash: 'h:abc123', note: 'hello' } as never, makeCtx(store as never));
    expect(out.ok).toBe(true);
    expect(addAnnotation).toHaveBeenCalledWith('h:abc123', 'hello');
    expect(store.editEngram).not.toHaveBeenCalled();
  });

  it('annotate with fields only calls editEngram', async () => {
    const editEngram = vi.fn().mockReturnValue({ ok: true, newHash: 'abc123def', metadataOnly: true });
    const store = {
      addAnnotation: vi.fn(),
      editEngram,
      chunks: new Map(),
      archivedChunks: new Map(),
      fileViews: undefined,
    };
    const out = await handleAnnotate(
      { hash: 'h:abc123', fields: { type: 'note' } } as never,
      makeCtx(store as never),
    );
    expect(out.ok).toBe(true);
    expect(editEngram).toHaveBeenCalledWith('h:abc123', { type: 'note' });
    expect(store.addAnnotation).not.toHaveBeenCalled();
  });

  it('annotate with both note and fields runs both', async () => {
    const addAnnotation = vi.fn().mockReturnValue({ ok: true, id: 'ann_y' });
    const editEngram = vi.fn().mockReturnValue({ ok: true, newHash: 'abc', metadataOnly: true });
    const store = {
      addAnnotation,
      editEngram,
      chunks: new Map(),
      archivedChunks: new Map(),
      fileViews: undefined,
    };
    const out = await handleAnnotate(
      { hash: 'h:abc123', note: 'hi', fields: { summary: 's' } } as never,
      makeCtx(store as never),
    );
    expect(out.ok).toBe(true);
    expect(addAnnotation).toHaveBeenCalled();
    expect(editEngram).toHaveBeenCalled();
  });
});

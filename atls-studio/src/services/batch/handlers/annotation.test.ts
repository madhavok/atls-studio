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
    expect(out.summary).toMatch(/annotate: ERROR missing hash/);
  });
});

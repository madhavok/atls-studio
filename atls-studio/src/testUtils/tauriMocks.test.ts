import { describe, expect, it } from 'vitest';
import {
  createTauriCoreInvokeMock,
  createTauriEventListenMock,
  createTauriEventListenRef,
} from './tauriMocks';

describe('tauriMocks', () => {
  it('createTauriEventListenRef starts with null callback', () => {
    const ref = createTauriEventListenRef();
    expect(ref.menuCb).toBeNull();
  });

  it('createTauriEventListenMock registers callback', async () => {
    const { ref, listen } = createTauriEventListenMock();
    const unlisten = await listen('foo', (e) => e);
    expect(unlisten).toBeTypeOf('function');
    expect(ref.menuCb).toBeTypeOf('function');
  });

  it('createTauriCoreInvokeMock returns map values and undefined default', async () => {
    const inv = createTauriCoreInvokeMock({ x: 1 });
    await expect(inv('x')).resolves.toBe(1);
    await expect(inv('missing')).resolves.toBeUndefined();
  });
});

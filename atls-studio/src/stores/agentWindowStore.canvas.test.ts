/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentWindowStore } from './agentWindowStore';

function store() {
  return useAgentWindowStore.getState();
}

describe('agentWindowStore canvas geometry', () => {
  beforeEach(() => {
    localStorage.clear();
    store().reset();
    store().hydrateProject('/tmp/proj');
    store().setActiveParentSession('parent-1');
    store().ensurePrimaryWindow('parent-1', 'Primary');
  });

  it('assigns canvas geometry defaults to windows', () => {
    const primary = store().windowsByParent['parent-1'][0];
    expect(primary.rect).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
    expect(primary.zIndex).toBeGreaterThanOrEqual(1);
    expect(primary.minimized).toBe(false);
    expect(primary.pinned).toBe(false);
  });

  it('moves a window and persists the rect to per-project storage', () => {
    const id = 'primary-parent-1';
    store().moveWindow(id, 321, 654);
    const moved = store().windowsByParent['parent-1'].find((w) => w.windowId === id)!;
    expect(moved.rect.x).toBe(321);
    expect(moved.rect.y).toBe(654);

    const raw = localStorage.getItem('atls-agent-windows-v2:' + encodeURIComponent('/tmp/proj'));
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    const persisted = parsed.windowsByParent['parent-1'].find((w: { windowId: string }) => w.windowId === id);
    expect(persisted.rect.x).toBe(321);
  });

  it('clamps resize to minimum dimensions', () => {
    const id = 'primary-parent-1';
    store().resizeWindow(id, 10, 10);
    const win = store().windowsByParent['parent-1'].find((w) => w.windowId === id)!;
    expect(win.rect.w).toBeGreaterThanOrEqual(280);
    expect(win.rect.h).toBeGreaterThanOrEqual(200);
  });

  it('raises z-index when bringing a window to front', () => {
    const childId = store().spawnStandardWindow('parent-1', 'child-1', 'Child');
    const before = store().windowsByParent['parent-1'].find((w) => w.windowId === 'primary-parent-1')!.zIndex;
    store().bringToFront('primary-parent-1');
    const after = store().windowsByParent['parent-1'].find((w) => w.windowId === 'primary-parent-1')!.zIndex;
    const childZ = store().windowsByParent['parent-1'].find((w) => w.windowId === childId)!.zIndex;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(childZ);
  });

  it('clamps zoom and persists pan', () => {
    store().setZoom(5);
    expect(store().viewport.zoom).toBeLessThanOrEqual(2);
    store().setZoom(0.01);
    expect(store().viewport.zoom).toBeGreaterThanOrEqual(0.4);
    store().setPan({ x: 120, y: -40 });
    expect(store().viewport.pan).toEqual({ x: 120, y: -40 });
  });
});

describe('agentWindowStore auto-arrange', () => {
  beforeEach(() => {
    localStorage.clear();
    store().reset();
    store().hydrateProject('/tmp/proj');
    store().setActiveParentSession('parent-1');
    store().ensurePrimaryWindow('parent-1', 'Primary');
    store().spawnStandardWindow('parent-1', 'child-1', 'Child A');
    store().spawnStandardWindow('parent-1', 'child-2', 'Child B');
  });

  it('repositions unpinned windows onto a margin-aligned grid', () => {
    store().moveWindow('primary-parent-1', 999, 999);
    store().autoArrange('grid');
    const primary = store().windowsByParent['parent-1'].find((w) => w.windowId === 'primary-parent-1')!;
    expect(primary.rect.x).not.toBe(999);
    expect(store().viewport.arrangeStrategy).toBe('grid');
  });

  it('leaves pinned windows in place during auto-arrange', () => {
    store().moveWindow('primary-parent-1', 777, 333);
    store().togglePinned('primary-parent-1');
    store().autoArrange('grid');
    const primary = store().windowsByParent['parent-1'].find((w) => w.windowId === 'primary-parent-1')!;
    expect(primary.rect.x).toBe(777);
    expect(primary.rect.y).toBe(333);
  });

  it('excludes minimized windows from auto-arrange', () => {
    const child = store().windowsByParent['parent-1'].find((w) => w.title === 'Child A')!;
    store().moveWindow(child.windowId, 555, 222);
    store().toggleMinimized(child.windowId);
    store().autoArrange('cascade');
    const after = store().windowsByParent['parent-1'].find((w) => w.windowId === child.windowId)!;
    expect(after.rect.x).toBe(555);
    expect(after.rect.y).toBe(222);
  });

  it('clusters windows by project when tidying', () => {
    const child = store().windowsByParent['parent-1'].find((w) => w.title === 'Child B')!;
    store().setWindowProjectPath(child.windowId, '/tmp/other-repo');
    store().autoArrange('tidy');
    const tidied = store().windowsByParent['parent-1'].find((w) => w.windowId === child.windowId)!;
    // The other-project window lands in a separate column band (non-zero x).
    expect(tidied.rect.x).toBeGreaterThan(0);
    expect(store().viewport.arrangeStrategy).toBe('tidy');
  });
});

describe('agentWindowStore panel windows', () => {
  beforeEach(() => {
    localStorage.clear();
    store().reset();
    store().hydrateProject('/tmp/proj');
    store().setActiveParentSession('parent-1');
    store().ensurePrimaryWindow('parent-1', 'Primary');
  });

  it('adds a cockpit panel window once per kind', () => {
    const id1 = store().ensurePanelWindow('parent-1', 'mission', 'Mission Control');
    const id2 = store().ensurePanelWindow('parent-1', 'mission', 'Mission Control');
    expect(id1).toBe(id2);
    const panels = store().windowsByParent['parent-1'].filter((w) => w.kind === 'panel');
    expect(panels).toHaveLength(1);
    expect(panels[0].panelKind).toBe('mission');
  });
});

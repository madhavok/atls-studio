/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { useOrchestrationUiStore } from './orchestrationUiStore';

describe('orchestrationUiStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useOrchestrationUiStore.getState().resetLayout();
  });

  it('tracks selected tasks without mixing runtime task state', () => {
    useOrchestrationUiStore.getState().selectTask('task-1');
    expect(useOrchestrationUiStore.getState().selectedTaskId).toBe('task-1');

    useOrchestrationUiStore.getState().selectTask(null);
    expect(useOrchestrationUiStore.getState().selectedTaskId).toBeNull();
  });

  it('persists layout preferences to localStorage', () => {
    useOrchestrationUiStore.getState().setDensity('comfortable');
    useOrchestrationUiStore.getState().setFocusMode(true);
    useOrchestrationUiStore.getState().toggleMinimized('telemetry');

    const stored = JSON.parse(localStorage.getItem('atls-orchestration-cockpit-ui-v1') || '{}');
    expect(stored.density).toBe('comfortable');
    expect(stored.focusMode).toBe(true);
    expect(stored.windows.some((w: { id: string; minimized: boolean }) => w.id === 'telemetry' && w.minimized)).toBe(true);
  });
});

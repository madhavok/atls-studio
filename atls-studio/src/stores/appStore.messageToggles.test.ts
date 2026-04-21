/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MESSAGE_TOGGLES, mergeMessageToggles, useAppStore } from './appStore';

describe('mergeMessageToggles', () => {
  it('returns a full defaults payload when raw is undefined', () => {
    const merged = mergeMessageToggles(DEFAULT_MESSAGE_TOGGLES, undefined);
    expect(merged).toEqual(DEFAULT_MESSAGE_TOGGLES);
    // Must be a fresh object — mutating it should not affect the defaults
    expect(merged).not.toBe(DEFAULT_MESSAGE_TOGGLES);
  });

  it('preserves sibling defaults when only a nested key is overridden', () => {
    const merged = mergeMessageToggles(DEFAULT_MESSAGE_TOGGLES, {
      spin: { modes: { goal_drift: false } },
    });
    expect(merged.spin.modes.goal_drift).toBe(false);
    // All other mode defaults intact
    expect(merged.spin.modes.context_loss).toBe(true);
    expect(merged.spin.modes.tool_confusion).toBe(true);
    // Other groups untouched
    expect(merged.assess).toBe(true);
    expect(merged.edits.damaged).toBe(true);
  });

  it('migrates legacy spinCircuitBreakerHaltEnabled when new halt key missing', () => {
    const merged = mergeMessageToggles(DEFAULT_MESSAGE_TOGGLES, {}, true);
    expect(merged.spin.tiers.halt).toBe(true);
  });

  it('prefers the new-path halt value over legacy when both set', () => {
    const merged = mergeMessageToggles(
      DEFAULT_MESSAGE_TOGGLES,
      { spin: { tiers: { halt: false } } },
      true, // legacy says true — should be ignored
    );
    expect(merged.spin.tiers.halt).toBe(false);
  });

  it('rejects non-boolean persisted values and falls back to defaults', () => {
    const merged = mergeMessageToggles(DEFAULT_MESSAGE_TOGGLES, {
      assess: 'yes' as unknown,
      spin: { modes: { context_loss: 1 as unknown } },
    });
    expect(merged.assess).toBe(true);
    expect(merged.spin.modes.context_loss).toBe(true);
  });

  it('ignores an array payload where object is expected', () => {
    const merged = mergeMessageToggles(DEFAULT_MESSAGE_TOGGLES, [1, 2, 3]);
    expect(merged).toEqual(DEFAULT_MESSAGE_TOGGLES);
  });
});

describe('useAppStore.updateMessageToggles', () => {
  let initial: ReturnType<typeof useAppStore.getState>['settings'];
  beforeEach(() => {
    initial = useAppStore.getState().settings;
    // Reset to defaults for each test so side effects don't leak
    useAppStore.setState({
      settings: { ...initial, messageToggles: { ...DEFAULT_MESSAGE_TOGGLES } },
    });
  });
  afterEach(() => {
    useAppStore.setState({ settings: initial });
    if (typeof localStorage !== 'undefined') localStorage.removeItem('atls-studio-settings');
  });

  it('deep-merges a spin.modes patch without dropping siblings', () => {
    useAppStore.getState().updateMessageToggles({ spin: { modes: { tool_confusion: false } } });
    const mt = useAppStore.getState().settings.messageToggles;
    expect(mt.spin.modes.tool_confusion).toBe(false);
    expect(mt.spin.modes.context_loss).toBe(true);
    expect(mt.spin.enabled).toBe(true);
    expect(mt.assess).toBe(true);
  });

  it('mirrors the halt toggle into the deprecated legacy field for migration window', () => {
    useAppStore.getState().updateMessageToggles({ spin: { tiers: { halt: true } } });
    const s = useAppStore.getState().settings;
    expect(s.messageToggles.spin.tiers.halt).toBe(true);
    expect(s.spinCircuitBreakerHaltEnabled).toBe(true);
  });

  it('persists to localStorage under atls-studio-settings', () => {
    if (typeof localStorage === 'undefined') return;
    useAppStore.getState().updateMessageToggles({ batchReadSpinWarn: false });
    const raw = localStorage.getItem('atls-studio-settings');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.messageToggles.batchReadSpinWarn).toBe(false);
  });
});

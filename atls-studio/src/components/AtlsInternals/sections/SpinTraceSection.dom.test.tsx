/** @vitest-environment happy-dom */
import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpinTraceSection } from './SpinTraceSection';
import { DEFAULT_MESSAGE_TOGGLES, useAppStore } from '../../../stores/appStore';
import { useRoundHistoryStore } from '../../../stores/roundHistoryStore';

describe('SpinTraceSection — Interventions panel', () => {
  let initialSettings: ReturnType<typeof useAppStore.getState>['settings'];

  beforeEach(() => {
    initialSettings = useAppStore.getState().settings;
    useAppStore.setState({
      settings: { ...initialSettings, messageToggles: { ...DEFAULT_MESSAGE_TOGGLES } },
    });
    // Seed a minimal snapshot so the main diagnostics branch renders. The
    // Interventions panel itself is verified for both empty and non-empty
    // snapshot states; see the dedicated "always visible" test below.
    useRoundHistoryStore.setState({
      snapshots: [
        {
          round: 1,
          timestamp: 0,
          turnId: 1,
          wmTokens: 0,
          bbTokens: 0,
          stagedTokens: 0,
          archivedTokens: 0,
          overheadTokens: 0,
          freeTokens: 0,
          maxTokens: 200_000,
          staticSystemTokens: 0,
          conversationHistoryTokens: 0,
          stagedBucketTokens: 0,
          workspaceContextTokens: 0,
          providerInputTokens: 0,
          estimatedTotalPromptTokens: 0,
          cacheStablePrefixTokens: 0,
          cacheChurnTokens: 0,
          reliefAction: 'none',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costCents: 0,
          compressionSavings: 0,
          rollingSavings: 0,
          rolledRounds: 0,
          rollingSummaryTokens: 0,
          freedTokens: 0,
          cumulativeSaved: 0,
          toolCalls: 0,
          manageOps: 0,
          hypotheticalNonBatchedCost: 0,
          actualCost: 0,
        },
      ] as unknown as ReturnType<typeof useRoundHistoryStore.getState>['snapshots'],
    });
  });

  afterEach(() => {
    useAppStore.setState({ settings: initialSettings });
    useRoundHistoryStore.setState({ snapshots: [] });
    if (typeof localStorage !== 'undefined') localStorage.removeItem('atls-studio-settings');
  });

  it('renders the Interventions header (collapsed by default)', () => {
    render(<SpinTraceSection />);
    expect(screen.getByText('Interventions')).toBeTruthy();
    // Collapsed by default: master toggle label should not be present yet.
    expect(screen.queryByText('Spin steering (master)')).toBeNull();
  });

  it('expands when clicked and shows grouped toggles', () => {
    render(<SpinTraceSection />);
    fireEvent.click(screen.getByText('Interventions'));
    expect(screen.getByText('Spin steering (master)')).toBeTruthy();
    expect(screen.getByText('ASSESS')).toBeTruthy();
    expect(screen.getByText('Completion Blocker')).toBeTruthy();
    expect(screen.getByText('Edit Banners')).toBeTruthy();
    expect(screen.getByText('Batch Summary')).toBeTruthy();
  });

  it('clicking a mode toggle flips the persisted setting', () => {
    render(<SpinTraceSection />);
    fireEvent.click(screen.getByText('Interventions'));
    const before = useAppStore.getState().settings.messageToggles.spin.modes.goal_drift;
    expect(before).toBe(true);

    const btn = screen.getByRole('button', { name: 'Goal Drift' });
    fireEvent.click(btn);

    const after = useAppStore.getState().settings.messageToggles.spin.modes.goal_drift;
    expect(after).toBe(false);
  });

  it('disables per-mode toggles when master is off', () => {
    useAppStore.getState().updateMessageToggles({ spin: { enabled: false } });
    render(<SpinTraceSection />);
    fireEvent.click(screen.getByText('Interventions'));
    const btn = screen.getByRole('button', { name: 'Context Loss' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an "N off" badge when any intervention is suppressed', () => {
    useAppStore.getState().updateMessageToggles({ assess: false, batchReadSpinWarn: false });
    render(<SpinTraceSection />);
    expect(screen.getByText(/off/)).toBeTruthy();
  });

  it('remains visible before any rounds have been recorded (empty snapshots)', () => {
    // Simulate a fresh session with zero snapshots — controls must stay
    // reachable so users can pre-configure interventions before a run starts.
    useRoundHistoryStore.setState({
      snapshots: [] as ReturnType<typeof useRoundHistoryStore.getState>['snapshots'],
    });
    render(<SpinTraceSection />);
    expect(screen.getByText('Interventions')).toBeTruthy();
    expect(screen.getByText(/No round data yet/)).toBeTruthy();
    // Expand and confirm the toggles render without any snapshots in store
    fireEvent.click(screen.getByText('Interventions'));
    expect(screen.getByText('Spin steering (master)')).toBeTruthy();
  });
});

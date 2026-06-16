/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatTelemetryPane } from './ChatTelemetryPane';
import { useAppStore, type ContextUsage } from '../../stores/appStore';
import { useContextStore } from '../../stores/contextStore';
import { useRoundHistoryStore } from '../../stores/roundHistoryStore';
import type { AgentWindow } from '../../stores/agentWindowStore';
import type { SwarmStats } from '../../stores/swarmStore';

const SESSION_ID = 'session-1';

function makeWindow(overrides: Partial<AgentWindow> = {}): AgentWindow {
  return {
    windowId: 'w-1',
    sessionId: SESSION_ID,
    parentSessionId: SESSION_ID,
    title: 'Live Chat',
    status: 'idle',
    groupColor: 'cyan',
    kind: 'primary',
    rect: { x: 0, y: 0, w: 420, h: 320 },
    zIndex: 1,
    minimized: false,
    pinned: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const EMPTY_SWARM_STATS: SwarmStats = {
  totalTasks: 0,
  completedTasks: 0,
  failedTasks: 0,
  runningTasks: 0,
  pendingTasks: 0,
  totalTokensUsed: 0,
  totalCostCents: 0,
  planPhaseTokens: 0,
  planPhaseCostCents: 0,
  synthesisPhaseTokens: 0,
  synthesisPhaseCostCents: 0,
  elapsedMs: 0,
};

const CONTEXT_USAGE: ContextUsage = {
  inputTokens: 4000,
  outputTokens: 1500,
  totalTokens: 5500,
  maxTokens: 200000,
  percentage: 3,
  costCents: 12,
};

function renderPane(selectedWindow: AgentWindow, windows: AgentWindow[] = [selectedWindow]) {
  const promptMetrics = useAppStore.getState().promptMetrics;
  return render(
    <ChatTelemetryPane
      selectedWindow={selectedWindow}
      windows={windows}
      sessions={[]}
      currentSessionId={SESSION_ID}
      messages={[]}
      contextUsage={CONTEXT_USAGE}
      promptMetrics={promptMetrics}
      snapshots={[]}
      swarmTasks={[]}
      swarmStats={EMPTY_SWARM_STATS}
      runtimesByWindow={{}}
      parentEvents={[]}
      collapsed={false}
      onToggleCollapsed={() => undefined}
    />,
  );
}

describe('ChatTelemetryPane — live-session ContextMetrics', () => {
  beforeEach(() => {
    useRoundHistoryStore.getState().reset();
    useContextStore.getState().resetSession();
    useAppStore.setState({
      currentSessionId: SESSION_ID,
      availableModels: [{
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        provider: 'anthropic',
        contextWindow: 200000,
        isReasoning: true,
      }],
      settings: {
        ...useAppStore.getState().settings,
        selectedModel: 'claude-sonnet-4-5',
        selectedProvider: 'anthropic',
      },
      promptMetrics: {
        ...useAppStore.getState().promptMetrics,
        modePromptTokens: 5000,
        totalOverheadTokens: 5000,
        roundCount: 2,
        inputCompressionSavings: 1200,
        inputCompressionCount: 3,
        cumulativeInputSaved: 1200,
      },
    });
  });

  it('renders the rich breakdown + compression rollup for the live session', () => {
    renderPane(makeWindow());

    // Live-session detail container is present.
    expect(screen.getByTestId('live-context-metrics')).toBeTruthy();

    // Expand the collapsed metrics readout.
    fireEvent.click(screen.getByText('metrics'));

    // Main-branch overhead breakdown restored.
    expect(screen.getByText('Prompt Overhead')).toBeTruthy();
    expect(screen.getByText('Budget Split')).toBeTruthy();

    // Compression "glyphing" encoder rollup surfaces (input-comp track).
    expect(screen.getByTitle(/input-compression encoder savings/)).toBeTruthy();
  });

  it('omits the rich breakdown for a background (non-live) window', () => {
    renderPane(makeWindow({ windowId: 'w-2', sessionId: 'other-session' }));

    expect(screen.queryByTestId('live-context-metrics')).toBeNull();
    // Thin per-window stats remain.
    expect(screen.getByText('Selected Chat')).toBeTruthy();
  });
});

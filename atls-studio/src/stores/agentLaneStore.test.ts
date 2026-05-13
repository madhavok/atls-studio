/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { getLanePromptPrefix, useAgentLaneStore } from './agentLaneStore';

describe('agentLaneStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentLaneStore.setState({
      lanesBySession: {},
      selectedLaneBySession: {},
      expandedLaneBySession: {},
      draftsByLane: {},
    });
  });

  it('spawns a manual lane scoped to a chat session', () => {
    const laneId = useAgentLaneStore.getState().spawnManualLane('session-1', 'reviewer', 'Check regressions');

    const state = useAgentLaneStore.getState();
    expect(state.lanesBySession['session-1']).toHaveLength(1);
    expect(state.lanesBySession['session-1'][0].id).toBe(laneId);
    expect(state.lanesBySession['session-1'][0].role).toBe('reviewer');
    expect(state.selectedLaneBySession['session-1']).toBe(laneId);
    expect(state.expandedLaneBySession['session-1']).toBe(laneId);
  });

  it('records lane messages and telemetry', () => {
    const laneId = useAgentLaneStore.getState().spawnManualLane('session-1', 'tester');

    useAgentLaneStore.getState().appendLaneMessage(laneId, { role: 'user', content: 'Run tests' });
    useAgentLaneStore.getState().replaceLastAssistantMessage(laneId, 'Tests passed');
    useAgentLaneStore.getState().updateLaneTelemetry(laneId, { totalTokens: 1200, rounds: 1 });

    const lane = useAgentLaneStore.getState().lanesBySession['session-1'][0];
    expect(lane.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(lane.telemetry.totalTokens).toBe(1200);
    expect(lane.telemetry.rounds).toBe(1);
  });

  it('builds compact role prompts for lane execution', () => {
    expect(getLanePromptPrefix('debugger', 'Trace failing build')).toContain('Debugger lane');
    expect(getLanePromptPrefix('debugger', 'Trace failing build')).toContain('Trace failing build');
  });
});

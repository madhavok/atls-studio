/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { activateParentSession } from './activateSessionContext';
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore';
import { useAgentWindowStore } from '../stores/agentWindowStore';
import { useAppStore } from '../stores/appStore';

describe('activateParentSession', () => {
  beforeEach(() => {
    useAgentWindowStore.setState({
      projectPath: null,
      activeParentSessionId: null,
      windowsByParent: {},
      selectedWindowByParent: {},
      telemetryCollapsedByParent: {},
    });
    useAgentRuntimeStore.getState().reset();
    useAppStore.setState({ currentSessionId: null, chatSessions: [] });
  });

  it('focuses a parent session without invoking persistence loadSession hook', () => {
    activateParentSession('session-a', 'Mission Alpha');
    expect(useAgentWindowStore.getState().activeParentSessionId).toBe('session-a');
    expect(useAgentWindowStore.getState().selectedWindowByParent['session-a']).toBe('primary-session-a');
    expect(useAppStore.getState().currentSessionId).toBe('session-a');
    expect(useAgentRuntimeStore.getState().runtimesByWindow['primary-session-a']?.sessionId).toBe('session-a');
  });

  it('writes last-active session id for the current project', () => {
    useAgentWindowStore.setState({ projectPath: '/tmp/project' });
    activateParentSession('session-b', 'Mission Beta');
    expect(localStorage.getItem('atls:last-active-session-by-project-v1')).toContain('session-b');
  });
});

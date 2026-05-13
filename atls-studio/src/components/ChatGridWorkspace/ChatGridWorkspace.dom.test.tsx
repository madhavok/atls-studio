/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAgentWindowStore } from '../../stores/agentWindowStore';
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore';
import { useAppStore } from '../../stores/appStore';
import { useContextStore } from '../../stores/contextStore';
import { useRoundHistoryStore } from '../../stores/roundHistoryStore';
import { useSwarmStore, type SwarmTask } from '../../stores/swarmStore';
import { handleDelegateToolCall, handleSubAgentProgress } from '../../services/agentDelegateBridge';
import { ChatGridWorkspace } from './index';

const chatDbMock = vi.hoisted(() => ({
  initialized: false,
  createSession: vi.fn(),
  loadFullSession: vi.fn(),
  addMessage: vi.fn(),
}));

vi.mock('../AiChat', () => ({ AiChat: () => <div data-testid="m-aichat" /> }));
vi.mock('../../services/chatDb', () => ({
  chatDb: {
    isInitialized: () => chatDbMock.initialized,
    createSession: chatDbMock.createSession,
    loadFullSession: chatDbMock.loadFullSession,
    addMessage: chatDbMock.addMessage,
  },
}));

function task(): SwarmTask {
  return {
    id: 'task-1',
    title: 'Implement grid',
    description: 'Build full child chats',
    status: 'running',
    assignedModel: 'claude-sonnet-4-5',
    assignedProvider: 'anthropic',
    assignedRole: 'coder',
    contextHashes: [],
    fileClaims: ['src/App.tsx'],
    contextFiles: [],
    dependencies: [],
    tokensUsed: 2400,
    costCents: 5,
    retryCount: 0,
    maxRetries: 3,
    conversationLog: [{ id: 'msg-1', role: 'assistant', content: 'Working through layout.', timestamp: new Date() }],
  };
}

describe('ChatGridWorkspace', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    chatDbMock.initialized = false;
    chatDbMock.loadFullSession.mockResolvedValue(null);
    useAgentWindowStore.getState().reset();
    useAgentRuntimeStore.getState().reset();
    useSwarmStore.getState().resetSwarm();
    useRoundHistoryStore.getState().reset();
    useContextStore.getState().resetSession();
    useAppStore.setState({
      currentSessionId: 'session-1',
      messages: [],
      isGenerating: false,
      chatMode: 'agent',
      activeFile: null,
      openFiles: [],
      projectPath: '/tmp/project',
      contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, maxTokens: 1000, percentage: 0 },
    });
  });

  it('renders the primary chat as a full grid window', () => {
    render(<ChatGridWorkspace />);

    expect(screen.getByTestId('chat-grid-primary')).toBeTruthy();
    expect(screen.getByTestId('chat-telemetry-pane')).toBeTruthy();
    expect(screen.getByTestId('primary-chat-window')).toBeTruthy();
    expect(screen.getByText('This parent session is ready for agentic chat.')).toBeTruthy();
  });

  it('spawns new agents as new parent sessions, not child windows', async () => {
    render(<ChatGridWorkspace />);

    fireEvent.click(screen.getByText('New Parent Session'));

    await waitFor(() => {
      expect(screen.getAllByText('Agent Session 1').length).toBeGreaterThan(0);
    });
    const activeParentSessionId = useAgentWindowStore.getState().activeParentSessionId;
    expect(useAppStore.getState().currentSessionId).toBe('session-1');
    expect(activeParentSessionId).not.toBe('session-1');
    expect(useAgentWindowStore.getState().windowsByParent[activeParentSessionId ?? '']?.some((window) => window.kind === 'standard')).toBe(false);
  });

  it('selecting a standard window does not load it into the global parent session', async () => {
    const loadSession = vi.fn(async () => true);
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().spawnStandardWindow('session-1', 'session-2', 'Agent Window 1');
    const window = useAgentWindowStore.getState().windowsByParent['session-1'].find((candidate) => candidate.kind === 'standard');
    render(<ChatGridWorkspace loadSession={loadSession} />);
    if (!window) throw new Error('expected standard window');
    fireEvent.click(screen.getByTestId(`agent-chat-window-${window.windowId}`));

    expect(loadSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().currentSessionId).toBe('session-1');
  });

  it('does not render manual delegate spawn controls in chat headers', () => {
    render(<ChatGridWorkspace />);

    expect(screen.queryByTitle('Spawn coder delegate window')).toBeNull();
  });

  it('spawns a visible delegate window from model delegate tool calls', async () => {
    render(<ChatGridWorkspace />);

    handleDelegateToolCall('session-1', {
      id: 'tool-call-1',
      name: 'delegate.code',
      args: { goal: 'Implement the bridge' },
      status: 'running',
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Coder Delegate/).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/Delegate call running/)).toBeTruthy();
    expect(useAppStore.getState().currentSessionId).toBe('session-1');
    expect(useAgentWindowStore.getState().selectedWindowByParent['session-1']).toBe('primary-session-1');
    expect(screen.getByTestId('agent-runtime-transcript-primary-session-1')).toBeTruthy();
  });

  it('keeps the streaming parent runtime active when a delegate window appears', async () => {
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Primary Chat');
    useAgentRuntimeStore.getState().ensureRuntime({ windowId: 'primary-session-1', sessionId: 'session-1', parentSessionId: 'session-1' });
    useAgentRuntimeStore.getState().startRun('primary-session-1', new AbortController());
    useAgentRuntimeStore.getState().setStreamingText('primary-session-1', 'Parent stream still active');
    render(<ChatGridWorkspace />);

    handleDelegateToolCall('session-1', {
      id: 'tool-call-2',
      name: 'delegate.test',
      args: { goal: 'Verify parent stream persistence' },
      status: 'running',
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Tester Delegate/).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Parent stream still active')).toBeTruthy();
    expect(useAgentRuntimeStore.getState().runtimesByWindow['primary-session-1'].isGenerating).toBe(true);
  });

  it('keeps multiple parent window streams active while focus moves', () => {
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Parent One');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-2', 'Parent Two');
    useAgentRuntimeStore.getState().ensureRuntime({ windowId: 'primary-session-1', sessionId: 'session-1', parentSessionId: 'session-1' });
    useAgentRuntimeStore.getState().ensureRuntime({ windowId: 'primary-session-2', sessionId: 'session-2', parentSessionId: 'session-2' });
    useAgentRuntimeStore.getState().startRun('primary-session-1', new AbortController());
    useAgentRuntimeStore.getState().startRun('primary-session-2', new AbortController());
    useAgentRuntimeStore.getState().setStreamingText('primary-session-1', 'Parent one streaming');
    useAgentRuntimeStore.getState().setStreamingText('primary-session-2', 'Parent two streaming');

    render(<ChatGridWorkspace />);
    fireEvent.click(screen.getByText('Parent Two'));

    expect(screen.getByText('Parent one streaming')).toBeTruthy();
    expect(screen.getByText('Parent two streaming')).toBeTruthy();
    expect(useAgentRuntimeStore.getState().runtimesByWindow['primary-session-1'].isGenerating).toBe(true);
    expect(useAgentRuntimeStore.getState().runtimesByWindow['primary-session-2'].isGenerating).toBe(true);
  });

  it('mirrors subagent progress into the spawned child runtime', async () => {
    render(<ChatGridWorkspace />);

    handleSubAgentProgress('session-1', 'step-1', {
      toolName: 'delegate.test',
      status: 'Running tests',
      round: 2,
      done: false,
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Tester Delegate/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Round 2: Running tests').length).toBeGreaterThan(0);
    expect(screen.getByText('live stream active')).toBeTruthy();
  });

  it('opens delegate windows from step start progress before completion', async () => {
    render(<ChatGridWorkspace />);

    handleSubAgentProgress('session-1', 'delegate-step-1', {
      toolName: 'delegate.code',
      status: 'Starting delegate.code',
      round: 0,
      done: false,
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Coder Delegate/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Round 0: Starting delegate.code').length).toBeGreaterThan(0);

    handleSubAgentProgress('session-1', 'delegate-step-1', {
      toolName: 'read.context',
      status: 'Reading: src/App.tsx',
      round: 1,
      done: false,
    });

    await waitFor(() => {
      expect(screen.getAllByText('Round 1: Reading: src/App.tsx').length).toBeGreaterThan(0);
    });
    const delegateWindows = useAgentWindowStore.getState().windowsByParent['session-1'].filter((window) => window.sourceToolCallId === 'delegate-step-1');
    expect(delegateWindows).toHaveLength(1);
    expect(useAgentRuntimeStore.getState().runtimesByWindow[delegateWindows[0].windowId].isGenerating).toBe(true);
  });

  it('keeps child runtime output visible while switching window focus', () => {
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    const windowId = useAgentWindowStore.getState().spawnStandardWindow('session-1', 'session-2', 'Agent Window 1', 'tester');
    useAgentRuntimeStore.getState().ensureRuntime({ windowId, sessionId: 'session-2', parentSessionId: 'session-1', role: 'tester' });
    useAgentRuntimeStore.getState().appendMessage(windowId, { role: 'user', content: 'Verify the grid' });
    useAgentRuntimeStore.getState().startRun(windowId, new AbortController());
    useAgentRuntimeStore.getState().setStreamingText(windowId, 'Running tests...');

    render(<ChatGridWorkspace />);
    fireEvent.click(screen.getByTestId('primary-chat-window'));

    expect(screen.getByText('live stream active')).toBeTruthy();
    expect(screen.getByText('Running tests...')).toBeTruthy();
  });

  it('cancels only the targeted child runtime', () => {
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    const firstWindowId = useAgentWindowStore.getState().spawnStandardWindow('session-1', 'session-2', 'Agent Window 1');
    const secondWindowId = useAgentWindowStore.getState().spawnStandardWindow('session-1', 'session-3', 'Agent Window 2');
    useAgentRuntimeStore.getState().ensureRuntime({ windowId: firstWindowId, sessionId: 'session-2', parentSessionId: 'session-1' });
    useAgentRuntimeStore.getState().ensureRuntime({ windowId: secondWindowId, sessionId: 'session-3', parentSessionId: 'session-1' });
    useAgentRuntimeStore.getState().startRun(firstWindowId, new AbortController());
    useAgentRuntimeStore.getState().startRun(secondWindowId, new AbortController());

    useAgentRuntimeStore.getState().cancelRun(firstWindowId);

    expect(useAgentRuntimeStore.getState().runtimesByWindow[firstWindowId].isGenerating).toBe(false);
    expect(useAgentRuntimeStore.getState().runtimesByWindow[secondWindowId].isGenerating).toBe(true);
  });

  it('keeps child runtime output visible when parent file focus changes', () => {
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    const windowId = useAgentWindowStore.getState().spawnStandardWindow('session-1', 'session-2', 'Agent Window 1');
    useAgentRuntimeStore.getState().ensureRuntime({ windowId, sessionId: 'session-2', parentSessionId: 'session-1' });
    useAgentRuntimeStore.getState().appendMessage(windowId, { role: 'assistant', content: 'Output survives file focus.' });

    render(<ChatGridWorkspace />);
    useAppStore.setState({ activeFile: 'src/App.tsx' });

    expect(screen.getByText('Output survives file focus.')).toBeTruthy();
  });

  it('renders swarm tasks as grouped child chat windows', () => {
    useAppStore.setState({ chatMode: 'swarm' });
    useSwarmStore.setState({ isActive: true, status: 'running', tasks: [task()] });

    render(<ChatGridWorkspace />);

    expect(screen.getByTestId('swarm-chat-window-task-1')).toBeTruthy();
    expect(screen.getByText('Implement grid')).toBeTruthy();
    expect(screen.getByText('Working through layout.')).toBeTruthy();
  });

  it('can collapse the selected chat telemetry pane', () => {
    render(<ChatGridWorkspace />);

    fireEvent.click(screen.getByTitle('Hide chat telemetry'));

    expect(screen.getByTestId('chat-telemetry-pane-collapsed')).toBeTruthy();
  });

  it('rehydrates child runtime output from persisted delegate transcripts', async () => {
    chatDbMock.initialized = true;
    chatDbMock.loadFullSession.mockResolvedValue({
      messages: [{
        id: 'persisted-1',
        role: 'assistant',
        content: 'Persisted delegate output',
        timestamp: new Date(),
      }],
    });
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().spawnStandardWindow('session-1', 'delegate-session-1', 'Coder Delegate', 'coder', 'tool-call-1');

    render(<ChatGridWorkspace />);

    await waitFor(() => {
      expect(screen.getAllByText('Persisted delegate output').length).toBeGreaterThan(0);
    });
  });
});

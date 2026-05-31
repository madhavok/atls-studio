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
  updateSessionTitle: vi.fn(),
  getSessions: vi.fn(async () => []),
}));

const fetchModelsMock = vi.hoisted(() => vi.fn(async () => [{
  id: 'claude-sonnet-4-5',
  name: 'Claude Sonnet 4.5',
  provider: 'anthropic',
  contextWindow: 200000,
  isReasoning: true,
}]));
const streamChatMock = vi.hoisted(() => vi.fn(async (
  _config: unknown,
  _messages: unknown,
  callbacks: {
    onStreamId?: (streamId: string) => void;
    onToken?: (token: string) => void;
    onDone?: () => void;
  },
) => {
  callbacks.onStreamId?.('stream-test');
  callbacks.onToken?.('Streamed response');
  callbacks.onDone?.();
}));

vi.mock('../../services/activateAgentWindow', () => ({
  activateAgentWindow: vi.fn(async () => undefined),
  activateAgentParentSession: vi.fn(async () => undefined),
}));

vi.mock('../../services/aiService', () => ({
  fetchModels: fetchModelsMock,
  resetStaticPromptCache: vi.fn(),
  streamChat: streamChatMock,
}));

vi.mock('../../services/chatDb', () => ({
  chatDb: {
    isInitialized: () => chatDbMock.initialized,
    createSession: chatDbMock.createSession,
    loadFullSession: chatDbMock.loadFullSession,
    addMessage: chatDbMock.addMessage,
    updateSessionTitle: chatDbMock.updateSessionTitle,
    getSessions: chatDbMock.getSessions,
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
    chatDbMock.updateSessionTitle.mockResolvedValue(undefined);
    fetchModelsMock.mockClear();
    streamChatMock.mockClear();
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
      chatSessions: [],
      contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, maxTokens: 1000, percentage: 0 },
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
        anthropicApiKey: 'test-key',
      },
    });
    useAgentWindowStore.getState().hydrateProject('/tmp/project');
  });

  it('renders the primary chat as a full grid window', () => {
    render(<ChatGridWorkspace />);

    expect(screen.getByTestId('chat-grid-primary')).toBeTruthy();
    expect(screen.getByTestId('chat-telemetry-pane')).toBeTruthy();
    expect(screen.getByTestId('primary-chat-window')).toBeTruthy();
    expect(screen.getByTestId('agent-runtime-transcript-primary-session-1')).toBeTruthy();
    expect(screen.queryByTestId('m-aichat')).toBeNull();
  });

  it('renders conversation selector for parent session switching', () => {
    render(<ChatGridWorkspace />);
    expect(screen.getByTestId('conversation-selector')).toBeTruthy();
    expect(screen.getByLabelText('Switch parent conversation')).toBeTruthy();
  });

  it('restores project-scoped card layouts without leaking across projects', async () => {
    useAppStore.setState({
      currentSessionId: null,
      projectPath: '/tmp/project-a',
      chatSessions: [{
        id: 'project-a-session',
        title: 'Project A Chat',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
      }],
    });
    const { rerender } = render(<ChatGridWorkspace />);

    await waitFor(() => {
      expect(screen.getAllByText('Project A Chat').length).toBeGreaterThan(0);
    });
    useAgentWindowStore.getState().ensurePrimaryWindow('project-a-extra', 'Project A Extra');
    expect(useAgentWindowStore.getState().projectPath).toBe('/tmp/project-a');

    useAppStore.setState({
      projectPath: '/tmp/project-b',
      chatSessions: [{
        id: 'project-b-session',
        title: 'Project B Chat',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
      }],
    });
    rerender(<ChatGridWorkspace />);

    await waitFor(() => {
      expect(screen.getAllByText('Project B Chat').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('Project A Extra')).toBeNull();

    useAppStore.setState({
      projectPath: '/tmp/project-a',
      chatSessions: [{
        id: 'project-a-session',
        title: 'Project A Chat',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
      }],
    });
    rerender(<ChatGridWorkspace />);

    await waitFor(() => {
      expect(useAgentWindowStore.getState().windowsByParent['project-a-extra']?.some((window) => window.title === 'Project A Extra')).toBe(true);
    });
  });

  it('shows shared chat controls on the selected card', () => {
    render(<ChatGridWorkspace />);

    expect(screen.getByText('Controls')).toBeTruthy();
    expect(screen.getByText('Model: Claude Sonnet 4.5')).toBeTruthy();
    expect(screen.getByText('Mode: agent')).toBeTruthy();
    expect(screen.getByText('Options')).toBeTruthy();
    expect(screen.queryByTitle('Select model')).toBeNull();

    fireEvent.click(screen.getByText('Options'));
    expect(screen.getByTestId('chat-options-modal').className).toContain('fixed');
    expect(screen.getByTitle('Select model')).toBeTruthy();
    expect(screen.getByTitle('Settings')).toBeTruthy();
  });

  it('keeps controls visible on every card in the active parent group', () => {
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Parent One');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-2', 'Parent Two');
    const childWindowId = useAgentWindowStore.getState().spawnStandardWindow('session-1', 'session-3', 'Agent Window 1');

    render(<ChatGridWorkspace />);

    expect(screen.getByTestId('agent-card-controls-primary-session-1')).toBeTruthy();
    expect(screen.getByTestId(`agent-card-controls-${childWindowId}`)).toBeTruthy();
    expect(screen.queryByTestId('agent-card-controls-primary-session-2')).toBeNull();
    expect(screen.getAllByText('Options').length).toBeGreaterThanOrEqual(2);
  });

  it('opens global options model menus downward', () => {
    render(<ChatGridWorkspace />);

    fireEvent.click(screen.getByText('Options'));
    fireEvent.click(screen.getByTitle('Select model'));
    const searchInput = screen.getByPlaceholderText('Search models by provider...');
    expect(searchInput.closest('.sticky')?.parentElement?.className).toContain('top-full');
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
    expect(screen.getByTestId(`agent-runtime-transcript-primary-${activeParentSessionId}`)).toBeTruthy();
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
    useAppStore.setState({ currentSessionId: 'session-2' });
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
    useAppStore.setState({ currentSessionId: 'session-3' });
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Parent One');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-2', 'Parent Two');
    useAgentRuntimeStore.getState().ensureRuntime({ windowId: 'primary-session-1', sessionId: 'session-1', parentSessionId: 'session-1' });
    useAgentRuntimeStore.getState().ensureRuntime({ windowId: 'primary-session-2', sessionId: 'session-2', parentSessionId: 'session-2' });
    useAgentRuntimeStore.getState().startRun('primary-session-1', new AbortController());
    useAgentRuntimeStore.getState().startRun('primary-session-2', new AbortController());
    useAgentRuntimeStore.getState().setStreamingText('primary-session-1', 'Parent one streaming');
    useAgentRuntimeStore.getState().setStreamingText('primary-session-2', 'Parent two streaming');

    const { rerender } = render(<ChatGridWorkspace />);
    expect(screen.getByText('Parent one streaming')).toBeTruthy();
    expect(screen.queryByText('Parent two streaming')).toBeNull();

    useAgentWindowStore.getState().setActiveParentSession('session-2');
    rerender(<ChatGridWorkspace />);
    expect(screen.getByText('Parent two streaming')).toBeTruthy();
    expect(screen.queryByText('Parent one streaming')).toBeNull();
    expect(useAgentRuntimeStore.getState().runtimesByWindow['primary-session-1'].isGenerating).toBe(true);
    expect(useAgentRuntimeStore.getState().runtimesByWindow['primary-session-2'].isGenerating).toBe(true);
  });

  it('bounds transcript output inside the card viewport', () => {
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Bounded Parent');
    useAgentRuntimeStore.getState().ensureRuntime({ windowId: 'primary-session-1', sessionId: 'session-1', parentSessionId: 'session-1' });
    useAgentRuntimeStore.getState().appendMessage('primary-session-1', {
      role: 'assistant',
      content: 'x'.repeat(500),
    });

    render(<ChatGridWorkspace />);
    const card = screen.getByTestId('primary-chat-window');
    const transcript = screen.getByTestId('agent-runtime-transcript-primary-session-1');

    expect(card.className).toContain('h-[520px]');
    expect(card.className).toContain('overflow-hidden');
    expect(transcript.className).toContain('overflow-y-auto');
    expect(transcript.className).toContain('overflow-x-hidden');
    expect(screen.getByText('x'.repeat(500)).className).toContain('break-words');
  });

  it('keeps auto-scroll paused when the user scrolls up and can jump back to latest', async () => {
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Scrollable Parent');
    useAgentRuntimeStore.getState().ensureRuntime({ windowId: 'primary-session-1', sessionId: 'session-1', parentSessionId: 'session-1' });
    useAgentRuntimeStore.getState().appendMessage('primary-session-1', {
      role: 'assistant',
      content: 'Initial output',
    });

    render(<ChatGridWorkspace />);
    const transcript = screen.getByTestId('agent-runtime-transcript-primary-session-1');
    Object.defineProperty(transcript, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(transcript, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(transcript, 'scrollTop', { value: 100, writable: true, configurable: true });

    fireEvent.scroll(transcript);
    await waitFor(() => {
      expect(screen.getByText('Latest')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Latest'));
    await waitFor(() => {
      expect(screen.queryByText('Latest')).toBeNull();
    });
  });

  it('renames parent cards from their own first prompt', async () => {
    chatDbMock.initialized = true;
    useAppStore.setState({
      chatSessions: [{
        id: 'session-1',
        title: 'Agent Session 1',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
      }],
    });
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Agent Session 1');

    render(<ChatGridWorkspace />);
    fireEvent.change(screen.getByPlaceholderText('Send a parent session task...'), {
      target: { value: 'Build isolated card streaming now' },
    });
    fireEvent.click(screen.getByText('Run'));

    await waitFor(() => {
      expect(chatDbMock.updateSessionTitle).toHaveBeenCalledWith('session-1', 'Build isolated card streaming now');
    });
    expect(useAgentWindowStore.getState().windowsByParent['session-1'][0].title).toBe('Build isolated card streaming now');
    expect(streamChatMock).toHaveBeenCalledTimes(1);
  });

  it('syncs parent card titles from renamed chat sessions', async () => {
    useAgentWindowStore.getState().setActiveParentSession('session-1');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Old Parent Title');
    useAppStore.setState({
      chatSessions: [{
        id: 'session-1',
        title: 'Renamed Parent Mission',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
      }],
    });

    render(<ChatGridWorkspace />);

    await waitFor(() => {
      expect(useAgentWindowStore.getState().windowsByParent['session-1'][0].title).toBe('Renamed Parent Mission');
    });
    expect(screen.getAllByText('Renamed Parent Mission').length).toBeGreaterThan(0);
  });

  it('closes older parent session windows without deleting the current chat', () => {
    useAppStore.setState({ currentSessionId: 'session-1' });
    useAgentWindowStore.getState().setActiveParentSession('session-2');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Parent One');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-2', 'Parent Two');

    render(<ChatGridWorkspace />);
    fireEvent.click(screen.getByTitle('Close parent session window'));

    expect(useAgentWindowStore.getState().windowsByParent['session-2']).toBeUndefined();
    expect(useAppStore.getState().currentSessionId).toBe('session-1');
    expect(screen.queryByText('Parent Two')).toBeNull();
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

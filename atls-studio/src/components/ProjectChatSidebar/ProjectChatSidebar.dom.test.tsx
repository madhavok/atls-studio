/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAppStore } from '../../stores/appStore';
import { useAgentWindowStore } from '../../stores/agentWindowStore';

const ACTIVE_PATH = '/proj/active';
const OTHER_PATH = '/proj/other';

// chatDb is mocked so the real useProjectChatGroups hook can fetch the non-active
// project's sessions without touching Tauri.
const chatDbMocks = vi.hoisted(() => ({
  getProjectPath: vi.fn<[], string | null>(() => '/proj/active'),
  withProjectScope: vi.fn(<T,>(_path: string | null, fn: () => Promise<T>) => fn()),
  getSessions: vi.fn(async () => [
    { id: 'o1', title: 'Other Chat', mode: 'agent', created_at: '', updated_at: new Date().toISOString(), is_swarm: false },
  ]),
  createSession: vi.fn(async () => 'new-id'),
  deleteSession: vi.fn(async () => undefined),
  isInitialized: vi.fn(() => true),
}));

vi.mock('../../services/chatDb', () => ({ chatDb: chatDbMocks }));

const actionMocks = vi.hoisted(() => ({
  createChatInProject: vi.fn(async () => 'new-id'),
  openChatInProject: vi.fn(async () => true),
  deleteChatInProject: vi.fn(async () => undefined),
}));

vi.mock('../../services/projectChatActions', () => actionMocks);

vi.mock('../../hooks/useAtls', () => ({
  useAtls: () => ({ openProject: vi.fn(), newProject: vi.fn(), openProjectWithPicker: vi.fn() }),
}));

vi.mock('../../hooks/useChatPersistence', () => ({
  useChatPersistence: () => ({ createNewSession: vi.fn(), deleteSession: vi.fn() }),
}));

import { ProjectChatSidebar } from './index';

beforeEach(() => {
  actionMocks.createChatInProject.mockClear();
  actionMocks.openChatInProject.mockClear();
  actionMocks.deleteChatInProject.mockClear();
  chatDbMocks.getProjectPath.mockReturnValue(ACTIVE_PATH);

  useAgentWindowStore.setState({ activeParentSessionId: null });
  useAppStore.setState({
    projectPath: ACTIVE_PATH,
    currentSessionId: 's1',
    chatSessions: [
      { id: 's1', title: 'Active Chat', messages: [], createdAt: new Date(), updatedAt: new Date() },
    ],
    projectHistory: [
      { path: ACTIVE_PATH, name: 'active', lastOpened: new Date() },
      { path: OTHER_PATH, name: 'other', lastOpened: new Date(Date.now() - 1000) },
    ],
  });
});

afterEach(() => {
  cleanup();
});

describe('ProjectChatSidebar', () => {
  it('groups chats by project: active project expanded, others collapsed', () => {
    render(<ProjectChatSidebar />);

    // Active project header + its live chat are shown.
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('Active Chat')).toBeTruthy();

    // The other project header is present but collapsed (no rows fetched yet).
    expect(screen.getByText('other')).toBeTruthy();
    expect(screen.queryByText('Other Chat')).toBeNull();
  });

  it('spawns a new chat from the project header "+"', () => {
    render(<ProjectChatSidebar />);

    fireEvent.click(screen.getByLabelText('New chat in active'));

    expect(actionMocks.createChatInProject).toHaveBeenCalledTimes(1);
    expect(actionMocks.createChatInProject).toHaveBeenCalledWith(ACTIVE_PATH, expect.anything());
  });

  it('deletes a conversation after inline confirm', () => {
    render(<ProjectChatSidebar />);

    fireEvent.click(screen.getByLabelText('Delete Active Chat'));
    // Confirm affordance appears; delete only fires after confirm.
    expect(actionMocks.deleteChatInProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Confirm delete Active Chat'));

    expect(actionMocks.deleteChatInProject).toHaveBeenCalledWith(ACTIVE_PATH, 's1', expect.anything());
  });

  it('lazy-loads and opens a chat from another project', async () => {
    render(<ProjectChatSidebar />);

    // Expand the non-active project header to trigger a scoped fetch.
    fireEvent.click(screen.getByText('other'));

    const otherRow = await screen.findByText('Other Chat');
    expect(chatDbMocks.withProjectScope).toHaveBeenCalled();

    fireEvent.click(otherRow);

    await waitFor(() =>
      expect(actionMocks.openChatInProject).toHaveBeenCalledWith(
        OTHER_PATH,
        'o1',
        'Other Chat',
        expect.anything(),
      ),
    );
  });
});

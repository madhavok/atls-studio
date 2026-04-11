/** @vitest-environment happy-dom */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionPicker } from './index';

const { mockInit, mockGetSessions } = vi.hoisted(() => {
  return {
    mockInit: vi.fn().mockResolvedValue(undefined),
    mockGetSessions: vi.fn().mockResolvedValue([
      {
        id: 'sess-1',
        title: 'Hello',
        mode: 'agent' as const,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        is_swarm: false,
      },
    ]),
  };
});

vi.mock('../../services/chatDb', () => ({
  chatDb: {
    init: mockInit,
    getSessions: mockGetSessions,
  },
}));

describe('SessionPicker', () => {
  it('loads sessions when open and shows title', async () => {
    render(
      <SessionPicker
        isOpen
        projectPath="/tmp/p"
        onNewSession={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockInit).toHaveBeenCalledWith('/tmp/p');
    });
    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeTruthy();
    });
  });
});

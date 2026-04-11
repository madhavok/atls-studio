/** @vitest-environment happy-dom */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Settings } from './index';
import { useAppStore } from '../../stores/appStore';

const fetchModelsMock = vi.fn();

vi.mock('../../services/aiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiService')>();
  return {
    ...actual,
    fetchModels: (...args: Parameters<typeof actual.fetchModels>) =>
      fetchModelsMock(...args) as ReturnType<typeof actual.fetchModels>,
  };
});

describe('Settings', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchModelsMock.mockReset();
    fetchModelsMock.mockResolvedValue([]);
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        anthropicApiKey: 'sk-ant-12345678901',
        maxTokens: 4096,
      },
    });
  });

  it('renders heading and provider tab when open', () => {
    render(<Settings isOpen onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /settings/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Providers' })).toBeTruthy();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<Settings isOpen={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('switches to Models tab and toggles a filter checkbox', () => {
    render(<Settings isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    const onlyTool = screen.getByRole('checkbox', {
      name: /only show tool-capable models/i,
    });
    expect((onlyTool as HTMLInputElement).checked).toBe(true);
    fireEvent.click(onlyTool);
    expect((onlyTool as HTMLInputElement).checked).toBe(false);
  });

  it('saves chat settings and closes', async () => {
    const onClose = vi.fn();
    render(<Settings isOpen onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat' }));
    const maxInput = screen.getByDisplayValue('4096');
    fireEvent.change(maxInput, { target: { value: '8192' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useAppStore.getState().settings.maxTokens).toBe(8192);
  });

  it('cancel calls onClose without persisting local edits', () => {
    const onClose = vi.fn();
    render(<Settings isOpen onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat' }));
    fireEvent.change(screen.getByDisplayValue('4096'), { target: { value: '2048' } });
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalled();
    expect(useAppStore.getState().settings.maxTokens).toBe(4096);
  });
});

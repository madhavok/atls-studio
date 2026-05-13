/** @vitest-environment happy-dom */
import { act, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelModeSelector } from './index';
import { useAppStore } from '../../stores/appStore';

const fetchModelsMock = vi.fn();

vi.mock('../../services/aiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiService')>();
  return {
    ...actual,
    fetchModels: (...args: Parameters<typeof actual.fetchModels>) =>
      fetchModelsMock(...args) as ReturnType<typeof actual.fetchModels>,
    resetStaticPromptCache: vi.fn(),
  };
});

describe('ModelModeSelector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchModelsMock.mockReset();
    fetchModelsMock.mockResolvedValue([
      { id: 'claude-test', name: 'Claude Test', provider: 'anthropic' as const },
    ]);
    useAppStore.setState({
      availableModels: [],
      modelsLoading: false,
      chatMode: 'agent',
      selectedAgent: '',
      customAgents: [],
      settings: {
        ...useAppStore.getState().settings,
        anthropicApiKey: 'sk-ant-12345678901',
        selectedModel: 'claude-sonnet-4-5',
        selectedProvider: 'anthropic',
        disabledProviders: [],
        agentPromptVersion: 'v1',
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches models after debounce and lists them in the model menu', async () => {
    render(<ModelModeSelector />);
    await act(async () => {
      vi.advanceTimersByTime(520);
    });
    expect(fetchModelsMock).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTitle('Select model'));
    expect(screen.getByText('Claude Test')).toBeTruthy();
    fireEvent.click(screen.getByText('Claude Test'));
    expect(useAppStore.getState().settings.selectedModel).toBe('claude-test');
    expect(useAppStore.getState().settings.selectedProvider).toBe('anthropic');
  });

  it('toggles the Agent v2 prompt surface without changing chat mode', async () => {
    render(<ModelModeSelector />);
    await act(async () => {
      vi.advanceTimersByTime(520);
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'V2' }));

    expect(useAppStore.getState().chatMode).toBe('agent');
    expect(useAppStore.getState().settings.agentPromptVersion).toBe('v2');
  });

  it('changes chat mode from the mode menu', async () => {
    render(<ModelModeSelector />);
    await act(async () => {
      vi.advanceTimersByTime(520);
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }));
    fireEvent.click(screen.getByRole('button', { name: /Ask Simple Q&A/i }));
    expect(useAppStore.getState().chatMode).toBe('ask');
  });

  it('keeps worker routing inside the model popover', async () => {
    render(<ModelModeSelector />);
    await act(async () => {
      vi.advanceTimersByTime(520);
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTitle('Select model'));

    expect(screen.getByText('Agent Routing')).toBeTruthy();
    expect(screen.getByText('Worker:')).toBeTruthy();
    expect(screen.queryByText('SA:')).toBeNull();
  });

  it('hides extra-high thinking when the selected model does not support it', async () => {
    render(<ModelModeSelector />);
    await act(async () => {
      vi.advanceTimersByTime(520);
      await Promise.resolve();
    });

    expect(screen.queryByRole('button', { name: 'XHi' })).toBeNull();
  });

  it('shows extra-high thinking for adaptive-thinking models', async () => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        selectedModel: 'claude-opus-4-7',
        selectedProvider: 'anthropic',
      },
    });

    render(<ModelModeSelector />);
    await act(async () => {
      vi.advanceTimersByTime(520);
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'XHi' })).toBeTruthy();
  });
});

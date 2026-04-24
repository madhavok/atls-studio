/** @vitest-environment happy-dom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastContainer } from './index';

const toastState = vi.hoisted(() => ({
  toasts: [
    {
      id: 't1',
      type: 'info' as const,
      message: 'Hello toast',
      duration: 0,
    },
  ],
  removeToast: vi.fn(),
}));

vi.mock('../../stores/appStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({
      toasts: toastState.toasts,
      removeToast: toastState.removeToast,
    }),
}));

describe('ToastContainer', () => {
  beforeEach(() => {
    toastState.removeToast.mockClear();
    toastState.toasts = [
      { id: 't1', type: 'info', message: 'Hello toast', duration: 0 },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders toast message', () => {
    render(<ToastContainer />);
    expect(screen.getByText('Hello toast')).toBeTruthy();
  });

  it('auto-dismisses when duration > 0', () => {
    vi.useFakeTimers();
    toastState.toasts = [{ id: 't2', type: 'success', message: 'bye', duration: 100 }];
    render(<ToastContainer />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(toastState.removeToast).toHaveBeenCalledWith('t2');
  });

  it('dismiss button calls removeToast', () => {
    toastState.toasts = [{ id: 't3', type: 'warning', message: 'warn', duration: 0 }];
    render(<ToastContainer />);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(toastState.removeToast).toHaveBeenCalledWith('t3');
  });
});

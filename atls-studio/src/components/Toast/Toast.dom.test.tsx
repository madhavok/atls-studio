/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToastContainer } from './index';

vi.mock('../../stores/appStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({
      toasts: [
        {
          id: 't1',
          type: 'info' as const,
          message: 'Hello toast',
          duration: 0,
        },
      ],
      removeToast: vi.fn(),
    }),
}));

describe('ToastContainer', () => {
  it('renders toast message', () => {
    render(<ToastContainer />);
    expect(screen.getByText('Hello toast')).toBeTruthy();
  });
});

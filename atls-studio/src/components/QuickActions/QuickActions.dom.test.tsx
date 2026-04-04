/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuickActions } from './index';

describe('QuickActions', () => {
  it('renders filtered action label when open', () => {
    const onClose = vi.fn();
    render(
      <QuickActions
        isOpen
        onClose={onClose}
        actions={[
          {
            id: '1',
            label: 'Open Settings',
            category: 'settings',
            action: vi.fn(),
          },
        ]}
      />,
    );
    expect(screen.getByText('Open Settings')).toBeTruthy();
  });
});

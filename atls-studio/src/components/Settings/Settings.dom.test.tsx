/** @vitest-environment happy-dom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Settings } from './index';

vi.mock('../../services/aiService', () => ({
  fetchModels: vi.fn().mockResolvedValue([]),
}));

describe('Settings', () => {
  it('renders heading and provider tab when open', () => {
    render(<Settings isOpen onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /settings/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Providers' })).toBeTruthy();
  });
});

/** @vitest-environment happy-dom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SwarmErrorBoundary } from './SwarmErrorBoundary';

function Boom(): null {
  throw new Error('unit-test boom');
}

describe('SwarmErrorBoundary', () => {
  it('shows fallback and recovers on Try again', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <SwarmErrorBoundary>
        <Boom />
      </SwarmErrorBoundary>,
    );

    expect(screen.getByText('Swarm panel crashed')).toBeTruthy();
    expect(screen.getByText(/unit-test boom/)).toBeTruthy();

    rerender(
      <SwarmErrorBoundary>
        <span>ok</span>
      </SwarmErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('ok')).toBeTruthy();

    spy.mockRestore();
  });
});

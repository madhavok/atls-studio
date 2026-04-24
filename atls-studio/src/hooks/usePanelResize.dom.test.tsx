/** @vitest-environment happy-dom */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { usePanelResize, clampLeft, clampRight, clampBottom } from './usePanelResize';

function LeftHarness() {
  const [l, setL] = useState(200);
  const [r, setR] = useState(400);
  const [b, setB] = useState(200);
  const { handleLeftResize, handleRightResize, handleBottomResize, isResizing } = usePanelResize({
    leftWidth: l,
    setLeftWidth: setL,
    rightWidth: r,
    setRightWidth: setR,
    bottomHeight: b,
    setBottomHeight: setB,
  });
  return (
    <div>
      <button type="button" data-testid="left" onMouseDown={handleLeftResize} />
      <button type="button" data-testid="right" onMouseDown={handleRightResize} />
      <button type="button" data-testid="bottom" onMouseDown={handleBottomResize} />
      <span data-testid="l">{l}</span>
      <span data-testid="res">{isResizing ? '1' : '0'}</span>
    </div>
  );
}

describe('usePanelResize (DOM)', () => {
  beforeEach(() => {
    vi.stubGlobal('innerWidth', 2000);
    vi.stubGlobal('innerHeight', 1000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('left drag updates width on mouseup', () => {
    render(<LeftHarness />);
    const btn = screen.getByTestId('left');
    fireEvent.mouseDown(btn, { clientX: 100, preventDefault: vi.fn() });
    expect(screen.getByTestId('res').textContent).toBe('1');
    fireEvent(document, new MouseEvent('mousemove', { clientX: 160, bubbles: true }));
    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }));
    const w = Number(screen.getByTestId('l').textContent);
    expect(w).toBe(clampLeft(200 + 60));
  });

  it('unmount cleans ghost and listeners', () => {
    const { unmount } = render(<LeftHarness />);
    const btn = screen.getByTestId('left');
    fireEvent.mouseDown(btn, { clientX: 0, preventDefault: vi.fn() });
    act(() => {
      unmount();
    });
    expect(document.body.querySelector('.panel-ghost-line')).toBeNull();
  });
});

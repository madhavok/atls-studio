/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CloseIcon, FileIcon, RefreshIcon, StopIcon } from './icons';

describe('icons', () => {
  it('renders CloseIcon with svg role', () => {
    const { container } = render(<CloseIcon />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders FileIcon', () => {
    const { container } = render(<FileIcon />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders RefreshIcon and StopIcon', () => {
    const { container: a } = render(<RefreshIcon />);
    const { container: b } = render(<StopIcon />);
    expect(a.querySelector('path')).toBeTruthy();
    expect(b.querySelector('rect')).toBeTruthy();
  });
});

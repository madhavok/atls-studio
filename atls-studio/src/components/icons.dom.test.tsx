/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CloseIcon, FileIcon } from './icons';

describe('icons', () => {
  it('renders CloseIcon with svg role', () => {
    const { container } = render(<CloseIcon />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders FileIcon', () => {
    const { container } = render(<FileIcon />);
    expect(container.querySelector('svg')).toBeTruthy();
  });
});

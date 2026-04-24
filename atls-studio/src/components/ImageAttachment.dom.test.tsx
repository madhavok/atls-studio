/** @vitest-environment happy-dom */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImageAttachment } from './ImageAttachment';
import type { ChatAttachment } from '../stores/attachmentStore';

const base: ChatAttachment = {
  id: '1',
  name: 'pic.png',
  type: 'image',
  path: '/p',
};

describe('ImageAttachment', () => {
  it('returns null when no image src', () => {
    const { container } = render(
      <ImageAttachment attachment={{ ...base, content: undefined, base64: undefined, thumbnailUrl: undefined }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders img from base64 data URL and toggles stats', () => {
    const att: ChatAttachment = {
      ...base,
      base64: 'QUFB',
      mediaType: 'image/png',
      metadata: { original_size: 1000, compressed_size: 500 },
    };
    render(<ImageAttachment attachment={att} />);
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toContain('data:image/png;base64,');
    fireEvent.click(img!);
    expect(screen.getByText(/KB/)).toBeTruthy();
  });

  it('renders remove when onRemove is passed', () => {
    const onRemove = vi.fn();
    const att: ChatAttachment = { ...base, content: 'http://x/' };
    render(<ImageAttachment attachment={att} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: /remove image/i }));
    expect(onRemove).toHaveBeenCalled();
  });
});

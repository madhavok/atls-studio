/** @vitest-environment happy-dom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatMessage } from './ChatMessage';
import type { Message } from '../stores/appStore';

describe('ChatMessage', () => {
  it('renders markdown for plain user content', () => {
    const message: Message = {
      id: '1',
      role: 'user',
      content: 'Hello **world**',
      timestamp: new Date(),
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByText(/world/i)).toBeTruthy();
  });
});

/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { ReasoningBlock } from './ReasoningBlock';
import { render, screen } from '@testing-library/react';

describe('ReasoningBlock', () => {
  it('shows thinking label while streaming', () => {
    render(<ReasoningBlock content="planning next step" isStreaming />);
    expect(screen.getByText('Thinking...')).toBeTruthy();
    expect(screen.getByText('planning next step')).toBeTruthy();
  });

  it('shows thought label when complete', () => {
    render(<ReasoningBlock content="done thinking" isStreaming={false} />);
    expect(screen.getByText('Thought')).toBeTruthy();
  });
});

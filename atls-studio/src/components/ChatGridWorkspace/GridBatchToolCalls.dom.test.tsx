/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MessageToolCall } from '../../stores/appStore';
import { GridBatchToolCalls } from './GridBatchToolCalls';

describe('GridBatchToolCalls', () => {
  it('renders expanded delegate steps from a batch tool call', () => {
    const toolCall: MessageToolCall = {
      id: 'batch-1',
      name: 'batch',
      status: 'running',
      args: {
        steps: [
          { id: 'step-a', use: 'delegate.code', with: { goal: 'Fix auth module', step_id: 'step-a' } },
          { id: 'step-b', use: 'read.context', with: { path: 'src/App.tsx' } },
        ],
      },
      startTime: new Date(),
    };

    render(<GridBatchToolCalls toolCall={toolCall} windowId="primary-session-1" />);

    expect(screen.getByTestId('grid-batch-tool-calls')).toBeTruthy();
    expect(screen.getByText(/Coder delegate/)).toBeTruthy();
    expect(screen.getByText(/Fix auth module/)).toBeTruthy();
  });
});

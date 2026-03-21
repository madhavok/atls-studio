import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Prevents an uncaught render/lifecycle error in Swarm UI from unmounting the entire app (black screen).
 */
export class SwarmErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[SwarmErrorBoundary]', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col h-full min-h-0 bg-studio-bg p-6 text-studio-text">
          <div className="text-lg font-medium text-studio-title mb-2">Swarm panel crashed</div>
          <p className="text-sm text-studio-muted mb-4">
            The swarm UI hit an unexpected error. Your project is unchanged. Try closing the swarm or reloading the window.
          </p>
          <pre className="text-xs bg-studio-surface border border-studio-border rounded p-3 overflow-auto max-h-40 text-red-400 whitespace-pre-wrap">
            {this.state.message}
          </pre>
          <button
            type="button"
            className="mt-4 self-start px-3 py-1.5 bg-studio-accent text-white text-sm rounded hover:opacity-90"
            onClick={() => this.setState({ hasError: false, message: '' })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

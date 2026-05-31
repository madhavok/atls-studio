import { Component, type ErrorInfo, type ReactNode } from 'react';

interface GridErrorBoundaryProps {
  windowId: string;
  children: ReactNode;
}

interface GridErrorBoundaryState {
  error: Error | null;
}

export class GridErrorBoundary extends Component<GridErrorBoundaryProps, GridErrorBoundaryState> {
  state: GridErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): GridErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[GridErrorBoundary] window ${this.props.windowId}:`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-red-200">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-red-300">Window render error</div>
          <div className="max-w-sm break-words text-red-100/90">{this.state.error.message}</div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded border border-red-400/40 px-2 py-1 text-[10px] uppercase tracking-wide"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

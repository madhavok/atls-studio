/**
 * Per-run scope for concurrent grid agent streams.
 * Threaded through streamChat → createHandlerContext → batch tools.
 */

export interface AgentRunScope {
  dbSessionId: string;
  windowId?: string;
  fileClaims?: string[];
  projectPath?: string;
}

let activeRunScope: AgentRunScope | null = null;

export function setActiveRunScope(scope: AgentRunScope | null): void {
  activeRunScope = scope;
}

export function getActiveRunScope(): AgentRunScope | null {
  return activeRunScope;
}

export function resolveDbSessionId(fallback?: string | null): string | null {
  return activeRunScope?.dbSessionId ?? fallback ?? null;
}

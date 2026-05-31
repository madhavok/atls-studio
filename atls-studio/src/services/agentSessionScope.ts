/**
 * Per-run scope for concurrent grid agent streams.
 * Threaded through streamChat → createHandlerContext → batch tools.
 */

import { syncCurrentSessionIdToLocalStorage } from './lastActiveSession';

export interface AgentRunLoopState {
  roundHadMutations: boolean;
  hadVerification: boolean;
}

export interface AgentRunScope {
  dbSessionId: string;
  windowId?: string;
  fileClaims?: string[];
  projectPath?: string;
  loopState?: AgentRunLoopState;
}

export interface EndTurnHistoryCache {
  history: Array<{ role: string; content: unknown }>;
  uiMessageCount: number;
  boundary: number;
}

let activeRunScope: AgentRunScope | null = null;
const endTurnHistoryBySession = new Map<string, EndTurnHistoryCache>();

export function setActiveRunScope(scope: AgentRunScope | null): void {
  activeRunScope = scope;
}

export function getActiveRunScope(): AgentRunScope | null {
  return activeRunScope;
}

export function resolveDbSessionId(fallback?: string | null): string | null {
  return activeRunScope?.dbSessionId ?? fallback ?? null;
}

export function resolveScopedProjectPath(fallback?: string | null): string | null {
  return activeRunScope?.projectPath ?? fallback ?? null;
}

export function getEndTurnHistoryForSession(sessionId: string): EndTurnHistoryCache | undefined {
  return endTurnHistoryBySession.get(sessionId);
}

export function setEndTurnHistoryForSession(sessionId: string, cache: EndTurnHistoryCache): void {
  endTurnHistoryBySession.set(sessionId, cache);
}

export function clearEndTurnHistoryForSession(sessionId: string): void {
  endTurnHistoryBySession.delete(sessionId);
}

/** Run fn with scoped session id visible to legacy localStorage readers (single-flight). */
export async function withDbSessionScope<T>(scope: AgentRunScope, fn: () => Promise<T>): Promise<T> {
  const prior = activeRunScope;
  const priorSessionId = typeof localStorage !== 'undefined' ? localStorage.getItem('current_session_id') : null;
  setActiveRunScope(scope);
  syncCurrentSessionIdToLocalStorage(scope.dbSessionId);
  try {
    return await fn();
  } finally {
    setActiveRunScope(prior);
    syncCurrentSessionIdToLocalStorage(prior?.dbSessionId ?? priorSessionId);
  }
}

export function markRunRoundMutation(): void {
  if (activeRunScope?.loopState) activeRunScope.loopState.roundHadMutations = true;
  else markLegacyRoundMutation();
}

export function markRunVerification(): void {
  if (activeRunScope?.loopState) activeRunScope.loopState.hadVerification = true;
  else markLegacyVerification();
}

export function readRunRoundHadMutations(): boolean {
  return activeRunScope?.loopState?.roundHadMutations ?? readLegacyRoundHadMutations();
}

export function resetRunRoundHadMutations(): void {
  if (activeRunScope?.loopState) activeRunScope.loopState.roundHadMutations = false;
  else resetLegacyRoundHadMutations();
}

export function readRunHadVerification(): boolean {
  return activeRunScope?.loopState?.hadVerification ?? readLegacyHadVerification();
}

/** Legacy module-level fallbacks for singleton chat path. */
let legacyRoundHadMutations = false;
let legacyHadVerification = false;

function markLegacyRoundMutation(): void { legacyRoundHadMutations = true; }
function markLegacyVerification(): void { legacyHadVerification = true; }
function readLegacyRoundHadMutations(): boolean { return legacyRoundHadMutations; }
function resetLegacyRoundHadMutations(): void { legacyRoundHadMutations = false; }
function readLegacyHadVerification(): boolean { return legacyHadVerification; }

export function resetLegacyRunLoopFlags(): void {
  legacyRoundHadMutations = false;
  legacyHadVerification = false;
}

/**
 * Retention Fingerprint — per-family equivalence identity for tool results.
 *
 * Returns a stable fingerprint string for operations that should be
 * subject to latest+1 retention. Returns null for operations that
 * must never be fingerprinted (mutations, session ops, reads).
 */

import type { OperationKind } from './batch/types';

function sortedJoin(arr: unknown[]): string {
  return [...arr].filter(v => typeof v === 'string').map(String).sort().join(',');
}

export function buildRetentionFingerprint(
  use: OperationKind | string,
  params: Record<string, unknown>,
): string | null {
  if (use.startsWith('change.') || use.startsWith('session.') || use.startsWith('annotate.')
    || use.startsWith('read.') || use.startsWith('delegate.')) {
    return null;
  }

  switch (use) {
    case 'search.code': {
      const queries = Array.isArray(params.queries) ? params.queries : [];
      return `search.code:${sortedJoin(queries)}`;
    }
    case 'search.symbol': {
      const names = Array.isArray(params.symbol_names) ? params.symbol_names
        : params.name ? [params.name] : params.query ? [params.query] : [];
      return `search.symbol:${sortedJoin(names)}`;
    }
    case 'search.usage': {
      const syms = Array.isArray(params.symbol_names) ? params.symbol_names : [];
      return `search.usage:${sortedJoin(syms)}`;
    }
    case 'search.similar':
      return `search.similar:${String(params.type ?? 'code')}:${String(params.query ?? '')}`;
    case 'search.issues':
      return 'search.issues';
    case 'search.patterns':
      return 'search.patterns';

    case 'verify.build':
    case 'verify.test':
    case 'verify.lint':
    case 'verify.typecheck':
      return `verify:${use}`;

    case 'system.exec': {
      const cmd = typeof params.cmd === 'string' ? params.cmd : '';
      return `exec:${cmd}`;
    }
    case 'system.git': {
      const action = typeof params.action === 'string' ? params.action : '';
      const mutating = ['stage', 'unstage', 'commit', 'push', 'reset'];
      if (mutating.includes(action)) return null;
      return `git:${action}`;
    }
    case 'system.workspaces':
      return 'system.workspaces';
    case 'system.help':
      return null;

    default: {
      if (use.startsWith('analyze.')) {
        const fps = Array.isArray(params.file_paths) ? params.file_paths : [];
        return `analyze:${use}:${sortedJoin(fps)}`;
      }
      return null;
    }
  }
}

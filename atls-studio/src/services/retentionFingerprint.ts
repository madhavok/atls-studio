/**
 * Retention Fingerprint — per-family equivalence identity for tool results.
 *
 * Returns a stable fingerprint string for operations that should be
 * subject to latest+1 retention. Returns null for operations that
 * must never be fingerprinted (mutations, session ops, reads).
 */

import type { OperationKind } from './batch/types';

export interface SemanticSignature {
  opKind: string;
  targetFiles: string[];
  targetSymbols?: string[];
  verificationTarget?: string;
}

export interface FingerprintResult {
  fingerprint: string;
  semanticSignature: SemanticSignature;
}

function sortedJoin(arr: unknown[]): string {
  return [...arr].filter(v => typeof v === 'string').map(String).sort().join(',');
}

export function buildRetentionFingerprint(
  use: OperationKind | string,
  params: Record<string, unknown>,
): FingerprintResult | null {
  if (use.startsWith('change.') || use.startsWith('session.') || use.startsWith('annotate.')
    || use.startsWith('read.') || use.startsWith('delegate.')) {
    return null;
  }

  switch (use) {
    case 'search.code': {
      const queries = Array.isArray(params.queries) ? params.queries : [];
      return {
        fingerprint: `search.code:${sortedJoin(queries)}`,
        semanticSignature: { opKind: use, targetFiles: [], targetSymbols: queries.filter((q): q is string => typeof q === 'string') },
      };
    }
    case 'search.symbol': {
      const names = Array.isArray(params.symbol_names) ? params.symbol_names
        : params.name ? [params.name] : params.query ? [params.query] : [];
      return {
        fingerprint: `search.symbol:${sortedJoin(names)}`,
        semanticSignature: { opKind: use, targetFiles: [], targetSymbols: names.filter((n): n is string => typeof n === 'string') },
      };
    }
    case 'search.usage': {
      const syms = Array.isArray(params.symbol_names) ? params.symbol_names : [];
      return {
        fingerprint: `search.usage:${sortedJoin(syms)}`,
        semanticSignature: { opKind: use, targetFiles: [], targetSymbols: syms.filter((s): s is string => typeof s === 'string') },
      };
    }
    case 'search.similar':
      return {
        fingerprint: `search.similar:${String(params.type ?? 'code')}:${String(params.query ?? '')}`,
        semanticSignature: { opKind: use, targetFiles: [], targetSymbols: [String(params.query ?? '')] },
      };
    case 'search.issues':
      return {
        fingerprint: 'search.issues',
        semanticSignature: { opKind: use, targetFiles: [], targetSymbols: [] },
      };
    case 'search.patterns':
      return {
        fingerprint: 'search.patterns',
        semanticSignature: { opKind: use, targetFiles: [], targetSymbols: [] },
      };

    case 'verify.build':
    case 'verify.test':
    case 'verify.lint':
    case 'verify.typecheck':
    case 'system.exec':
    case 'system.git':
      return null;
    case 'system.workspaces':
      return {
        fingerprint: 'system.workspaces',
        semanticSignature: { opKind: use, targetFiles: [], targetSymbols: [] },
      };
    case 'system.help':
      return null;

    case 'analyze.graph': {
      const syms = Array.isArray(params.symbol_names) ? params.symbol_names : [];
      const mode = typeof params.mode === 'string' ? params.mode : 'callees';
      const depth = typeof params.depth === 'number' ? params.depth : 3;
      const targetSymbols = syms.filter((s): s is string => typeof s === 'string');
      return {
        fingerprint: `analyze.graph:${mode}:${depth}:${sortedJoin(syms)}`,
        semanticSignature: { opKind: use, targetFiles: [], targetSymbols },
      };
    }
    case 'analyze.calls': {
      const syms = Array.isArray(params.symbol_names) ? params.symbol_names : [];
      const depth = typeof params.depth === 'number' ? params.depth : 2;
      const targetSymbols = syms.filter((s): s is string => typeof s === 'string');
      return {
        fingerprint: `analyze.calls:${depth}:${sortedJoin(syms)}`,
        semanticSignature: { opKind: use, targetFiles: [], targetSymbols },
      };
    }
    default: {
      if (use.startsWith('analyze.')) {
        const fps = Array.isArray(params.file_paths) ? params.file_paths : [];
        const singular =
          typeof params.file_path === 'string' && params.file_path.trim().length > 0
            ? params.file_path.trim()
            : '';
        const pathsForKey = fps.length > 0 ? fps : singular ? [singular] : [];
        const targetFiles = pathsForKey.filter((f): f is string => typeof f === 'string');
        return {
          fingerprint: `analyze:${use}:${sortedJoin(pathsForKey)}`,
          semanticSignature: { opKind: use, targetFiles },
        };
      }
      return null;
    }
  }
}

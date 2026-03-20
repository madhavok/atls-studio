import { invoke } from '@tauri-apps/api/core';
import { useContextStore } from '../stores/contextStore';
import { getPreflightAutomationDecision, runFreshnessPreflight } from './freshnessPreflight';
import {
  resolveHashRefsInParams,
  setRecencyResolver,
  setEditRecencyResolver,
  setReadRecencyResolver,
  setStageRecencyResolver,
  type HashLookup as HppHashLookup,
} from '../utils/hashResolver';
import { parseSetExpression } from '../utils/hashRefParsers';
import { getTurn } from './hashProtocol';

const TOOL_TIMEOUT_MS = 120000;

/** Ensures h:$last / h:$last_edit / h:$last_read resolvers point at contextStore.
 * Call before resolveHashRefsInParams — covers paths that load toolHelpers before aiService. */
let _hppRecencyResolversWired = false;
function ensureHppRecencyResolversWired(): void {
  if (_hppRecencyResolversWired) return;
  _hppRecencyResolversWired = true;
  const store = () => useContextStore.getState();
  setRecencyResolver((offset) => store().resolveRecencyRef(offset));
  setEditRecencyResolver((offset) => store().resolveEditRecencyRef(offset));
  setReadRecencyResolver((offset) => store().resolveReadRecencyRef(offset));
  setStageRecencyResolver((offset) => store().resolveStageRecencyRef(offset));
}

// ---------------------------------------------------------------------------
// HPP-Native Search: per-turn cache for h:@search(query) results
// ---------------------------------------------------------------------------

interface SearchResult {
  hash: string;
  source: string;
  line: number;
  symbol: string;
  kind: string;
  relevance: number;
  signature?: string;
}

let _searchCacheTurn = -1;
const _searchCache = new Map<string, SearchResult[]>();

function getSearchCache(turn: number): Map<string, SearchResult[]> {
  if (_searchCacheTurn !== turn) {
    _searchCache.clear();
    _searchCacheTurn = turn;
  }
  return _searchCache;
}

function parseSearchRefSpec(fullRef: string): { query: string; limit?: number; tier?: string; suffix: string } | null {
  const parsed = parseSetExpression(fullRef);
  if (!parsed || 'left' in parsed || parsed.selector.kind !== 'search') return null;
  const close = fullRef.lastIndexOf(')');
  return {
    query: parsed.selector.query,
    limit: parsed.selector.limit,
    tier: parsed.selector.tier,
    suffix: close >= 0 ? fullRef.slice(close + 1) : '',
  };
}

function collectSearchRefsFromString(text: string): string[] {
  const refs: string[] = [];
  const prefix = 'h:@search(';
  const delimiter = /[\s"'`{}\[\],;]/;
  let offset = 0;

  while (offset < text.length) {
    const start = text.indexOf(prefix, offset);
    if (start < 0) break;

    let pos = start + prefix.length;
    let parenDepth = 1;
    while (pos < text.length && parenDepth > 0) {
      const ch = text[pos];
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      pos++;
    }
    if (parenDepth !== 0) break;

    let bestRef: string | null = parseSearchRefSpec(text.slice(start, pos)) ? text.slice(start, pos) : null;
    let bestEnd = pos;
    let suffixDepth = 0;
    while (pos < text.length) {
      const ch = text[pos];
      if (suffixDepth === 0 && delimiter.test(ch)) break;
      if (ch === '(') suffixDepth++;
      else if (ch === ')' && suffixDepth > 0) suffixDepth--;
      pos++;
      const candidate = text.slice(start, pos);
      if (parseSearchRefSpec(candidate)) {
        bestRef = candidate;
        bestEnd = pos;
      }
    }

    if (bestRef) {
      refs.push(bestRef);
      offset = bestEnd;
    } else {
      offset = start + prefix.length;
    }
  }

  return refs;
}

function collectSearchRefsInValue(value: unknown, refs: Set<string>): void {
  if (typeof value === 'string') {
    for (const ref of collectSearchRefsFromString(value)) refs.add(ref);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchRefsInValue(item, refs);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectSearchRefsInValue(entry, refs);
  }
}

export async function resolveSearchRefs(
  params: Record<string, unknown>,
  turn: number,
): Promise<Record<string, unknown>> {
  function replaceSearchRefsInValue(
    value: unknown,
    replacements: Map<string, string | string[]>,
  ): unknown {
    if (typeof value === 'string') {
      if (replacements.has(value)) return replacements.get(value);
      let next = value;
      for (const [fullRef, replacement] of replacements) {
        if (!next.includes(fullRef) || typeof replacement !== 'string') continue;
        next = next.split(fullRef).join(replacement);
      }
      return next;
    }
    if (Array.isArray(value)) {
      return value.map((item) => replaceSearchRefsInValue(item, replacements));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, replaceSearchRefsInValue(entry, replacements)]),
      );
    }
    return value;
  }

  const matches = new Set<string>();
  collectSearchRefsInValue(params, matches);
  if (matches.size === 0) return params;

  const cache = getSearchCache(turn);
  const uniqueRefs = new Map<string, { query: string; limit?: number; tier?: string; suffix: string }>();
  for (const fullRef of matches) {
    if (uniqueRefs.has(fullRef)) continue;
    const parsed = parseSearchRefSpec(fullRef);
    if (parsed) uniqueRefs.set(fullRef, parsed);
  }

  for (const [fullRef, opts] of uniqueRefs) {
    if (cache.has(fullRef)) continue;
    try {
      const results = await invoke<SearchResult[]>('resolve_search_selector', {
        query: opts.query,
        limit: opts.limit ?? 10,
        tier: opts.tier ?? null,
      });
      cache.set(fullRef, results);
      const store = useContextStore.getState();
      for (const r of results) store.pushHash(r.hash);
    } catch (e) {
      console.warn(`[HPP] search selector failed for "${opts.query}":`, e);
      cache.set(fullRef, []);
    }
  }

  const replacements = new Map<string, string | string[]>();
  for (const [fullRef, opts] of uniqueRefs) {
    const results = cache.get(fullRef) ?? [];
    const hashes = results.map(r => `h:${r.hash}${opts.suffix}`);
    replacements.set(fullRef, hashes.length === 1 ? hashes[0] : hashes);
  }
  return replaceSearchRefsInValue(params, replacements) as Record<string, unknown>;
}

function inferNodeWorkspaceCwd(errorText: string): string | null {
  if (!errorText || !/package\.json/i.test(errorText)) return null;
  if (/atls-studio\\package\.json/i.test(errorText) || /atls-studio\/package\.json/i.test(errorText)) {
    return 'atls-studio';
  }
  if (/src-tauri\\Cargo\.toml/i.test(errorText) || /src-tauri\/Cargo\.toml/i.test(errorText)) {
    return 'atls-studio/src-tauri';
  }
  return null;
}

export function buildWorkspaceVerifyHint(errorText: string): string | null {
  const workspace = inferNodeWorkspaceCwd(errorText);
  if (!workspace) return null;
  return `Run the verify command from ${workspace} (workspace/package root) before retrying.`;
}

export function buildSharedExportRemovalWarning(filePath: string, params: Record<string, unknown>): string | null {
  if (!/src[\\/]prompts[\\/].+\.ts$/i.test(filePath)) return null;
  const serialized = JSON.stringify(params);
  if (!serialized.includes('delete') && !serialized.includes('old')) return null;
  if (!serialized.includes('export const') && !serialized.includes('export {')) return null;
  return 'Shared prompt export change detected. Search live importers and verify blast radius before removing or renaming exports.';
}
export function resolveProjectPath(filePath: string): string {
  const projectPath = getProjectPath();
  if (!projectPath) {
    return filePath;
  }
  const separator = projectPath.includes('\\') ? '\\' : '/';
  return `${projectPath}${separator}${filePath}`;
}

let _projectPathGetter: (() => string | null) | null = null;

/** Inject the project-path accessor to avoid circular imports with appStore. */
export function setProjectPathGetter(fn: () => string | null): void {
  _projectPathGetter = fn;
}

export function getProjectPath(): string | null {
  return _projectPathGetter ? _projectPathGetter() : null;
}

export async function invokeWithTimeout<T>(
  cmd: string,
  args: Record<string, unknown>,
  timeoutMs: number = TOOL_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const invokePromise = invoke<T>(cmd, args);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([invokePromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

interface HashLookup {
  (ref: string): { source?: string; content?: string } | undefined;
}

export function createHashLookup(sessionId: string | null): HashLookup {
  const ctx = useContextStore.getState();
  const fromStore = (ref: string) => {
    return ctx.getChunkForHashRef(ref);
  };

  return (ref: string) => {
    const resolved = fromStore(ref);
    if (resolved) {
      return { source: resolved.source, content: resolved.content };
    }
    return undefined;
  };
}

/** Async hash lookup that falls back to backend registry on context store miss. */
export async function resolveHashFromBackend(
  ref: string,
): Promise<{ source?: string; content: string } | null> {
  const ctx = useContextStore.getState();
  const local = ctx.getChunkForHashRef(ref);
  if (local) return { source: local.source, content: local.content };

  try {
    const results = await invoke<Array<{ source: string | null; content: string; tokens: number } | null>>(
      'batch_resolve_hash_refs',
      { refs: [ref.startsWith('h:') ? ref : `h:${ref}`] },
    );
    const entry = results?.[0];
    if (entry) return { source: entry.source ?? undefined, content: entry.content };
  } catch {
    // Backend miss — ref not found anywhere
  }
  return null;
}

export async function atlsBatchQuery(
  operation: string,
  params: Record<string, unknown>,
  timeoutMs: number = TOOL_TIMEOUT_MS
): Promise<unknown> {
  ensureHppRecencyResolversWired();
  const sessionId = localStorage.getItem('current_session_id');
  const syncLookup = createHashLookup(sessionId);
  const setLookup = useContextStore.getState().createSetRefLookup();

  const hppLookup: HppHashLookup = async (hash: string) => {
    const r = syncLookup(hash.startsWith('h:') ? hash.slice(2) : hash);
    if (!r?.content) return null;
    return { content: r.content, source: r.source };
  };

  const searchResolved = await resolveSearchRefs(params, getTurn());

  const resolved = await resolveHashRefsInParams(
    searchResolved, hppLookup, undefined, setLookup,
  ) as Record<string, unknown>;

  const atlsBatchQueryForPreflight = async (op: string, p: Record<string, unknown>) =>
    invokeWithTimeout(
      'atls_batch_query',
      { operation: op, params: p, sessionId, hashLookup: syncLookup, setLookup },
      timeoutMs,
    );

  const preflight = await runFreshnessPreflight(operation, resolved, {
    atlsBatchQuery: atlsBatchQueryForPreflight,
  });
  const store = useContextStore.getState();
  store.recordRebindOutcomes(preflight.decisions);
  const automation = getPreflightAutomationDecision(preflight);

  if (preflight.blocked) {
    throw new Error(preflight.error ?? 'File changed externally; re-read required');
  }
  if (automation.action === 'review_required') {
    throw new Error(`Low-confidence ${preflight.strategy} rebind detected; re-read the target file before editing`);
  }

  const paramsToSend = preflight.params;

  return invokeWithTimeout(
    'atls_batch_query',
    {
      operation,
      params: paramsToSend,
      sessionId,
      hashLookup: syncLookup,
      setLookup,
    },
    timeoutMs
  );
}

export function normalizeToolParams(params: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

/**
 * Universal UHPP resolution middleware. Resolves all h: refs in tool params
 * before dispatch. Covers search refs, recency refs, hash refs, set refs,
 * and temporal refs in a single pass.
 *
 * Tools that handle their own per-op resolution (manage batch) should skip this.
 */
export async function resolveToolParams(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  ensureHppRecencyResolversWired();
  const sessionId = localStorage.getItem('current_session_id');
  const syncLookup = createHashLookup(sessionId);
  const setLookup = useContextStore.getState().createSetRefLookup();

  const hppLookup: HppHashLookup = async (hash: string) => {
    const r = syncLookup(hash.startsWith('h:') ? hash.slice(2) : hash);
    if (!r?.content) return null;
    return { content: r.content, source: r.source };
  };

  const searchResolved = await resolveSearchRefs(params, getTurn());

  const resolved = await resolveHashRefsInParams(
    searchResolved, hppLookup, undefined, setLookup,
  ) as Record<string, unknown>;

  return resolved;
}

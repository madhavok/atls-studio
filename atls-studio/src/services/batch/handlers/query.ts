/**
 * Query operation handlers — search, symbol, deps (proxy to atlsBatchQuery).
 */

import type {
  HandlerContext,
  OpHandler,
  StepOutput,
  SearchCodeParams,
  SearchSymbolParams,
  SearchUsageParams,
  AnalyzeDepsParams,
  AnalyzeImpactParams,
  AnalyzeBlastRadiusParams,
  AnalyzeStructureParams,
  SearchMemoryParams,
} from '../types';
import {
  extractSearchSummary,
  extractSymbolSummary,
  extractDepsSummary,
  flattenCodeSearchHits,
  type CodeSearchHitRow,
} from '../../../utils/contextHash';
import { countTokensSync } from '../../../utils/tokenCounter';
import { formatResult, FORMAT_RESULT_MAX_SEARCH } from '../../../utils/toon';
import { checkRetention } from './retention';
import { useAppStore } from '../../../stores/appStore';

/**
 * Check if any result file paths overlap with the entry manifest and return a nudge note.
 *
 * When `wasScoped` is true (caller passed explicit `file_paths` to narrow the
 * search), the nudge is suppressed: the agent clearly wanted FTS within that
 * specific file and pointing them at `rc`/`rs` would not help — the entry
 * manifest only carries signatures, not text. The nudge is meant for
 * *unscoped* searches that incidentally hit a manifested file during
 * discovery.
 */
function getManifestHitNote(filePaths: string[], wasScoped = false): string {
  if (wasScoped) return '';
  if (filePaths.length === 0) return '';
  const manifest = useAppStore.getState().projectProfile?.entryManifest;
  if (!manifest?.length) return '';
  const manifestPaths = new Set(manifest.map(e => e.path.replace(/\\/g, '/')));
  const hits = filePaths.filter(fp => manifestPaths.has(fp.replace(/\\/g, '/')));
  if (hits.length === 0) return '';
  return `MANIFEST: ${hits.join(', ')} already in entry manifest (system prompt, 0tk). Use read.context or read.shaped directly — no search needed for known entry points.\n`;
}

function err(label: string, msg: string): StepOutput {
  return { kind: 'search_results', ok: false, refs: [], summary: `${label}: ERROR ${msg}`, error: msg };
}

/** Unique file paths in hit order (first occurrence per file) — feeds `content.file_paths` for from_step bindings. */
function extractFilePathsFromSearchResult(result: unknown): string[] {
  const rows = flattenCodeSearchHits(result);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const r of rows) {
    if (!seen.has(r.file)) {
      seen.add(r.file);
      paths.push(r.file);
    }
  }
  return paths;
}

/** 1-based line numbers per unique file (parallel to extractFilePathsFromSearchResult). */
function extractLinesFromSearchResult(result: unknown): number[] {
  const rows = flattenCodeSearchHits(result);
  const seen = new Set<string>();
  const lines: number[] = [];
  for (const r of rows) {
    if (seen.has(r.file)) continue;
    seen.add(r.file);
    lines.push(r.line);
  }
  return lines;
}

/** Paired end_lines for search hits: end_line when set, otherwise same as line. */
function extractEndLinesFromSearchResult(result: unknown): number[] {
  const rows = flattenCodeSearchHits(result);
  const seen = new Set<string>();
  const endLines: number[] = [];
  for (const r of rows) {
    if (seen.has(r.file)) continue;
    seen.add(r.file);
    const start = r.line;
    endLines.push(r.end_line != null && r.end_line >= start ? r.end_line : start);
  }
  return endLines;
}

/**
 * One entry per search hit (not deduped by file) — aligns `content.file_paths.${i}` with
 * intent.search_replace edit slots and `content.lines.${i}`.
 */
function extractPerHitStructured(result: unknown, maxHits: number): {
  file_paths: string[];
  lines: number[];
  end_lines: number[];
  capped: boolean;
} {
  const rows = flattenCodeSearchHits(result);
  const slice = typeof maxHits === 'number' && maxHits > 0 && rows.length > maxHits
    ? rows.slice(0, maxHits)
    : rows;
  const file_paths = slice.map(r => r.file);
  const lines = slice.map(r => r.line);
  const end_lines = slice.map((r) => {
    const start = r.line;
    const el = r.end_line;
    return el != null && el >= start ? el : start;
  });
  return {
    file_paths,
    lines,
    end_lines,
    capped: slice.length < rows.length,
  };
}

const LITERAL_FALLBACK_MAX = 50;

function normalizeSearchPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function hasGlobMagic(path: string): boolean {
  return /[*?[\]{}]/.test(path);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function globToRegex(glob: string): RegExp {
  const pattern = normalizeSearchPath(glob);
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === '*' && next === '*') {
      const after = pattern[i + 2];
      if (after === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegexLiteral(ch);
    }
  }
  source += '$';
  return new RegExp(source);
}

function filterCandidatePathsByScope(candidatePaths: string[], scopes: string[] | undefined): string[] {
  if (!scopes?.length) return candidatePaths;

  const concreteScopes = new Set(
    scopes
      .filter(scope => typeof scope === 'string' && scope && !hasGlobMagic(scope))
      .map(normalizeSearchPath),
  );
  const globScopes = scopes
    .filter(scope => typeof scope === 'string' && scope && hasGlobMagic(scope))
    .map(globToRegex);

  return candidatePaths.filter((candidate) => {
    const normalized = normalizeSearchPath(candidate);
    return concreteScopes.has(normalized) || globScopes.some(re => re.test(normalized));
  });
}

function concreteScopedPaths(scopes: string[] | undefined): string[] {
  if (!scopes?.length) return [];
  return scopes.filter(scope => typeof scope === 'string' && scope && !hasGlobMagic(scope));
}

/**
 * Drop search-result entries that point at ATLS linter scratch files
 * (`__atls_check_*.ts`). These are created by verify.lint pre-write syntax
 * checks and RAII-cleaned on the Rust side, but the FTS / symbol / similar
 * indexes can briefly hold stale entries that leak into any search.* result
 * shape. Called by every search handler before formatResult / chunking so
 * neither the rendered text nor the structured content bindings see scratch
 * hits.
 *
 * Covers backend shapes:
 *   - code_search: `{results: [{query?, results|hits|groups: [...]}]}`
 *   - find_similar_code: `{results: [{file, line, ...}]}`
 *   - find_symbol / symbol_usage / find_issues / detect_patterns: same
 *     top-level `results[]` with per-entry `file` / `path`.
 *   - tiered `{high, medium}` and compact `{r}` variants.
 *
 * Mutates in place.
 */
function scrubScratchHitsFromResult(result: unknown): void {
  const isScratchFile = (v: unknown): boolean => {
    if (typeof v !== 'string') return false;
    const base = v.replace(/\\/g, '/').split('/').pop() ?? '';
    return base.startsWith('__atls_check_');
  };
  const filterArr = (arr: unknown[]): unknown[] =>
    arr.filter((h) => {
      if (!h || typeof h !== 'object') return true;
      const o = h as Record<string, unknown>;
      const file = o.file ?? o.f ?? o.path ?? o.file_path;
      if (isScratchFile(file)) return false;
      // Recurse into nested hit lists (groups / tiered blocks).
      for (const k of ['results', 'hits', 'matches', 'r', 'high', 'medium', 'groups']) {
        const v = o[k];
        if (Array.isArray(v)) o[k] = filterArr(v);
      }
      return true;
    });
  if (!result || typeof result !== 'object') return;
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.results)) obj.results = filterArr(obj.results);
  for (const k of ['hits', 'matches', 'high', 'medium', 'groups']) {
    const v = obj[k];
    if (Array.isArray(v)) obj[k] = filterArr(v);
  }
}

/** When FTS yields no structured hits, find 1-based line numbers by substring scan (scoped search / intent.search_replace). */
function literalHitsFromContent(filePath: string, content: string, query: string): CodeSearchHitRow[] {
  const rows: CodeSearchHitRow[] = [];
  const q = query;
  if (!q.trim() || !filePath) return rows;
  const lines = content.split(/\r?\n/);
  const qLines = q.split('\n');
  if (qLines.length === 1) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(q)) {
        rows.push({ file: filePath, line: i + 1, end_line: i + 1 });
        if (rows.length >= LITERAL_FALLBACK_MAX) break;
      }
    }
  } else {
    const idx = content.indexOf(q);
    if (idx >= 0) {
      const startLine = content.slice(0, idx).split('\n').length;
      const endLine = startLine + qLines.length - 1;
      rows.push({ file: filePath, line: startLine, end_line: endLine });
    }
  }
  return rows;
}

function extractFirstContextFileContent(result: unknown): { file: string; content: string } | null {
  if (!result || typeof result !== 'object') return null;
  const items = (result as Record<string, unknown>).results;
  if (!Array.isArray(items) || items.length === 0) return null;
  const r = items[0] as Record<string, unknown>;
  const raw = r.content ?? r.context ?? r.text;
  const content = typeof raw === 'string' ? raw : '';
  if (!content) return null;
  const file =
    (typeof r.file === 'string' && r.file) ||
    (typeof r.path === 'string' && r.path) ||
    '';
  if (!file) return null;
  return { file, content };
}

async function literalFallbackHitsForScopedSearch(
  ctx: HandlerContext,
  filePath: string,
  query: string,
): Promise<CodeSearchHitRow[]> {
  try {
    const ctxRes = await ctx.atlsBatchQuery('context', { type: 'full', file_paths: [filePath] });
    const ext = extractFirstContextFileContent(ctxRes);
    if (!ext) return [];
    return literalHitsFromContent(ext.file, ext.content, query);
  } catch {
    return [];
  }
}

async function literalFilteredHitsForFiles(
  ctx: HandlerContext,
  filePaths: string[],
  query: string,
  maxHits: number,
): Promise<CodeSearchHitRow[]> {
  if (!query.trim() || filePaths.length === 0) return [];

  const rows: CodeSearchHitRow[] = [];
  const seen = new Set<string>();
  for (const fp of filePaths) {
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    const hits = await literalFallbackHitsForScopedSearch(ctx, fp, query);
    for (const hit of hits) {
      rows.push(hit);
      if (maxHits > 0 && rows.length >= maxHits) return rows;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// search.code
// ---------------------------------------------------------------------------

export const handleSearchCode: OpHandler = async (params, ctx) => {
  const queries = params.queries as string[];
  if (!queries?.length) return err('search', 'missing queries param');

  try {
    const filePaths = params.file_paths as string[] | undefined;
    const searchParams: Record<string, unknown> = { queries };
    if (filePaths?.length) searchParams.file_paths = filePaths;
    const result = await ctx.atlsBatchQuery('code_search', searchParams);
    // Scrub before summary/format/chunk so downstream consumers never see
    // stale linter-scratch hits. `flattenCodeSearchHits` is a second line of
    // defense for the structured-content bindings path.
    scrubScratchHitsFromResult(result);
    const summary = extractSearchSummary(result, queries);
    const resultStr = formatResult(result, FORMAT_RESULT_MAX_SEARCH);

    const maxPaths = params.max_file_paths;
    const rowCap = typeof maxPaths === 'number' && maxPaths > 0 ? maxPaths : 0;
    let perHit = extractPerHitStructured(result, rowCap);

    const exactTextRaw = typeof params.exact_text === 'string' ? params.exact_text : '';
    const exactText = exactTextRaw.trim() ? exactTextRaw : '';

    if (
      !exactText &&
      perHit.file_paths.length === 0 &&
      Array.isArray(filePaths) &&
      filePaths.length === 1 &&
      typeof filePaths[0] === 'string' &&
      queries.length >= 1
    ) {
      const fb = await literalFallbackHitsForScopedSearch(ctx, filePaths[0], exactText || queries[0]);
      if (fb.length > 0) {
        const cappedByMax = rowCap > 0 ? fb.slice(0, rowCap) : fb;
        perHit = {
          file_paths: cappedByMax.map((r) => r.file),
          lines: cappedByMax.map((r) => r.line),
          end_lines: cappedByMax.map((r) => {
            const start = r.line;
            const el = r.end_line;
            return el != null && el >= start ? el : start;
          }),
          capped: rowCap > 0 && fb.length > rowCap,
        };
      }
    }

    if (exactText) {
      const uncappedPerHit = extractPerHitStructured(result, 0);
      const ftsCandidatePaths = filterCandidatePathsByScope(uncappedPerHit.file_paths, filePaths);
      const candidatePaths = ftsCandidatePaths.length > 0
        ? ftsCandidatePaths
        : concreteScopedPaths(filePaths);
      const literalHits = await literalFilteredHitsForFiles(ctx, candidatePaths, exactText, rowCap);
      perHit = {
        file_paths: literalHits.map((r) => r.file),
        lines: literalHits.map((r) => r.line),
        end_lines: literalHits.map((r) => {
          const start = r.line;
          const el = r.end_line;
          return el != null && el >= start ? el : start;
        }),
        capped: rowCap > 0 && literalHits.length >= rowCap,
      };
    }

    // `file_paths`/`lines`/`end_lines` are per-hit and parallel, so
    // callers that need hit-aligned data (line-scoped edits) keep working.
    // `unique_file_paths` is the deduped per-file view — consumers that
    // operate at file granularity (intent.search_replace text-replace) bind
    // against this to avoid emitting duplicate edit slots when one file has
    // multiple FTS hits. First-occurrence order preserved.
    const seenForUnique = new Set<string>();
    const uniqueFilePaths: string[] = [];
    for (const fp of perHit.file_paths) {
      if (seenForUnique.has(fp)) continue;
      seenForUnique.add(fp);
      uniqueFilePaths.push(fp);
    }
    const structuredContent = {
      file_paths: perHit.file_paths,
      lines: perHit.lines,
      end_lines: perHit.end_lines,
      unique_file_paths: uniqueFilePaths,
    };
    const cappedNote = perHit.capped && typeof maxPaths === 'number' && maxPaths > 0
      ? ` — hits capped to ${maxPaths}`
      : '';

    const retained = checkRetention('search.code', params, resultStr, true, 'search_results', `search: ${queries.join(', ')}`, undefined, structuredContent);
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'search', queries.join(', '), undefined, summary, undefined, {
      // Enable auto-drop once the model reads all hit paths: carry the
      // deduped file set so the store can decide when the search is
      // fully superseded. See `dropSupersededSearches`.
      searchPaths: uniqueFilePaths,
    });
    const tk = countTokensSync(resultStr);
    const wasScoped = Array.isArray(filePaths) && filePaths.length > 0;
    const manifestNote = getManifestHitNote([...new Set(structuredContent.file_paths)], wasScoped);
    return {
      kind: 'search_results', ok: true,
      refs: [`h:${hash}`],
      summary: `${manifestNote}search: ${queries.join(', ')} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)${cappedNote}`,
      tokens: tk,
      content: structuredContent,
    };
  } catch (searchErr) {
    return err('search', searchErr instanceof Error ? searchErr.message : String(searchErr));
  }
};

// ---------------------------------------------------------------------------
// search.symbol
// ---------------------------------------------------------------------------

export const handleSearchSymbol: OpHandler = async (params, ctx) => {
  const p = params as Partial<SearchSymbolParams>;
  const queries = p.symbol_names;
  if (!queries?.length) return err('find_symbol', 'missing symbol_names param');

  try {
    const result = await ctx.atlsBatchQuery('find_symbol', { symbol_names: queries, query: queries[0] });
    scrubScratchHitsFromResult(result);
    const resultStr = formatResult(result, FORMAT_RESULT_MAX_SEARCH);
    const resultFilePaths = extractFilePathsFromSearchResult(result);
    const resultLines = extractLinesFromSearchResult(result);
    const resultEndLines = extractEndLinesFromSearchResult(result);
    const structuredContent = { file_paths: resultFilePaths, lines: resultLines, end_lines: resultEndLines };
    const retained = checkRetention('search.symbol', params, resultStr, true, 'symbol_refs', `find_symbol: ${queries.join(', ')}`, undefined, structuredContent);
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'symbol', queries.join(', '));
    const tk = countTokensSync(resultStr);
    const manifestNote = getManifestHitNote(resultFilePaths);
    return {
      kind: 'symbol_refs', ok: true,
      refs: [`h:${hash}`],
      summary: `${manifestNote}find_symbol: ${queries.join(', ')} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
      content: structuredContent,
    };
  } catch (findErr) {
    return err('find_symbol', findErr instanceof Error ? findErr.message : String(findErr));
  }
};

// ---------------------------------------------------------------------------
// search.usage
// ---------------------------------------------------------------------------

export const handleSearchUsage: OpHandler = async (params, ctx) => {
  const symbolNames = params.symbol_names as string[];
  if (!symbolNames?.length) return err('symbols', 'missing symbol_names param');

  try {
    const result = await ctx.atlsBatchQuery('symbol_usage', { symbol_names: symbolNames });
    scrubScratchHitsFromResult(result);
    const summary = extractSymbolSummary(result, symbolNames);
    const resultStr = formatResult(result, FORMAT_RESULT_MAX_SEARCH);
    const resultFilePaths = extractFilePathsFromSearchResult(result);
    const resultLines = extractLinesFromSearchResult(result);
    const resultEndLines = extractEndLinesFromSearchResult(result);
    const structuredContent = { file_paths: resultFilePaths, lines: resultLines, end_lines: resultEndLines };
    const retained = checkRetention('search.usage', params, resultStr, true, 'symbol_refs', `symbols: ${symbolNames.join(', ')}`, undefined, structuredContent);
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'symbol', symbolNames.join(', '), undefined, summary);
    const tk = countTokensSync(resultStr);
    return {
      kind: 'symbol_refs', ok: true,
      refs: [`h:${hash}`],
      summary: `symbols: ${symbolNames.join(', ')} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
      content: structuredContent,
    };
  } catch (symErr) {
    return err('symbols', symErr instanceof Error ? symErr.message : String(symErr));
  }
};

// ---------------------------------------------------------------------------
// search.similar
// ---------------------------------------------------------------------------

const SIMILAR_TYPE_TO_OP: Record<string, string> = {
  code: 'find_similar_code',
  function: 'find_similar_functions',
  concept: 'find_conceptual_matches',
  pattern: 'find_pattern_implementations',
};

export const handleSearchSimilar: OpHandler = async (params, ctx) => {
  try {
    const simType = (params.type as string) || 'code';
    const operation = SIMILAR_TYPE_TO_OP[simType] || 'find_similar_code';
    let batchParams = { ...params };
    if (operation === 'find_similar_functions' && !params.function_names && !params.functions) {
      const q = params.query;
      const arr = Array.isArray(q) ? q : (typeof q === 'string' && q ? [q] : []);
      batchParams = { ...params, function_names: arr.filter(Boolean).map(String) };
    }
    if (operation === 'find_conceptual_matches' && !params.concepts && !params.concept) {
      const q = params.query;
      const arr = Array.isArray(q) ? q : (typeof q === 'string' && q ? [q] : []);
      if (arr.length) batchParams = { ...batchParams, concepts: arr.filter(Boolean).map(String) };
    }
    // Backend `find_similar_code` requires `pattern`/`code` (or file+line_range).
    // Public schema advertises `query` across all subtypes; coerce when caller
    // omits the canonical param but supplied query text.
    if (operation === 'find_similar_code' && !params.pattern && !params.code) {
      const q = params.query;
      const patternStr = Array.isArray(q)
        ? q.filter(Boolean).map(String).join('\n')
        : (typeof q === 'string' ? q : '');
      if (patternStr) batchParams = { ...batchParams, pattern: patternStr };
    }
    // Backend `find_pattern_implementations` reads `patterns` (array); without
    // it, it silently falls back to 9 preset patterns — dropping the caller's
    // intent. Coerce `query` → `patterns[]` when canonical is absent.
    if (operation === 'find_pattern_implementations' && !params.patterns) {
      const q = params.query;
      const arr = Array.isArray(q)
        ? q.filter(Boolean).map(String)
        : (typeof q === 'string' && q ? [q] : []);
      if (arr.length) batchParams = { ...batchParams, patterns: arr };
    }
    const result = await ctx.atlsBatchQuery(operation, batchParams);
    scrubScratchHitsFromResult(result);
    const resultStr = formatResult(result, FORMAT_RESULT_MAX_SEARCH);
    const retained = checkRetention('search.similar', params, resultStr, true, 'search_results', 'find_similar');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'search', 'find_similar');
    const tk = countTokensSync(resultStr);
    return {
      kind: 'search_results', ok: true,
      refs: [`h:${hash}`],
      summary: `find_similar → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (simErr) {
    return err('find_similar', simErr instanceof Error ? simErr.message : String(simErr));
  }
};

// ---------------------------------------------------------------------------
// search.issues
// ---------------------------------------------------------------------------

export const handleSearchIssues: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('find_issues', params);
    scrubScratchHitsFromResult(result);
    const resultStr = formatResult(result, FORMAT_RESULT_MAX_SEARCH);
    const retained = checkRetention('search.issues', params, resultStr, true, 'search_results', 'find_issues');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'issues', 'find_issues');
    const tk = countTokensSync(resultStr);
    return {
      kind: 'search_results', ok: true,
      refs: [`h:${hash}`],
      summary: `find_issues → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (issueErr) {
    return err('find_issues', issueErr instanceof Error ? issueErr.message : String(issueErr));
  }
};

// ---------------------------------------------------------------------------
// search.patterns
// ---------------------------------------------------------------------------

export const handleSearchPatterns: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('detect_patterns', params);
    scrubScratchHitsFromResult(result);
    const resultStr = formatResult(result, FORMAT_RESULT_MAX_SEARCH);
    const retained = checkRetention('search.patterns', params, resultStr, true, 'search_results', 'detect_patterns');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'search', 'detect_patterns');
    const tk = countTokensSync(resultStr);
    return {
      kind: 'search_results', ok: true,
      refs: [`h:${hash}`],
      summary: `detect_patterns → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (patErr) {
    return err('detect_patterns', patErr instanceof Error ? patErr.message : String(patErr));
  }
};

// ---------------------------------------------------------------------------
// analyze.deps
// ---------------------------------------------------------------------------

export const handleAnalyzeDeps: OpHandler = async (params, ctx) => {
  const p = params as Partial<AnalyzeDepsParams>;
  const filePaths = p.file_paths ?? [];
  const depMode = p.mode || 'graph';
  if (!filePaths.length) return err('deps', 'missing file_paths param');

  try {
    const operation = depMode === 'impact' ? 'change_impact' : 'dependencies';
    const result = await ctx.atlsBatchQuery(operation, { file_paths: filePaths, mode: depMode });
    const summary = extractDepsSummary(result, filePaths, depMode);
    const resultStr = formatResult(result);
    const retained = checkRetention('analyze.deps', params, resultStr, true, 'analysis', `deps: ${depMode} ${filePaths.join(', ')}`);
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'deps', filePaths.join(', '), undefined, summary);
    const tk = countTokensSync(resultStr);
    return {
      kind: 'analysis', ok: true,
      refs: [`h:${hash}`],
      summary: `deps: ${depMode} ${filePaths.join(', ')} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (depErr) {
    return err('deps', depErr instanceof Error ? depErr.message : String(depErr));
  }
};

// ---------------------------------------------------------------------------
// analyze.calls
// ---------------------------------------------------------------------------

export const handleAnalyzeCalls: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('call_hierarchy', params);
    const resultStr = formatResult(result);
    const retained = checkRetention('analyze.calls', params, resultStr, true, 'analysis', 'call_hierarchy');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'analysis', 'call_hierarchy');
    const tk = countTokensSync(resultStr);
    return {
      kind: 'analysis', ok: true,
      refs: [`h:${hash}`],
      summary: `call_hierarchy → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (callErr) {
    return err('call_hierarchy', callErr instanceof Error ? callErr.message : String(callErr));
  }
};

// ---------------------------------------------------------------------------
// analyze.graph (symbol call graph: callees, callers, subgraph)
// ---------------------------------------------------------------------------

export const handleAnalyzeGraph: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('symbol_graph', params);
    const resultStr = formatResult(result);
    const retained = checkRetention('analyze.graph', params, resultStr, true, 'analysis', 'symbol_graph');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'analysis', 'symbol_graph');
    const tk = countTokensSync(resultStr);
    return {
      kind: 'analysis', ok: true,
      refs: [`h:${hash}`],
      summary: `symbol_graph → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (graphErr) {
    return err('symbol_graph', graphErr instanceof Error ? graphErr.message : String(graphErr));
  }
};

// ---------------------------------------------------------------------------
// analyze.structure
// ---------------------------------------------------------------------------

export const handleAnalyzeStructure: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('symbol_dep_graph', params);
    const resultStr = formatResult(result);
    const retained = checkRetention('analyze.structure', params, resultStr, true, 'analysis', 'symbol_dep_graph');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'analysis', 'symbol_dep_graph');
    const tk = countTokensSync(resultStr);
    return {
      kind: 'analysis', ok: true,
      refs: [`h:${hash}`],
      summary: `symbol_dep_graph → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (structErr) {
    return err('symbol_dep_graph', structErr instanceof Error ? structErr.message : String(structErr));
  }
};

// ---------------------------------------------------------------------------
// analyze.impact (file-level ripple via change_impact)
// ---------------------------------------------------------------------------

export const handleAnalyzeImpact: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('change_impact', params);
    const resultStr = formatResult(result);
    const retained = checkRetention('analyze.impact', params, resultStr, true, 'analysis', 'change_impact');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'analysis', 'change_impact');
    const tk = countTokensSync(resultStr);
    return {
      kind: 'analysis', ok: true,
      refs: [`h:${hash}`],
      summary: `change_impact → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (impactErr) {
    return err('change_impact', impactErr instanceof Error ? impactErr.message : String(impactErr));
  }
};

// ---------------------------------------------------------------------------
// analyze.blast_radius (symbol-level blast radius via impact_analysis)
// ---------------------------------------------------------------------------

export const handleAnalyzeBlastRadius: OpHandler = async (params, ctx) => {
  const p = params as Partial<AnalyzeBlastRadiusParams>;
  const symbolNames = p.symbol_names;
  if (!symbolNames?.length) {
    return err('blast_radius', 'missing symbol_names — blast_radius requires at least one symbol to analyze (use file_paths as optional anchor)');
  }

  const backendParams: Record<string, unknown> = { ...params };
  if (!backendParams.from && !backendParams.file_path) {
    const filePaths = backendParams.file_paths as string[] | undefined;
    if (filePaths?.length) {
      backendParams.from = filePaths[0];
    }
  }

  try {
    const result = await ctx.atlsBatchQuery('impact_analysis', backendParams);
    const resultStr = formatResult(result);
    const retained = checkRetention('analyze.blast_radius', params, resultStr, true, 'analysis', 'impact_analysis');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'analysis', 'impact_analysis');
    const tk = countTokensSync(resultStr);
    return {
      kind: 'analysis', ok: true,
      refs: [`h:${hash}`],
      summary: `impact_analysis → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (blastErr) {
    return err('impact_analysis', blastErr instanceof Error ? blastErr.message : String(blastErr));
  }
};

// ---------------------------------------------------------------------------
// analyze.extract_plan
// ---------------------------------------------------------------------------

export const handleAnalyzeExtractPlan: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('extract_plan', params);
    const resultStr = formatResult(result);
    const p = params as Partial<{ file_path?: string }>;
    const filePath = typeof p.file_path === 'string' ? p.file_path : '';
    const retained = checkRetention('analyze.extract_plan', params, resultStr, true, 'analysis', 'extract_plan');
    if (retained.reused) return retained.output;
    const chunkSource = filePath || 'extract_plan';
    const hash = ctx.store().addChunk(resultStr, 'analysis', chunkSource);
    const tk = countTokensSync(resultStr);
    return {
      kind: 'analysis', ok: true,
      refs: [`h:${hash}`],
      summary: `extract_plan → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
    };
  } catch (extractErr) {
    return err('extract_plan', extractErr instanceof Error ? extractErr.message : String(extractErr));
  }
};

// ---------------------------------------------------------------------------
// search.memory — full-text grep across all memory regions
// ---------------------------------------------------------------------------

export const handleSearchMemory: OpHandler = async (params, ctx) => {
  const p = params as Partial<SearchMemoryParams>;
  const query = p.query;
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return err('search.memory', 'missing or too short query (min 2 chars)');
  }

  const regions = p.regions as Array<'active' | 'archived' | 'dormant' | 'bb' | 'staged' | 'dropped'> | undefined;
  const caseSensitive = p.case_sensitive ?? false;
  const maxResults = Math.min(p.max_results ?? 30, 100);

  const results = ctx.store().searchMemory(query.trim(), { regions, caseSensitive, maxResults });

  if (results.length === 0) {
    return {
      kind: 'search_results', ok: true, refs: [],
      summary: `search.memory: "${query}" — 0 hits across memory`,
    };
  }

  const regionCounts: Record<string, number> = {};
  const refs: string[] = [];

  for (const r of results) {
    regionCounts[r.region] = (regionCounts[r.region] || 0) + 1;
    refs.push(r.ref);
  }

  const regionSummary = Object.entries(regionCounts).map(([k, v]) => `${k}:${v}`).join(' ');
  const structured = {
    tool: 'search.memory',
    query: query.trim(),
    region_summary: regionSummary,
    total_hits: results.length,
    entries: results.map(r => ({
      region: r.region,
      ref: r.ref,
      source: r.source,
      type: r.type,
      tokens: r.tokens,
      hits: r.hits.map(h => ({ lineNumber: h.lineNumber, line: h.line })),
    })),
  };
  const resultStr = formatResult(structured, FORMAT_RESULT_MAX_SEARCH);
  const hash = ctx.store().addChunk(resultStr, 'search', `memory: ${query}`);
  const tk = countTokensSync(resultStr);

  const archivedCount = regionCounts['archived'] ?? 0;
  const dormantCount = regionCounts['dormant'] ?? 0;
  const totalDormant = archivedCount + dormantCount;
  // Internal visibility states (archived vs dormant) collapsed to one
  // model-facing `dormant` category — the model's action is the same:
  // `rec h:XXXX` to restore.
  const recallHint = totalDormant > 0
    ? `\n${totalDormant} result${totalDormant === 1 ? '' : 's'} dormant — rec h:XXXX to restore if needed`
    : '';

  return {
    kind: 'search_results', ok: true,
    refs: [`h:${hash}`],
    summary: `search.memory: "${query}" → h:${hash} (${results.length} hits, ${regionSummary}, ${(tk / 1000).toFixed(1)}k tk)${recallHint}`,
    tokens: tk,
  };
};

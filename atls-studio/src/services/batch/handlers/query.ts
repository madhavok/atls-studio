/**
 * Query operation handlers — search, symbol, deps (proxy to atlsBatchQuery).
 */

import type { OpHandler, StepOutput, SearchCodeParams, SearchSymbolParams, SearchUsageParams, AnalyzeDepsParams, AnalyzeImpactParams, AnalyzeBlastRadiusParams, AnalyzeStructureParams, SearchMemoryParams } from '../types';
import { estimateTokens, extractSearchSummary, extractSymbolSummary, extractDepsSummary } from '../../../utils/contextHash';
import { formatResult } from '../../../utils/toon';
import { checkRetention } from './retention';

function err(label: string, msg: string): StepOutput {
  return { kind: 'search_results', ok: false, refs: [], summary: `${label}: ERROR ${msg}`, error: msg };
}

/** Extract unique file paths from code_search result for from_step dataflow (e.g. intent.search_replace, intent.investigate). */
function extractFilePathsFromSearchResult(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  const results = obj.results as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const r of results) {
    const file = (r.file ?? r.path ?? r.file_path) as string | undefined;
    if (typeof file === 'string' && file && !seen.has(file)) {
      seen.add(file);
      paths.push(file);
    }
  }
  return paths;
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
    const summary = extractSearchSummary(result, queries);
    const resultStr = formatResult(result);
    const retained = checkRetention('search.code', params, resultStr, true, 'search_results', `search: ${queries.join(', ')}`);
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'search', queries.join(', '), undefined, summary);
    const tk = estimateTokens(resultStr);
    const resultFilePaths = extractFilePathsFromSearchResult(result);
    return {
      kind: 'search_results', ok: true,
      refs: [`h:${hash}`],
      summary: `search: ${queries.join(', ')} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
      content: { file_paths: resultFilePaths },
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
    const resultStr = formatResult(result);
    const retained = checkRetention('search.symbol', params, resultStr, true, 'symbol_refs', `find_symbol: ${queries.join(', ')}`);
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'symbol', queries.join(', '));
    const tk = estimateTokens(resultStr);
    return {
      kind: 'symbol_refs', ok: true,
      refs: [`h:${hash}`],
      summary: `find_symbol: ${queries.join(', ')} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
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
    const summary = extractSymbolSummary(result, symbolNames);
    const resultStr = formatResult(result);
    const retained = checkRetention('search.usage', params, resultStr, true, 'symbol_refs', `symbols: ${symbolNames.join(', ')}`);
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'symbol', symbolNames.join(', '), undefined, summary);
    const tk = estimateTokens(resultStr);
    return {
      kind: 'symbol_refs', ok: true,
      refs: [`h:${hash}`],
      summary: `symbols: ${symbolNames.join(', ')} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
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
    const result = await ctx.atlsBatchQuery(operation, batchParams);
    const resultStr = formatResult(result);
    const retained = checkRetention('search.similar', params, resultStr, true, 'search_results', 'find_similar');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'search', 'find_similar');
    const tk = estimateTokens(resultStr);
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
    const resultStr = formatResult(result);
    const retained = checkRetention('search.issues', params, resultStr, true, 'search_results', 'find_issues');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'search', 'find_issues');
    const tk = estimateTokens(resultStr);
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
    const resultStr = formatResult(result);
    const retained = checkRetention('search.patterns', params, resultStr, true, 'search_results', 'detect_patterns');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'search', 'detect_patterns');
    const tk = estimateTokens(resultStr);
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
    const tk = estimateTokens(resultStr);
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
    const tk = estimateTokens(resultStr);
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
// analyze.structure
// ---------------------------------------------------------------------------

export const handleAnalyzeStructure: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('symbol_dep_graph', params);
    const resultStr = formatResult(result);
    const retained = checkRetention('analyze.structure', params, resultStr, true, 'analysis', 'symbol_dep_graph');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'analysis', 'symbol_dep_graph');
    const tk = estimateTokens(resultStr);
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
    const tk = estimateTokens(resultStr);
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
  try {
    const result = await ctx.atlsBatchQuery('impact_analysis', params);
    const resultStr = formatResult(result);
    const retained = checkRetention('analyze.blast_radius', params, resultStr, true, 'analysis', 'impact_analysis');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'analysis', 'impact_analysis');
    const tk = estimateTokens(resultStr);
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
    const retained = checkRetention('analyze.extract_plan', params, resultStr, true, 'analysis', 'extract_plan');
    if (retained.reused) return retained.output;
    const hash = ctx.store().addChunk(resultStr, 'analysis', 'extract_plan');
    const tk = estimateTokens(resultStr);
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
  const lines: string[] = [];

  for (const r of results) {
    regionCounts[r.region] = (regionCounts[r.region] || 0) + 1;
    refs.push(r.ref);
    const hitsPreview = r.hits
      .map(h => `    L${h.lineNumber}: ${h.line}`)
      .join('\n');
    lines.push(`  [${r.region}] ${r.ref} (${r.source || 'unknown'}, ${r.type || '?'}, ${r.tokens ?? '?'}tk)\n${hitsPreview}`);
  }

  const regionSummary = Object.entries(regionCounts).map(([k, v]) => `${k}:${v}`).join(' ');
  const resultStr = `search.memory: "${query}" — ${results.length} hits [${regionSummary}]\n${lines.join('\n')}`;
  const hash = ctx.store().addChunk(resultStr, 'search', `memory: ${query}`);
  const tk = estimateTokens(resultStr);

  return {
    kind: 'search_results', ok: true,
    refs: [`h:${hash}`],
    summary: `search.memory: "${query}" → h:${hash} (${results.length} hits, ${regionSummary}, ${(tk / 1000).toFixed(1)}k tk)`,
    tokens: tk,
  };
};

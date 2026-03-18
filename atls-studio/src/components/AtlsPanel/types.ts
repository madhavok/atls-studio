/** Shared types for ATLS Intelligence Panel sub-components */

export interface FileRelation {
  path: string;
  relation_type: string;
}

export interface FileGraphRaw {
  file: { path: string };
  incoming: FileRelation[];
  outgoing: FileRelation[];
  symbols: Array<{ name: string; kind: string; line: number; end_line?: number }>;
}

export interface FileGraph {
  file: string;
  imports: string[];      // outgoing relations (files we import from)
  exports: string[];      // incoming relations (files that import us)
  symbols: Array<{ name: string; kind: string; line: number; end_line?: number }>;
}

/** Smart context returned by atls_batch_query({ operation: 'context', type: 'smart' }) */
export interface SmartContext {
  file: string;
  symbols: number;
  imports: number;
  related_files?: string[];
  issues?: number;
  summary?: string;
}

/** A symbol affected by changes to the target file */
export interface AffectedSymbol {
  name: string;
  file: string;
  kind: string;
  line: number;
  end_line?: number;
}

/** Impact analysis returned by atls_batch_query({ operation: 'dependencies', mode: 'impact' }) */
export interface ImpactAnalysis {
  file: string;
  risk_level: 'low' | 'medium' | 'high';
  direct_dependents: number;
  indirect_dependents: number;
  total_affected: number;
  affected_files?: string[];
  affected_symbols?: AffectedSymbol[];
}

/** Component context returned by atls_batch_query({ operation: 'context', type: 'component' }) */
export interface ComponentContext {
  file: string;
  children?: string[];
  hooks?: string[];
  props?: string[];
  framework?: string;
}

/** AST query result for complexity analysis */
export interface ComplexityEntry {
  name: string;
  file: string;
  line: number;
  end_line?: number;
  complexity: number;
  lines?: number;
  kind?: string;
}

/** Pattern match from detect_patterns */
export interface PatternMatch {
  file: string;
  line: number;
  end_line?: number;
  message?: string;
  snippet?: string;
}

/** Detected pattern group */
export interface DetectedPattern {
  pattern_id: string;
  description?: string;
  matches: PatternMatch[];
  count: number;
}

/** Refactoring inventory entry */
export interface RefactorCandidate {
  name: string;
  file: string;
  line: number;
  end_line?: number;
  complexity: number;
  lines: number;
  signature?: string;
}

export type TabType = 'issues' | 'file' | 'patterns' | 'overview' | 'health';

/** Per-language index health diagnostics from atls_get_language_health */
export interface LanguageSymbols {
  total: number;
  functions: number;
  structs: number;
  methods: number;
  traits: number;
  types: number;
  constants: number;
  other: number;
}

export interface LanguageCapabilities {
  inventory: boolean;
  rename: boolean;
  move: boolean;
  extract: boolean;
  find_symbol: boolean;
  symbol_usage: boolean;
  verify_typecheck: boolean;
  verify_test: boolean;
}

export interface LanguageHealth {
  language: string;
  files: number;
  loc: number;
  symbols: LanguageSymbols;
  calls: number;
  issues: number;
  capabilities: LanguageCapabilities;
}

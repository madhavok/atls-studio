/** Minimal shape for deduping symbol locations (definitions + references). */
export interface SymbolLocationRef {
  file: string;
  line: number;
  kind?: string;
}

/** Merge definitions and references, dropping duplicates that share file + line + kind. */
export function mergeDefinitionsAndReferencesUnique(
  definitions: SymbolLocationRef[],
  references: SymbolLocationRef[],
): SymbolLocationRef[] {
  const seen = new Set<string>();
  const out: SymbolLocationRef[] = [];
  for (const entry of [...definitions, ...references]) {
    const key = `${entry.file}:${entry.line}:${entry.kind ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

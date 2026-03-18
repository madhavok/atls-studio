export function resolveSymbolToLines(content: string, kind: string | undefined, name: string): [number, number] | null {
  const [baseName, overloadIdx] = parseOverloadIndex(name);
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = kindToRegexPrefix(kind);
  const pattern = new RegExp(`${prefix}${escaped}(?:\\s|[<({\\:,;]|$)`);
  const lines = content.split('\n');
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) matches.push(i);
  }
  if (matches.length === 0) return null;
  const targetIdx = overloadIdx ?? 1;
  if (targetIdx < 1 || targetIdx > matches.length) return null;
  const start = matches[targetIdx - 1];
  const end = findBlockEnd(lines, start, lines.length);
  return [start + 1, end + 1];
}

export function kindToRegexPrefix(kind: string | undefined): string {
  const prefixes: Record<string, string> = {
    fn: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|function|def|func|method)\\s+(?:self\\.)?',
    cls: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:abstract\\s+)?class\\s+',
    struct: '(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+',
    trait: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:trait|interface)\\s+',
    enum: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?enum\\s+',
    type: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:type|typedef)\\s+',
    impl: '(?:pub(?:\\([^)]*\\))?\\s+)?impl(?:\\s+\\w+\\s+for\\s+)?',
    const: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:const|static|final)\\s+(?:\\w+\\s+)?',
  };
  const def = '(?:fn|function|def|class|struct|interface|trait|enum)\\s+';
  return kind ? (prefixes[kind] ?? def) : def;
}

/** Parse overload index from symbol name (e.g. "foo#2" -> ["foo", 2]). */
export function parseOverloadIndex(name: string): [string, number | null] {
  const hashPos = name.lastIndexOf('#');
  if (hashPos >= 0) {
    const suffix = name.slice(hashPos + 1);
    const idx = parseInt(suffix, 10);
    if (!isNaN(idx)) return [name.slice(0, hashPos), idx];
  }
  return [name, null];
}

/** Find block end by brace depth (simplified; no string/comment awareness). */
export function findBlockEnd(lines: string[], start: number, total: number): number {
  const trimmed = lines[start]?.trim() ?? '';
  if (trimmed.endsWith(';') && !trimmed.includes('{')) return start;
  let depth = 0;
  let foundOpen = false;
  for (let i = start; i < total; i++) {
    for (const c of lines[i]) {
      if (c === '{') { depth++; foundOpen = true; }
      else if (c === '}') depth--;
    }
    if (foundOpen && depth === 0) return i;
  }
  return total > 0 ? total - 1 : start;
}

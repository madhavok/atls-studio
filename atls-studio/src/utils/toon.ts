/**
 * TOON (Token-Oriented Object Notation) serializer.
 * Compact alternative to JSON for AI model outputs — typically 40-60% fewer tokens.
 *
 * Rules:
 *  - Booleans: 1 / 0
 *  - Null/undefined/empty string: omitted
 *  - Strings: unquoted unless they contain special chars
 *  - Objects: {key:val,key:val}
 *  - Arrays: [val,val]
 */
export function toTOON(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (/[:\s,{}[\]]/.test(value)) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.map(toTOON).filter(Boolean).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}:${toTOON(v)}`);
    return entries.length ? `{${entries.join(',')}}` : '';
  }
  return String(value);
}

// ============================================================================
// File-path compaction — groups arrays of objects by their file/path field
// ============================================================================

const FILE_KEYS = ['file', 'f', 'path'] as const;

/**
 * Detect the dominant file-path field in an array of objects.
 * Returns the key name if >50% of object entries share it, else null.
 */
function detectFileKey(arr: unknown[]): string | null {
  const counts: Record<string, number> = {};
  let objCount = 0;

  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      objCount++;
      for (const key of FILE_KEYS) {
        if (typeof (item as Record<string, unknown>)[key] === 'string') {
          counts[key] = (counts[key] || 0) + 1;
        }
      }
    }
  }

  if (objCount < 2) return null;
  for (const key of FILE_KEYS) {
    if ((counts[key] || 0) > objCount * 0.5) return key;
  }
  return null;
}

/**
 * Recursively walk a JSON structure and group arrays-of-objects by their
 * file-path field (file/f/path). Replaces the array with an object keyed
 * by file path, removing the file field from each entry.
 *
 * Only groups when uniqueFiles < totalEntries (actual dedup benefit).
 * Also strips redundant `relative_path` fields during grouping.
 */
export function compactByFile(data: unknown): unknown {
  if (data === null || data === undefined || typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    const recursed = data.map(compactByFile);
    if (recursed.length < 2) return recursed;

    const fileKey = detectFileKey(recursed);
    if (!fileKey) return recursed;

    const fileValues = new Set<string>();
    let withKey = 0;
    for (const item of recursed) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const val = (item as Record<string, unknown>)[fileKey];
        if (typeof val === 'string') {
          fileValues.add(val);
          withKey++;
        }
      }
    }

    if (fileValues.size >= withKey || withKey < recursed.length * 0.5) return recursed;

    const grouped: Record<string, unknown[]> = {};
    const ungrouped: unknown[] = [];

    for (const item of recursed) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const val = obj[fileKey];
        if (typeof val === 'string') {
          if (!grouped[val]) grouped[val] = [];
          const entry = { ...obj };
          delete entry[fileKey];
          delete entry['relative_path'];
          grouped[val].push(entry);
          continue;
        }
      }
      ungrouped.push(item);
    }

    if (ungrouped.length > 0) {
      grouped['_other'] = ungrouped;
    }
    return grouped;
  }

  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = compactByFile(val);
  }
  return result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Format a tool result as TOON with a size ceiling.
 * Applies file-path compaction before serialization for token efficiency.
 */
export function formatResult(result: unknown, maxSize = 80000): string {
  const compacted = compactByFile(result);
  const toon = toTOON(compacted);
  if (toon.length > maxSize) {
    return toon.substring(0, maxSize) + '\n[truncated - narrow query]';
  }
  return toon;
}

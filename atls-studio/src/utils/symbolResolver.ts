/**
 * Resolve a symbol anchor (e.g. fn(name), cls(MyClass)) to 1-based [start, end] line numbers.
 * Mirrors Rust shape_ops.rs resolve_symbol_anchor_lines with tiered fallback:
 *   Tier 1:  kind_to_regex_prefix match (keyword-based declarations)
 *   Tier 1.5a: JS/TS class method shorthand (indented method())
 *   Tier 1.5b: Variable-bound arrow/assigned functions (const x = () => {})
 *   Tier 2:  C-family return-type syntax (void parse_number(...))
 *   Tier 3:  Go type declarations (type Name struct)
 */
export function resolveSymbolToLines(content: string, kind: string | undefined, name: string): [number, number] | null {
  const [baseName, overloadIdx] = parseOverloadIndex(name);
  const escaped = escapeRegex(baseName);
  const prefix = kindToRegexPrefix(kind);
  const pattern = new RegExp(`${prefix}${escaped}(?:\\s|[<({\\:,;]|$)`);
  const lines = content.split('\n');
  const total = lines.length;

  // Tier 1: kind-based regex match
  let matches = findMatchingLines(lines, pattern, baseName);

  // Tier 1.5a: JS/TS class method shorthand (only for fn or untyped sym)
  if (matches.length === 0 && (kind === 'fn' || kind === undefined || kind === 'sym')) {
    matches = tryClassMethodMatch(lines, escaped);
  }

  // Tier 1.5b: Variable-bound arrow/assigned functions
  if (matches.length === 0 && (kind === 'fn' || kind === undefined || kind === 'sym')) {
    matches = tryVariableBoundFnMatch(lines, escaped);
  }

  // Tier 2: C-family return-type syntax
  if (matches.length === 0 && (kind === 'fn' || kind === undefined || kind === 'sym')) {
    matches = tryCFamilyFnMatch(lines, escaped, baseName);
  }

  // Tier 3: Go type declarations
  if (matches.length === 0 && (kind === 'struct' || kind === 'trait' || kind === 'interface' || kind === undefined || kind === 'sym')) {
    matches = tryGoTypeMatch(lines, escaped, kind);
  }

  if (matches.length === 0) return null;

  const targetIdx = overloadIdx ?? 1;
  if (targetIdx < 1 || targetIdx > matches.length) return null;
  const start = matches[targetIdx - 1];

  // Skip bodyless declarations (re-exports, type aliases, forward decls)
  const skipBodyless = kind === 'const' || kind === 'static' || kind === 'type' ||
    kind === 'macro' || kind === 'field' || kind === 'property' ||
    kind === 'enum_member' || kind === 'variant' || kind === 'event';
  if (!skipBodyless && isBodylessLine(lines[start])) {
    const end = findBlockEnd(lines, start, total);
    if (end === start) return [start + 1, start + 1]; // bodyless single-line declaration
  }

  // Decorator/annotation rollback: include preceding @decorator, #[attr], /** doc */ lines
  const adjustedStart = rollbackToDecorators(lines, start);
  const end = findBlockEnd(lines, start, total);
  return [adjustedStart + 1, end + 1];
}

/** Find lines matching a regex pattern, with cheap substring pre-filter. */
function findMatchingLines(lines: string[], pattern: RegExp, baseName: string): number[] {
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(baseName) && pattern.test(lines[i])) {
      matches.push(i);
    }
  }
  return matches;
}

/** Escape regex special characters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * All canonical kind prefixes and their regex patterns.
 * Mirrors Rust kind_to_regex_prefix in shape_ops.rs.
 */
export function kindToRegexPrefix(kind: string | undefined): string {
  const prefixes: Record<string, string> = {
    // Functions: Rust fn, JS/TS function, Python def, Go func, Kotlin fun, Swift func, method
    fn: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:unsafe\\s+)?(?:const\\s+)?(?:async\\s+)?(?:extern\\s+\\S+\\s+)?(?:fn|fun|function|def|func(?:\\s+\\([^)]*\\))?|method)\\s+(?:self\\.)?(?:\\w+\\.)*',
    // Classes
    cls: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:abstract\\s+)?\\bclass\\s+',
    class: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:abstract\\s+)?\\bclass\\s+',
    // Structs
    struct: '(?:pub(?:\\([^)]*\\))?\\s+)?\\bstruct\\s+',
    // Traits / Interfaces
    trait: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:\\btrait|\\binterface)\\s+',
    interface: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:\\btrait|\\binterface)\\s+',
    // Swift protocols
    protocol: '(?:public\\s+|open\\s+|internal\\s+|fileprivate\\s+|private\\s+)?(?:@objc\\s+)?\\bprotocol\\s+',
    // Enums
    enum: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?\\benum\\s+',
    // Records (Java, C#, Kotlin data class)
    record: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+|internal\\s+|sealed\\s+)?(?:data\\s+)?\\brecord\\s+',
    // Swift extensions
    extension: '(?:public\\s+|open\\s+|internal\\s+|fileprivate\\s+|private\\s+)?\\bextension\\s+',
    // Dart mixins
    mixin: '\\bmixin\\s+',
    // Macros (Rust macro_rules!, C #define, general macro)
    macro: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:macro_rules!\\s+|\\bmacro\\s+|#\\s*define\\s+)',
    // Type aliases
    type: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:\\btype|\\btypedef)\\s+',
    // Impl blocks (Rust)
    impl: '(?:pub(?:\\([^)]*\\))?\\s+)?impl(?:\\s*<[^{]*>)?\\s+(?:\\w+\\s+for\\s+)?',
    // Constants
    const: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:const|static|final)\\s+(?:\\w+\\s+)?',
    // Statics (same regex as const — Rust static, Java static final, etc.)
    static: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:const|static|final)\\s+(?:\\w+\\s+)?',
    // Modules / Namespaces
    mod: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:mod|module|namespace|package)\\s+',
    ns: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:mod|module|namespace|package)\\s+',
    namespace: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:mod|module|namespace|package)\\s+',
    package: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:mod|module|namespace|package)\\s+',
    // Constructors
    ctor: '(?:public|protected|private|internal)?\\s*(?:constructor|new)\\s*',
    // Properties (get/set accessors)
    property: '(?:public\\s+|private\\s+|protected\\s+|internal\\s+)?(?:static\\s+)?(?:readonly\\s+)?(?:get|set)\\s+',
    // Fields
    field: '(?:public\\s+|private\\s+|protected\\s+|internal\\s+)?(?:readonly\\s+|static\\s+)?(?:\\w+\\s+)*',
    // Enum members / variants
    enum_member: '^\\s*',
    variant: '^\\s*',
    // Operators
    operator: '\\boperator\\s*',
    // Events (C#)
    event: '\\bevent\\s+\\w+\\s+',
    // Kotlin objects / companion objects
    object: '(?:companion\\s+)?\\bobject\\s+',
    // Swift actors
    actor: '(?:public\\s+|open\\s+|internal\\s+|fileprivate\\s+|private\\s+)?\\bactor\\s+',
    // C/C++ unions
    union: '\\bunion\\s+',
  };
  const defaultPrefix = '(?:pub(?:\\([^)]*\\))?\\s+)?(?:export\\s+)?(?:unsafe\\s+)?(?:const\\s+)?(?:async\\s+)?(?:extern\\s+\\S+\\s+)?(?:fn|fun|function|def|func(?:\\s+\\([^)]*\\))?|class|struct|interface|trait|enum|type|impl|macro_rules!\\s|protocol|record|extension|mixin|object|actor|union)\\s*(?:self\\.)?';
  return kind ? (prefixes[kind] ?? defaultPrefix) : defaultPrefix;
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

// ---------------------------------------------------------------------------
// Bodyless / Re-export Detection
// ---------------------------------------------------------------------------

/** Check if a line is a bodyless declaration (re-export, type alias, forward decl). */
function isBodylessLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.endsWith(';') && !trimmed.includes('{')) return true;
  // JS/TS re-exports: export { X } from '...' / import { X } from '...'
  if ((trimmed.startsWith('export {') || trimmed.startsWith('import {')) && trimmed.includes(' from ')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Similar Name Suggestions
// ---------------------------------------------------------------------------

/** Extract declared symbol names from content for a given kind. */
export function extractSymbolNames(content: string, kind: string | undefined): string[] {
  const prefix = kindToRegexPrefix(kind);
  const pattern = new RegExp(`${prefix}(\\w+)`, 'g');
  const names = new Set<string>();
  for (const line of content.split('\n')) {
    if (line.length > 16384) continue; // skip minified lines
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(line)) !== null) {
      if (m[1]) names.add(m[1]);
    }
  }
  return [...names];
}

/** Find names similar to the search term (substring, prefix, contains). */
export function findSimilarNames(names: string[], search: string): string[] {
  const lower = search.toLowerCase();
  const scored: [number, string][] = names
    .map(n => {
      const nl = n.toLowerCase();
      let score = 0;
      if (nl === lower) score = 100;
      else if (nl.startsWith(lower) || lower.startsWith(nl)) score = 50;
      else if (nl.includes(lower) || lower.includes(nl)) score = 25;
      return [score, n] as [number, string];
    })
    .filter(([s]) => s > 0);
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 5).map(([, n]) => n);
}

// ---------------------------------------------------------------------------
// Tiered Fallback Matchers (Tiers 1.5a, 1.5b, 2, 3)
// ---------------------------------------------------------------------------

/**
 * Tier 1.5a: JS/TS class method shorthand.
 * Matches: `getUser()`, `async getUser()`, `static create()`, `get name()`, `#privateMethod()`.
 */
function tryClassMethodMatch(lines: string[], escapedName: string): number[] {
  const re = new RegExp(`^\\s+(?:async\\s+)?(?:static\\s+)?(?:get\\s+|set\\s+)?(?:#)?${escapedName}\\s*(?:<[^>]*>\\s*)?\\(`);
  const total = lines.length;
  const matches: number[] = [];
  for (let i = 0; i < total; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!re.test(line)) continue;
    // Reject if = precedes the name (it's an assignment, not a method)
    if (trimmed.includes('=') && trimmed.indexOf('=') < trimmed.indexOf(escapedName.replace(/\\/g, ''))) continue;
    const blockEnd = findBlockEnd(lines, i, total);
    if (blockEnd > i || trimmed.includes('{')) matches.push(i);
  }
  return matches;
}

/**
 * Tier 1.5b: Variable-bound arrow functions and const-assigned functions.
 * Matches: `const handler = async (req) => {`, `export const foo = () => {`,
 * `const bar = function(x) {`
 */
function tryVariableBoundFnMatch(lines: string[], escapedName: string): number[] {
  const arrowRe = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapedName}\\s*(?::\\s*[^=]+)?\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[a-zA-Z_]\\w*)\\s*(?::\\s*[^=\\n]*)?\\s*=>`);
  const assignedFnRe = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapedName}\\s*=\\s*(?:async\\s+)?function`);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (arrowRe.test(line) || assignedFnRe.test(line)) {
      const blockEnd = findBlockEnd(lines, i, lines.length);
      if (blockEnd > i) matches.push(i);
    }
  }
  return matches;
}

/**
 * Tier 2: C-family function declarations with return-type syntax.
 * Matches: `void parse_number(...)`, `public String toJson(...)`.
 * Rejects expression contexts: name preceded by . -> = ( ,
 */
function tryCFamilyFnMatch(lines: string[], escapedName: string, baseName: string): number[] {
  const nameRe = new RegExp(`\\b${escapedName}\\s*(?:<[^>]*>\\s*)?\\(`);
  const rejectRe = new RegExp(`(?:\\.|->|[=(,])\\s*${escapedName}\\s*(?:<[^>]*>\\s*)?\\(`);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (nameRe.test(line) && !rejectRe.test(line)) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('import ') && !trimmed.startsWith('from ')) {
        const blockEnd = findBlockEnd(lines, i, lines.length);
        if (blockEnd > i || trimmed.includes('{')) matches.push(i);
      }
    }
  }
  return matches;
}

/**
 * Tier 3: Go `type Name struct/interface` declarations.
 */
function tryGoTypeMatch(lines: string[], escapedName: string, kind: string | undefined): number[] {
  const typeSuffix = kind === 'struct' ? '\\s+struct\\b'
    : (kind === 'trait' || kind === 'interface') ? '\\s+interface\\b'
    : '(?:\\s+(?:struct|interface)\\b)?';
  const re = new RegExp(`^\\s*type\\s+${escapedName}${typeSuffix}`);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) matches.push(i);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Decorator / Annotation Rollback
// ---------------------------------------------------------------------------

/**
 * Scan backwards from a symbol's declaration line to include preceding
 * decorators, annotations, and doc comments.
 */
function rollbackToDecorators(lines: string[], start: number): number {
  let i = start - 1;
  while (i >= 0) {
    const trimmed = lines[i].trim();
    if (trimmed === '') { i--; continue; }
    // Python/Java/Kotlin/TS decorators: @something
    if (trimmed.startsWith('@')) { i--; continue; }
    // Rust attributes: #[...] or #![...]
    if (trimmed.startsWith('#[') || trimmed.startsWith('#![')) { i--; continue; }
    // C++ attributes: [[...]]
    if (trimmed.startsWith('[[')) { i--; continue; }
    // Doc comments: /// ..., //! ...
    if (trimmed.startsWith('///') || trimmed.startsWith('//!')) { i--; continue; }
    // JSDoc / block doc comment body and boundaries
    if (trimmed.startsWith('*') || trimmed.startsWith('/**') || trimmed === '*/') { i--; continue; }
    if (trimmed.startsWith('/*')) { i--; continue; }
    break;
  }
  // Skip leading blank lines in the decorator block
  let result = i + 1;
  while (result < start && lines[result].trim() === '') result++;
  return result;
}

// ---------------------------------------------------------------------------
// Block End Detection — String/Comment Aware
// ---------------------------------------------------------------------------

/** Check if a line starts a Lua keyword block (function...end). */
function isLuaBlock(trimmed: string): boolean {
  // Lua: function name(...) or local function name(...)
  return /^(?:local\s+)?function\b/.test(trimmed) && !trimmed.includes('{');
}

/** Track Lua function...end keyword blocks. */
function findLuaBlockEnd(lines: string[], start: number, total: number): number {
  const openers = /^\s*(?:(?:local\s+)?function\b|if\b|for\b|while\b|repeat\b)/;
  const closers = /^\s*(?:end\b|until\b)/;
  let depth = 0;
  for (let i = start; i < total; i++) {
    const trimmed = lines[i].trim();
    if (openers.test(trimmed)) depth++;
    if (closers.test(trimmed)) {
      depth--;
      if (depth <= 0) return i;
    }
  }
  for (let i = total - 1; i >= start; i--) {
    if (lines[i].trim().length > 0) return i;
  }
  return Math.max(0, total - 1);
}
/** Check if a line starts a Ruby/Elixir keyword block (def...end, not Python). */
function isRubyLikeBlock(trimmed: string): boolean {
  const firstWord = trimmed.split(/\s/)[0] || '';
  const keywords = ['def', 'class', 'module', 'do', 'begin', 'if', 'unless', 'case'];
  return keywords.includes(firstWord) && !trimmed.includes('{') && !trimmed.endsWith(':');
}

/** Track Ruby/Elixir def...end keyword blocks. */
function findKeywordBlockEnd(lines: string[], start: number, total: number): number {
  const openers = ['def', 'class', 'module', 'do', 'begin', 'if', 'unless', 'case', 'for', 'while', 'until'];
  let depth = 0;
  for (let i = start; i < total; i++) {
    const trimmed = lines[i].trim();
    const firstWord = trimmed.split(/\s/)[0] || '';
    if (openers.includes(firstWord) && !trimmed.endsWith('end')) {
      depth++;
    }
    if (trimmed === 'end' || trimmed.startsWith('end ') || trimmed.startsWith('end;') || trimmed.startsWith('end)')) {
      depth--;
      if (depth <= 0) return i;
    }
  }
  // Fallback: last non-empty line
  for (let i = total - 1; i >= start; i--) {
    if (lines[i].trim().length > 0) return i;
  }
  return Math.max(0, total - 1);
}

/**
 * Find the end of a block starting at `start`.
 * String/comment-aware brace tracking. Falls back to indentation for Python
 * (lines ending with ':'), and def...end keyword tracking for Ruby/Elixir.
 * Mirrors Rust find_block_end in shape_ops.rs.
 */
export function findBlockEnd(lines: string[], start: number, total: number): number {
  const startTrimmed = lines[start]?.trim() ?? '';
  if (startTrimmed.endsWith(';') && !startTrimmed.includes('{')) return start;

  // Ruby/Elixir: keyword-block tracking
  if (isRubyLikeBlock(startTrimmed)) {
    return findKeywordBlockEnd(lines, start, total);
  }

  // Lua: function...end keyword tracking
  if (isLuaBlock(startTrimmed)) {
    return findLuaBlockEnd(lines, start, total);
  }

  // Python blocks end with ':' and use indentation, not braces.
  const indentOnly = startTrimmed.endsWith(':');

  let depth = 0;
  let foundOpen = false;
  let inBlockComment = false;
  let inString: string | null = null;
  let templateDepth = 0; // Track nested ${...} in template literals
  let inRawString: number | null = null; // hash count when inside r#"..."#

  for (let i = start; i < total; i++) {
    let inLineComment = false;
    const chars = lines[i];
    const len = chars.length;
    let j = 0;

    while (j < len) {
      const c = chars[j];

      // Inside Rust raw string — scan for closing "###
      if (inRawString !== null) {
        if (c === '"') {
          let trailing = 0;
          while (trailing < inRawString && j + 1 + trailing < len && chars[j + 1 + trailing] === '#') {
            trailing++;
          }
          if (trailing === inRawString) {
            j += 1 + inRawString;
            inRawString = null;
            continue;
          }
        }
        j++;
        continue;
      }

      // Inside block comment
      if (inBlockComment) {
        if (j + 1 < len && c === '*' && chars[j + 1] === '/') {
          inBlockComment = false;
          j += 2;
          continue;
        }
        j++;
        continue;
      }

      // Inside line comment
      if (inLineComment) {
        j++;
        continue;
      }

      // Inside string literal
      if (inString !== null) {
        // Template literal interpolation: ${...} — exit string, track depth
        if (inString === '`' && c === '$' && j + 1 < len && chars[j + 1] === '{') {
          inString = null;
          templateDepth++;
          j++; // skip $, next iteration picks up { as real brace
          continue;
        }
        if (c === '\\' && j + 1 < len) {
          j += 2;
          continue;
        }
        if (c === inString) {
          inString = null;
        }
        j++;
        continue;
      }

      // Line comment start: //
      if (j + 1 < len && c === '/' && chars[j + 1] === '/') {
        inLineComment = true;
        j += 2;
        continue;
      }

      // Python line comment: #
      if (c === '#' && indentOnly) {
        inLineComment = true;
        j++;
        continue;
      }

      // Block comment start: /*
      if (j + 1 < len && c === '/' && chars[j + 1] === '*') {
        inBlockComment = true;
        j += 2;
        continue;
      }

      // Rust raw strings: r"...", r#"..."#, r##"..."## etc.
      if (c === 'r' && j + 1 < len && (chars[j + 1] === '#' || chars[j + 1] === '"')) {
        let hashes = 0;
        let k = j + 1;
        while (k < len && chars[k] === '#') { hashes++; k++; }
        if (k < len && chars[k] === '"') {
          k++;
          let closed = false;
          while (k < len) {
            if (chars[k] === '"') {
              let trailing = 0;
              while (trailing < hashes && k + 1 + trailing < len && chars[k + 1 + trailing] === '#') {
                trailing++;
              }
              if (trailing === hashes) {
                j = k + 1 + hashes;
                closed = true;
                break;
              }
            }
            k++;
          }
          if (!closed) {
            inRawString = hashes;
            j = len;
          }
          continue;
        }
      }

      // Python triple-quote strings: \"\"\" or '''
      if ((c === '"' || c === '\'') && j + 2 < len && chars[j + 1] === c && chars[j + 2] === c) {
        const tq = c;
        j += 3;
        let closedTriple = false;
        while (j + 2 < len) {
          if (chars[j] === tq && chars[j + 1] === tq && chars[j + 2] === tq) {
            j += 3;
            closedTriple = true;
            break;
          }
          j++;
        }
        if (!closedTriple) {
          for (let ti = i + 1; ti < total; ti++) {
            const cl = lines[ti].indexOf(tq.repeat(3));
            if (cl >= 0) {
              i = ti;
              j = len;
              break;
            }
          }
          if (j < len) j = len;
        }
        continue;
      }

      // String literals
      if (c === '"' || c === '\'' || c === '`') {
        inString = c;
        j++;
        continue;
      }

      // Brace/bracket tracking (skip for Python indent-only blocks)
      if (!indentOnly) {
        if (c === '{') {
          depth++;
          foundOpen = true;
        } else if (c === '[') {
          // Skip empty [] (type annotations like SectionDef[])
          if (j + 1 < len && chars[j + 1] === ']') {
            j += 2;
            continue;
          }
          depth++;
          foundOpen = true;
        } else if (c === '}' && templateDepth > 0 && depth > 0) {
          // Template literal: closing } of ${...} re-enters backtick string mode
          depth--;
          if (depth <= 0 && foundOpen) {
            // This } closes the outer block, not a template interpolation
            depth++; // undo
            templateDepth--;
            inString = '`';
            j++;
            continue;
          }
          templateDepth--;
          inString = '`';
          j++;
          continue;
        } else if ((c === '}' || c === ']') && foundOpen) {
          depth--;
          if (depth <= 0) return i;
        }
      }

      j++;
    }

    // Indentation-based fallback for no-open-brace blocks
    if (!foundOpen && i > start && inRawString === null) {
      const trimmedLine = lines[i].trim();
      // Rust `where` clauses and trait bounds are continuation lines
      const isRustContinuation = trimmedLine === 'where'
        || trimmedLine.startsWith('where ')
        || trimmedLine.endsWith(',')
        || trimmedLine.endsWith('+');
      if (!isRustContinuation) {
        const currentIndent = lines[i].length - lines[i].trimStart().length;
        const startIndent = lines[start].length - lines[start].trimStart().length;
        if (currentIndent <= startIndent && trimmedLine.length > 0) {
          return Math.max(i - 1, start);
        }
      }
    }
  }

  // Fallback: last non-empty line
  for (let i = total - 1; i >= start; i--) {
    if (lines[i].trim().length > 0) return i;
  }
  return Math.max(0, total - 1);
}

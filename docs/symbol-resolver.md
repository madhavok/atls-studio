# Symbol Resolver — Frontend Parser

**Module**: [`atls-studio/src/utils/symbolResolver.ts`](../atls-studio/src/utils/symbolResolver.ts)
**Tests**: [`symbolResolver.test.ts`](../atls-studio/src/utils/__tests__/symbolResolver.test.ts) (~1500 lines)
**Rust parity**: [`src-tauri/src/shape_ops.rs`](../atls-studio/src-tauri/src/shape_ops.rs) (`resolve_symbol_anchor_lines`, `find_block_end`, `kind_to_regex_prefix`, `extract_symbol_names`)

A pure-TypeScript content scanner that resolves symbol anchors — `fn(name)`, `cls(Name)`, `sym(Name)`, `fn(name#2)` — to 1-based `[start, end]` line ranges. No tree-sitter, no AST: just tiered regex + string/comment-aware brace tracking. Runs in the renderer wherever the Rust backend is unavailable or undesired (UHPP hash expansion, post-edit relocation, symbol-name suggestions).

## Why a frontend parser exists

The Tauri backend owns the canonical tree-sitter resolution (`ast_query.rs` + `shape_ops.rs`). A parallel TS implementation is retained for three reasons:

1. **UHPP `sym()` / `fn()` expansion** in [`hashResolver.ts`](../atls-studio/src/utils/hashResolver.ts) runs inline against `entry.content` already held in the renderer. Round-tripping to Rust per modifier would add latency and churn.
2. **Freshness relocation** ([`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts)) rebinds stale line spans after same-round edits. Relocation operates on in-memory post-edit content that has not yet been flushed to disk.
3. **Deterministic parity** with the Rust resolver is a correctness contract. Both implementations consume the same regex prefix table and share integration fixtures.

## Public API

| Export | Purpose |
|--------|---------|
| `resolveSymbolToLines(content, kind, name) → [start, end] \| null` | 1-based inclusive line range. `null` when no match. |
| `kindToRegexPrefix(kind) → string` | Regex prefix for a canonical symbol kind. Falls back to a multi-keyword default when kind is unknown or `undefined`. |
| `parseOverloadIndex(name) → [baseName, idx \| null]` | Splits `foo#2` into `["foo", 2]`. Non-numeric or missing `#` returns `[name, null]`. |
| `findBlockEnd(lines, start, total) → endIdx` | Locate the last line of the block declared at `start`. String/comment aware. |
| `extractSymbolNames(content, kind) → string[]` | All declared names for a kind (used to build similar-name suggestions). |
| `findSimilarNames(names, search) → string[]` | Top-5 fuzzy matches (exact > prefix > substring). |

All functions are pure, synchronous, and free of I/O. They accept raw file content (string) and return values or `null`; no exceptions are thrown on miss.

## Resolution tiers

`resolveSymbolToLines` runs up to five tiers, stopping at the first that yields matches:

| Tier | Strategy | Guards |
|------|----------|--------|
| 1 | `kindToRegexPrefix(kind)` + escaped name, per-line substring pre-filter | Always active |
| 1.5a | JS/TS class-method shorthand: `^\s+(?:async\s+)?(?:static\s+)?(?:get\s+\|set\s+)?(?:#)?name\s*\(` | Only for `fn`, `undefined`, `sym`. Rejects assignments (`name = fn`). |
| 1.5b | Variable-bound arrow / `const x = function` | Same guard as 1.5a |
| 2 | C-family return-type syntax (`void parse_number(...)`, `public String toJson(...)`) | Rejects expression contexts (`.name(`, `=name(`, import lines) |
| 3 | Go `type Name struct\|interface` | Only for `struct`, `trait`, `interface`, `undefined`, `sym` |

Tier ordering follows the Rust resolver exactly. When an overload index is present (`#N`), `resolveSymbolToLines` keeps the **Nth** match (1-based) from the winning tier; otherwise the first match wins.

After a tier matches, the resolver:

- **Skips bodyless lines** (re-exports, `export {} from`, trailing `;` without `{`) for kinds where a body is expected — returning a single-line span for aliases (`type`, `const`, `field`, `variant`, `macro`, …).
- **Rolls back to preceding decorators** — `@Component`, `#[derive(...)]`, `[[nodiscard]]`, `///`, `//!`, `/** … */` — extending `start` upward.
- **Calls `findBlockEnd`** to extend `end` downward through the body.

Output is 1-based inclusive `[start, end]`, aligned with the display layer and Rust `resolve_symbol_anchor_lines`.

## `kindToRegexPrefix` — canonical kinds

Each kind maps to a regex prefix that accepts the common visibility / modifier combinations for the kind's host languages. See the table in [`hash-protocol.md`](./hash-protocol.md#symbol-extraction) for the UHPP alias surface (`class()→cls`, `interface()→trait`, `ns()→mod`, …).

| Kind(s) | Languages covered | Modifiers accepted |
|---------|-------------------|--------------------|
| `fn` | Rust `fn`, TS/JS `function`, Python `def`, Go `func`, Kotlin `fun`, Swift `func`, generic `method` | `pub(…)`, `unsafe`, `const`, `async`, `extern "C"`, receiver path (`self.foo.bar`) |
| `cls` / `class` | TS/JS, Python, Java, C#, Kotlin, Swift, C++ | `pub`, `export`, `abstract` |
| `struct` | Rust, Go, Swift, C/C++ | `pub(…)` |
| `trait` / `interface` | Rust trait, TS/Java/Kotlin interface | `pub`, `export` |
| `protocol` | Swift | `public`, `open`, `internal`, `fileprivate`, `private`, `@objc` |
| `enum` | Rust, TS, Java, C#, Swift, Kotlin | `pub`, `export` |
| `record` | Java, C#, Kotlin data class | `pub`, `export`, `public`, `private`, `protected`, `internal`, `sealed`, `data` |
| `extension` | Swift | visibility keywords |
| `mixin` | Dart | — |
| `macro` | Rust `macro_rules!`, C `#define`, generic `macro` | `pub` |
| `type` | Rust/TS `type`, C `typedef` | `pub`, `export` |
| `impl` | Rust `impl`, `impl Trait for Struct`, generic `impl<T>` | `pub` |
| `const` / `static` | const/static/final across languages | `pub`, `export` + optional type annotation (`const int MAX`) |
| `mod` / `ns` / `namespace` / `package` | Rust `mod`, C++ `namespace`, Java `package`, ES `module` | `pub` |
| `ctor` | constructors (`constructor`, `new`) | visibility |
| `property` | `get`/`set` accessors | visibility, `static`, `readonly` |
| `field` | class/struct fields | visibility, `readonly`, `static`, type prefix |
| `enum_member` / `variant` | enum variants | — (anchored at start of line) |
| `operator` | C++/Rust `operator` | — |
| `event` | C# `event` | — |
| `object` | Kotlin `object`, `companion object` | — |
| `actor` | Swift actor | visibility |
| `union` | C/C++ union | — |

Unknown or `undefined` kinds fall back to a default prefix that matches any of: `fn`, `fun`, `function`, `def`, `func`, `class`, `struct`, `interface`, `trait`, `enum`, `type`, `impl`, `macro_rules!`, `protocol`, `record`, `extension`, `mixin`, `object`, `actor`, `union`.

## `findBlockEnd` — string- and comment-aware

The block-end finder is the most intricate piece of the parser. It tracks brace/bracket depth while correctly ignoring braces inside strings, comments, and template interpolations. Strategy selection is keyed off the declaration line:

| Declaration shape | Strategy |
|-------------------|----------|
| Trailing `;` with no `{` | Single-line span (`return start`) |
| Matches Ruby/Elixir opener (`def`, `class`, `module`, `do`, `begin`, `if`, `unless`, `case`) without `{` or `:` | Keyword-block tracking: depth-count `def/class/…` vs `end` / `end;` / `end)` |
| `(local )?function` without `{` | Lua `function…end` tracking (openers: `function`, `if`, `for`, `while`, `repeat`; closers: `end`, `until`) |
| Trailing `:` | Python indentation mode — block ends when a non-empty line's indent ≤ `start`'s indent. Lines starting with `#` are treated as comments. |
| Otherwise | Brace tracking (`{`, `[`, `}`, `]`) with skip rules below |

### Skip rules (brace mode)

The scanner walks characters and skips braces inside:

- **Line comments**: `//` for C-family; `#` for Python-indent blocks.
- **Block comments**: `/* … */`, multi-line.
- **String literals**: `"…"`, `'…'`, backticks.
- **Template literals**: `` `…${expr}…` `` — on `${` the scanner exits string mode and increments `templateDepth`; on the matching `}` it decrements and re-enters backtick mode, never closing the outer block.
- **Rust raw strings**: `r"…"`, `r#"…"#`, `r##"…"##`, … — `#` count is preserved across line boundaries via `inRawString`.
- **Python triple-quote strings**: `"""…"""` and `'''…'''`, multi-line.
- **Empty `[]`**: skipped wholesale so TS type annotations (`SectionDef[]`) do not open a bracket level.
- **Rust `where` clauses / trait bounds**: lines that are just `where`, or end with `,`, `+` are treated as continuation lines for the indentation fallback.

### Indentation fallback

If no `{` has been seen yet and the scanner passes a line whose indent is ≤ `start`'s indent (excluding Rust continuation lines), the block is considered closed on the previous line. This handles Python/JSX-style blocks that never reach a brace, plus Rust functions with `where` clauses preceding `{`.

Absent any close condition, the fallback is the last non-empty line of the content.

## Overload indexing

`foo#2` selects the second declaration of `foo` among the matches returned by the winning tier. `foo#0` or indices outside range produce `null`. Useful for files with multiple constructors, overloaded Java/C# methods, or re-exported shadows.

```
h:abc123:fn(toJson#2)   → second `toJson` declaration in the file
```

`parseOverloadIndex` handles edge cases: `a#b#3` → `["a#b", 3]`; non-numeric suffix (`foo#abc`) → `["foo#abc", null]`; leading `#2` → `["", 2]`.

## Decorator / annotation rollback

Before returning, `resolveSymbolToLines` walks backward from the matched line, absorbing any contiguous block of:

- `@decorator` (Python, Java, Kotlin, TS)
- `#[attr]` / `#![attr]` (Rust)
- `[[attribute]]` (C++)
- `///`, `//!` (Rust/Doxygen doc comments)
- `/**`, `*`, `*/` (JSDoc / block doc comment body)
- `/*` (block comment opener)
- blank lines interleaved with the above

The returned `start` is the first decorator/doc-comment line, so hash expansion like `h:X:fn(bar):sig` captures the JSDoc that documents `bar`.

## Bodyless detection

A line is **bodyless** when either of:

- Trimmed ends with `;` and contains no `{` (C/Java forward declarations, TS ambient declarations).
- Trimmed starts with `export {` or `import {` and contains ` from ` (ES re-export / re-import).

For kinds where a body is always expected (`fn`, `cls`, `struct`, `trait`, `impl`, …) bodyless lines are collapsed to a single-line span. Declaration-only kinds (`const`, `static`, `type`, `macro`, `field`, `property`, `enum_member`, `variant`, `event`) skip the bodyless check entirely so their natural single-line span is preserved.

## `extractSymbolNames` + `findSimilarNames`

Used for **error-message hints** when a UHPP anchor misses. `extractSymbolNames` runs the prefix regex globally, with a 16 KB per-line guard against minified bundles. `findSimilarNames` scores candidates as:

| Score | Rule |
|-------|------|
| 100 | exact lowercase match |
| 50 | prefix match either direction |
| 25 | substring match either direction |
| 0 | dropped |

Top 5 scored names are returned, letting the resolver surface `did you mean …?` when the model references a function name with a typo.

## Consumers

| Caller | Role |
|--------|------|
| [`hashResolver.ts`](../atls-studio/src/utils/hashResolver.ts) | Expands UHPP modifiers with a `symbol` component (`:fn(name)`, `:cls(Name)`, `:sym(Name)`, `:<kind>(name):sig`). Throws only when `opts.missingSymbol === 'throw'`; otherwise returns the original entry with an attached warning. |
| [`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts) | Post-edit relocation: when stored line spans go stale, retries with the original symbol anchor against the new content to produce a fresh `[start, end]`. |
| UHPP anchor parsing | [`hashModifierParser.ts`](../atls-studio/src/utils/hashModifierParser.ts) produces the `{kind, name}` objects fed into `resolveSymbolToLines`. |

All three paths rely on the resolver being **pure + sync + side-effect-free** so they can be called from hot freshness loops and preflight without awaiting.

## Rust parity

The Rust resolver in `shape_ops.rs` defines the canonical behavior:

- `kind_to_regex_prefix` (line ~198) — same canonical kind table.
- `resolve_symbol_anchor_lines` (line ~359) — same tiered fallback.
- `find_block_end` (line ~424) — same string/comment/template/raw-string tracking.
- `resolve_symbol_anchor_lines_lang` (line ~1000) — language-aware wrapper the TS version does not have; it adds tree-sitter-backed resolution when the language has a registered parser, falling back to the regex path.

The TS resolver is the **regex path only**. Divergences between the two implementations are bugs; the test file contains shared fixtures that should keep them aligned. Whenever `shape_ops.rs` adds a new kind, modifier, or fallback tier, mirror the change in `symbolResolver.ts` and extend `symbolResolver.test.ts`.

## Testing

`symbolResolver.test.ts` exercises:

- `parseOverloadIndex` edge cases (empty, multi-`#`, non-numeric suffix).
- `kindToRegexPrefix` coverage across all canonical kinds and their language variants.
- `findBlockEnd` for: nested braces, strings (single/double/backtick), template literals, line/block comments, Python colon-blocks (nested), Ruby `def…end` (nested), Rust raw strings, Rust `where` clauses.
- `resolveSymbolToLines` integration: TS/JS (function, class, interface, enum, type, const, overloads, arrow functions), Rust (struct, impl, trait, macro), Python, Ruby, C-family return-type syntax, Go `type struct`, decorator rollback, `#N` overload selection.

New behavior must land with parallel tests in both `symbolResolver.test.ts` and the Rust test module in `shape_ops.rs` (`test_resolve_symbol_anchor_lines_*`).

## Limitations

- **Regex-based** — cannot distinguish symbols in macro-expanded code, template bodies, or conditionally-compiled blocks. For those, defer to the Rust tree-sitter path.
- **One file at a time** — no cross-file resolution. Callers are responsible for selecting the correct file content before calling.
- **No type information** — overloads are ordered by textual occurrence, not signature match.
- **Single-line scan per match** — signatures split across multiple lines (e.g., Rust functions with `where` on a new line) are matched on their header line only; the body extension still works via `findBlockEnd`.

These limitations are intentional: the resolver is a **fast, deterministic fallback**, not a replacement for the Rust tree-sitter pipeline.

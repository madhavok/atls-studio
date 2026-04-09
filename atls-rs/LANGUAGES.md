# Supported Languages

ATLS supports the following programming languages through tree-sitter parsing and the core editing engine.

## Language Support Matrix

| Language | Extensions | Body Detection | Symbol Extraction | Linting | Qualified Refs |
|----------|-----------|---------------|------------------|---------|----------------|
| TypeScript | `.ts`, `.tsx` | Brace-based | ✅ Tree-sitter | ✅ SWC | ✅ |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | Brace-based | ✅ Tree-sitter | ✅ SWC | ✅ |
| Python | `.py` | Indent-based | ✅ Tree-sitter | — | ✅ |
| Go | `.go` | Brace-based | ✅ Tree-sitter | — | ✅ |
| Java | `.java` | Brace-based | ✅ Tree-sitter | — | ✅ |
| Rust | `.rs` | Brace-based | ✅ Tree-sitter | — | ✅ |
| C# | `.cs` | Brace-based | ✅ Tree-sitter | — | ✅ |
| PHP | `.php` | Brace-based | ✅ Tree-sitter | — | — |
| Swift | `.swift` | Brace-based | ✅ Tree-sitter | — | — |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx` | Brace-based | ✅ Tree-sitter | — | — |
| C | `.c`, `.h` | Brace-based | ✅ Tree-sitter | — | — |
| Ruby | `.rb` | Brace-based | ✅ Tree-sitter | — | — |
| Scala | `.scala` | Brace-based | ✅ Tree-sitter | — | — |
| Kotlin | `.kt`, `.kts` | Brace-based | ✅ Tree-sitter | — | — |
| Dart | `.dart` | Brace-based | ✅ Tree-sitter | — | — |

## Feature Details

### Body Detection

Body detection determines the boundaries of functions, classes, and other code blocks for operations like `replace_body` and `extract`.

- **Brace-based** (most languages): Tracks matching `{`/`}` pairs while correctly handling strings, comments, template literals, regex literals, and nested structures. The scanner (`scan_char` in `lib.rs`) handles:
  - Single and double-quoted strings with escape sequences
  - Template literals with nested expressions (`` `${expr}` ``)
  - Line comments (`//`) and block comments (`/* */`)
  - Regex literals (`/pattern/`) distinguished from division operators
  - JSX/TSX angle bracket contexts

- **Indent-based** (Python): Detects `def`, `class`, and `async def` blocks by tracking indentation levels. The body starts at the first indented line after the colon and extends until indentation returns to or below the definition level.

### Symbol Extraction

Tree-sitter grammars provide accurate symbol extraction for all supported languages, enabling:

- `h:XXXX:fn(name)` — reference a function by name
- `h:XXXX:cls(Name)` — reference a class by name
- `h:XXXX:sym(Name)` — reference any symbol by name
- Symbol-based edit actions (`replace_body`, `move`, `delete`)
- Dependency analysis and call graph construction

### Linting (TypeScript/JavaScript)

SWC-powered linting provides:

- Syntax error detection with location information
- Fix suggestions with confidence levels
- Template literal parsing with nested expression support
- Generic type parameter handling (distinguishing `<T>` from comparison operators)
- Barrel export deduplication
- Both syntax-only (fast) and deep (comprehensive) check modes

### Qualified References

For languages that support it, ATLS tracks qualified external references (e.g., `module.symbol` in Go, `crate::module::symbol` in Rust) to enable accurate consumer rewiring during refactoring operations like rename and move.

## Language Detection

Language detection maps file extensions to canonical language names via the `get_language` function in the linter module. The mapping is used by:

- The linter (for JS/TS-specific SWC analysis)
- The edit engine (for body detection strategy selection)
- The tree-sitter index (for grammar selection)
- The refactoring engine (for import/export syntax)

## Adding Language Support

To add support for a new language:

1. **Register the tree-sitter grammar** in the core crate
2. **Map file extensions** to the canonical language name in `get_language`
3. **Define symbol query patterns** for the tree-sitter grammar
4. **Choose body detection strategy** — brace-based for most languages, indent-based for whitespace-sensitive languages
5. **Add qualified reference patterns** (optional) for refactoring consumer rewiring
|------|-----------|---------------|
| Tier 1 — Full | TypeScript, JavaScript, Python, Rust, Java, Go, C, C++, C#, Swift, PHP, Ruby, Scala, Dart | Parse (tree-sitter), Index (symbols/imports), Lint (syntax + tooling), Pattern detection |
| Tier 2 — Index via fallback | Kotlin | Hash refs, symbol anchors, :refs, :deps, Lint (kotlinc), Index (regex-based symbols/imports) |

## Tree-Sitter Grammar Versions

| Language | Crate | Version |
|----------|-------|---------|
| TypeScript | tree-sitter-typescript | 0.23 |
| JavaScript | tree-sitter-javascript | 0.25 |
| Python | tree-sitter-python | 0.25 |
| Rust | tree-sitter-rust | 0.24 |
| Java | tree-sitter-java | 0.23 |
| Go | tree-sitter-go | 0.25 |
| C/C++ | tree-sitter-cpp | 0.23 |
| C# | tree-sitter-c-sharp | 0.23 |
| Swift | tree-sitter-swift | 0.7 |
| PHP | tree-sitter-php | 0.24 |
| Ruby | tree-sitter-ruby | 0.23 |
| Scala | tree-sitter-scala | 0.23 |
| Dart | tree-sitter-dart-orchard | 0.3 |

Kotlin: tree-sitter-kotlin requires tree-sitter \< 0.23; workspace uses 0.25. Regex fallback provides symbols and imports.

## Node Types (Contributor Reference)

For adding extractors or patterns, key node types per grammar:

| Language | Import nodes | Call nodes | Scope nodes |
|----------|--------------|------------|-------------|
| Swift | `import_declaration` | `call_expression` | `function_declaration`, `class_declaration` |
| PHP | `include_expression`, `use_declaration` | `call_expression` | `function_definition` |
| Ruby | `call` (require) | `call` | `method`, `class`, `module` |
| Scala | `import_declaration` | `call_expression` | `function_definition`, `class_definition` |
| Dart | `library_import` | `invocation_expression`, `function_invocation` | `class_definition`, `function_signature`, `method_signature` |

Kotlin: regex fallback (no tree-sitter). See `fallback_extractor.rs` for patterns.

See each grammar's `node-types.json` (tree-sitter/tree-sitter-{lang} on GitHub) for full reference.

# ATLS Language Support

## Tier Overview

| Tier | Languages | Capabilities |
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

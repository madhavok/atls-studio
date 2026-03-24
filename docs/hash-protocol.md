# Hash Protocol (HPP) & Reference Syntax (UHPP)

ATLS uses two complementary hash systems: the **Hash Presence Protocol (HPP)** for tracking engram visibility across turns, and the **Universal Hash Pointer Protocol (UHPP)** for referencing, slicing, and operating on engrams.

## Hash Presence Protocol (HPP)

HPP tracks the visibility state of every engram across the turn-based conversation, enabling the prompt assembly layer to know exactly what the model can "see."

### Visibility States

```typescript
type ChunkVisibility = 'materialized' | 'referenced' | 'archived' | 'evicted';
```

| State | In Prompt? | Content Shown | Recallable |
|-------|-----------|---------------|------------|
| **materialized** | Yes | Full content in ACTIVE ENGRAMS | — |
| **referenced** | Counted only | "N dormant engrams" | Yes |
| **archived** | No | Not shown | Yes |
| **evicted** | No | Not shown | Must re-read |

### ChunkRef

```typescript
interface ChunkRef {
  hash: string;
  shortHash: string;
  type: ChunkType;
  visibility: ChunkVisibility;
  seenAtTurn: number;
  pinned?: boolean;
  pinnedShape?: string;
  source?: string;
  tokens: number;
  totalLines: number;
  editDigest: string;
  freshness?: FreshnessState;
  freshnessCause?: FreshnessCause;
  origin?: 'read' | 'edit' | 'stage' | 'derived';
}
```

### Turn Lifecycle

On each turn:

1. **`advanceTurn()`** increments `currentTurn`. Materialized refs from prior turns that are unpinned (`seenAtTurn < currentTurn && !pinned`) transition to `referenced`.
2. **`materialize(hash, ...)`** creates or updates a ref as `materialized` with `seenAtTurn = currentTurn`. Called when new engrams are read, edited, or recalled.
3. **`dematerialize(hash)`** transitions `materialized → referenced` within the same turn. Used when history compression replaces content with a hash pointer.
4. **`archive(hash)`** transitions to `archived`. Excluded from working memory formatting.
5. **`evict(hash)`** transitions to `evicted`. Fully removed from prompt.

### Materialization Decision

```typescript
function shouldMaterialize(ref: ChunkRef): boolean {
  if (ref.visibility === 'archived' || ref.visibility === 'evicted') return false;
  if (ref.visibility !== 'materialized') return false;
  return ref.seenAtTurn === currentTurn || !!ref.pinned;
}
```

Only engrams materialized this turn (or pinned) get their full content in the prompt. Everything else appears as a dormant count or is invisible.

### Sorting

```typescript
function sortRefs(a: ChunkRef, b: ChunkRef): number {
  const aFile = FILE_TYPES.has(a.type);
  const bFile = FILE_TYPES.has(b.type);
  if (aFile !== bFile) return aFile ? -1 : 1;
  return b.seenAtTurn - a.seenAtTurn;
}
```

File-backed engrams before artifacts, then by turn (most recent first).

---

## Universal Hash Pointer Protocol (UHPP)

UHPP provides a rich reference syntax for addressing, slicing, and operating on engrams.

### Basic References

```
h:a1b2c3                 → Direct hash reference (6-16 hex chars)
h:a1b2c3d4e5f6           → Full 16-char hash
```

Resolution: exact map key → exact `shortHash` → unambiguous prefix match (≥8 chars).

### Line Ranges

```
h:a1b2c3:15-50           → Lines 15 through 50
h:a1b2c3:15-22,40-55     → Multiple ranges
h:a1b2c3:45              → Single line
h:a1b2c3:45-             → Line 45 to end of file
```

### Shapes (Structural Views)

Transform engram content into alternative views without modifying the source:

| Shape | Description | Typical Savings |
|-------|-------------|-----------------|
| `sig` | Function/class signatures only | ~85% token reduction |
| `fold` | Collapsed function bodies | ~50-70% |
| `dedent` | Remove leading whitespace | ~10-15% |
| `nocomment` | Strip comments | ~10-30% |
| `imports` | Import statements only | ~90% |
| `exports` | Export statements only | ~90% |
| `head(N)` | First N lines | Variable |
| `tail(N)` | Last N lines | Variable |
| `grep(pattern)` | Lines matching pattern | Variable |

**Composable**: `h:a1b2c3:15-80:dedent`, `h:a1b2c3:fn(init):sig`, `h:a1b2c3:15-50:hl(22,25-27)`

### Symbol Extraction

Extract specific symbols from a file by name and kind:

```
h:XXXX:fn(name)           → Specific function
h:XXXX:cls(Name)          → Specific class
h:XXXX:sym(Name)          → Any symbol by name
h:XXXX:fn(name):sig       → Function signature only
h:XXXX:fn(name#2)         → Second overload of a function
```

**Supported symbol kinds** (from the UHPP parser):

| Kind | Maps To | Notes |
|------|---------|-------|
| `fn()` | fn | Function |
| `cls()` | cls | Class (alias: `class()`) |
| `struct()` | struct | Struct |
| `trait()` | trait | Trait (alias: `interface()`) |
| `protocol()` | protocol | Protocol |
| `enum()` | enum | Enum |
| `record()` | record | Record |
| `union()` | union | Union |
| `type()` | type | Type alias |
| `alias()` | alias | Alias |
| `const()` | const | Constant |
| `var()` | var | Variable |
| `let()` | let | Let binding |
| `prop()` | prop | Property |
| `field()` | field | Field |
| `attr()` | attr | Attribute |
| `method()` | method | Method |
| `impl()` | impl | Implementation block |
| `mod()` | mod | Module (alias: `ns()`, `pkg()`) |
| `macro()` | macro | Macro |
| `test()` | test | Test function |
| `sym()` | *(any)* | Generic — matches any symbol kind |

The Rust backend resolves symbols via tree-sitter, so extraction works across languages. Symbols are used in extraction, refactoring, and navigation: `refactor(extract:"fn(name)", from:"h:XXXX", to:"target.ts")`.

### Exclusions and Highlights

```
h:a1b2c3:ex(15-30)       → Exclude lines 15-30 from output
h:a1b2c3:hl(22,25-27)    → Highlight specific lines in rendered output
```

### Semantic Modifiers

Pattern-based content extraction beyond structural shapes:

```
h:XXXX:concept(auth)              → Extract code related to "auth" concept
h:XXXX:pattern(error-handling)    → Extract error-handling patterns
h:XXXX:if(has(TODO))              → Conditional: include only if content has TODOs
```

### Meta Modifiers (Zero Content Cost)

Retrieve metadata without transferring content:

```
h:XXXX:tokens             → Token count only
h:XXXX:meta               → Metadata (source, type, revision, freshness)
h:XXXX:lang               → Detected language
h:XXXX:source             → Source file path
h:XXXX:content            → Full content (explicit)
```

### Blackboard References

```
h:bb:plan                 → Blackboard entry by key
h:bb:findings             → Another blackboard entry
h:bb:plan:sig             → Blackboard entry with shape applied
```

### Recency References (Intra-Batch Hash Chaining)

Reference engrams by recency within a batch or across turns:

```
h:$last                   → Most recently accessed engram
h:$last-1                 → Second most recent
h:$last-2                 → Third most recent
h:$last_edit              → Most recently edited engram
h:$last_read              → Most recently read engram
h:$last_stage             → Most recently staged engram
```

These resolve at batch execution time, enabling chaining without knowing hashes in advance:

```json
{"id": "r1", "use": "read.context", "with": {"file_paths": ["src/api.ts"]}},
{"id": "p1", "use": "session.pin", "with": {"hashes": ["h:$last"]}}
```

### Set Selectors

Dynamically select groups of engrams:

```
h:@all                    → All active refs
h:@edited                 → All result-type refs
h:@pinned                 → All pinned refs
h:@dormant                → All dormant (compacted) refs
h:@stale                  → All stale refs
h:@latest                 → Most recent N refs
h:@latest:5               → Most recent 5 refs
h:@file=*.ts              → Glob pattern on source path
h:@type=search            → Filter by chunk type
h:@sub:subtask1           → Bound to subtask
h:@ws:frontend            → Workspace filter
h:@search(auth)           → Dynamic search selector
h:@search(auth,limit=5,tier=high) → Parameterized search
```

### Set Operations

Combine selectors with boolean operators:

```
h:@edited+h:@file=*.ts    → Union: edited OR TypeScript files
h:@edited&h:@file=*.ts    → Intersect: edited AND TypeScript files
h:@all-h:@pinned          → Difference: all except pinned
h:@search(auth)&h:@file=*.rs → Search results intersected with Rust files
```

Set refs are expanded inline during batch execution via `expandSetRefsInHashes` — the model writes `h:@file=*.ts` in a `session.unload` call and the executor resolves it to concrete hash list before dispatch.

### Diff References

```
h:abc..h:def              → Unified diff between two engram versions
```

The UI renders diff refs as collapsible diff views. The diff trail (`h:OLD..h:NEW`) is the standard way to review changes after edits.

### Temporal References (Git Time Travel)

Access file content at any point in git history:

```
HEAD~1:src/auth.ts        → File at previous commit
HEAD~3:src/auth.ts        → File 3 commits ago
tag:v1.0:src/auth.ts      → File at a tagged release
commit:abc123:src/auth.ts → File at a specific commit
```

Temporal refs are resolved by the Rust backend via `resolve_temporal_ref`, which:
1. Runs `git show <ref>:<path>` against the repository
2. Registers the content in the hash registry
3. Returns the resolved content with optional shape applied
4. Tries all workspace roots (active first) until one succeeds

Shapes compose with temporal refs: `HEAD~1:src/auth.ts:sig` retrieves the signature-only view of the file at the previous commit.

### Content-As-Ref (Inline Resolution)

Hash refs auto-resolve when used as content values in batch parameters:

```json
{"use": "change.create", "with": {"creates": [{"path": "new.ts", "content": "h:XXXX:fn(name):dedent"}]}}
```

The content field resolves to the extracted, dedented function from the referenced engram. This enables content composition without the model copying code.

For edits, ref content is treated as discovery material — the system ensures edit targets match live file state via snapshot hashing, not the referenced content.

---

## Batch-Level Hash Resolution

When the batch executor dispatches a step to the Rust backend, all `h:` references in the parameters are resolved inline by `resolve_hash_refs`:

1. **`file` / `file_path` fields**: `h:XXXX` resolves to the source path (not content)
2. **`content` / `content_hash` fields**: `h:XXXX` resolves to content (with modifiers applied)
3. **`hashes` fields**: `h:` prefix stripped, passed through as raw hashes
4. **`deletes` / `restore` fields**: `h:XXXX` resolves to source path
5. **Set refs** (`h:@...`): Expanded via `expandSetRefsInHashes` before backend dispatch
6. **Nested edits**: Each entry in `edits[]` and `line_edits[]` gets individual resolution

Unresolved refs are left as literal strings with a warning — resolution is lenient to avoid hard failures on transient hash registry gaps.

---

## Shadow Versions (Hash Forwarding Rollback)

When edits create new file versions, the previous content is preserved as a shadow version in the chat database:

```
insert_shadow_version(session_id, source_path, hash, content, replaced_by)
list_shadow_versions(session_id, source_path) → version history
get_shadow_version(session_id, hash) → specific prior content
```

Shadow versions enable:
- **Rollback**: `change.rollback` with `restore:[{file, hash}]` retrieves content from shadow versions
- **Diff trail**: `h:OLD..h:NEW` diffs resolved from shadow version content
- **Audit**: Full edit history for a file within a session

**Rollback recency**: For `restore[].hash`, use `h:$last_edit` / `h:$last_edit-N` (edit stack) or explicit hashes from a paused execute’s `_rollback`. Prefer **not** `h:$last` / `h:$last-N` here — those resolve from the **global** hash stack (reads, search, edits, etc.) and may not match a registry-backed restore target.

---

## HPP Version History

| Version | Added |
|---------|-------|
| **v1** | Core materialized/referenced/archived/evicted visibility |
| **v2** | ShapeOp, DiffRef, SymbolAnchor parsing |
| **v3** | Set references (`h:@selector`) for multi-hash operations; hash registry persistence |
| **v4** | Recency refs (`h:$last` / `h:$last-N`) for intra-batch hash chaining |
| **v5** | Semantic modifiers, search selectors, composite set operations |
| **v6** | Symbol kind catalog, content-as-ref, extract/refactor integration, temporal refs |

These rows are **UHPP reference-syntax** versions (how `h:` refs are parsed and resolved). They are **not** the same as **persisted memory snapshot** format versions (v4/v5) in [session-persistence.md](./session-persistence.md).

---

**Source**: [`hashProtocol.ts`](../atls-studio/src/services/hashProtocol.ts), [`hashRefParsers.ts`](../atls-studio/src/utils/hashRefParsers.ts), [`hashModifierParser.ts`](../atls-studio/src/utils/hashModifierParser.ts), [`uhppTypes.ts`](../atls-studio/src/utils/uhppTypes.ts), [`uhppExpansion.ts`](../atls-studio/src/services/uhppExpansion.ts), [`hash_resolver.rs`](../atls-studio/src-tauri/src/hash_resolver.rs), [`hash_commands.rs`](../atls-studio/src-tauri/src/hash_commands.rs), [`hashProtocol.ts` (prompt)](../atls-studio/src/prompts/hashProtocol.ts)

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
| **referenced** | Header-counted + per-row in `## HASH MANIFEST` | Each ref appears as a compact `demat` row (hash, source, tokens, total lines); header tracks aggregate counts | Yes |
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

### Scoped views

`createScopedView()` returns a `ScopedHppView` with an isolated `advanceTurn` that only increments a **local** turn counter. It does **not** dematerialize refs, and it does **not** run the main `roundRefreshHook` (the hook that triggers `refreshRoundEnd` on the global context store). See [`hashProtocol.ts`](../atls-studio/src/services/hashProtocol.ts). Used by subagents and test harnesses that need turn-local accounting without disturbing the main protocol state or reconciliation pipeline.

### Materialization Decision

```typescript
function shouldMaterialize(ref: ChunkRef): boolean {
  if (ref.visibility === 'archived' || ref.visibility === 'evicted') return false;
  if (ref.visibility !== 'materialized') return false;
  return ref.seenAtTurn === currentTurn || !!ref.pinned;
}
```

Only engrams materialized this turn (or pinned) get their full content in the prompt. Everything else appears as a dormant count or is invisible.

### Interaction with FileView

HPP governs the **per-chunk** visibility state machine. The FileView layer sits above it for file-backed content: a pinned FileView renders its skeleton + fills + fullBody in `## FILE VIEWS` and suppresses its constituent chunks from ACTIVE ENGRAMS (the view is the canonical surface). An unpinned FileView is dormant and does not suppress anything — its constituent chunks participate normally under HPP (`seenAtTurn`-gated dematerialization, TTL archive via `refreshRoundEnd`). `pruneFileViewsForChunks` is invoked when chunks TTL-archive, so dormant views thin naturally as their backing chunks age out. See [engrams.md — FileView lifecycle](./engrams.md#fileview-lifecycle-pin-gated-rollout).

### Sorting

```typescript
// hashProtocol.ts utility — used by manifest and diagnostics
function sortRefs(a: ChunkRef, b: ChunkRef): number {
  const aFile = FILE_TYPES.has(a.type);
  const bFile = FILE_TYPES.has(b.type);
  if (aFile !== bFile) return aFile ? -1 : 1;
  return a.seenAtTurn - b.seenAtTurn;   // ascending: oldest-first within the file/artifact group
}
```

This is the **protocol-level** sort utility. The **prompt's** working-memory ordering is different — [`contextFormatter.ts`](../atls-studio/src/services/contextFormatter.ts) ~298-306 sorts by `b.lastAccessed - a.lastAccessed` (LRU, most-recent first) within the pinned → file-backed → artifact bands. In other words:

- `sortRefs` in `hashProtocol.ts` is a utility used by manifest construction and test code.
- Prompt rendering of ACTIVE ENGRAMS follows **LRU on `lastAccessed`**, not `seenAtTurn`. See [`engrams.md`](./engrams.md#working-memory-chunks) and [`prompt-assembly.md`](./prompt-assembly.md).

---

## Universal Hash Pointer Protocol (UHPP)

UHPP provides a rich reference syntax for addressing, slicing, and operating on engrams.

### Basic References

```
h:a1b2c3                 → Direct hash reference (6-16 hex chars)
h:a1b2c3d4e5f6           → Full 16-char hash
h:bb:key                 → Blackboard entry by key (see §Blackboard References)
```

Resolution: exact map key → exact `shortHash` → unambiguous prefix match (≥8 chars).

### FileView refs — one retention ref per file (unified namespace)

A FileView is the per-path unified surface (skeleton + filled regions + optional `fullBody`) for one source file at one revision. Identity is `h:<SHORT_HASH_LEN hex>` derived from `(normalizedPath, sourceRevision)` — **stable across fills**, so a ref emitted by a first-touch `rs shape:sig` stays valid as subsequent `rl` slices or `rf type:full` land in the same view.

View refs and chunk refs share the same `h:<short>` namespace. The model sees one format. The runtime disambiguates via `resolveAnyRef` in [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts): views win on short-hash collision (retention primitive), chunks fall through. Collision counts are tracked per-round on `RoundSnapshot.refCollisions`.

Read handlers (`read.shaped`, `read.lines`, `read.file`, `read.context`) return this `h:<short>` as their primary ref for every file-backed read. This is the **single retention identity per file** — the model pins / unpins / drops that one ref, and any slice hash for the same file transparently routes to the view (see [engrams.md — FileView lifecycle](./engrams.md#fileview-lifecycle-pin-gated-rollout)).

| Op | Behavior on a view ref (or any slice ref whose source has a FileView) |
|----|-------------------------------------------------------------------------|
| `session.pin` | Pins the view (renders + charges tokens). Non-file chunks still pin at chunk level. |
| `session.unpin` / wildcard `*` | Unpins the view. View stays in state (dormant, 0 prompt cost); re-pin instantly restores it. |
| `session.drop` | Drops the view entry and all backing chunks — model writes one ref, runtime cleans up the whole file's working-memory footprint. |
| Subagent handoff / Tauri IPC | View refs never cross the TS↔Rust boundary — `resolveFileViewRefs` in [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) expands any ref that matches a view into its constituent chunk hashes before ship-out. Non-view refs pass through. |

FileViews are **rendered outside ACTIVE ENGRAMS** in their own `## FILE VIEWS` block (see [prompt-assembly.md](./prompt-assembly.md)); chunks whose hashes back a pinned view are filtered from ACTIVE ENGRAMS to prevent double-render.

Three hash roles coexist for file content — don't confuse them:

| Role | Form | Where it comes from | What it's used for |
|------|------|---------------------|---------------------|
| Retention | `h:<short>` (view-derived) | Read handlers' primary ref | `pi` / `pu` / `dro` — one per file |
| Edit citation | `h:<sourceRevision>` | `@h:XXX` in the FileView block header | `content_hash` on `change.edit`, path refs like `f:h:...:L-M` |
| Slice / range | `h:<chunkHash>` | Search results, edit `edits_resolved`, diff refs, inline `content:"h:..."` | Citing a specific region or piece of content — not for retention |

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
| `sig` | Code: function/class signatures. Markdown: heading outline with `[start-end]` section ranges. | ~85% token reduction |
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

Symbol anchors resolve through the **symbol resolver** — tiered regex prefixes plus a string/comment-aware block-end finder — with TypeScript (`symbolResolver.ts`) and Rust (`shape_ops.rs`) kept in parity. The Rust wrapper `resolve_symbol_anchor_lines_lang` may optionally use **tree-sitter** when a grammar is registered, then fall back to the same regex path; the hot renderer path is regex-only. See [symbol-resolver.md](./symbol-resolver.md). Symbols are used in extraction, refactoring, and navigation: `refactor(extract:"fn(name)", from:"h:XXXX", to:"target.ts")`.

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
h:@edited                 → Refs produced by an edit (origin === 'edit' OR editSessionId != null)
h:@pinned                 → All pinned refs
h:@dormant                → All dormant (compacted) refs
h:@dematerialized         → Refs dematerialized in the last round (demat rows in the manifest)
h:@stale                  → Uncompacted, unpinned chunks with lastAccessed older than 5 min (LRU age — NOT the same as freshness 'suspect')
h:@latest                 → Most recent N refs
h:@latest:5               → Most recent 5 refs
h:@file=*.ts              → Glob pattern on source path
h:@type=search            → Filter by chunk type
h:@sub:subtask1           → Bound to subtask
h:@ws:frontend            → Workspace filter
h:@search(auth)           → Dynamic search selector (async; resolved by resolveSearchRefs)
h:@search(auth,limit=5,tier=high) → Parameterized search
```

**Semantic precision:**

- **`h:@edited`** — [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) ~5906-5908 filters on `origin === 'edit' || editSessionId != null`, not on chunk type. A read ref derived from an edit's output qualifies; a vanilla `search` result does not.
- **`h:@stale`** — [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) ~5920-5924 uses `lastAccessed < now - 5*60_000` over uncompacted, unpinned chunks. This is **LRU age**, not freshness state. An engram marked `freshness: 'suspect'` is surfaced to the model via the `[STALE: re-read before edit]` label (see [`freshness.md`](./freshness.md)), and is a separate concept.
- **`h:@search(...)`** — sync `queryBySetSelector` errors on this selector (it's documented to require async resolution via `resolveSearchRefs` in [`toolHelpers.ts`](../atls-studio/src/services/toolHelpers.ts)). Use only in contexts that run async ref expansion.

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

When the batch executor dispatches a step to the Rust backend, all `h:` references in the parameters are resolved inline by the Tauri command **`batch_resolve_hash_refs`** (see [`hash_resolver.rs`](../atls-studio/src-tauri/src/hash_resolver.rs) and handler wiring in [`handlers/change.ts`](../atls-studio/src/services/batch/handlers/change.ts) ~788):

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
chat_db_insert_shadow_version(session_id, source_path, hash, content, replaced_by)
chat_db_list_shadow_versions(session_id, source_path) → version history
chat_db_get_shadow_version(session_id, hash) → specific prior content
```

These are the Tauri command names as registered in [`src-tauri/src/lib.rs`](../atls-studio/src-tauri/src/lib.rs) `generate_handler!` — the internal Rust handlers live in [`chat_db_commands.rs`](../atls-studio/src-tauri/src/chat_db_commands.rs).

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

**Source**: [`hashProtocol.ts`](../atls-studio/src/services/hashProtocol.ts), [`hashRefParsers.ts`](../atls-studio/src/utils/hashRefParsers.ts), [`hashModifierParser.ts`](../atls-studio/src/utils/hashModifierParser.ts), [`uhppTypes.ts`](../atls-studio/src/utils/uhppTypes.ts), [`uhppExpansion.ts`](../atls-studio/src/services/uhppExpansion.ts), [`hash_resolver.rs`](../atls-studio/src-tauri/src/hash_resolver.rs), [`hash_commands.rs`](../atls-studio/src-tauri/src/hash_commands.rs), [`hashProtocol.ts` (prompt)](../atls-studio/src/prompts/hashProtocol.ts), [`fileViewStore.ts`](../atls-studio/src/services/fileViewStore.ts) (FileView identity + reconcile), [`fileViewRender.ts`](../atls-studio/src/services/fileViewRender.ts) (pin-gated render + cover set)

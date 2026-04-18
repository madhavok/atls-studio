# Engrams & Memory Model

Engrams are the fundamental data unit in ATLS — content-addressed chunks of knowledge with lifecycle metadata. Every file read, code search, tool result, and edit output creates an engram. The model references engrams by hash (`h:a1b2c3`) rather than repeating content.

File-backed content has an additional layer on top of raw chunks: the **Unified FileView** (see [FileView — the unified file-content surface](#fileview--the-unified-file-content-surface)). FileViews are the **primary model-visible surface for source files**; the flat chunk listing (`## ACTIVE ENGRAMS`) is the fallback for non-file artifacts (search, tool results, blackboard derivatives, etc.).

## Data Model

The snippet below lists **core fields** for orientation. The production type has additional fields (`digest`, `editDigest`, `summary`, `createdAt`, `suspectKind`, subtask binding, revision metadata, `readSpan`, etc.). See [`ContextChunk` in `contextStore.ts`](../atls-studio/src/stores/contextStore.ts).

```typescript
interface ContextChunk {
  hash: string;           // 16-char content hash (two FNV-1a 32-bit)
  shortHash: string;      // First 6 chars for human-readable references
  type: ChunkType;        // file, smart, search, symbol, deps, tree, etc.
  content: string;        // Full content or edit-ready digest if compacted
  tokens: number;         // Estimated token count
  source?: string;        // Origin (file path, tool name, command)
  sourceRevision?: string; // File content hash when engram was created
  viewKind?: 'latest' | 'snapshot' | 'derived';
  
  // Lifecycle
  pinned?: boolean;       // Protected from bulk unload
  compacted?: boolean;    // Content replaced with digest
  compactTier?: 'pointer' | 'sig';
  ttl?: number;           // Turns remaining before auto-drop
  lastAccessed: number;   // For LRU ordering
  
  // Freshness
  freshness?: 'fresh' | 'forwarded' | 'shifted' | 'changed' | 'suspect';
  freshnessCause?: FreshnessCause;
  suspectSince?: number;
  
  // Relationships
  annotations?: EngramAnnotation[];
  synapses?: Synapse[];   // caused_by, depends_on, related_to, supersedes, refines
}
```

### Content types (`ChunkType`)

Canonical union: [`ChunkType` in `contextHash.ts`](../atls-studio/src/utils/contextHash.ts). Summary:

| Type | Source | Description |
|------|--------|-------------|
| `msg:user` | Chat | User message |
| `msg:asst` | Chat | Assistant message |
| `call` | Tools | Tool call (request) |
| `result` | Tools | Tool result |
| `file` | File read | Raw file content |
| `exec:cmd` | Terminal | Command line |
| `exec:out` | Terminal | Command output |
| `smart` | Smart read | Parsed with imports, exports, symbols |
| `raw` | Read path | Raw file content (alternate path) |
| `search` | Code search | Search result set |
| `symbol` | Symbol lookup | Symbol definitions and references |
| `deps` | Dependency analysis | Import/export graph |
| `issues` | Issue finder | Lint/type errors |
| `tree` | Project tree | Directory structure |
| `analysis` | Batch / analyze | Structured analysis outputs (e.g. deps, extract_plan) |

### Content Hashing

Hashes are computed by two 32-bit FNV-style mixing streams initialized with distinct primes, concatenated into a 16-character hex string (see [`contextHash.ts`](../atls-studio/src/utils/contextHash.ts) ~63-89). The first 6 characters serve as the `shortHash` for display and human reference. The backend uses adaptive 6-8 characters on collision detection.

Token estimation adjusts characters-per-token (~2.5-5.0) based on content density: minified code at ~2.5, normal code at ~3.5, prose at ~4.5, whitespace-heavy at ~5.0.

## Activation States

Engrams exist in one of four states:

```
Active ──(unpin)──► Dormant ──(age/evict)──► Archived ──(drop)──► Evicted
   │                    │                        │
   │◄──(pin)────────────│                        │
   │◄──(recall)─────────┘────────────────────────┘
```

| State | Content | Visible to Model | Recallable | How Created |
|-------|---------|-----------------|------------|-------------|
| **Active** | Full | Full content in ACTIVE ENGRAMS section | — | Read, edit, search, recall |
| **Dormant** | Digest (~60 tokens) | Digest in DORMANT ENGRAMS block | Yes, by `h:ref` | Unpinned after `advanceTurn` |
| **Archived** | Full (in archive map) | Not visible | Yes, by `h:ref` | Unload, subtask advance |
| **Evicted** | Manifest entry only | Not visible | Must re-read | Drop, emergency eviction at 90% |

This lifecycle applies to all non-chat engrams. **FileViews mirror it** (`pinned` → rendered in `## FILE VIEWS`; unpinned → dormant, 0 tokens; TTL archival of backing chunks thins regions; empty view drops on next render). See [FileView lifecycle (pin-gated rollout)](#fileview-lifecycle-pin-gated-rollout).

### Runtime-Exposed Transitions

Through session operations, the model can manage its active working set within the ATLS runtime:

| Operation | Effect | When to Use |
|-----------|--------|-------------|
| `session.pin` | Keep active across turns | File being actively edited |
| `session.unpin` | Allow dormancy on next turn | Done with a file for now |
| `session.compact` | Replace content with structural digest | Need awareness but not full content |
| `session.unload` | Move to archive | Done for this subtask, might need later |
| `session.drop` | Evict entirely | Won't need again |
| `session.recall` | Promote back to active | Need archived/dormant content again |

**Pin inheritance**: Editing a pinned engram auto-pins the new engram and auto-unpins the old one. The active working set follows the latest edit result.

### Shaped Views

When pinning, the model can request structural views:

- `pin(hashes:["h:src"], shape:"sig")` — Signature-level (~200 tokens/round vs ~13k full)
- `pin(hashes:["h:src"])` — Full content (expensive but complete)

The `sig` shape extracts function/class declarations, preserving structural awareness at a fraction of the token cost.

### Multi-path `read.file`

When `read.file` is given multiple paths, working memory stores **one engram per file** and returns **one `h:` ref per file** (aligned with `read.context`). Each of those reads also populates the file's FileView (see [below](#fileview--the-unified-file-content-surface)); the FileView is the canonical surface the model reads from, not the individual per-file chunk refs. Prompts that assumed a single composite ref for multi-file loads should be updated.

### `session.drop` and dormant stubs

`session.drop` with `scope:"dormant"` permanently drops **compacted, unpinned** chunks still in working memory (the same “dormant” region as memory search). Explicit `hashes` are optional when `scope` is set; otherwise `hashes` is required.

## FileView — the unified file-content surface

A FileView is a **progressively-refined, hash-addressed view of one file at one source revision**. It replaces the old per-read chunk-centric model in which each `read.lines` / `read.shaped` / `read.file` produced an independent engram the model had to stitch back together by hand.

### One hash per file

FileView identity is **stable per `(filePath, sourceRevision)`** — it does not change as fills, the skeleton, or a `fullBody` are added. The model sees **one `h:fv:<hash>` ref per file**, regardless of how many reads built it up; pinning once retains the whole view across rounds. This is what restores the pre-FileView "flat refs" manageability: `pi` on any file read's ref pins the file's view, `pu` unpins it, `dro` drops the view plus its backing chunks — all cascading through a single retention identity.

Retention routing for file-backed chunks:

| Ref form the model emits | What actually happens |
|--------------------------|-----------------------|
| `pi h:fv:<hash>` | Pins the view directly. |
| `pi h:<sliceHash>` (slice/chunk hash for a file) | Routes to the view — same effect as `pi h:fv:<hash>`. Backward-compatible with legacy prompts. |
| `pu` / `dro` on any of the above | Mirror routing — unpin / drop act on the view. |
| `pi` on a non-file chunk (search, BB, tool result) | Still chunk-level — these have no FileView. |

### Key characteristics

- **One view per path**, keyed by normalized file path. Multiple slice reads (`rl sl:42 el:56` followed by `rl sl:80 el:120`) merge into the same view as sorted, non-overlapping filled regions.
- **Skeleton + fills**: the view carries a cheap signature-level skeleton (imports + folded bodies, `~5–10%` of full-file tokens) overlaid with filled regions for ranges the agent has actually read. Full-body reads (`rf` / `read.file`) materialize `fullBody` directly and suppress the skeleton.
- **Addressable as `h:fv:<hash>`**. Identity is `h:fv:<fnv(normalizedPath + sourceRevision)>` — stable across fills. Only revision bumps (source file edits) or path changes produce a new identity. Auto-healing reconcile updates the identity when the source revision changes.
- **Rendered as a single block** in the prompt (`## FILE VIEWS`), file-ordered, with fold markers like `{ ... } [205-213]` showing what's still elided. Chunks whose hashes are covered by the view are filtered out of `## ACTIVE ENGRAMS` so the same bytes never appear twice.
- **Auto-heal on revision change**: `same_file_prior_edit` causes shifted regions to rebase via the freshness journal's `lineDelta`; external / session-restore causes queue refetches for pinned views (capped per round); unpinned regions drop silently. Rebase failures surface as `[REMOVED was Lx-y]` markers rather than silent staleness.

### FileView data model

```typescript
interface FileView {
  filePath: string;
  sourceRevision: string;      // content hash at view creation
  observedRevision: string;    // current hash as of last reconcile
  totalLines: number;
  skeletonRows: string[];      // sig/fold rows (imports + folded bodies)
  sigLevel: 'sig' | 'fold';
  filledRegions: FilledRegion[]; // sorted, non-overlapping ranges
  fullBody?: string;           // set if a full read landed or coverage auto-promoted
  fullBodyChunkHash?: string;
  hash: string;                // h:fv:<16-char> — stable per (filePath, sourceRevision)
  pinned: boolean;             // lifecycle gate — see "FileView lifecycle" below
  pinnedShape?: string;
  removedMarkers?: Array<{ start: number; end: number }>; // rebase failures
  pendingRefetches?: PendingRefetch[]; // async refetch queue (pinned only)
  freshness?: 'fresh' | 'shifted' | 'suspect';
  freshnessCause?: FileViewFreshnessCause;
  lastAccessed: number;
}

interface FilledRegion {
  start: number; end: number;  // 1-based inclusive line range
  content: string;             // N|CONTENT rows
  chunkHashes: string[];       // source chunks aggregated here
  tokens: number;
  origin: 'read' | 'refetch';
  refetchedAtRound?: number;
}
```

See [`fileViewStore.ts`](../atls-studio/src/services/fileViewStore.ts) for the full type, merge, auto-promote, and auto-heal reconcile logic (all pure functions). Zustand integration lives in [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts); rendering in [`fileViewRender.ts`](../atls-studio/src/services/fileViewRender.ts); token accounting in [`fileViewTokens.ts`](../atls-studio/src/services/fileViewTokens.ts).

### FileView lifecycle (pin-gated rollout)

FileViews participate in the same `Active ──(unpin)──► Dormant ──(age/evict)──► Archived ──(drop)` lifecycle as other engrams. Pin state is the gate:

| State | Rendered in prompt | Constituent chunks suppressed from ACTIVE ENGRAMS | Tokens charged |
|-------|-------------------|--------------------------------------------------|----------------|
| **Pinned** | Yes, in `## FILE VIEWS` | Yes — view is the canonical surface | Skeleton + fills + fullBody + chrome |
| **Unpinned (dormant)** | No | No — chunks re-surface under normal HPP rules (dematerialize → dormant digest → TTL-archive) | 0 |
| **Empty** (all regions pruned, no skeleton, no fullBody) | No — filtered by `hasContent` gate | n/a | 0 |

Unpinned state stays warm in the `fileViews` map, so re-pin instantly restores the rendered view with all existing fills (no re-read). When the last backing chunk TTL-archives, `refreshRoundEnd` calls `pruneFileViewsForChunks` and the view thins toward empty naturally.

### FileView operations

Reads return `h:fv:<hash>` as the primary retention ref for the file:

| Operation | Effect | Returned ref |
|-----------|--------|--------------|
| `read.shaped shape:sig` (`rs`) | Creates or refreshes the view's skeleton at the current revision. Default first-touch for a new file. | `h:fv:<hash>` |
| `read.lines sl:A el:B` (`rl`) | Creates a filled region `[A, B]`. Merges with adjacent or overlapping regions on the same view. | `h:fv:<hash>` (same identity as any prior read on this file at this revision) |
| `read.file` / `read.context contextType:full` / `rf type:full` | Populates `fullBody` directly; subsequent slice reads merge into regions but `fullBody` remains authoritative for rendering. | `h:fv:<hash>` |
| Tree / directory reads | Directory listings have no FileView. | Chunk hash |

Retention primitives route through the view when the ref has a file source:

| Operation | Effect |
|-----------|--------|
| `session.pin <ref>` | `ref = h:fv:<hash>` or a slice hash whose source has a FileView → pins the view. Slice refs for non-file chunks still pin at chunk level. |
| `session.unpin <ref>` / `session.unpin *` | Mirrors pin routing. Wildcard unpins all pinned views and non-file chunks. |
| `session.drop <ref>` | `ref = h:fv:<hash>` or any chunk ref for a file → drops the whole view and all backing chunks. |
| `session.drop scope:dormant` / `scope:archived` | Bulk drops compacted-dormant (active map) or archived chunks without requiring explicit hashes. |

### Token accounting

`contextStore.getPromptTokens()` sums: (a) non-chat chunks not covered by any pinned FileView, plus (b) every pinned live FileView block's rendered token cost (skeleton rows not overlaid + filled-region bodies + `fullBody` + chrome). Unpinned views contribute 0 in both halves, and their constituent chunks fall back to normal HPP dormant-digest accounting in `## ACTIVE ENGRAMS`. See [`fileViewTokens.ts`](../atls-studio/src/services/fileViewTokens.ts) and [`docs/metrics.md`](./metrics.md).

### Coverage auto-promote

When the sum of `filledRegion.tokens` crosses `COVERAGE_PROMOTE_RATIO` (default 0.9) of the estimated full-body tokens, `applyFillToView` composes `fullBody` from the regions and switches to fullBody rendering. Prevents paying the chrome cost of fragmented regions when the model has effectively already read the whole file.

## Memory Regions

The context store maintains five concurrent regions:

### Working Memory (`chunks`)

The model's primary workspace for **non-file artifacts** (search results, tool outputs, analysis, terminal output, etc.) and for the **constituent chunks** that back FileViews. Active and dormant engrams live here. Budget: **`WM_BUDGET_TOKENS = 38000`** ([`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) ~28).

Sorted for prompt inclusion by [`contextFormatter.ts`](../atls-studio/src/services/contextFormatter.ts) ~362-374: chunks whose hash is covered by a **pinned** FileView are filtered out entirely (the view renders those bytes); remaining chunks sort pinned first, then file-backed types (the `FILE_TYPES` set) before artifacts, then **LRU on `lastAccessed` (most recent first)**. Note that `analysis` chunks are **not** in `FILE_TYPES`, so they sort alongside artifacts rather than with file-backed engrams.

### FileViews (`fileViews`)

A separate `Map<filePath, FileView>` alongside `chunks`. Each entry is the single canonical surface for one file at one revision — skeleton + fills + optional `fullBody`. See [FileView — the unified file-content surface](#fileview--the-unified-file-content-surface). Unpinned views stay in this map as dormant state (zero prompt cost, instant re-pin restore); TTL-archival of backing chunks thins them over time via `pruneFileViewsForChunks`.

### Archive (`archivedChunks`)

Full-content backup for recall. LRU-capped at 50k tokens. Engrams move here via `unload`, subtask advance, or dormant eviction (if large enough). Recallable by hash reference — `findOrPromoteEngram` checks archive as a fallback.

### Staged Snippets (`stagedSnippets`)

Pre-cached context. Budget: **`STAGED_BUDGET_TOKENS = 4500`** (planning target) with a hard cap of **`STAGED_TOTAL_HARD_CAP_TOKENS = 65536`** enforced at prune time by `pruneStagedSnippetsToBudget`. Anchor tier is bounded separately by **`STAGED_ANCHOR_BUDGET_TOKENS = 1400`** tokens and **`MAX_PERSISTENT_STAGE_ENTRIES = 12`** entries — all constants from [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) ~20-27, ~94. Staged entries appear in the prompt's staged block. Used for Anthropic prompt caching when content is stable across rounds.

Classification:
- **Persistent anchor**: Small entries (≤300 tokens), survive pruning
- **Transient anchor**: Medium entries, may be demoted
- **Transient payload**: Large entries, first to be pruned

### Blackboard (`blackboardEntries`)

Persistent session knowledge — plans, analysis results, decisions, extracted patterns. Budget: **`BLACKBOARD_BUDGET_TOKENS = 4800`** ([`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) ~30). Survives across turns and subtask transitions. The model writes via `session.bb.write` (shorthand `bw`) and reads via `session.bb.read` (shorthand `br`).

Blackboard entries are referenced as `h:bb:key` and appear in the dynamic block of the prompt, separate from working memory.

**Long-horizon facts**: When rounds age out of the verbatim history window, the distiller can record **findings** (and other fields) in the rolling summary — an API-only `[Rolling Summary]` block distinct from dormant per-engram digests. See [history-compression.md](./history-compression.md).

## Emergency Eviction

When estimated prompt pressure exceeds 90%, `addChunk` triggers emergency eviction:

1. Prune staged snippets over budget
2. Compact unpinned, non-recent engrams (oldest first)
3. Drop compacted engrams if still over pressure

The 70% threshold is shown in the stats line as a warning to the model ("consider drop/compact"). The runtime encourages proactive working-set management; emergency eviction is a safety net.

## Anti-Patterns

Common failure modes that lead to context loops and wasted tokens:

| Anti-Pattern | Why It Fails | Fix |
|-------------|-------------|-----|
| Reading file content without pinning the FileView ref | Unpinned FileView is dormant — nothing renders. Next turn you re-read the same file. | Pin the `h:fv:<hash>` returned by any file read. One pin covers the whole file. |
| Pinning multiple slice refs for the same file | Slice pins route to the view anyway — the second and later pins are no-ops. | One `pi` per file. The view already covers every slice you've filled. |
| Treating `sg` as a "lighter pin" | Staging was never a retention tier for file content; FileView handles that. Using `sg` duplicates bytes into the staged block. | Use `pi` on the FileView ref. Reserve `sg` for explicit cross-subtask anchors / prefetch. |
| Waiting for "complete picture" before writing to BB | You lose partial findings to compaction before ever recording them. | Write to BB after your first read pass. Update incrementally. |
| Re-reading content already in a pinned FileView | The view already renders it — either skeleton, a filled region, or `fullBody`. | Check the `## FILE VIEWS` block for the file. Slice-read only ranges not yet filled. |
| Full-reading for planning | Full reads cost 2-13k tokens. Sigs cost ~200 tokens and contain all structural info. | Default first-touch: `rs shape:sig` to populate the skeleton. Full reads only when editing. |
| Reading 3+ times without acting | Analysis paralysis. You have enough context after 1-2 reads. | After 2 reads on the same target, your next step MUST be a mutation or a decision to stop. |
| Not using BB as primary anchor | BB survives compaction, eviction, and session boundaries. Everything else is ephemeral. | `bb_write` findings immediately. `bb_read` before re-searching. |

## Engram Annotations and Relationships

### Annotations

Notes attached to engrams without mutating content:

```typescript
interface EngramAnnotation {
  id: string;
  content: string;
  createdAt: number;
  tokens: number;
}
```

### Synapses

Typed connections between engrams:

```typescript
interface Synapse {
  targetHash: string;
  relation: 'caused_by' | 'depends_on' | 'related_to' | 'supersedes' | 'refines';
  createdAt: number;
}
```

The model creates synapses via `annotate.link(from:"h:X", to:"h:Y", relation:"depends_on")`, building a knowledge graph within the session.

---

**Source**: [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) (types, lifecycle, memory regions, FileView Zustand wire), [`contextHash.ts`](../atls-studio/src/utils/contextHash.ts) (hashing, token estimation, digest generation), [`fileViewStore.ts`](../atls-studio/src/services/fileViewStore.ts) (FileView types + pure helpers: interval merge, coverage auto-promote, reconcile), [`fileViewRender.ts`](../atls-studio/src/services/fileViewRender.ts) (pin-gated render + chunk-coverage), [`fileViewTokens.ts`](../atls-studio/src/services/fileViewTokens.ts) (pin-gated token estimator + LRU cache)

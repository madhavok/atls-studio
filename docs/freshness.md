# Freshness System (Runtime Internals)

> **Model-facing surface note:** freshness is a **runtime-internal** concern after the ref-language unification. The model does not read `[STALE]` / `[FRESH]` labels, does not pass freshness flags, and does not distinguish `identity_lost` / `stale_hash` / `low_confidence_rebind` internally-taxonomized errors. The runtime auto-refetches pinned diverged views, drops unpinned diverged views silently, and surfaces one of two action strings on unrecoverable failures: `content changed — re-read and retry` (auto-forwardable) or `content cannot auto-rebind — re-read before retry`. The structures below are the machinery; nothing here is a model-facing specification.

The freshness system ensures the runtime never silently serves the model stale content. It tracks file revisions, detects when knowledge is outdated, blocks unsafe operations, and attempts automatic recovery when possible.

## Why Freshness Matters

Without freshness tracking, an agent that reads a file, edits it, then reasons about the pre-edit content will produce incorrect results — wrong line numbers, patches that don't apply, diffs based on content that no longer exists. This is the single most common failure mode in agentic coding tools.

ATLS addresses this at three levels (all internal):

1. **Snapshot tracking** — Record what was read and when
2. **Freshness classification** — Know whether knowledge is still valid
3. **Preflight gating** — Block operations on suspect content, recover rebaseable content

## Universal freshness (`canSteerExecution`)

Across blackboard entries, staged snippets, retention traces, task directives, and working-memory engrams, the runtime enforces one **execution authority** invariant:

> Artifacts may **steer** the next mutation only if none of their state axes are disqualifying. An artifact is disqualified when: `state` is `historical | superseded | duplicate | distilled`, OR `stageState` is `stale | superseded`, OR `traceState` is `duplicate | distilled`, OR engram `freshness` is `suspect | changed`.

Implementation lives in [`universalFreshness.ts`](../atls-studio/src/services/universalFreshness.ts):

- **`canSteerExecution(...)`** — Single gate used when assembling prompts, building intent context, and extracting subagent pins. Returns `true` when *all four axes* pass (omitted / unknown axes are treated as passing). Returns `false` for any disqualifying value listed above.
- **`UniversalState`** — `active` | `historical` | `superseded` | `duplicate` | `distilled` (blackboard and related artifacts). Only `state === 'active'` is truly *execution-authoritative*, checked separately by `isExecutionAuthoritative`.
- **`validateSourceIdentity(path)`** — Rejects bogus or placeholder paths before identities enter the snapshot tracker, awareness, blackboard, or normalized batch params (keeps `derived_from` and file paths trustworthy).

**Staged snippets** carry **`stageState`**: `current` | `stale` | `superseded`. `reconcileSourceRevision` sets `stale` when the source file revision no longer matches. Stale lines are labeled **`[STALE]`** in staged blocks; **`buildIntentContext`** and subagent pin extraction skip stale or suspect staged rows.

**Blackboard**: Supersession by path considers **`derivedFrom`** as well as `filePath`. New artifact kinds (e.g. summary / fixplan) participate in the same shadowing rules where applicable.

**Retention / search traces**: Entries can move to **`traceState`** `duplicate` or `distilled`; distilled traces contribute summary text instead of full content. Bumping workspace revision evicts search-family retention so old results are not reused as current.

**Telemetry** (local counters for tests / Internals): [`freshnessTelemetry.ts`](../atls-studio/src/services/freshnessTelemetry.ts) — includes BB superseded, staged marked stale, task directives superseded, cognitive rules expired, retention distilled, session-restore reconcile signals, plus file-tree coarse vs path-aware paths.

## Snapshot Tracker

During batch execution, the `SnapshotTracker` records the content hash of every file the model reads:

```typescript
interface SnapshotIdentity {
  filePath: string;
  snapshotHash: string;
  canonicalHash?: string;       // promoted by full-span read.lines to authorize canonical edits
  readAt: number;
  readKind: 'canonical' | 'shaped' | 'lines' | 'cached';
  readRegions?: LineRegion[];
  shapeHash?: string;
  fullFileLineCount?: number;   // used to detect full-span read.lines that earn canonical authority
}
```

### Awareness Levels

| Level | Acquired By | Authorizes |
|-------|-------------|------------|
| **CANONICAL** (3) | `read.context type:full` | Full-file edits |
| **TARGETED** (2) | `read.lines` | Edits within the read range |
| **SHAPED** (1) | `read.shaped` | Structural awareness only (no edits) |
| **NONE** (0) | — | Nothing |

Awareness never downgrades — a canonical read is not overwritten by a subsequent shaped read.

### Automatic Hash Injection

Before any `change.*` step, the executor injects `snapshot_hash` from the tracker. The Rust backend verifies this against the current file. If the file has changed, the edit is rejected with `stale_hash` rather than silently applying a bad patch.

After a successful mutation, `invalidateAndRerecord` clears the old snapshot and records the post-edit hash, so subsequent steps see fresh state.

## Freshness States

Each engram carries a freshness classification:

| State | Meaning | Source |
|-------|---------|--------|
| **fresh** | Content matches current file state | Initial read, reconciliation |
| **forwarded** | Hash updated after own edit (known lineage) | `forwardStagedHash` after edit |
| **shifted** | Same file edited in a prior step; line numbers may have moved | `reconcileSourceRevision` with `same_file_prior_edit` |
| **changed** | External change detected | Watcher event, manual trigger |
| **suspect** | Freshness uncertain | Unknown cause, timing gap |

### Model-facing surface (two-state projection)

The engine maintains the full five-state taxonomy for preflight classification and internal diagnostics. The **model** sees a simplified two-state projection, produced by `formatSuspectHint` in [`contextFormatter.ts`](../atls-studio/src/services/contextFormatter.ts) ~107-116:

| Engine condition | Model label | Action |
|------------------|-------------|--------|
| `freshness ∈ {fresh, forwarded, shifted}` and `suspectSince` is unset | *(no label)* | Use freely |
| `suspectSince != null` **or** `freshness ∈ {suspect, changed}` | `[STALE: re-read before edit]` | Re-read before editing |

Note the trigger is `suspectSince || freshness` — an engram with a recorded suspect timestamp is labeled stale even if its latest `freshness` classification hasn't been updated. This applies uniformly across engram headers (working memory), dormant engram digest, staged snippet headers, and tool output. Rebind metadata, strategy, confidence, and relocation summaries are **not** included in model-visible context.

### Freshness Causes

| Cause | Classification | Recovery |
|-------|---------------|----------|
| `hash_forward` | Rebaseable | Relocate lines via edit journal |
| `same_file_prior_edit` | Rebaseable | Relocate via journal/shape/symbol |
| `external_file_change` | Suspect | Content-verify then relocate, or hard stop |
| `watcher_event` | Suspect | Content-verify then relocate, or hard stop |
| `unknown` | Suspect | Content-verify then relocate, or hard stop |

## Testing freshness changes

### Automated

From the `atls-studio/` package directory, run Vitest with a filter that hits the formatter, store, batch handlers, and preflight:

```bash
npm run test -- contextFormatter contextStore change.test delegate freshnessPreflight subagentService
```

For full TypeScript coverage before a push, use `npm run test`. Full-stack parity (TS + Rust crates) is `npm run test:all`.

### Manual smoke (desktop)

End-to-end behavior needs the Tauri app, real disk, and the snapshot tracker. Typical loop:

1. Open a workspace and pick a small file `PATH` (for example a test fixture under the repo).
2. Have the assistant **read** `PATH` and echo a few lines so a working-memory engram exists.
3. **Change `PATH` on disk outside the assistant** (save in your editor, or append a comment from a terminal) so the file revision moves.
4. Send the **example prompt** below (replace `PATH`). Confirm the reply mentions **`[STALE: re-read before edit]`** and/or **`[STALE]`** on staged lines where applicable, and that the assistant **re-reads** before a `change.*` edit—not silent use of old line numbers.

Optional: after a successful edit in the same turn, confirm MEMORY TELEMETRY in formatted context does **not** list rebind/block/retry counters (those stay internal).

### Example prompt (paste after external edit)

Use a real file path from your workspace.

```text
Freshness verification for PATH (replace with the file you read, e.g. atls-studio/src/services/contextFormatter.ts):

You already read this file earlier in the thread. I edited and saved it on disk just now without sending another message before this one.

1) In your current context, do you see "[STALE: re-read before edit]" on any working-memory line for PATH, or "[STALE]" on staged snippet lines for PATH, or neither? Quote the exact label lines if present.

2) If anything is labeled stale, what is the correct next step before calling change.edit or any mutating tool on PATH?

3) After you re-read PATH if needed, state the first non-empty line of the file as proof the read is current.
```

## Freshness Preflight

Before any mutation operation, the preflight system classifies every target. For file-backed targets it first runs a **batched** `context` request with `{ type: 'full', file_paths }` so the backend returns current content and hashes for those paths. It then calls **`refreshRoundEnd`** for the same file set (with per-path revisions derived from that result) so the context store's `sourceRevision` metadata matches disk before relocation and gating run. Classification then feeds `getPreflightAutomationDecision` in [`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts) ~194-205:

```
Fresh / high confidence          → proceed
Rebaseable, medium confidence    → proceed_with_note (relocation summary attached)
Rebaseable, low confidence       → review_required
Suspect / blocked / none         → block (require re-read)
```

So the decision model is **four-way**, not three-way: `proceed | proceed_with_note | review_required | block`. The model sees the `[STALE: re-read before edit]` label on block; the `proceed_with_note` and `review_required` surfaces are internal (Internals UI / rebind evidence).

### Healing preflight for reads

Reads are allowed to *heal* stale context rather than blocking on it. When preflight runs against `operation === 'context'` or `operation === 'read_lines'`, the `healingReadOps` branch in [`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts) ~461-462 skips the hard block even on suspect refs — the read itself will reconcile the source revision in the same pass. Mutation ops (edits, creates, refactors) go through content verification first.

### Suspect Content Verification

Before hard-blocking on suspect refs, the preflight system attempts **content verification** — checking whether each suspect engram's content still exists verbatim in the current file. This handles the common case where an external edit (formatter, another tool, git operation) shifts lines without altering the model's specific section.

**How it works:**

1. For each non-compacted suspect ref with stored content, the preflight fetches the current file content (already available from the batched `context` call).
2. `locateSnippetFingerprint` searches for the suspect's content in the current file. If found uniquely, the ref is promoted to `rebaseable` with `strategy: 'content_match'` and `confidence: 'medium'`.
3. If fingerprint matching fails and the ref has line coordinates, `relocateLineRanges` is tried as a fallback.
4. Promoted refs enter the standard rebase cascade for line relocation.
5. **Compacted chunks** (content replaced with digest) cannot be content-verified directly. They are auto-promoted when all non-compacted suspect refs for the same file are successfully verified.
6. If any suspect ref cannot be verified, the operation is still blocked.

**Confidence cap:** Promoted suspect refs are capped at `medium` confidence (no lineage information from external edits), which maps to `proceed_with_note` via `getPreflightAutomationDecision`. The model never sees rebind metadata — only the absence of the `[STALE]` label when content is verified.

### Rebase Strategy Cascade

When an engram is rebaseable (from own prior edit, hash forward, or content-verified suspect), the system attempts recovery through progressively less confident strategies:

| Strategy | Confidence | Method |
|----------|-----------|--------|
| **edit_journal** | High | Use recorded `lineDelta` from prior edits to shift line references |
| **shape_match** | High | Compare structural hash — if identical, content is equivalent |
| **content_match** | Medium | Suspect ref content found unchanged in current file |
| **symbol_identity** | Medium | Resolve symbol name to its current line range |
| **fingerprint_match** | Medium | Locate content snippet by fuzzy matching |
| **line_relocation** | Medium/High | Search for content in a window around expected position |
| **blocked** | None | Identity lost — cannot locate content, block the operation |

### Rebase Evidence

Each recovery records its evidence:

```typescript
interface RebindOutcome {
  classification: 'fresh' | 'rebaseable' | 'suspect';
  strategy: RebaseStrategy;
  confidence: 'high' | 'medium' | 'low' | 'none';
  factors: RebaseEvidence[];
  linesBefore?: string;
  linesAfter?: string;
  sourceRevision?: string;
  observedRevision?: string;
  at: number;                   // timestamp of the rebind attempt
}
```

Evidence factors include: `revision_match`, `journal_line_delta`, `shape_hash_match`, `shape_hash_mismatch`, `symbol_identity`, `fingerprint_unique`, `content_window_match`, `exact_line_match`, `missing_content`, `identity_lost`, `suspect_content_verified`, `suspect_promoted`.

The `suspect_content_verified` factor indicates a suspect ref was promoted via content verification. `suspect_promoted` indicates a compacted chunk was auto-promoted because all non-compacted siblings for the same file were verified.

This data is stored on the engram for internal diagnostics (Internals UI) but is **not** surfaced in the model's prompt context.

## Reconciliation

When files change, `reconcileSourceRevision` sweeps all memory regions:

| Chunk State | Action |
|-------------|--------|
| Active latest (non-compacted) | Update `sourceRevision` to current |
| Snapshot (`viewKind: 'snapshot'`) | Preserve regardless (intentionally frozen) |
| Derived with stale revision | Evict from chunks and archive |
| Dormant (compacted, unpinned, stale) | Archive if >1000 tokens, drop if smaller |
| Staged (non-snapshot, non-derived) | Update revision metadata; may set **`stageState`** to `stale` on mismatch |
| Staged derived with stale revision | Delete from staged |

### Reconciliation Triggers

| Trigger | Source |
|---------|--------|
| File read | `context.ts` handler calls `reconcileSourceRevision` after read |
| Edit completion | `executor.ts` calls `forwardStagedHash` after successful edit |
| Round end | `refreshRoundEnd` sweeps file-backed **working** and **archived** chunks and **staged snippets** (latest view) against current revisions — see below |
| File watcher (with paths) | External changes trigger `markEngramsSuspect` for specific paths |
| File watcher (coarse) | When exact paths are unavailable, awareness is cleared and a deferred `refreshRoundEnd` reconciles per-path hashes; falls back to blanket suspect only if reconcile fails |

### Round-end revision sweep (`refreshRoundEnd`)

`refreshRoundEnd` gathers normalized source paths from every **latest** file-backed engram in working memory and **archived** chunks, plus **staged snippet** sources (skipping `viewKind: 'snapshot'`). Before the revision sweep it **decrements `ttl` on unpinned chunks**; when `ttl` reaches 0 the chunk is **archived with `freshnessCause: 'ttl_expired'`** (recallable, not evicted outright — see [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) ~3573-3615). Immediately after `hppArchive`, TTL-archived chunk hashes are passed to **`pruneFileViewsForChunks`** so any FileView regions backed by those chunks are dropped — unpinned / dormant views thin naturally as their backing chunks age out. See [engrams.md — FileView lifecycle](./engrams.md#fileview-lifecycle-pin-gated-rollout).

It then resolves **current** content hashes for those paths in bulk via the Tauri command **`get_current_revisions`** (registered at app startup from [`useAtls.ts`](../atls-studio/src/hooks/useAtls.ts) as `setBulkRevisionResolver` — one IPC round-trip for the whole path set). For each path it calls **`reconcileSourceRevision`**, which also fans out to **`reconcileFileViewsForPath`**. Paths that cannot be resolved are passed to **`markEngramsSuspect`** with `external_file_change`; directory-like keys are skipped (`suspectSkippedDirKeys`).

### FileView auto-heal reconcile

`reconcileFileView` ([`fileViewStore.ts`](../atls-studio/src/services/fileViewStore.ts) ~284-377) is the FileView counterpart to `reconcileSourceRevision`. Policy:

| Cause | Pinned view | Unpinned view |
|-------|-------------|---------------|
| `same_file_prior_edit` with non-zero journal `lineDelta` | Rebase regions by `lineDelta` (line numbers + `N|` row prefixes rewritten); freshness → `shifted` |
| `external_file_change` / `session_restore` | Queue `pendingRefetches` (capped per round by `applyRefetchCap`, default 10) | Regions drop silently |
| Rebase would push a region below line 1 | Record `[REMOVED was L..-..]` marker |
| Revision unchanged | Bump `observedRevision`, freshness → `fresh`; no region work |

`fullBody` invalidates on any revision bump (conservatively cleared; model re-reads if still needed). Pending refetches above the per-round cap surface an aggregate `[changed: N regions pending refetch — re-read on demand]` marker in the render block.

The hash-protocol **`advanceTurn`** hook invokes `refreshRoundEnd` (via [`aiService.ts`](../atls-studio/src/services/aiService.ts) `setRoundRefreshHook`). In the main chat tool loop, **`advanceTurn` runs only when `round > 0`**, so the **first** round of a user turn does **not** run this sweep before the model step; reconciliation for restored sessions is therefore **deferred** until the next round boundary, preflight, or other triggers (see [session-persistence.md](./session-persistence.md)).

Other call sites: **`refreshRoundEnd()`** with no path filter after intelligence refresh ([`useAtls.ts`](../atls-studio/src/hooks/useAtls.ts)), and **preflight** with explicit paths after a `context` full pass ([`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts)).

## Recent Revision Tracking

The system tracks recent edits via `recordRevisionAdvance` with a 10-second TTL:

```typescript
const recentRevisionAdvances = new Map<string, {
  cause: FreshnessCause;
  sessionId?: string;
  at: number;
}>();
```

When `reconcileSourceRevision` runs, it consumes this record to determine whether the change was from the model's own edit (`same_file_prior_edit`) or external (`external_file_change`). Own edits are rebaseable; external changes are suspect.

---

## Sequential `line_edits` (Top-Down Application)

`apply_line_edits` in the Rust backend applies edits **in array order**. Each edit resolves its `line` / `anchor` against the *current* file content **after all prior edits in the same array**.

- **Why**: Models reason sequentially (“insert at L10, then L50 is now L53”). The old bottom-up / snapshot-resolved-all-lines model fought that mental model and could target wrong lines.
- **Prompts**: `src/prompts/toolRef.ts` and `src/prompts/cognitiveCore.ts` document sequential semantics for the model.
- **Validation**: The TS `change.edit` path no longer sorts, merges, or rejects “overlapping” explicit line edits — those heuristics assumed a single coordinate frame. Overlaps in *original* line numbers can be valid when edits are sequential.

---

## Cross-Step Line Rebase (Batch Executor)

When a batch contains **multiple steps** that edit the same file with **numeric** `line` fields, the model typically authored later steps against the **pre-batch** file. After step *N* runs, line numbers in steps *N+1…* must be shifted by the net effect of completed edits.

- **`computePositionalDeltas`** (`executor.ts`): Walks `line_edits` in order, tracks a **running cumulative line delta**, and records each edit’s effect at its **original-file** line (`originalLine = sequentialLine - cumulativeDelta` before applying that edit’s delta). This produces a list `{ line, delta }` in original coordinates.
- **`rebaseSubsequentSteps`**: For each future `change.*` step on the same file, adds to each explicit `line` the sum of `delta` where `d.line < targetLine` (same “BUG5” rule as before).

Anchor/symbol edits (`line <= 0`) are skipped — they resolve at apply time on the backend.

---

## Post-Edit Context Refresh (`refreshContextAfterEdit`)

After a successful `change.*`, the executor keeps the UI / next-round context aligned with disk:

1. **Full-file engrams**: Resolve `h:NEW` via `batch_resolve_hash_refs` and `addChunk` with `origin: 'edit-refresh'`.
2. **Staged snippets**:
   - **Shaped**: Re-resolve `h:NEW:{shapeSpec}`.
   - **Line-range**: `getFreshnessJournal` → `lineDelta` → `applyLineDelta` on the line spec, then `resolve_hash_ref` with `h:NEW:lines`.
   - **Full-file staged** (no lines/shape): Resolve `h:NEW` only.

**Order**: `registerOwnWrite` and **synchronous** `rebaseStagedLineNumbers` (from journal) run **before** the async `refreshContextAfterEdit` so the next model sees correct line refs.

---

## Own-Write Suppression (`intel:file_change`)

Successful edits register paths as **own writes** so the file watcher does not emit spurious `intel:file_change` events for ATLS’s own writes. That avoids false “external change” / suspect freshness and races with git restore (external writes still flow normally).

---

**History compression**: Mostly orthogonal to per-file reconciliation, but **`deflateToolResults` / history compression** skips deflating onto **stale** engrams when the source file revision no longer matches — avoiding silent reuse of outdated WM hashes. The **rolling verbatim window** caps transcript size via eviction (no distillation); see [history-compression.md](./history-compression.md).

## Source Files (Quick Reference)

| Concern | Primary files |
|--------|----------------|
| Universal gate + path validation | [`universalFreshness.ts`](../atls-studio/src/services/universalFreshness.ts), [`freshnessTelemetry.ts`](../atls-studio/src/services/freshnessTelemetry.ts) |
| Snapshot tracking + injection | [`snapshotTracker.ts`](../atls-studio/src/services/batch/snapshotTracker.ts), [`executor.ts`](../atls-studio/src/services/batch/executor.ts) |
| `line_edits` apply (Rust) | [`lib.rs`](../atls-studio/src-tauri/src/lib.rs) (`apply_line_edits`) |
| `line_edits` dispatch (no TS overlap/coalesce) | [`change.ts`](../atls-studio/src/services/batch/handlers/change.ts) |
| Cross-step rebase | [`executor.ts`](../atls-studio/src/services/batch/executor.ts) (`computePositionalDeltas`, `rebaseSubsequentSteps`) |
| Post-edit refresh + staged rebase | [`executor.ts`](../atls-studio/src/services/batch/executor.ts) (`refreshContextAfterEdit`, `rebaseStagedLineNumbers` hook) |
| Freshness preflight / journal | [`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts), [`freshnessJournal.ts`](../atls-studio/src/services/freshnessJournal.ts) |
| Round-end sweep + bulk revisions | [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) (`refreshRoundEnd`), [`useAtls.ts`](../atls-studio/src/hooks/useAtls.ts) (`setBulkRevisionResolver` → `get_current_revisions`) |
| Reconciliation | [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) |

---

**Source**: [`snapshotTracker.ts`](../atls-studio/src/services/batch/snapshotTracker.ts), [`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts), [`freshnessJournal.ts`](../atls-studio/src/services/freshnessJournal.ts), [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) (reconciliation)

# Engrams & Memory Model

Engrams are the fundamental data unit in ATLS — content-addressed chunks of knowledge with lifecycle metadata. Every file read, code search, tool result, and edit output creates an engram. The model references engrams by hash (`h:a1b2c3`) rather than repeating content.

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

Hashes are computed via dual FNV-1a 32-bit with different seeds, producing a 16-character hex string. The first 6 characters serve as the `shortHash` for display and human reference. The backend uses adaptive 6-8 characters on collision detection.

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

## Memory Regions

The context store maintains four concurrent regions:

### Working Memory (`chunks`)

The model's primary workspace. Active and dormant engrams live here. Budget: ~32k tokens.

Sorted for prompt inclusion: pinned first, then file-backed types before artifacts, then LRU (most recently accessed first).

### Archive (`archivedChunks`)

Full-content backup for recall. LRU-capped at 50k tokens. Engrams move here via `unload`, subtask advance, or dormant eviction (if large enough). Recallable by hash reference — `findOrPromoteEngram` checks archive as a fallback.

### Staged Snippets (`stagedSnippets`)

Pre-cached context. Budget: ~4k tokens with 12 persistent anchor entries. Staged entries appear in the prompt's staged block. Used for Anthropic prompt caching when content is stable across rounds.

Classification:
- **Persistent anchor**: Small entries (≤300 tokens), survive pruning
- **Transient anchor**: Medium entries, may be demoted
- **Transient payload**: Large entries, first to be pruned

### Blackboard (`blackboardEntries`)

Persistent session knowledge — plans, analysis results, decisions, extracted patterns. Budget: ~4k tokens. Survives across turns and subtask transitions. The model writes via `bb_write` and reads via `bb_read`.

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
| Reading without pinning | Reads go dormant → compacted → evicted. Next turn you re-read the same file. | Every read batch MUST end with `session.pin` on refs you need. |
| Waiting for "complete picture" before writing to BB | You lose partial findings to compaction before ever recording them. | Write to BB after your first read pass. Update incrementally. |
| Re-reading pinned/staged content | Wastes tokens and batch ops. The content is already in your context. | Check STAGED and pinned refs before issuing reads. |
| Full-reading for planning | Full reads cost 2-13k tokens. Sigs cost ~200 tokens and contain all structural info. | Use `read.shaped(sig)` or `pin(shape:"sig")` for planning. Full reads only when editing. |
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

**Source**: [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) (types, lifecycle, memory regions), [`contextHash.ts`](../atls-studio/src/utils/contextHash.ts) (hashing, token estimation, digest generation)

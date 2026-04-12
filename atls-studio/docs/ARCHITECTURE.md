# ATLS Studio Architecture

## Overview

ATLS Studio is a Tauri-based desktop application that provides an AI-powered cognitive development environment with managed working memory. It combines a Rust backend for core operations with a TypeScript/React frontend for orchestration and UI.

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|----------|
| Desktop Shell | Tauri 2.x | Native window, IPC, file system access |
| Backend | Rust | Line edits, content hashing, workspace scanning, PTY, linting |
| Frontend | TypeScript + React | Orchestration, AI integration, state management |
| AI Providers | Anthropic, OpenAI, Google, Vertex, LM Studio | Multi-provider LLM integration |
| Parsing | Tree-sitter | Multi-language symbol extraction and code navigation |
| Linting | SWC | JavaScript/TypeScript syntax analysis and fix suggestions |
| Hashing | FNV-1a (32-bit) | Deterministic content identity for all file operations |

## Core Concepts

### Engrams

Engrams are hash-addressed units of knowledge — the fundamental building blocks of ATLS working memory. Each engram tracks:

- **Content hash** — deterministic identity via FNV-1a
- **Source** — file path, tool output, or derived origin
- **Type** — file, search, tool-result, chat, staged, etc.
- **Lifecycle state** — active → dormant → archived → evicted
- **Annotations** — user-defined metadata and notes
- **Synapses** — typed links between engrams

**Lifecycle States:**

| State | Content | Visibility | Recovery |
|-------|---------|-----------|----------|
| Active | Full content in context | Current turn | Automatic |
| Dormant | Digest only (~60 tokens) | Hash reference | `recall(h:XXXX)` |
| Archived | Recallable by hash | Not visible | `recall(h:XXXX)` |
| Evicted | Manifest entry only | Not visible | Re-read from disk |

Pinning keeps an engram active across turns. Unpinned engrams deflate to dormant after one round. Edits inherit pin status from their source.

### Universal Hash Pointer Protocol (UHPP)

UHPP provides a unified syntax for referencing content by hash. All reads, edits, searches, and tool results return `h:XXXX` references.

**Reference Types:**

| Syntax | Purpose | Example |
|--------|---------|----------|
| `h:XXXX` | Basic hash reference | `h:cab239` |
| `h:XXXX:15-22` | Line range | `` |
| `h:XXXX:fn(name)` | Symbol reference | `h:cab239:fn(auth)` |
| `h:XXXX:sig` | Signature shape | `{file:atls-studio/docs/ARCHITECTURE.md,imports:[],issues:[],related_files:[],symbols:[]}` |
| `h:XXXX:fold` | Folded view | `{file:atls-studio/docs/ARCHITECTURE.md,imports:[],issues:[],related_files:[],symbols:[]}` |
| `h:XXXX:imports` | Import section | `{file:atls-studio/docs/ARCHITECTURE.md,imports:[],issues:[],related_files:[],symbols:[]}` |
| `h:XXXX:exports` | Export section | `{file:atls-studio/docs/ARCHITECTURE.md,imports:[],issues:[],related_files:[],symbols:[]}` |
| `h:OLD..h:NEW` | Diff between versions | `h:abc..h:def` |
| `h:$last` | Most recent hash | `h:$last` |
| `h:@selector` | Set reference | `h:@head(src/api.ts)` |

**Composition:** Modifiers can be chained — `h:XXXX:15-30:dedent`, `h:XXXX:fn(name):sig`

### Hash Protocol (HPP)

The Hash Protocol tracks chunk visibility and materialization state across turns:

| Visibility | Description | Transition |
|-----------|-------------|------------|
| Materialized | Full content visible to model | On read/edit |
| Referenced | Digest only, hash pointer | After turn ends |
| Archived | Stored, recallable by hash | On unload |
| Evicted | Manifest only, must re-read | On drop |

### Blackboard

A durable key-value store that persists across compaction, eviction, and session boundaries. Stores:

- **Task plans** — goal, subtasks, progress
- **Findings** — per-file/symbol analysis results (clear/bug/inconclusive)
- **Edit records** — change history with rationale
- **Cognitive rules** — user-defined reasoning constraints
- **Status tracking** — examination progress and remaining work

Artifact kinds: `plan`, `bug`, `repair`, `status`, `err`, `fix`, `edit`, `general`, `summary`, `fixplan`

## Architecture Layers

```
┌─────────────────────────────────────────────┐
│                  UI (React)                  │
├─────────────────────────────────────────────┤
│              Orchestrator                    │
│  (task decomposition, multi-agent coord)     │
├──────────┬──────────┬───────────────────────┤
│ AI Service│ Subagent │   Batch Executor       │
│ (providers│ Service  │ (positional rebase,    │
│  streams) │ (4 types)│  snapshots, hashing)   │
├──────────┴──────────┴───────────────────────┤
│          Context Store + App Store           │
│  (engrams, staging, BB, awareness cache)     │
├─────────────────────────────────────────────┤
│         Rust Backend (Tauri IPC)             │
│  (line edits, batch query, workspace, PTY)   │
└─────────────────────────────────────────────┘
```

### Rust Backend (`src-tauri/src/`)

**Line Edit Engine** (`lib.rs`):
- Multi-action edits: `replace`, `insert_before`, `insert_after`, `delete`, `move`, `replace_body`
- Automatic positional rebasing across sequential edits
- Content hashing via FNV-1a for deterministic identity
- Shadow editing with drift tolerance (finds content even when line numbers shift)
- Body bounds detection: brace-based for JS/TS/Java/etc, indent-based for Python
- Syntax validation with bracket balance hints after edits
- Undo system with per-file snapshot stacks

**Batch Query Engine** (`batch_query/mod.rs`):
- Central dispatcher for all async operations (~15k lines)
- File I/O with hashing and undo history
- Edit operations in draft (validate-only) and write modes with stale-hash protection
- Refactoring: rename with consumer rewiring, move with import updates, extract with target creation
- Code search via tree-sitter index and pattern matching
- Verification: build/test command execution, SWC-based linting
- Git operations: status, diff, stage, commit, push, log, reset, restore
- Workspace scanning with framework detection and language statistics

**Additional Modules:**
- `linter.rs` — SWC-powered JavaScript/TypeScript linting with fix suggestions
- Workspace scanner — framework detection, `.atlsignore` support, language stats
- PTY management — cross-platform pseudo-terminal for shell execution

### TypeScript Services (`src/services/`)

**Orchestrator** (`orchestrator.ts`):
- Task decomposition into subtasks with dependency tracking
- Multi-agent coordination with context transfer
- File digests and research digests for inter-agent communication

**AI Service** (`aiService.ts`):
- Provider-agnostic integration (Anthropic, OpenAI, Google, Vertex, LM Studio)
- Streaming responses with tool execution loops
- Prompt assembly with context formatting
- Batch step expansion for UI display

**Batch Executor** (`batch/executor.ts`):
- Positional rebasing: adjusts line numbers across sequential edits
- Snapshot tracking with file content hashing
- Context refresh after edits (hash forwarding, auto-stage)
- Interruption detection (dry-run previews, confirmation gates, error pauses)
- Impact auto-staging of related code

**Subagent Service** (`subagentService.ts`):
- Four specialized agent types with different permission levels:
  - **Retriever** — read-only search and analysis
  - **Designer** — architecture research with blackboard write access
  - **Coder** — full edit permissions with verification
  - **Tester** — test writing and execution with iteration
- Each receives compressed state snapshot (not growing chat history)
- Isolated memory with dematerialization on completion

**History Compressor** (`historyCompressor.ts`):
- Tool result deflation: replaces large outputs with hash references
- Rolling summary: maintains compressed history of older interactions
- Batch input stubbing: summarizes tool call parameters
- Token estimation for budget management

**Hash Protocol** (`hashProtocol.ts`):
- Chunk visibility lifecycle management
- Turn-based materialization tracking
- Scoped views for subagent isolation
- Ref queries by source, type, recency, and custom selectors

### State Management (`src/stores/`)

**Context Store** (`contextStore.ts`, ~5000 lines):
- Working memory: engram CRUD with lifecycle transitions
- Staging area: pre-computed snippets with budget management (≤20k tokens)
- Blackboard: persistent key-value store with artifact classification
- Awareness cache: file content tracking for auto-staging related code
- Task plans: subtask lifecycle with active tracking
- Cognitive rules: user-defined reasoning constraints (session-scoped)
- Auto-management: pressure-based eviction at 90% capacity
- Memory events: audit trail for all operations

**App Store** (`appStore.ts`):
- Chat sessions with message history and streaming state
- Provider settings (API keys, model selection, temperature)
- Project workspace configuration with framework detection
- File tree structure and navigation state
- Agent tracking with progress and pending actions
- Context metrics (token counts, cache performance)

### Utilities (`src/utils/`)

**UHPP Canonical Types** (`uhppCanonical.ts`):
- Full type system for artifacts, slices, symbols, neighborhoods
- Edit targets with eligible operations and safety constraints
- Change sets with verification requirements
- Hash identity with stratification (content, semantic, structural)
- Shorthand operation types for batch compilation

**Hash Resolver** (`hashResolver.ts`):
- Resolves `h:XXXX` references to content
- Set references (`h:@selector`) for multi-hash operations
- Recency refs (`h:$last`, `h:$last-N`) for intra-batch chaining
- Modifier resolution: line ranges, shapes, symbols, patterns
- Inline ref resolution in tool parameters

## Operation Families

All operations are organized into 9 families with short codes for efficient routing:

| Family | Operations | Short Codes |
|--------|-----------|-------------|
| **Discover** | search.code, search.symbol, search.usage, search.similar, search.issues, search.patterns, search.memory | sc, sy, su, sv, si, sp, sm |
| **Understand** | read.context, read.shaped, read.lines, read.file, analyze.deps, analyze.calls, analyze.structure, analyze.impact, analyze.blast_radius, analyze.extract_plan | rc, rs, rl, rf, ad, ac, at, ai, ab, ax |
| **Change** | change.edit, change.create, change.delete, change.refactor, change.rollback, change.split_module | ce, cc, cd, cf, cb, cm |
| **Verify** | verify.build, verify.test, verify.lint, verify.typecheck | vb, vt, vl, vk |
| **Session** | plan, advance, status, pin, unpin, stage, unstage, compact, unload, drop, recall, stats, debug, diagnose, bb.write, bb.read, bb.delete, bb.list, rule, emit, shape, load, compact_history | spl, sa, ss, pi, pu, sg, ust, pc, ulo, dro, rec, st, db, dg, bw, br, bd, bl, ru, em, sh, ld, ch |
| **Annotation** | engram, note, link, retype, split, merge, design | eng, nn, nk, nr, ns, nm, nd |
| **Delegate** | retrieve, design, code, test | dr, dd, dc, dt |
| **System** | exec, git, workspaces, help | xe, xg, xw, xh |
| **Intent** | understand, edit, edit_multi, investigate, diagnose, survey, refactor, create, test, search_replace, extract | iu, ie, im, iv, id, srv, ifr, ic, it, is, ix |

## Chat Modes

| Mode | Purpose |
|------|----------|
| `agent` | Full autonomous agent with tool access |
| `designer` | Architecture and design focus |
| `ask` | Q&A without tool execution |
| `reviewer` | Code review mode |
| `retriever` | Search and information gathering |
| `custom` | User-defined system prompt |
| `swarm` | Multi-agent coordination |
| `refactor` | Code refactoring focus |
| `planner` | Task planning and decomposition |

## Data Flow

1. **User input** → AI provider (streaming)
2. **AI response** → tool calls extracted
3. **Tool calls** → batch executor dispatches steps
4. **Each step** → hash resolution → positional rebase → Rust backend (Tauri IPC)
5. **Rust backend** → file I/O, edits, search, verification
6. **Results** → hash references created, context updated
7. **History compression** → large outputs deflated to `h:XXXX` refs
8. **Next turn** → rolling summary + active engrams + staged snippets → prompt assembly

## Memory Architecture

```
┌─────────────────────────────────────────┐
│          Static Prefix (cached)          │
│   System prompt + tool definitions       │
├─────────────────────────────────────────┤
│          History (append-only)           │
│   Deflated tool results (hash ptrs)      │
├─────────────────────────────────────────┤
│          Dynamic Block (uncached)        │
│   BB + dormant + staged + active +       │
│   workspace context + steering           │
├─────────────────────────────────────────┤
│          Chat Messages                   │
│   Protected window + compressed older    │
└─────────────────────────────────────────┘
```

**Budget Constraints:**
- Stage: ≤20k tokens with priority sorting
- Pin budget: ≤15 engrams recommended
- Auto-eviction at 90% memory pressure
- History compression reduces tool outputs to hash references
- Rolling summaries for older interactions

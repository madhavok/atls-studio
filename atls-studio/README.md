# ATLS Studio

An AI-powered cognitive development environment with managed working memory, built on Tauri.

## Features

- **Engram-based Memory** — Hash-addressed knowledge units with lifecycle management (active → dormant → archived → evicted). Pin to retain, recall by hash, auto-evict under pressure.
- **Universal Hash Pointers (UHPP)** — Reference any content by hash with line ranges, symbol selectors, shapes, diffs, and composition chains. `h:XXXX:fn(name):sig` targets a function signature directly.
- **Multi-Provider AI** — Supports Anthropic (Claude), OpenAI (GPT), Google (Gemini), Vertex AI, and LM Studio for local models. Streaming responses with tool execution loops.
- **9 operation families, 76 `OperationKind` steps** — Discover, Understand, Change, Verify, Session, Annotation, Delegate, System, and Intent operations with short codes for efficient batch execution (see [`src/services/batch/families.ts`](src/services/batch/families.ts)).
- **Subagent Architecture** — Four specialized agents (Retriever, Designer, Coder, Tester) with isolated memory, compressed state snapshots, and different permission levels.
- **Batch Execution** — Positional rebasing across sequential edits, snapshot tracking with content hashing, automatic context refresh, and interruption detection.
- **Smart Editing** — Shadow editing with drift tolerance, body bounds detection (brace-based and indent-based), syntax validation with bracket hints, and per-file undo stacks.
- **Workspace Management** — Multi-root project support with framework detection, language statistics, and `.atlsignore` filtering.
- **Built-in Linting** — SWC-powered JavaScript/TypeScript analysis with fix suggestions and barrel export deduplication.
- **Durable Blackboard** — Persistent key-value store surviving compaction and session boundaries. Stores plans, findings, edit records, and cognitive rules.
- **History Compression** — Tool result deflation to hash references, batch input stubbing, and rolling summaries to maintain manageable context size.
- **9 Chat Modes** — Agent, Designer, Ask, Reviewer, Retriever, Custom, Swarm, Refactor, and Planner modes for different workflows.

## Architecture

```
┌──────────────────────────────────────────┐
│               UI (React)                  │
├──────────────────────────────────────────┤
│            Orchestrator                   │
│  (task planning, multi-agent coord)       │
├──────────┬──────────┬────────────────────┤
│ AI Service│ Subagent │  Batch Executor     │
│ (5 provs) │ (4 types)│  (rebase+snapshot)  │
├──────────┴──────────┴────────────────────┤
│       Context Store + App Store           │
│  (engrams, staging, BB, awareness)        │
├──────────────────────────────────────────┤
│       Rust Backend (Tauri IPC)            │
│  (edits, hashing, workspace, PTY, lint)   │
└──────────────────────────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for app-package architecture notes, or the repository overview at [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Development uses **npm** and **Node 20+** from this directory — see [Getting Started](#getting-started) below.

## Project structure

```
atls-studio/
├── src/                          # TypeScript frontend
│   ├── services/
│   │   ├── orchestrator.ts       # Task decomposition & multi-agent coordination
│   │   ├── aiService.ts          # AI provider integration & prompt assembly
│   │   ├── subagentService.ts    # Retriever/Designer/Coder/Tester dispatch
│   │   ├── historyCompressor.ts  # Tool result deflation & rolling summaries
│   │   ├── hashProtocol.ts       # Chunk visibility lifecycle (HPP)
│   │   └── batch/
│   │       ├── executor.ts       # Positional rebase & snapshot tracking
│   │       ├── types.ts          # Operation types & parameter schemas
│   │       └── families.ts       # Operation family registry
│   ├── stores/
│   │   ├── contextStore.ts       # Working memory, staging, BB, awareness
│   │   └── appStore.ts           # Settings, sessions, providers, chat modes
│   └── utils/
│       ├── uhppCanonical.ts      # UHPP type system
│       └── hashResolver.ts       # Hash reference resolution
├── src-tauri/src/                # Rust backend
│   ├── lib.rs                    # Line edits, hashing, workspace, PTY, undo
│   ├── batch_query/mod.rs        # Central operation dispatcher
│   └── linter.rs                 # SWC-based JS/TS linting
└── docs/
    └── ARCHITECTURE.md           # Detailed architecture documentation
```

This file lives in the **app package** folder (`<clone>/atls-studio/` — one directory inside the repository root, alongside `docs/` and `atls-rs/`). Paths in docs often write `atls-studio/src/…` meaning **this** folder’s `src/`, not the repository root.

| Location | Role |
|----------|------|
| **Clone root** | `ARCHITECTURE.md`, `docs/`, `atls-rs/` |
| **This folder** (`atls-studio/`) | `package.json`, `src/`, `src-tauri/` — **run npm scripts here** |

## Vision

ATLS Studio is a minimal, purpose-built development environment where ATLS provides the intelligence and Claude provides the conversation. The four-panel layout gives you everything you need to understand and improve your codebase.

## Documentation

- **Freshness & edits** (universal `canSteerExecution`, staged `stageState`, snapshot hashes, sequential `line_edits`, cross-step rebase): [`../docs/freshness.md`](../docs/freshness.md)
- **Batch executor** (`batch()` tool, intents, snapshot injection, optional op/param shorthands): [`../docs/batch-executor.md`](../docs/batch-executor.md)
- **Docs index**: [`../docs/README.md`](../docs/README.md)
- **Subagents** (delegate roles, budgets, scoped HPP): [`../docs/subagents.md`](../docs/subagents.md)
- **Architecture overview**: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- **Tauri IPC command names**: [`../docs/tauri-commands.md`](../docs/tauri-commands.md)

### `line_edits` semantics

Edits in `change.edit` / `line_edits` apply **sequentially in array order** (top-down). Each `line` / `anchor` resolves against the file **after** all prior edits in the same array. Multi-step batches that edit the same file with numeric lines are adjusted between steps by the executor (see `docs/freshness.md`). Use inclusive **`line` + `end_line`** for spans and chain from **`edits_resolved`** in the step result when coordinating follow-up edits (see [`../docs/batch-executor.md`](../docs/batch-executor.md)).

### UI layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  ATLS Studio                                                         │
├─────────────┬─────────────────────────────┬──────────────────────────┤
│             │                             │                          │
│  FILE       │  CODE VIEWER                │  AI ASSISTANT            │
│  EXPLORER   │                             │                          │
│             │  Monaco Editor              │  Chat with Claude        │
│  Browse     │  Syntax highlighting        │  powered by ATLS         │
│  files      │  Read/Edit mode             │                          │
│             │                             │  Ask about code          │
│             ├─────────────────────────────┤  Find issues             │
│             │                             │  AI-powered fixes        │
│             │  ATLS INTELLIGENCE          │                          │
│             │                             │                          │
│             │  Issue detection            │                          │
│             │  AI fix suggestions         │                          │
│             │  Severity filtering         │                          │
└─────────────┴─────────────────────────────┴──────────────────────────┘
```

## Tech Stack

- **Tauri 2** — Rust-powered native shell
- **React 19** — UI
- **TypeScript** — Frontend
- **Monaco Editor** — Editor engine
- **Tailwind CSS** — Styling
- **Zustand** — State
- **ATLS** — Code intelligence via the in-process Tauri backend (`atls-core` in `../../atls-rs/crates/atls-core`)
- **Claude API** (and other providers) — Chat streaming through Rust adapters

## Prerequisites

1. **Rust** — [Install Rust](https://www.rust-lang.org/learn/get-started)
2. **Node.js** — 20 or later (see `engines` in `package.json`)
3. **Engine checkout** — `atls-rs` is included in this repository; no separate ATLS npm package is required to build the app.

## Getting Started

### Install Dependencies

```bash
cd atls-studio
npm install
```

### Development Mode

```bash
npm run tauri:dev
```

This starts the Vite dev server and launches the Tauri window.

### Build for Production

```bash
npm run tauri:build
```

Creates platform-specific installers in `src-tauri/target/release/bundle/`.

If you run `cargo build` directly under `src-tauri`, run `npm run build` in this directory first so `dist/` exists — Tauri embeds that bundle at compile time.

### Provider API keys

Configure provider credentials in the in-app **Settings** UI:

| Provider | Setting |
|----------|----------|
| Anthropic | API key |
| OpenAI | API key |
| Google | API key |
| Vertex AI | Project ID + Location + OAuth token |
| LM Studio | Base URL (default: `http://localhost:1234`) |

### TypeScript

```bash
npm run typecheck   # tsc -b — checks src/ + vite.config.ts (matches verify.typecheck for this package)
```

### Testing

```bash
npm run test        # Frontend tests (Vitest)
npm run test:all    # Frontend + Rust backend tests
```

HPP validation (parser, materialization, ref formatting) runs as part of `npm run test` via [`src/__tests__/hpp-validation.test.ts`](src/__tests__/hpp-validation.test.ts).

## App directories

```
atls-studio/              # this app package
├── src/                  # React frontend
│   ├── components/
│   │   ├── FileExplorer/
│   │   ├── CodeViewer/
│   │   ├── AtlsPanel/
│   │   └── AiChat/
│   ├── stores/
│   ├── hooks/
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/            # Rust backend (see ../docs/tauri-backend.md, ../docs/tauri-commands.md)
│   ├── src/
│   │   └── lib.rs        # Tauri entry + command registration
│   └── Cargo.toml
├── tailwind.config.js
└── package.json
```

## UI features

### File Explorer
- Hierarchical tree view
- File type icons by language
- Quick search filter
- Expand/collapse folders

### Code Viewer
- Monaco editor with syntax highlighting
- Tab management for open files
- Read-only default, edit mode available
- Dark theme optimized for coding

### ATLS Intelligence Panel
- Real-time issue detection
- Severity indicators (High/Medium/Low)
- Category filtering (Security, Performance, etc.)
- AI-powered fix suggestions via chat

### AI Chat
- Natural language interface
- Context-aware responses
- Suggested action prompts
- Quick action buttons
- Conversation history

## Fixing Issues

ATLS Studio uses AI-powered fixes via `edit(line_edits)` instead of pre-defined auto-fixers. When issues are detected:

1. **Find issues** — `find_issues` / batch `search.issues` detects code issues across your project
2. **Ask AI** — Chat with Claude about the issues
3. **AI generates fix** — Claude analyzes context and generates appropriate fixes
4. **Apply via edit** — Fixes are applied through line-level edits with symbol anchors

This approach provides more contextual, intelligent fixes compared to rigid pattern-based auto-fixers.

## Hash-Building Refactor Pipeline

ATLS Studio supports a content-as-ref composition model for code extraction and refactoring. Instead of regenerating code through the LLM, the model emits hash pointers that the runtime resolves to exact source content.

### Pipeline Steps

1. `read.context type:full` + `session.pin` - obtain `h:SOURCE` with full file content
2. `edit(creates:[{path, content}])` - compose new file using `h:SOURCE:cls(Name):dedent` refs in content
3. `edit(line_edits:[{action:'delete', line:N, count:M}])` - remove extracted code from source
4. `refactor(action:'rewire_consumers', source_file, target_file, symbol_names:[...])` - auto-rewrite imports in all consumer files + add source import
5. `verify.typecheck` - validate all files

### Requirements

- **Source hash must have full content** - shaped or sig-only reads do not contain function/class bodies. Symbol anchors (`cls()`, `fn()`, `sym()`) will error against shaped content.
- **Source hash must be pinned or active** - evicted hashes cannot be resolved.
- **Imports in the new file are manual** - the hash-building path does not auto-scaffold imports in the created file. Use `refactor(action:execute)` with `extract:` / `from:` / `to:` for automatic import scaffolding. Consumer imports are handled by `refactor(action:'rewire_consumers')`.

### Supported Symbol Kinds

- `cls(ClassName)` - class extraction
- `fn(functionName)` - function extraction
- `sym(symbolName)` - generic symbol extraction
- `:dedent` modifier - strips common indentation from extracted code

### Symbol-Anchored Deletes

Instead of manually reading line numbers, use the `symbol` field on `line_edits` to delete by symbol name:

```
edit(line_edits:[{action:'delete', symbol:'MyClass', position:'before'}])
```

When `action` is `delete` and `symbol` is provided with `position:'before'`, the `count` is automatically set to cover the full symbol range. No manual line reads needed.

### Alternative: Declarative Extract

For single-symbol extraction with automatic import/export handling, use the refactor execute path:

```
refactor(action:'execute', extract:'fn(myFunc)', from:'h:SOURCE', to:'target.ts')
```

This automatically scaffolds imports, adds export keywords, removes from source, and rewires consumer imports.

## Tauri commands (examples)

The Rust backend exposes many IPC commands. A few common names:

```text
get_file_tree, read_file_contents, write_file_contents
scan_project, find_issues, get_scan_status, get_issue_counts
```

This is **not** an exhaustive list. See [`../docs/tauri-commands.md`](../docs/tauri-commands.md) for the full inventory aligned with `src-tauri/src/lib.rs`, and [`../docs/tauri-backend.md`](../docs/tauri-backend.md) for module boundaries.

## Configuration

### Tailwind Theme

Custom colors in `tailwind.config.js`:

```javascript
colors: {
  studio: {
    bg: '#0d1117',      // Background
    surface: '#161b22', // Panel surfaces
    border: '#30363d',  // Borders
    text: '#c9d1d9',    // Primary text
    muted: '#8b949e',   // Secondary text
    accent: '#58a6ff',  // Accent color
    success: '#3fb950', // Success/fix
    warning: '#d29922', // Warning
    error: '#f85149',   // Error/high severity
  }
}
```

## Integration with ATLS

This desktop app talks to Rust via **Tauri `invoke()`** (see `src/services/` and `src/hooks/useAtls.ts`). The npm package `atls/studio` / `StudioBridge` is a **separate** integration surface for embedding ATLS outside this repo; it is **not** used by this application.

## License

See [`../LICENSE`](../LICENSE) at the repository root.

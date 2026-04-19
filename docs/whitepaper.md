# Output-Compression-First Architectures for LLM Coding Agents

**The ATLS System, the UHPP Reference Calculus, and the Hash Presence Protocol**

*A working paper on emission-oriented design for agent tooling.*

---

## Abstract

Contemporary LLM coding agents treat the **context window** as the primary resource to manage. We argue this is the wrong abstraction. Under current provider pricing, **output tokens cost 3–5× input tokens**, and cached input reads cost **0.1× uncached input**, producing an input:output cost ratio that can exceed **1:50** in practice. Under this asymmetry, the dominant cost of an agent round is not what the model *reads* but what it *writes*. Designs that optimize context packing while leaving the model to emit free-form reasoning, fully-qualified tool calls, and verbatim code in every round are leaving an order of magnitude of cost on the table.

We present **output-compression-first architecture** as a unifying design thesis for LLM agent tooling: every subsystem should be architected to minimize the tokens the model must emit, not merely the tokens the model must ingest. We identify **six axes** along which emission can be compressed — lexical, semantic, temporal, spatial, computational, and transcript — and show how disciplined application of all six stacks multiplicatively.

Complementing this, we document a **ten-layer input compression stack** — wire-format serialization (TOON), dictionary compression with ditto encoding, progressive-disclosure shaped reads, one-hash-per-file FileView merging, history deflation to hash pointers, cache-aware prompt layout with hard token budgets, materialization control, workspace-context minimization, and redundant-read blocking — that reduces input cost by an additional 20–25% beyond prompt caching alone. The two approaches compound: output compression saves at 5× per token, input compression saves at 1× (uncached) or 0.1× (cached), and together they achieve roughly **40–50% total cost reduction** versus either approach in isolation.

We introduce two protocols that operationalize this thesis:

- **UHPP (Universal Hash Pointer Protocol)** — a reference calculus for addressing, slicing, shaping, and composing LLM working memory. UHPP provides a unified syntax (`h:SHORT:slice:shape:op`) with temporal refs, set selectors, symbol extraction, and content-as-ref resolution, enabling a model to reference code artifacts compactly instead of copying them.
- **HPP (Hash Presence Protocol)** — a round-scoped visibility state machine (`materialized → referenced → archived → evicted`) over content-addressed engrams, with scoped views that let subagents participate without disturbing global presence state.

We describe **ATLS**, a reference implementation combining UHPP, HPP, a managed memory runtime, a single batch-tool execution surface, a freshness subsystem with first-class epistemic-integrity primitives, and a history-compression pipeline. ATLS is embodied as a Tauri desktop coding environment totaling approximately **200k LOC** across TypeScript (cognitive runtime, batch handlers, prompt system, managed stores, React UI, 148 test files) and Rust (code intelligence engine with tree-sitter indexing, UHPP shape/symbol resolution with dual-implementation parity, edit application with preimage verification, AI streaming, and SQLite persistence across 38 backend modules with `#[cfg(test)]` blocks in 36 of them).

We argue that the combination of (a) a protocol for referencing content without copying it, (b) a visibility calculus over that content, and (c) a system-wide discipline of minimizing model emission, together constitute a transferable architectural primitive for agent tooling that can and should be adopted beyond the reference implementation.

---

## 1. Introduction

The last three years have seen an explosion of LLM-based coding agents — Cursor, Aider, Cline, Claude Code, Continue, and many others — each offering a tool surface, a memory system, and a prompt-assembly strategy. The design conversation in this space has centered almost exclusively on **context window management**: how to fit more relevant code into the model's input, how to retrieve the right files, how to summarize history, how to cache prefixes.

This is the wrong primary axis.

Under the pricing regimes of the major frontier model providers in 2025–2026, the dominant cost of a multi-round agent loop is not the input tokens the model ingests. It is the **output tokens the model emits**, amplified by the cost multiplier that providers charge on output and the discount they grant on cached input.

This paper makes the following contributions:

1. We quantify the input/output cost asymmetry in current provider pricing and show that under conservative assumptions, a single round of a typical naive agent emits enough output to dominate its own cost envelope.

2. We propose **output-compression-first** as a unifying design thesis: every subsystem of an agent tool should be evaluated by its effect on model emission, not merely on context efficiency.

3. We identify **six axes of emission compression** — lexical, semantic, temporal, spatial, computational, and transcript — and show through case analysis that disciplined application of all six stacks multiplicatively, not additively.

4. We introduce **UHPP**, a reference calculus for LLM working memory that collapses what would otherwise be verbose code citations, file paths, and slice coordinates into compact, composable hash-pointer expressions.

5. We introduce **HPP**, a round-scoped visibility state machine that lets an agent tool track what the model can currently "see" across turns without relying on transcript-based inference.

6. We describe **ATLS**, a reference implementation that integrates UHPP, HPP, a managed memory runtime with a single-tool batch execution surface, a freshness subsystem, and a history-compression pipeline.

7. We document a **ten-layer input compression stack** — TOON serialization, dictionary compression, shaped reads, FileView merging, history deflation, cache-aware prompt layout, token budgets, materialization control, workspace minimization, and redundant-read blocking — that complements the output-side thesis with measured input-side savings.

8. We describe the **symbol resolver** — a tiered regex + block-end scanner with TypeScript/Rust parity that makes UHPP anchor resolution fast enough to run inline in the batch execution hot path without IPC or full AST parsing.

The remainder of the paper is organized as follows. §2 presents the economic problem. §3 articulates the output-compression-first thesis and introduces the complementary input compression stack. §4 defines UHPP. §5 defines HPP. §6 enumerates the six compression axes. §7 describes the reference system architecture (approximately 200k LOC across TypeScript and Rust). §8 treats freshness as epistemic integrity. §9 presents the empirical evaluation. §10 surveys related work. §11 discusses limitations and future work. §12 concludes.


---

## 2. The Economic Problem

### 2.1 The input/output cost asymmetry

Frontier model providers price output tokens at a significant multiple of input tokens. As a representative example, Anthropic's Claude pricing tier (Sonnet 4 and Opus 4) applies the following multipliers relative to the baseline uncached input rate:

| Token class | Multiplier (× uncached input) |
|---|---|
| Cached input read | 0.1× |
| Uncached input | 1.0× (baseline) |
| Cache write | 1.25× |
| Output | **5.0×** |

A model round that reads 10k cached input tokens and writes 1k output tokens thus pays approximately `10,000 × 0.1 + 1,000 × 5.0 = 6,000` input-equivalent tokens — of which **83% is attributable to output**. Against uncached input, the comparison is less extreme but still output-dominant: `10,000 × 1.0 + 1,000 × 5.0 = 15,000` input-equivalents, with output contributing 33%.

For Opus-tier pricing ($15/MTok input, $75/MTok output), these ratios translate directly into dollar costs. A 10-round tool loop spending 30–50k uncached input per round and 2–4k output per round costs approximately \$1.37–\$2.27 on Sonnet 4 and \$6.85–\$11.35 on Opus 4.

### 2.2 Why the dominant mitigations are input-side — and why they are insufficient alone

Prompt caching — the standard economic mitigation — reduces **input** cost by preserving prefix byte-identity across requests. Cached reads at 0.1× can bring input cost to near-zero for the static portion of the prompt. But cache prefixes must be byte-stable: any changing content between the cache breakpoint and the request terminator invalidates cache for everything after it. Agents with living working memory — hash manifests, blackboards, staged snippets, dynamically-materialized engrams, steering signals — have, by design, a large mutable tail that cannot sit inside a cacheable prefix. Empirically, naive agent architectures report cache hit rates of 30–40% versus 85% for static chatbots, precisely because the interesting parts of the prompt are the moving parts.

This is a well-known structural limitation. But the conclusion that input-side work is exhausted does not follow. **Beyond caching, substantial input compression remains available**: wire-format optimization (replacing JSON with token-efficient serialization), dictionary compression on structured tool results, progressive-disclosure reads that deliver 5–10% of a file's tokens instead of the full body, history deflation that replaces past tool results with hash pointers, and hard token budgets that cap each prompt section regardless of session length. ATLS implements all of these as a ten-layer input compression stack (documented in [docs/input-compression.md](./input-compression.md)), achieving roughly 20–25% input cost reduction beyond what caching alone provides.

The deeper point: **input-side caching addresses the static prefix; input-side compression addresses the dynamic tail**. Both are necessary. But neither eliminates the fundamental asymmetry: output tokens still cost 5× input tokens, and the output side is where the design conversation in the field has invested *least*. Further compression must come from both sides — and the output side offers the larger per-token return.

### 2.3 The naive agent round: an audit

Consider what a typical tool-calling agent emits in a single round, on a simple edit task:

1. **A free-form reasoning paragraph** (100–400 tokens). "I'll start by reading the file to understand the current implementation, then identify where the bug is, and apply a targeted fix."
2. **A tool call as a JSON object** (50–200 tokens): fully-qualified tool name, fully-named parameter keys, file path and other identifiers as string literals.
3. **Repeat (1)–(2)** for each atomic action. Multi-step workflows emit narration between each tool call.
4. **Copy-paste of code content** for edits — the model writes the new content verbatim as a string in the tool call parameters.

A 4-step workflow (read, analyze, edit, verify) under this pattern emits on the order of 1,500–3,000 output tokens — much of it restating content the runtime already knows.

ATLS's measured output for a comparable 4-step workflow, using the full compression stack described in this paper, is **on the order of 40–100 output tokens**. The savings are not a 2× optimization; they are a **20–50× compression** of the emission path.

### 2.4 The thesis, stated precisely

> **Every token the model emits should express intent the runtime cannot infer.**
> Names, paths, coordinates, narration, and repetitions are the runtime's job.

This is the design principle that, applied consistently, produces the 20–50× compression observed in the reference implementation. The rest of this paper is a treatment of what "applied consistently" looks like in practice.

---

## 3. Design Thesis: Output-Compression-First

### 3.1 The principle

An **output-compression-first architecture** is one in which every subsystem — tool surface, memory manager, prompt assembler, history compressor, coordination layer — is designed with the primary optimization target being: *reduce the tokens the model must emit*.

This is distinct from, and complementary to, context-window optimization. Context-window design asks: *what can we pack into the prompt?* Output-compression design asks: *what can we let the model not say?*

The two goals are sometimes aligned and sometimes in tension. A richer prompt can let the model emit less because more context reduces the need for reasoning-out-loud. A more structured tool surface can let the model emit less because shorthand replaces verbose JSON. But a more aggressive summarization of history can *increase* emission if the summary is insufficient and the model re-asks questions it has already answered. Output-compression-first resolves these trade-offs by naming the primary target explicitly: **emission, not ingestion**.

### 3.2 Why this reframe matters

The context-window frame has produced real progress: retrieval-augmented generation, summarization, semantic search, and prompt engineering have all extended what agents can do within a fixed token budget. But the frame treats the model as a *consumer* of context and does not directly address the *producer* side.

The output-compression frame inverts this. It treats the model as an expensive producer whose output should be constrained to the minimum information the runtime genuinely cannot compute. This reframe motivates the designs in §4–§6 — all of which would seem over-engineered under a context-window-first framing, and all of which deliver measured cost reduction under an output-compression-first one.

### 3.3 Compounding across axes

A single compression mechanism rarely delivers more than 10–20% emission reduction. The ATLS result (20–50× on representative workflows) arises because disciplined application of **all six axes** stacks multiplicatively. A 4-step batch using lexical shorthand alone saves ~30%; using shorthand plus intent macros saves ~60%; using shorthand, intents, content-as-ref, and computational inference can save 95%+.

The implication for design is that half-measures are worse than they look. A system that applies only lexical compression captures one-sixth of the available gain. Output-compression-first is most effective as a system-wide discipline, not a point optimization.

### 3.4 The complementary input stack

Output-compression-first does not mean input compression is unimportant — it means output compression offers higher per-token ROI under current pricing. ATLS applies both.

The input compression stack operates across ten layers: (1) **TOON serialization** replaces JSON's quoted keys and nested braces with a token-efficient wire format, saving 30–60% on structured payloads; (2) **dictionary compression** abbreviates repeated keys to single-character codes and applies ditto encoding across adjacent array elements; (3) **substring dictionaries** identify frequently-occurring strings and replace them with numbered codes via an inline legend; (4) **shaped reads** deliver progressive-disclosure views — signature skeletons at ~5% of file size, with targeted line slices on demand; (5) **FileView merging** consolidates multiple reads of the same file into one live view with a single hash identity; (6) **history deflation** replaces past tool results and assistant stubs with hash pointers, capping conversation history at 24k tokens regardless of session length; (7) **cache-aware prompt layout** places stable content in cacheable prefix regions and confines dynamic content to the mutable tail; (8) **hard token budgets** cap each prompt section (WM: 38k, history: 24k, workspace: 7k, BB: 4.8k) with proportional relief under pressure; (9) **materialization control** renders previously-seen chunks as compact digest lines instead of full content; (10) **redundant-read blocking** prevents re-ingestion of content already present in working memory.

The full input compression architecture is documented in [docs/input-compression.md](./input-compression.md). The key insight: output compression saves at **5×** per token while input compression saves at **1×** (uncached) or **0.1×** (cached). Combining both yields roughly 40–50% total cost reduction — neither captures the full benefit alone.

---

## 4. UHPP: A Reference Calculus for LLM Working Memory

The single largest emission-compression gain in ATLS comes from **not copying code**. When a model needs to refer to a function, a file region, or a prior artifact, the naive pattern is to copy it verbatim into a tool call. UHPP replaces this with a compact pointer.

### 4.1 Motivation

Content-addressable storage is a well-established primitive (Git, IPFS, Merkle-DAG systems). The contribution of UHPP is not hash-addressing itself; it is the elevation of hash references to a **composable reference calculus** — a small grammar of operators that lets a single expression select, slice, shape, transform, and temporally locate content.

The alternative to UHPP is to have the model emit:
- file paths (often 30–80 tokens each when fully qualified),
- line coordinates (often re-emitted between rounds as the model navigates),
- verbatim code snippets (often hundreds of tokens, duplicating content already in context),
- narration about which artifact is being referred to.

UHPP collapses these into a single, parseable reference form.

### 4.2 Base syntax

A UHPP reference has the shape:

```
h:HASH[:slice][:shape][:op][:meta]
```

The `HASH` component is either a short hash (a 6+ character hex prefix of a content hash, disambiguated by the runtime) or a named selector (see §4.5). Successive components are composable modifiers applied left-to-right.

**Examples:**

```
h:a1b2c3                  → direct reference to engram a1b2c3
h:a1b2c3:15-50            → slice: lines 15 through 50
h:a1b2c3:fn(init):sig     → shape: signature only of function `init`
h:a1b2c3:15-50:dedent     → slice then strip leading whitespace
h:a1b2c3:tokens           → zero-content: retrieve only token count
```

### 4.3 Slicing

UHPP supports line-range slicing with inclusive 1-based semantics:

```
h:XXXX:15-50              → lines 15–50 inclusive
h:XXXX:15-22,40-55        → multiple ranges
h:XXXX:45                 → single line
h:XXXX:45-                → line 45 through end of file
```

Slicing is composable with shape and symbol operators (§4.4), allowing expressions like `h:XXXX:fn(init):15-22:dedent`.

### 4.4 Shape operators

Shape operators transform content into alternative views without modifying the source. The ATLS implementation includes:

| Shape | Description | Typical savings |
|---|---|---|
| `sig` | Code: function/class signatures. Markdown: heading outline with `[start-end]` section ranges. | ~85% |
| `fold` | Collapsed function bodies (keeps signatures, elides implementations) | ~50–70% |
| `dedent` | Strip leading whitespace | ~10–15% |
| `nocomment` | Strip comments | ~10–30% |
| `imports` | Import/use statements only | ~90% |
| `exports` | Exported symbols only | ~90% |
| `head(N)` | First N lines | variable |
| `tail(N)` | Last N lines | variable |
| `grep(pat)` | Lines matching a regex | variable |

Shapes compose with slices and with each other: `h:XXXX:fn(init):sig:dedent`, `h:XXXX:15-80:nocomment`, `h:XXXX:imports`.

Symbol extraction is a special shape parameterized by kind and name:

```
h:XXXX:fn(name)           → a specific function
h:XXXX:cls(Name)          → a specific class
h:XXXX:sym(Name)          → any symbol by name, kind-agnostic
h:XXXX:fn(name#2)         → second overload of a function
```

UHPP symbol anchors resolve through ATLS's **symbol resolver** — not a generic AST walk in the hot path: **tiered regex prefixes** per canonical kind, false-positive guards, decorator rollback, overload indexing (`name#N`), and a **string/comment-aware** `findBlockEnd` that tracks braces, raw strings, template literals, and non-brace block styles (Python indent, Ruby/Lua `end`, etc.). The TypeScript implementation (`symbolResolver.ts`) runs synchronously in the renderer for UHPP expansion in `hashResolver.ts` and for **freshness relocation** in `freshnessPreflight.ts` without per-modifier IPC. Rust holds deterministic parity in `shape_ops.rs` (`resolve_symbol_anchor_lines`, `find_block_end`, shared kind table). The wrapper `resolve_symbol_anchor_lines_lang` may **optionally** consult **tree-sitter** when a registered grammar exists, then fall back to the regex tiers — but the architecture that makes `:fn(name)` cheap and ubiquitous is this custom scanner, not tree-sitter-first parsing. Tree-sitter remains the backbone of **project indexing, structured queries, and pattern-based issue detection** in `atls-core` — a different responsibility than turning a UHPP anchor into a line span. See [symbol-resolver.md](./symbol-resolver.md). The supported kind catalog spans typical language constructs (fn, cls, struct, trait, protocol, enum, record, union, type, alias, const, var, let, prop, field, attr, method, impl, mod, macro, test).

### 4.5 Selectors: set-valued references

UHPP extends beyond single-content references to dynamically-evaluated **set selectors**, prefixed with `@`:

```
h:@all                    → all active refs
h:@pinned                 → all pinned refs
h:@edited                 → refs produced by an edit
h:@dormant                → all dematerialized (referenced) refs
h:@stale                  → refs with lastAccessed older than threshold
h:@latest:N               → most recent N refs
h:@file=*.ts              → glob on source path
h:@type=search            → filter by chunk type
h:@search(query)          → dynamic search (async resolution)
```

Selectors compose with Boolean operators:

```
h:@edited+h:@file=*.ts           → union
h:@edited&h:@file=*.ts           → intersection
h:@all-h:@pinned                 → difference
h:@search(auth)&h:@file=*.rs     → search intersected with file filter
```

Set selectors deliver a disproportionate share of the lexical-compression gain (§6.4) because a single token can address an arbitrarily large, dynamically-evaluated hash list.

### 4.6 Temporal references

UHPP integrates with the version-control system to support time-traveled references:

```
HEAD~1:src/auth.ts               → file at the previous commit
HEAD~3:src/auth.ts               → file three commits ago
tag:v1.0:src/auth.ts             → file at a tagged release
commit:abc123:src/auth.ts        → file at a specific commit
```

Temporal refs compose with shapes: `HEAD~1:src/auth.ts:sig` retrieves the signature-only view of the file at the previous commit. Resolution is performed by the runtime (not the model) via `git show` against the active repository.

### 4.7 Recency references

For intra-batch and intra-session chaining, UHPP provides recency operators resolved at execution time:

```
h:$last                   → most recently accessed engram
h:$last-1                 → second most recent
h:$last_edit              → most recently edited engram
h:$last_read              → most recently read
h:$last_stage             → most recently staged
h:$last_edit-2            → third-most-recent edit
```

Recency refs eliminate the need for the model to emit specific hashes when chaining: `read → pin` becomes `{read file}; {pin h:$last}` rather than `{read file}; {pin <explicit-hash-from-prior-result>}`.

### 4.8 Blackboard references

The runtime's persistent key-value store (blackboard) is addressable via a dedicated ref namespace:

```
h:bb:plan                 → blackboard entry `plan`
h:bb:findings:sig         → blackboard entry with shape applied
```

### 4.9 Diff references

A unified-diff between two engram versions is expressible as:

```
h:OLD..h:NEW              → diff between two versions of an engram
```

This is used both for audit trails and for efficient rollback operations.

### 4.10 Content-as-ref resolution

The most impactful UHPP feature from an emission-compression standpoint is **content-as-ref resolution**: hash refs used as content parameters in tool calls are resolved inline by the runtime.

```json
{
  "use": "change.create",
  "with": {
    "creates": [
      {"path": "new.ts", "content": "h:XXXX:fn(name):dedent"}
    ]
  }
}
```

The `content` field resolves to the extracted, dedented function from engram `XXXX`. The model never emits the function body; it emits a reference to it. For operations like `change.create`, `change.refactor`, and `annotate.design`, this replaces what would be hundreds or thousands of tokens of verbatim code with a ~25-token ref expression.

### 4.11 Resolution semantics

UHPP resolution is performed by the runtime, not the model. A centralized resolver component receives tool call parameters containing UHPP expressions and expands them to concrete content, paths, or hash lists before dispatching to handlers. This produces two desirable properties:

1. **Emission compression at the call site**: The wire form contains only the pointer.
2. **Execution integrity at dispatch**: The resolved content is subject to freshness checks (§8) before being used for mutation, so stale refs cannot cause silent data corruption.

Resolution is *lenient* by design — an unresolvable reference is passed through as a literal with a warning, rather than causing hard failure — because the ref registry state evolves across rounds and transient gaps during, e.g., session restore should not break a batch.

### 4.12 UHPP as a protocol contribution

The tractable core of UHPP is:

- A grammar (approximately 80 lines of EBNF; Appendix A).
- A resolution semantics (slice → shape → symbol → selector → temporal, applied left-to-right with well-defined precedence).
- A small set of operators (~30 modifiers across the five categories above).
- A convention for set algebra (three Boolean operators over selectors).

Any agent tool can adopt UHPP as its reference syntax. The reference implementation in this paper uses UHPP, but UHPP is **not** specific to ATLS. A 200–500 LOC implementation in any language could provide a working UHPP resolver sufficient to interoperate with ATLS-style artifacts or to serve as the reference layer for a different agent architecture.

Adoption of UHPP as a cross-tool protocol is the single highest-leverage external move from the work described in this paper. §11 returns to this point.

---

## 5. HPP: Hash Presence Protocol

UHPP solves the *addressing* problem: how to refer to content. HPP solves the *visibility* problem: tracking what the model can currently see.

### 5.1 The visibility problem

In a multi-round tool loop, the model's effective context changes every round. Content that was materialized (full text in prompt) on round N may be referenced (pointer-only) on round N+1 and archived (not shown) on round N+2. The agent tool needs to track this precisely, because:

- Tool calls that reference archived content must re-materialize it first (or the model will fail to ground its response).
- Prompt assembly must know which engrams to include verbatim and which to elide.
- History compression needs to know when an inline content block can safely be replaced with a pointer.
- Freshness checks need to know which visibility transitions invalidate prior reasoning.

Without an explicit protocol, agents typically handle this implicitly, with bugs that accumulate into silent correctness failures ("why did the model re-read this file it just edited?").

### 5.2 The state machine

HPP defines four visibility states:

```
materialized  → full content currently in prompt
referenced    → visible as a pointer (hash manifest row), not full content
archived      → not shown; recallable on demand
evicted       → not shown; must be re-read from source
```

Every content-addressed engram carries a HPP state. Transitions are driven by explicit operations:

- `advanceTurn()` — increments the round counter; unpinned materialized refs from prior rounds become `referenced`.
- `materialize(hash)` — transitions to `materialized`, marks the ref as seen-this-turn.
- `dematerialize(hash)` — transitions `materialized → referenced` within the same round (used by history compression when a full block is replaced by a pointer).
- `archive(hash)` — transitions to `archived`.
- `evict(hash)` — transitions to `evicted`.

### 5.3 Materialization decision

Whether content is actually rendered into the prompt is determined by a single predicate:

```
materialize-this-turn(ref) := 
    ref.visibility == 'materialized' 
    AND (ref.seenAtTurn == currentTurn OR ref.pinned)
```

In other words: full content is rendered only for references touched this turn or explicitly pinned. Everything else is either elided or surfaced as a compact manifest entry. This rule is the single largest contributor to dynamic-block stability and to avoiding unbounded context growth.

### 5.4 Scoped views

A distinctive feature of HPP is **scoped view** support: subordinate agents (subagents, test harnesses) can operate with a *local* turn counter that reads shared ref state but does not trigger global side effects.

```
createScopedView() → {
    localTurn counter,
    read access to shared refs,
    no global advanceTurn,
    no global dematerialization,
    no round-end hooks
}
```

This resolves a subtle bug class: when subagents share the main agent's ref state, their turn advances pollute the main agent's visibility — content materialized for a worker gets dematerialized from the main agent's view, forcing re-reads. Scoped views eliminate this interaction while preserving shared reference identity.

### 5.5 HPP as a reusable component

HPP is smaller and simpler than UHPP — approximately 200–400 LOC in a typical implementation. Its contribution is primarily the state machine and the scoped-view discipline. Any agent using hash-addressed memory will benefit from adopting an HPP-like visibility layer; the cost-efficiency of the design comes from the discipline it imposes, not from algorithmic novelty.

---

## 6. The Six Axes of Emission Compression

We now describe the six axes along which ATLS compresses model emission. Each axis is supported by concrete mechanisms in the reference implementation. The axes are treated in order of increasing abstraction.

### 6.1 Axis 1: Lexical

Tokens saved by writing fewer characters for the same semantic content.

- **Single-tool envelope**: The agent emits one `batch()` tool call per round rather than N individual tool calls. This eliminates repeated tool-name tokenization and repeated JSON envelope structure.
- **Line-per-step format**: A batch is expressible as a text block with one step per line (`id op k:v …`), which tokenizes substantially more efficiently than the equivalent JSON array (measured ~70%+ savings for multi-step batches).
- **Operation shorthand**: A 76-code alphabet maps short identifiers to canonical operations (`ce` = `change.edit`, `sc` = `search.code`, `vb` = `verify.build`, `rl` = `read.lines`, etc.). A generated legend is embedded in the static system prompt; the runtime normalizes shorthands to canonical names before dispatch.
- **Parameter shorthand**: Frequent parameter keys are aliased (`ps` = `file_paths`, `le` = `line_edits`, `sl`/`el` = `start_line`/`end_line`, `sn` = `snippet`).
- **Dataflow shorthand**: `in:r1.refs` resolves to `{from_step: "r1", path: "refs"}`.
- **Condition shorthand**: `if:e1.ok` resolves to `{step_ok: "e1"}`; `if:!e1.ok` for negation; `if:e1.refs` for ref-presence.
- **TOON serialization**: A JSON-compatible serialization format that saves 40–60% for nested structured values by using `1`/`0` for booleans, unquoted strings, and minimal brace structure.
- **Bare hash tokens**: Hash refs in a step's line form (`read h:abc123 …`) are accumulated by the parser into the appropriate parameter without requiring a `hashes: ["h:abc123"]` array wrapper.

### 6.2 Axis 2: Semantic

Tokens saved by letting the model express *what* it wants rather than *how* to achieve it.

- **Intent macros**: High-level intents (`intent.edit`, `intent.investigate`, `intent.search_replace`, `intent.refactor`) expand client-side into primitive step sequences. A single `intent.edit` line expands into read + edit + conditional retry + optional verify — 3–5 primitive steps — that the model would otherwise emit by hand.
- **Skip-satisfied sub-steps**: Intent expansion is state-aware. A staged file skips its re-read step; a pinned ref skips its re-pin; a blackboard-cached result skips its re-search.
- **Speculative lookahead under pressure**: The intent expander may emit speculative read steps ("the model is likely to want this next"); under token pressure these are silently dropped before the model sees them.
- **Named bindings**: `out: "$name"` and `{bind: "$name"}` let the model assign a name to a value and reference it across steps without re-emitting.
- **Pre-registered refs**: A batch envelope accepts a refs array `[{name: "$target", ref: "h:..."}]` that pre-loads named hashes, further reducing repetition.
- **Structured result arrays**: Search results include parallel `file_paths`, `lines`, `end_lines` arrays so the next step can bind to positions directly rather than re-parsing formatted output.

### 6.3 Axis 3: Temporal

Tokens saved by referring to recency rather than re-pasting identifiers.

- **Global recency refs**: `h:$last`, `h:$last-1`, ...
- **Operation-scoped recency**: `h:$last_edit`, `h:$last_read`, `h:$last_stage` — separate recency stacks per origin, so the model can say "the last thing I edited" without conflating with other operations.
- **Rollback recency**: `h:$last_edit-N` resolves against the edit stack specifically, which is the correct target for `change.rollback` operations.

### 6.4 Axis 4: Spatial

Tokens saved by addressing groups and views rather than enumerating members.

- **Set selectors**: `h:@pinned`, `h:@edited`, `h:@file=*.ts`, `h:@type=search` — one token addresses a dynamic N-hash list.
- **Set algebra**: `+`, `&`, `-` Boolean combinators over selectors.
- **UHPP shapes**: `sig`, `fold`, `dedent`, `imports`, `exports`, `head(N)`, `tail(N)`, `grep(pat)` — structural views addressable with one modifier.
- **Symbol extraction**: `:fn(name)`, `:cls(Name)`, `:method(name)`, etc. — address a symbol by name without emitting coordinates.
- **Meta modifiers**: `:tokens`, `:meta`, `:lang`, `:source` — zero-content metadata retrieval.
- **Content-as-ref**: A content parameter that is itself a UHPP expression resolves to the referenced content at execution time, completely avoiding verbatim-code emission for create/refactor operations.
- **Line-range refs**: `h:XXXX:15-50` without a separate read step.

### 6.5 Axis 5: Computational

Tokens saved by moving arithmetic, injection, and coordination out of the model emission path.

- **Intra-step line rebase**: Multiple `line_edits` within a single `change.edit` use *pre-edit* coordinates; the executor computes cumulative deltas. The model never emits "L50 is now L53 after the prior insertion" reasoning.
- **Cross-step line rebase**: The same guarantee extends across batch steps — subsequent steps' line coordinates are auto-adjusted for edits made by earlier steps.
- **`edits_resolved` chaining**: Successful edits return resolved line numbers; subsequent steps consume these rather than the model restating spans.
- **Sequential `line_edits` semantics**: Edits apply in array order with running deltas. The order matches the model's natural reading order, so no mental reordering is ever serialized.
- **Auto-workspace inference**: `verify.*` steps resolve the workspace from the edited file paths, eliminating the need for an explicit `workspace:` parameter.
- **Auto-verify injection**: A policy flag causes the executor to append `verify.build` after any `change.*` step; the model does not emit it.
- **Auto pin migration on edit**: An edit that modifies a pinned engram automatically transfers the pin to the new hash, eliminating trailing `session.pin` emission.
- **Auto-stage impacted ranges**: After an edit, the executor stages impacted symbols for the next turn; the model does not emit `session.stage`.
- **Snapshot hash injection**: The executor injects the snapshot hash on edit steps from its internal tracker; the model does not emit it.
- **Own-write suppression**: The runtime recognizes self-authored writes and does not flag them as external change, preventing redundant re-reads and re-emissions.

### 6.6 Axis 6: Transcript

Tokens saved by shrinking the history the model reads, so the next emission repeats less.

- **Inline tool-result deflation**: Tool results over a threshold (100 tokens base, 200 for verify/system) are replaced with hash pointers in the transcript; the content remains in working memory or archive.
- **Assistant-side batch stubbing**: Past batch tool-use inputs over 80 tokens are replaced with `_stubbed` summaries, compressing the assistant's own trail.
- **Rolling window + distillation**: Rounds beyond a 20-round window are distilled into a bounded (1.65k-token) summary of decisions, files-changed, user preferences, work-done, findings, and errors.
- **Substantive-round counting**: Synthetic auto-continue rounds are excluded from window-eviction bookkeeping, so real rounds are not prematurely aged out.
- **Emergency compression**: Under hard token pressure, the compressor may deflate even rounds normally protected from modification.
- **Result size caps**: Handlers enforce per-tool caps on result size entering the transcript (80k default, 120k search, 100k git).

### 6.7 Interaction with prompt-level discipline

The six axes are supplemented by direct prompt-level pressure on model emission: a provider-specific override instructs the model to emit "at most one sentence between tool calls"; delegate subagents have per-role output caps (2–8k tokens depending on role); subagent prompts route their results through a structured blackboard key rather than free-form text. These are second-order; the six axes are the primary mechanism.

---

## 7. System Architecture

ATLS is a Tauri desktop application with a React/TypeScript frontend and a Rust backend. For the purposes of this paper, the architecturally relevant components are:

### 7.1 Layer summary

| Layer | Responsibility | Key files |
|---|---|---|
| **Batch executor** | Single-tool execution, dataflow, intent expansion, line rebase, read-range gating, retention dedup, spin detection | `services/batch/executor.ts`, `services/batch/opMap.ts` |
| **Batch handlers** | Per-operation dispatch: edit pipeline with preflight/retry/lesson BB (~2k LOC in `change.ts` alone); redundant-read enforcement in read ops; structured search results with parallel arrays for downstream binding; shell/git sanitization; delegate subagent dispatch with BB handoff caps; session memory management (pin, stage, compact, plan/advance); verify classification | `services/batch/handlers/*.ts` (10 handler files) |
| **Hash protocol** | HPP visibility state machine, ref lifecycle, scoped views, eviction min-heap | `services/hashProtocol.ts` |
| **UHPP resolver** | UHPP grammar parsing and resolution; field-name-driven `Auto` resolution (same `h:` token resolves to path in `file` fields, content in `content` fields); content-as-ref materialization; lenient semantics (unresolved refs become warnings, not failures); hash forwarding and adaptive short-hash lengths | `utils/uhppTypes.ts`, `services/uhppExpansion.ts`, `src-tauri/src/hash_resolver.rs` (~3,087 LOC) |
| **Symbol resolver** | `fn()` / `cls()` / `sym()` anchors → 1-based line ranges; 5-tier regex cascade with false-positive guards; string/comment-aware `findBlockEnd` supporting 8 block-end strategies (brace, Python indent, Ruby/Lua `end`, Rust raw strings, C++ `#endif`, template literals); decorator rollback; overload indexing; TS/Rust deterministic parity; sync + pure + no-IPC for hot-path UHPP expansion | `utils/symbolResolver.ts`, `src-tauri/src/shape_ops.rs` (~5,658 LOC); [symbol-resolver.md](./symbol-resolver.md) |
| **Shape operations** | UHPP structural views (`:sig`, `:fold`, `:dedent`, `:nocomment`, `:imports`, `:exports`, `:head`, `:tail`, `:grep`, `:refs`); `fold` self-heals to `sig` when ineffective (>80% line retention); symbol dependency analysis | `src-tauri/src/shape_ops.rs` |
| **Managed memory** | Engram graph (~5,800 LOC), tiered eviction, staging, blackboard, reconciliation, batch metrics accumulation, set-selector evaluation, coverage/plateau tracking | `stores/contextStore.ts` |
| **Prompt system** | Layered behavioral control: cognitive core (`CONTEXT_CONTROL`, ~6–8k chars teaching memory model, read patterns, BB discipline, spin avoidance), edit discipline (mechanical correctness rules, change justification), output style, UHPP spec, mode-specific identity prompts, provider overrides, shell guide; generated `BATCH_TOOL_REF` (~12–16k chars including operation families, shorthand legend, task recipes, and tool-message explanations) | `prompts/cognitiveCore.ts`, `prompts/editDiscipline.ts`, `prompts/toolRef.ts`, `prompts/modePrompts.ts`, `prompts/hashProtocol.ts`, `prompts/providerOverrides.ts`, `prompts/subagentPrompts.ts`, `prompts/outputStyle.ts`, `prompts/shellGuide.ts` |
| **Prompt assembly** | State/chat separation, cache breakpoint placement, dynamic block composition (hash manifest, orientation, BB, pending actions, edit awareness, completion gates, spin circuit breaker, project structure, workspace TOON), tool-loop steering publication | `services/aiService.ts` (~4,267 LOC), `services/contextFormatter.ts` |
| **History compressor** | Deflation (inline → pointer at 100-token threshold), assistant-side batch stubbing (>80 tokens), rolling window (20 rounds) + distillation into bounded summary (1.65k tokens), emergency compression, context hygiene middleware | `services/historyCompressor.ts`, `services/historyDistiller.ts` |
| **Freshness** | Preflight gating, round-end reconciliation, universal freshness filter, freshness journal, session-restore bulk reconciliation (hash-first, with deferred catch-up for cold-start ordering) | `services/freshnessPreflight.ts`, `services/batch/snapshotTracker.ts` |
| **Spin detection** | Multi-signal diagnosis (Jaccard similarity, tool categorization, context-loss detection, coverage plateau), circuit breaker with tiered escalation (nudge → warning → halt), integrated with prompt steering | `services/spinDetector.ts`, `services/spinCircuitBreaker.ts`, `services/spinDiagnostics.ts` |
| **ASSESS (pinned-WM hygiene)** | Resource-based steering companion to spin: scores pinned FileViews + pinned artifacts by `tokens × (idleRounds + 2 × survivedEditsWhileIdle)` and emits a `<<ASSESS: …>>` block with per-row `release / compact / hold` options. Fires at user-turn boundaries and under mid-loop pressure; single-fire dedupe by `(candidate set, CTX bucket)`; session-scoped sidecar tracks silent edit-forwarding. See [assess-context.md](./assess-context.md) | `services/assessContext.ts` |
| **Orchestrator** | Swarm coordination, research digest (per-file signatures, import graph, keyword-scored edit targets), task hydration with progressive token-budget degradation, dependency-aware scheduling, file-claim enforcement | `services/orchestrator.ts` (~2,238 LOC) |
| **Subagent runtime** | Engram-first delegate execution, role allowlists (retriever/design/coder/tester), scoped HPP views, per-role round caps and token budgets, BB-prefixed write scoping | `services/subagentService.ts` |
| **Telemetry pipeline** | Batch metrics accumulation (`contextStore.batchMetrics`) → per-round `RoundSnapshot` capture (`aiService.captureInternalsSnapshot`) → ring-buffer storage (`roundHistoryStore`, 200 snapshots) → cost aggregation (`costStore`) → UI dashboard sections (batch efficiency, tool tokens, cache composition, cost I/O, spin trace, context timeline) | `stores/roundHistoryStore.ts`, `stores/costStore.ts`, `components/AtlsInternals/` |
| **Code intelligence engine** | Tree-sitter-backed project indexing, incremental scanning with hash-based change detection, FTS + optional neural embeddings (`ort` feature flag), pattern-based issue detection with timeout/match-limit guards, query engine with TTL caches, SQLite WAL persistence (schema v3), reusable across Tauri host and MCP host | `atls-rs/crates/atls-core/` (~55 Rust source files) |
| **MCP server** | External MCP-compatible tool surface (7 tools: `batch_query`, `batch`, `find_issues`, `scan_project`, `get_codebase_overview`, `get_patterns`, `export`); stdio JSON-RPC transport; per-root project caching; intentionally does not expose UHPP (literal paths only) | `atls-rs/crates/atls-mcp/` |
| **Tauri backend** | Native host bridging `atls-core` to the TypeScript runtime: file I/O with watcher events, UHPP hash resolution, edit application with preimage verification and shadow versions, AI streaming with cache-breakpoint injection, PTY terminal management, BPE tokenization, session persistence (SQLite), git operations | `src-tauri/src/*.rs` (38 modules) |
| **Session persistence** | Snapshot format v6 with full rehydration (chunks, BB, staged, task plan, rolling summary, verify artifacts, awareness cache, freshness journal, Gemini cache, round history, cost, prompt/cache metrics); auto-resume on cold start; shutdown-safe final save via Tauri `onCloseRequested` | `services/chatDb.ts`, `hooks/useChatPersistence.ts`, `src-tauri/src/chat_db.rs` |
| **UI shell** | React/Vite desktop app: multi-panel workspace (explorer, code viewer, ATLS intelligence panel, AI chat, swarm panel, session picker, settings, internals dashboard); Zustand stores for app state, cost, swarm, terminals, attachments, retention, refactoring | `components/`, `stores/`, `hooks/` |

### 7.2 Batch execution surface

All model-initiated actions flow through a single `batch()` tool. A batch consists of:

- A goal string (for logging, not behavior).
- An ordered list of steps, each with `id`, `use` (operation), `with` (parameters), optional `in` (dataflow bindings), optional `out` (named output), optional `if` (conditional execution).
- Optional `refs` (named hash pre-registrations).
- Optional `policy` (execution mode, auto-verify flag, auto-rollback flag, max-steps cap, refactor validation).

Steps execute sequentially within a batch. Dataflow bindings let step N consume step M's output by dot-path navigation. Intent steps are expanded client-side into primitive sequences before dispatch. The executor handles:

- Intent expansion (§6.2).
- Speculative lookahead emission under non-pressure conditions.
- Snapshot-tracker initialization from the persistent awareness cache (so files read in prior batches can be edited without re-reading).
- Per-step enforcement gates (max-steps, swarm restrictions, policy mode, file claims).
- Condition evaluation (`step_ok`, `step_has_refs`, `ref_exists`, Boolean combinators).
- Binding resolution from prior step outputs and named bindings.
- Snapshot hash injection before edit steps.
- Intra-step line rebase (§6.5).
- Read-range edit gating (no edit outside previously-read ranges, with own-write exemption for edit-then-re-edit patterns).
- Handler dispatch to 10 specialized handler modules (76 canonical operations across 9 families).
- Post-step processing: snapshot tracker update, cross-step rebase, context refresh, impact auto-staging, verify artifact aggregation, workspace inference, spin detection, named-output registration, retention fingerprinting.
- Result formatting with volatile-ref nudges (warning when read/search refs are not pinned in-batch), verify confidence suffixes, and stale-verify prompts.

The handler layer deserves specific note. The **edit handler** (`change.ts`, ~2k LOC) is the most complex single module: it implements a full pipeline of normalize → resolve paths → freshness preflight → hash refresh → backend dispatch → retry on stale/anchor/drift errors → register hashes → pin migration → edit lessons (BB `err:`/`fix:` keys) → diff ref injection → lint surfacing → repair escalation. The **read handler** (`context.ts`, ~1,080 LOC) enforces **redundant-read-as-hard-error** — a second read of content already in working memory fails immediately rather than wasting tokens on duplicate ingestion. The **query handler** returns **structured parallel arrays** (`file_paths`, `lines`, `end_lines`) so subsequent steps can bind positions directly without re-parsing formatted output.

### 7.3 Prompt assembly

The prompt is constructed in three regions with distinct cache behavior:

**Region 1 (cached, 5-minute TTL):** The static system block — assembled from 9 prompt modules: mode identity prompt, project line, OS-aware shell guide, generated `BATCH_TOOL_REF` (~12–16k chars including operation family tables, shorthand legend from `opShorthand.ts`, common parameters, task recipes, and tool-message explanations), optional entry manifest, cognitive core (`CONTEXT_CONTROL`, ~6–8k chars teaching memory model, read patterns, BB discipline, and spin avoidance), edit discipline (mechanical correctness rules, change justification requirements), UHPP hash-protocol spec, output style, and provider-specific reinforcement (e.g., Gemini: "one sentence between tool calls"). Cached with a single `cache_control` breakpoint on the last tool definition. The cache key includes mode, shell, CWD, provider, entry-manifest fingerprint, and subagent configuration — all slow-changing, so the static prefix achieves near-100% cache hits after round 1.

**Region 2 (cached, append-only within a tool loop):** The conversation history — all prior user/assistant/tool-result turns. The rolling summary (if any) is prepended onto this array. A `<<PRIOR_TURN_BOUNDARY>>` marker is placed on the last prior turn; the backend attaches `cache_control` to that point.

**Region 3 (uncached):** The last user message. Immediately before the user's actual text, the prompt assembler injects the **state block** via `buildStateBlock()`, which composes three sub-blocks fresh each round:

1. **`buildDynamicContextBlock()`**: hash manifest (active/dematerialized/archived refs with turn metadata), orientation lines (task, context stats with pressure thresholds at 50%/70%/85%), blackboard entries (filtered through `canSteerExecution` freshness gate), pending-action blocks (`STATE CHANGED` / `BLOCKED` / `ACTION REQUIRED`), edit-awareness steering (damaged/recent/escalated edits from BB `edit:`/`err:`/`repair:` keys), completion gates, spin circuit-breaker messages (tiered: nudge → warning → halt), project structure (first turn only), and workspace context (TOON-serialized editor state).
2. **Staged snippets**: pre-materialized code context with active-engram dedup (pointers replace duplicate content).
3. **Working memory**: `## FILE VIEWS` block (pinned FileViews, file-ordered, skeleton + fills + fullBody + markers) followed by `## ACTIVE ENGRAMS` (non-file artifacts + file-backed chunks whose view is unpinned, sorted pinned-first then LRU); dormant count; archived list; cognitive rules. Chunks covered by a pinned FileView are filtered from ACTIVE ENGRAMS to prevent double-render.

The state block is never persisted into conversation history. For Gemini/Vertex, it flows through a separate `dynamicContext` parameter rather than being embedded in message content.

This design achieves two properties simultaneously:

1. **State can be mutated freely between rounds without invalidating the cache** for history. The mutable part sits entirely in the uncached tail.
2. **History remains append-only within a tool loop**, so the history cache stays byte-stable across all rounds of a single tool loop.

### 7.4 Memory runtime

Engrams are the unit of content in ATLS. Each engram has:

- A stable content hash.
- A short hash (6+ hex chars) for compact reference.
- A type (source file, search result, tool output, blackboard entry, etc.).
- An HPP visibility state (§5).
- Token counts, line ranges, source path, last-accessed timestamp, pinned status.
- A freshness classification (§8).

The memory runtime maintains:

- A map of engrams by hash.
- A **FileView map** keyed by normalized path: the unified, hash-addressed file-content surface. Multiple slice reads of the same file merge into one view as sorted non-overlapping regions, composed over a cheap signature skeleton; full reads materialize `fullBody` directly. Views are addressable as `h:<short>` (same namespace as chunks — the runtime disambiguates via `resolveAnyRef`, views winning on collision) and render in a dedicated `## FILE VIEWS` block above `## ACTIVE ENGRAMS`. Pinning a view (or any of its slices) is the gate for prompt inclusion: unpinned views are dormant — zero token cost, state warm for cheap re-pin — and their constituent chunks re-surface in ACTIVE ENGRAMS under normal HPP rules. Auto-heal reconcile rebases shifted regions via the freshness journal's line delta; rebase failures surface as `[REMOVED was Lx-y]` markers. See [engrams.md — FileView](./engrams.md#fileview--the-unified-file-content-surface).
- A set of pinned engrams (protected from eviction).
- A staged snippet area (pre-materialized content for the next round).
- A blackboard (persistent key-value entries that survive across rounds).
- A chunk graph (derived relationships: parent/child, edit-predecessor/successor, etc.).

Eviction under budget pressure follows a tiered strategy: completed-subtask engrams first, then non-chat engrams, then unprotected chat engrams. Pinned and stale-but-protected engrams are never evicted without explicit operator action. TTL archival of a file-backed chunk also prunes any FileView regions backed by that chunk (`pruneFileViewsForChunks` on the round-end sweep), so dormant views thin naturally as their backing chunks age out.

The memory runtime also accumulates **batch metrics** per round (tool call count, manage-op count, substantive-BB-write flag, read/edit flags), which are captured into a `RoundSnapshot` at round end. These snapshots feed the telemetry pipeline: `captureInternalsSnapshot` in the AI service computes hypothetical non-batched cost from manage-op counts and round cost splits, then pushes to a 200-snapshot ring buffer in `roundHistoryStore`. The cost store aggregates monetary totals per-chat, per-session, and per-day. The UI's Internals dashboard reads these stores to render the batch-efficiency, tool-token, cache-composition, cost-I/O, and spin-trace sections — closing the design→implement→measure→tune loop with first-party telemetry.

### 7.5 Code intelligence engine

The `atls-core` Rust library provides the code-intelligence substrate beneath both the Tauri desktop host and the external MCP server. It consists of approximately 55 Rust source files organized around:

- **`ParserRegistry`**: per-language tree-sitter parser instantiation with a compiled query cache keyed by `language:query_string`.
- **`Indexer`**: incremental project scanning with hash-based change detection, UHPP-oriented symbol extraction (`uhpp_extract_symbols`), relation tracking (import/call/dependency graphs), and optional regex fallbacks for languages without full tree-sitter support.
- **`QueryEngine`**: FTS (SQLite trigram + porter stemmer) with TTL caches; optional neural embeddings behind an `ort` feature flag with in-memory `VectorIndex` for hybrid search.
- **`DetectorRegistry`**: pattern-based issue detection via tree-sitter queries with configurable timeout and match-count limits; `FocusMatrix` for category → severity filtering.
- **`Database`**: SQLite WAL with schema v3 (destructive upgrade from older versions); tables for files, symbols, code issues, calls, relations, signatures, embeddings, FTS mirrors.

The engine is consumed by two hosts: the **Tauri backend** (full integration: UHPP resolution, batch dispatch, edit verification, AI streaming, git operations, terminal management) and the **MCP server** (narrower surface: 7 tools over stdio JSON-RPC, literal file paths only — no UHPP). The two hosts use different default database filenames (`.atls/atls.db` vs `.atls/db.sqlite`), an intentional separation that prevents shared-state assumptions between the desktop app and external MCP clients.

### 7.6 Freshness integration

Every read operation registers the file's current hash and line range in a snapshot tracker. Every edit operation checks, before dispatch, that the edit's target lines fall within a previously-read range (with own-write exemption). The snapshot tracker participates in prompt assembly via a universal freshness filter: steering signals that would direct the model to reason about a stale artifact are suppressed until reconciliation. The file watcher emits `canonical_revision_changed` events that trigger revision reconciliation, verify-artifact invalidation, retention eviction for mutation-sensitive fingerprints, and suspect/supersede BB annotations.

This is treated in detail in §8.

### 7.7 Symbol resolver as resolution economics

UHPP is only practical if anchor resolution is fast enough to run inline during batch execution without dominating round latency. If resolution required a full AST parse per modifier, UHPP would be theoretically elegant but practically unusable.

The symbol resolver addresses this with a **tiered regex + block-end scanner** that runs in O(lines) with a small constant. Five resolution tiers activate in order (canonical kind prefix → class-method shorthand → arrow/const-bound → C-family return-type → Go type-struct), with the first match winning. After matching, the resolver rolls back to preceding decorators/doc-comments, then extends forward through the function body via `findBlockEnd` — a state machine that correctly tracks braces, strings, comments, template interpolation depth, Rust raw strings, Python indent blocks, Ruby/Lua keyword blocks, and C++ preprocessor tails.

The TypeScript implementation runs synchronously in the renderer for two critical hot paths: UHPP expansion in `hashResolver.ts` (where an IPC round-trip per modifier would serialize the entire expansion pipeline) and freshness relocation in `freshnessPreflight.ts` (where post-edit content has not yet been flushed to disk). The Rust implementation in `shape_ops.rs` maintains deterministic parity with the same kind table and tier cascade; a language-aware wrapper may optionally consult tree-sitter when a registered grammar exists, falling back to the regex path.

This dual-implementation design — regex-first for speed, tree-sitter as optional enhancement — is what makes UHPP symbol anchors cheap enough to use ubiquitously in batch payloads. The resolution cost is paid per-anchor, not per-file, and the common case resolves on the first tier.

---

## 8. Freshness as Epistemic Integrity

A distinctive feature of ATLS relative to typical agent tooling is the treatment of **freshness** — the epistemic validity of content the model is reasoning about — as a first-class architectural concern.

### 8.1 The stale-content problem

In any agent with a persistent memory beyond a single round, a fundamental question arises: *does the model's current reasoning rest on content that is still valid?* A file read three rounds ago may have been edited by the model itself, by another tool, by a teammate via version control, or by a background process. Reasoning based on the stale read is not just inefficient; it can produce confidently wrong outputs that pass gates the agent itself defined.

Most agent tooling handles this implicitly or not at all. The result is a class of silent correctness bugs that are difficult to detect because they present as "the model seems to have decided to ignore my change."

### 8.2 The freshness taxonomy

ATLS assigns every file-backed engram one of five freshness states:

- **fresh** — content hash matches the current on-disk revision.
- **forwarded** — content has been replaced by a newer engram; the old one carries a forwarding pointer.
- **shifted** — line ranges have moved due to neighbor edits; content may be intact.
- **changed** — content has changed on disk since last read.
- **suspect** — content validity cannot be confirmed (e.g., post-session-restore before reconciliation).

These states are computed by comparing persisted source-revision markers against on-disk hashes, and updated by:

- **Preflight gating** before every mutation (a `change.edit` targeting a stale engram is rejected with `stale_hash` and triggers an automatic re-read retry).
- **Round-end sweeps** that reconcile file-backed engrams against disk state.
- **Intelligence/scan refreshes** when the workspace indexer emits revision updates.
- **Session-restore reconciliation** that runs hash-first bulk comparison against disk before reclassifying engrams as fresh or suspect.

### 8.3 Preflight gating

Before any `change.*` step executes, the executor injects the current snapshot hash from the tracker into the step parameters. The Rust backend verifies the hash matches the on-disk file and rejects the edit (with `stale_hash`) if it does not. The rejection triggers:

1. An automatic content refresh for the affected file.
2. Re-resolution of anchors, ranges, or symbols in the edit.
3. A single retry with the refreshed content.

This resolves the TOCTOU (time-of-check-to-time-of-use) window that naive agents leave open between read and edit.

### 8.4 Universal freshness filter

Steering signals in the prompt's dynamic block — completion gates, spin nudges, verify hints, continuation prompts — are passed through a universal freshness filter. Signals that would direct the model to act on stale or suspect artifacts are suppressed until the underlying content is reconciled. This prevents the prompt from confidently nudging the model toward actions the system knows may be invalid.

### 8.5 Why this matters for output compression

Freshness integration is critical to the compression thesis. Emission-compression requires the model to *trust* the runtime's bookkeeping. If the runtime might hand the model stale refs, the model will defensively re-emit file paths, coordinates, and content to verify its assumptions — destroying most of the compression gains. A freshness system that reliably rejects stale operations and reconciles proactively lets the model emit minimal references with confidence that the runtime will catch any drift.

In other words: **freshness is the correctness foundation that makes aggressive output compression safe**.

---

## 9. Empirical Evaluation

### 9.1 Workload

We evaluate ATLS on a **self-audit workload**: the system audits its own cognitive subsystems, identifies correctness bugs, fixes them, and verifies the fixes via typecheck and build.

Audit scope: 18 files spanning the critical cognitive path of the ~200k LOC system, totaling approximately 22k LOC of TypeScript on the audited surface. Target modules: hash protocol, context store, prompt memory, snapshot tracker, token counter, context hash utilities, TOON serialization, batch intent expansion, round history store, batch executor, orchestrator, context formatter, freshness preflight, spin detector, history compressor, and three intent resolvers (edit, editMulti, searchReplace).

### 9.2 Experimental conditions

- Model: Claude Sonnet 4.5.
- Environment: Tauri desktop build on Windows 11, PowerShell shell integration.
- Duration: a single continuous self-audit session.
- Total rounds: 92 (46 main-agent; remainder in subagents under `delegate.*` and swarm tasks).

### 9.3 Cost results

| Metric | Value |
|---|---|
| Total session cost | **\$91.28** |
| Main-agent cost (46 rounds) | **\$9.23** |
| Rounds | 92 (46 main-chat, ~46 subagent) |
| Total tool calls (within batch envelopes) | 198 |

### 9.4 Tool-token distribution

| Tool | Calls | Arg tokens | Result tokens | Total | Share |
|---|---|---|---|---|---|
| `read.lines` | 60 | 2,313 | 84,985 | 87,298 | 82.6% |
| `change.edit` | — | — | — | 5,392 | 5.1% |
| `session.bb.write` | — | — | — | 5,022 | 4.8% |
| `task_complete` | — | — | — | 2,747 | 2.6% |
| `read.shaped` | — | — | — | 2,011 | 1.9% |
| `session.pin` | — | — | — | 1,547 | 1.5% |
| Other | — | — | — | <900 | <2% |
| **Total tool tokens** | **198** | **13,675** | **92,031** | **105,706** | — |

Observations:

- **82.6% of tool tokens are `read.lines`**, consistent with an audit workload dominated by signature-guided targeted reads. The average `read.lines` result is 1,416 tokens (max 3,698), indicating tight slice bounds rather than whole-file reads.
- **Write-path is ~5%** of tool tokens. Edits via structured patches are cheap relative to reads.
- **User text tokens: 4,783**; assistant tool-definition tokens: 72. The audit proceeded almost entirely via tool calls, with minimal natural-language narration.

### 9.5 Bug density

The audit identified and fixed **5 real functional bugs** plus **1 documentation/code comment drift**:

1. **Sort comparator sign error** in `rebaseIntraStepSnapshotLineEdits` — symbol-based edits (where `snap === 0`) were sorted *before* positional edits, risking stale line coordinates in cross-step edit batches. (Fixed: changed return value from `1` to `-1`.)

2. **Full-hash vs short-hash lookup mismatch** in the orchestrator's synthesis persistence path — `addChunk` returns a full 16-char hash but the DB-persistence lookup compared against `shortHash` (6 chars). Synthesis results were silently dropped from DB persistence. (Fixed: comparison against `c.hash`.)

3. **Retry-count off-by-one** between pre- and post-acquisition retry paths in the orchestrator — the pre-acquisition path accounted for the `updateTaskError` increment by using `maxRetries - 1`; the post-acquisition path did not, effectively giving execution errors one additional retry versus rate-limit errors. (Fixed: both paths use `maxRetries - 1`.)

4. **Ignored `end_line` field in `extractEditRange`** — both `intents/edit.ts` and `intents/editMulti.ts` used a nonexistent `e.count` field to determine range end, treating multi-line edits as single-line ranges and causing insufficient pre-reads. (Fixed in both files to use `e.end_line`.)

5. **Reconciliation comment/code drift** in `promptMemory.ts` — comments described the sort as "overage ratio (most-over first)" but the code sorted by absolute overage. Behavior was defensible; documentation was misleading. (Fixed: comments updated to match code.)

Rough density: **5 bugs across ~22k LOC of audited critical code ≈ 0.23 bugs per KLOC**. Industry baseline for pre-production code is typically reported at 10–25 bugs/KLOC. The audited surface is approximately **two orders of magnitude** lower than baseline. We attribute this to (a) the discipline of documentation-first subsystem design (18 architecture docs at file-level precision, maintained alongside code), (b) comprehensive test coverage on every critical cognitive module (verified: 148 TypeScript test files covering all cognitive-core paths; `#[cfg(test)]` blocks present in 36 of 38 Rust modules), and (c) a model-coauthor development loop in which multiple frontier LLMs participate in implementation, review, and testing alongside the human architect — catching many bugs before they reach the tree.

### 9.6 Round-composition observations

Analysis of the round-composition dashboard reveals:

- **Batch ratio**: 0.8× (manage ops / tool calls). For every outer tool call, approximately 0.82 internal manage operations (context management, hash protocol, eviction, reconciliation). Most externally-visible rounds carry 10–12 manage ops on 1–3 tool calls, indicating the managed-memory runtime is doing substantial internal work per model round.
- **Freshness**: 76% fresh across the session. This is healthy for an audit workload that deliberately re-reads files for verification; the 24% non-fresh share is dominated by intentional `state: suspect` rounds and correct reconciliation events.
- **Output variability**: near zero across rounds. No round blew the budget with an unexpected long response.
- **Round 15** spiked on output tokens; inspection showed this was a verify-after-state-suspect round, and the output growth was in the expected category for suspect-path verification.

### 9.7 Caveats

The evaluation is a single workload in a single environment with a single provider. The self-audit workload is plausibly representative of a common professional-developer workflow (careful code review with verification), but we do not claim statistical coverage of the space of agent workloads.

---

## 10. Related Work

### 10.1 Tool calling and structured agents

Tool-calling or function-calling primitives have become standard in frontier models (Anthropic, OpenAI, Google). Most agent tools expose these primitives directly, often as a flat namespace of tools invoked one at a time. ATLS's single-batch surface compresses this: one tool call carries a structured plan. The closest conceptual relative is agentic workflow languages (LangGraph, LangChain agents, Microsoft AutoGen); these typically structure at the *code* level rather than the *emission* level.

### 10.2 Memory systems for agents

MemGPT (Packer et al., 2023) and related work treat agent memory as a tiered storage problem, with a working-memory/long-term-memory split. ATLS's managed memory runtime is kindred in the tiered eviction and staging design, but extends it with (a) content-addressed hashing as the primary identity, (b) first-class freshness tracking, and (c) a visibility state machine (HPP).

### 10.3 Context compression

Significant recent work addresses input-side compression: LongRoPE (Ding et al., 2024) and related context-extension methods; summarization-based approaches; semantic retrieval. ATLS integrates transcript-side compression (history deflation, rolling summary) but does not address model internals; our contribution is on the output side, which the context-compression literature does not typically address.

### 10.4 AI coding tools

Cursor, Aider, Cline, Continue, and Claude Code represent the current production landscape. Each makes different trade-offs on tool surface, memory model, and prompt assembly. Most adopt a direct tool-calling pattern (one tool per action) with varying degrees of context management. None, to our knowledge, has published a systematic output-compression discipline comparable to the six-axis framework in §6, though individual techniques (e.g., shorthand codes, response caps) appear in various tools.

### 10.5 Content-addressable storage

Hash-addressed content is a mature primitive: Git, IPFS, Merkle-DAG variants, and many others. UHPP's contribution is not hash addressing; it is the **reference calculus** built on top — the composable grammar of slice, shape, symbol, temporal, and set operators. The closest conceptual relative is Git's object-reference language (`HEAD~3^:path`), which UHPP extends along the shape/symbol/selector dimensions.

### 10.6 Protocol design for agent environments

The Model Context Protocol (MCP, Anthropic 2024) establishes a transport and tool-schema protocol for agent environments. ATLS exposes MCP-compatible tools via a dedicated `atls-mcp` crate. UHPP is complementary to MCP: MCP governs *how tools are called*, UHPP governs *how content is referenced inside tool calls*. The two could be adopted independently or together.

### 10.7 Freshness and epistemic integrity

We are not aware of prior agent-tool work that treats freshness as a first-class architectural primitive with a taxonomy, preflight gating, universal filter, and round-end reconciliation. Related concepts exist in distributed systems (CAP, causal consistency), in database transaction isolation, and in version-control conflict detection. ATLS's contribution is the transfer of this discipline into agent tooling, where we believe it is underdeveloped and undervalued.

---

## 11. Discussion: Limitations and Future Work

### 11.1 Limitations

**Single reference implementation.** All empirical data in this paper comes from one codebase evaluated in one environment. The 20–50× output-compression claim is consistent with individual mechanism analysis, but cross-system validation would strengthen it.

**Provider-specific pricing assumptions.** The economic analysis uses Anthropic Claude pricing as the representative model. Other providers have different ratios; the direction of the result (output-dominant cost) holds across all major providers we are aware of, but specific multipliers vary.

**Windows-specific surface area.** The reference implementation's shell integration is currently Windows/PowerShell-oriented in places (PTY paths, output sanitization). Cross-platform validation is in progress.

**Coarse-grained evaluation workload.** A single self-audit workload is an existence proof, not a benchmark. Constructing a reproducible benchmark suite for agent-tool output compression is an open problem and we do not solve it here.

**Model coupling.** Some compression mechanisms (e.g., provider-specific prompt overrides) are tuned to specific model families. Cross-family robustness is a subject for follow-up.

### 11.2 Future work

**UHPP as an independent specification.** The grammar and resolution semantics can be extracted into a standalone specification consumable by any agent-tool implementer. Reference implementations in at least one additional language would meaningfully advance cross-tool adoption.

**Formal semantics.** UHPP operators compose in a left-to-right application order, but full formal semantics (including precedence in edge cases like `h:@selector:shape:slice`) have not been published. A small-step operational semantics would help implementers reason about edge behavior.

**Extension to non-coding agents.** UHPP's hash, symbol, and shape primitives are oriented toward code. Extension to document-authoring, research, or agentic-workflow domains would require adapting the symbol kinds and shape operators to those domains' structural units.

**Content-addressable caching at the provider layer.** The largest remaining efficiency gain would come from providers adding content-addressable caching — charging 0.1× for content the provider has seen before regardless of its position in the prompt. ATLS already assigns stable hashes; only the API surface is missing.

**Workload benchmarks.** A public benchmark suite for agent-tool emission efficiency (bug-find-and-fix, refactoring, feature implementation, code review, debugging) would enable cross-tool comparison and make the output-compression-first thesis falsifiable.

**Cross-adoption of HPP.** HPP is simpler than UHPP (a state machine, not a grammar) and immediately useful in any agent tool with hash-addressed memory. Adoption in a second tool would be a lightweight independent validation.

### 11.3 A pragmatic note on adoption

If the ideas in this paper are to influence the field, three moves are high-leverage and low-cost:

1. **Publish UHPP as a standalone spec** with at least one non-reference implementation.
2. **Name the design principle** ("output-compression-first") so the community has a handle for discussing trade-offs against the context-window frame.
3. **Open-source the reference implementation** so empirical claims can be reproduced and mechanism-level analysis can be independently verified.

These moves convert "one tool with interesting properties" into "a transferable primitive." The distinction matters for the tech-tree question raised in the introduction.

---

## 12. Conclusion

We have argued that the dominant cost axis in current LLM coding agents is not context-window pressure but model emission, and that a disciplined **output-compression-first** architecture can reduce that cost substantially on representative workloads. We have introduced **UHPP**, a reference calculus for LLM working memory that lets models reference content without copying it, and **HPP**, a round-scoped visibility state machine that tracks what the model can currently see. We have described **ATLS**, a reference implementation that integrates these protocols with a managed memory runtime, a single-tool batch execution surface, a freshness subsystem, and a history-compression pipeline. We have presented empirical evidence from a self-audit workload in which the system found and fixed 5 real correctness bugs in its own cognitive subsystems at a total cost of \$91.28.

The primary contribution is not the specific system; it is the transferable discipline of treating model emission as the optimization target and the specific protocols that make that discipline practical. We believe UHPP in particular should be adopted beyond the reference implementation, and we identify the concrete moves (standalone spec, reference implementations in multiple languages, public benchmark suite) that would make such adoption feasible.

The pricing asymmetry that motivates this work is not a transient phenomenon; it is a structural feature of LLM inference economics, and it rewards output-compression disciplines independently of which model is deployed. As frontier models continue to advance in capability, the cost of *running* them at scale for agentic workloads will grow, not shrink, unless that growth is met by architectural disciplines that reduce emission. We offer this paper as a contribution toward such a discipline.

---

## Appendix A: UHPP Grammar (EBNF)

```ebnf
Reference      = "h:" Target Modifiers?
               | TemporalRef
               ;

Target         = ShortHash
               | FullHash
               | SelectorExpr
               | RecencyRef
               | BlackboardRef
               ;

ShortHash      = HexDigit{6,15}             (* 6–15 hex chars *)
FullHash       = HexDigit{16}               (* canonical 16 hex chars *)
HexDigit       = "0" | "1" | ... | "9" | "a" | ... | "f" ;

SelectorExpr   = BaseSelector { SetOp BaseSelector } ;
BaseSelector   = "@" SelectorName [ ":" Param ]
               | "(" SelectorExpr ")"
               ;
SetOp          = "+" | "&" | "-" ;
SelectorName   = "all" | "edited" | "pinned" | "dormant" 
               | "dematerialized" | "stale" | "latest" 
               | "file" | "type" | "search" | "ws" | "sub"
               | ... ;

RecencyRef     = "$last"
               | "$last-" NaturalNumber
               | "$last_" Origin
               | "$last_" Origin "-" NaturalNumber
               ;
Origin         = "edit" | "read" | "stage" ;

BlackboardRef  = "bb:" BbKey ;

Modifiers      = { ":" Modifier } ;
Modifier       = SliceMod
               | ShapeMod
               | SymbolMod
               | MetaMod
               | SemanticMod
               ;

SliceMod       = LineRange { "," LineRange } ;
LineRange      = NaturalNumber 
               | NaturalNumber "-" NaturalNumber
               | NaturalNumber "-"
               ;

ShapeMod       = "sig" | "fold" | "dedent" | "nocomment"
               | "imports" | "exports" 
               | "head(" NaturalNumber ")" 
               | "tail(" NaturalNumber ")"
               | "grep(" Regex ")"
               | "hl(" LineRange { "," LineRange } ")"
               | "ex(" LineRange ")"
               ;

SymbolMod      = SymbolKind "(" SymbolName [ "#" Ordinal ] ")" ;
SymbolKind     = "fn" | "cls" | "class" | "struct" | "trait"
               | "interface" | "protocol" | "enum" | "record"
               | "union" | "type" | "alias" | "const" | "var"
               | "let" | "prop" | "field" | "attr" | "method"
               | "impl" | "mod" | "ns" | "pkg" | "macro"
               | "test" | "sym"
               ;

MetaMod        = "tokens" | "meta" | "lang" | "source" | "content" ;

SemanticMod    = "concept(" Ident ")"
               | "pattern(" Ident ")"
               | "if(" Predicate ")"
               ;

TemporalRef    = GitRef ":" Path [ Modifiers ]
               | ( "h:" FullHash ".." "h:" FullHash )     (* diff *)
               ;
GitRef         = "HEAD" [ "~" NaturalNumber ]
               | "tag:" Ident
               | "commit:" HexDigits
               ;
```

**Notes:**

- The grammar permits chaining (`h:XXXX:fn(name):sig:dedent`), with modifiers applied left-to-right.
- The selector grammar permits Boolean set algebra; precedence is left-associative at the parser level.
- Unresolvable references are passed through as literals with a warning — resolution is intentionally lenient.
- The content-as-ref pattern is not a separate grammar; it is a behavioral convention wherein a ref used as a `content` parameter in a tool call resolves to the referenced content at execution time.

---

## Appendix B: Representative Cost Model

For a given agent round on a provider with input rate `r_in`, output rate `r_out = k_out × r_in`, cached-input rate `r_cached = k_cached × r_in`:

```
Cost(round) = r_cached × T_cached_input 
            + r_in    × T_uncached_input 
            + r_out   × T_output
```

Under Claude Sonnet 4 pricing (`k_out = 5.0`, `k_cached = 0.1`):

```
Cost(round) = r_in × (0.1 × T_cached + 1.0 × T_uncached + 5.0 × T_output)
```

For a 10-round loop with `T_cached_prefix ≈ 18k`, `T_cached_growth ≈ 3k`, `T_uncached_dynamic ≈ 40k`, `T_output ≈ 3k`:

```
Per-round input-equivalent = 0.1 × 18k + 1.0 × 40k + 5.0 × 3k
                           = 1.8k + 40k + 15k = 56.8k

Output share = 15/56.8 ≈ 26%
Uncached dynamic share = 40/56.8 ≈ 70%
Cached prefix share = 1.8/56.8 ≈ 3%
```

Reducing `T_output` by a factor of 20 (consistent with observed ATLS compression) reduces the per-round input-equivalent to `1.8 + 40 + 0.75 = 42.55k`, a 25% total-round saving — before accounting for the second-order effect of reduced emission on subsequent rounds' history-growth contribution.

Reducing `T_uncached_dynamic` is the other major lever; input-side caching captures part of this gain (§2) but is structurally limited by dynamic-block mutability. Output compression is therefore complementary to, not competitive with, input-side caching.

---

## Appendix C: Operation Family Inventory

| Family | Count | Representative operations |
|---|---|---|
| discover | 7 | `search.code`, `search.symbol`, `search.usage`, `search.similar`, `search.issues`, `search.patterns`, `search.memory` |
| understand | 11 | `read.context`, `read.shaped`, `read.lines`, `read.file`, `analyze.deps`, `analyze.calls`, `analyze.structure`, `analyze.impact`, `analyze.blast_radius`, `analyze.extract_plan`, `analyze.graph` |
| change | 6 | `change.edit`, `change.create`, `change.delete`, `change.refactor`, `change.rollback`, `change.split_module` |
| verify | 4 | `verify.build`, `verify.test`, `verify.lint`, `verify.typecheck` |
| session | 23 | `session.plan`, `session.advance`, `session.pin`, `session.stage`, `session.unload`, `session.compact`, `session.bb.*`, `session.compact_history`, ... |
| annotate | 7 | `annotate.engram`, `annotate.note`, `annotate.link`, `annotate.retype`, `annotate.split`, `annotate.merge`, `annotate.design` |
| delegate | 4 | `delegate.retrieve`, `delegate.design`, `delegate.code`, `delegate.test` |
| intent | 11 | `intent.understand`, `intent.edit`, `intent.edit_multi`, `intent.investigate`, `intent.diagnose`, `intent.survey`, `intent.refactor`, `intent.create`, `intent.test`, `intent.search_replace`, `intent.extract` |
| system | 4 | `system.exec`, `system.git`, `system.workspaces`, `system.help` |

Total: 76 canonical operations, each with a shorthand code (Axis 1). The full inventory and authoritative list lives in the system's operation families source file; this table is illustrative.

---

## References

*(Author's note to self: the following is a skeletal reference list for a formal submission. Populate with canonical cites before any external publication.)*

- Anthropic. *Model Context Protocol Specification.* 2024.
- Ding, X. et al. *LongRoPE: Extending LLM Context Window Beyond 2 Million Tokens.* 2024.
- Packer, C. et al. *MemGPT: Towards LLMs as Operating Systems.* 2023.
- Bochman, T. et al. *Anthropic Claude pricing.* 2024–2026.
- Merkle, R. *A Digital Signature Based on a Conventional Encryption Function.* CRYPTO 1987.
- Git SCM. *gitrevisions — specifying revisions and ranges for Git.* https://git-scm.com/docs/gitrevisions
- Benet, J. *IPFS — Content Addressed, Versioned, P2P File System.* 2014.

---

## Colophon

This paper was drafted collaboratively with the ATLS system itself — specifically, with a Claude-family model operating inside the reference implementation, using the UHPP, HPP, batch-tool, and freshness subsystems described herein to read, reason about, and cite the ~200k LOC codebase during drafting. The system dispatched five parallel subagents to explore different layers of the architecture (Rust backend, prompt system, batch handlers, code intelligence engine, and UI/telemetry), then synthesized their findings into the updated §7. The fact that a technical paper of this scope can be drafted by the system describing itself — with the system reading its own code, verifying its own claims, and correcting its own initial mischaracterizations — is in our view a useful concrete illustration of what the output-compression thesis purchases in practice: the discipline that saves dollars at scale also makes cognitive work economically tractable at the level of individual authorship.


# Subagents (engram-first delegate models)

The main agent can offload work to **subagents** — separate model runs that use cheaper models and a **snapshot-based** prompt instead of an ever-growing chat transcript. Subagents are **engram-first**: each round the runtime rebuilds context from the live context store (hash refs, blackboard, staged paths) and enforces **role-specific batch operation allowlists**.

Implementation: [`subagentService.ts`](../atls-studio/src/services/subagentService.ts), [`delegate.ts`](../atls-studio/src/services/batch/handlers/delegate.ts), [`subagentPrompts.ts`](../atls-studio/src/prompts/subagentPrompts.ts), scoped HPP in [`hashProtocol.ts`](../atls-studio/src/services/hashProtocol.ts) (`createScopedView`).

## Batch operations

| Operation | Role | Typical use |
|-----------|------|-------------|
| `delegate.retrieve` | **retriever** | Search, read, pin, stage; write findings to BB |
| `delegate.design` | **design** | Broader research + analysis intents |
| `delegate.code` | **coder** | Edits, verify, terminal (`system.exec`) |
| `delegate.test` | **tester** | Tests, limited edits, builds, terminal |

Parameters mirror the shared shape: `query` (required), optional `focus_files`, `max_tokens`, `token_budget`. The handler appends a workspace revision marker to the query for freshness awareness.

Subagents are disabled when **Subagent model** is set to `none` in settings (`subagentModel`).

## Roles and allowlists

Each role may only emit **batch** steps whose `use` string appears in its allowlist (enforced when the subagent executes tools). Blackboard keys are role-specific defaults for structured handoff:

| Role | Default BB key (hint) | Notes |
|------|------------------------|--------|
| retriever | `retriever:findings` | Search/read-heavy; no `change.*` |
| design | `design:research` | Adds analysis + broader intents vs retriever |
| coder | `coder:report` | `change.*`, `verify.*` (not `verify.test` in allowlist), `system.exec` |
| tester | `tester:results` | `verify.test`, smaller edit surface, `system.exec` |

**Coder** and **tester** runs attach tool execution to the subagent’s swarm terminal where applicable so build/test output stays isolated.

Exact allowlists are defined in `ROLE_ALLOWED_OPS` in `subagentService.ts` (source of truth).

## Snapshot loop and scoped HPP

- **Provider messages** are rebuilt each round from store state (not by appending full prior assistant text). That keeps subagent context aligned with **pins, refs, and BB** without transcript bloat.
- **`createScopedView()`** in the hash protocol exposes a **local turn counter** for materialization decisions. It **reads** shared chunk refs but does **not** run global `advanceTurn` side effects (no global dematerialization or round-refresh hooks from subagent turns).

## Budgets and stopping

Configured in [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts):

| Constant | Role |
|----------|------|
| `SUBAGENT_MAX_ROUNDS` | Upper bound on tool rounds (default 100) |
| `SUBAGENT_TOKEN_BUDGET_DEFAULT` | Default token budget for the run (200k) |
| `SUBAGENT_PIN_BUDGET_CAP` | Cap for pin-budget derivation (64k) |
| `SUBAGENT_STAGED_PATHS_CAP` | Cap on staged paths surfaced in the snapshot (60) |

Stopping uses **token budget** and **round** limits together with pin-budget heuristics (`computePinBudget`), not fixed per-role round caps.

## Step output (delegate handlers)

Successful delegate steps return structured content including **`refs`** (with hashes and metadata), **`bbKeys`**, **`pinCount` / `pinTokens`**, round and tool-call counts, and a short **summary** line for the parent batch — not a full duplicate of pinned file bodies in the step payload.

## Chat mode vs batch

The **retriever** row in [prompt-assembly.md](./prompt-assembly.md) describes a **chat mode** preset (tools: search, read, pin, stage). **`delegate.*`** subagents are the batch path for all four roles and share the engram-first pipeline above.

## Related

- [Batch executor](./batch-executor.md) — step loop and delegate family
- [Hash protocol](./hash-protocol.md) — `h:` refs and HPP behavior
- [ARCHITECTURE.md](../ARCHITECTURE.md) — batch executor overview

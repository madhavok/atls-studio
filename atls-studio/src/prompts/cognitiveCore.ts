/**
 * Cognitive Core — hash-relational virtual memory and behavioral instructions.
 * CONTEXT_CONTROL_V4 is the main behavioral backbone for agent/reviewer/refactor modes.
 * Edit/verify discipline lives in editDiscipline.ts (injected separately).
 */

export const CONTEXT_CONTROL_V4 = `## COGNITIVE CORE V1
You operate on a workspace of **engrams** — living, hash-addressed units of knowledge. Every read, edit, search, and tool result creates or updates an engram. Use hashes aggressively for recall and discovery.

### ENGRAM LIFECYCLE
YOU control: pin, unpin, compact, drop, stage, unstage, recall, compact_history, context_debug, rule.
SYSTEM shows 70% warning in stats line (consider drop/compact). Emergency eviction only at 90%+.
**Activation states:**
- **Active** — full content, visible this turn. Pin to keep active across turns.
- **Dormant** — digest only (still editable/recallable by h:ref). Unpinned engrams go dormant next turn.
- **Archived** — recallable by hash on demand. Created by unload or task_advance.
- **Evicted** — manifest only, re-read to access. Created by drop.
Edit inherits pin: editing a pinned engram auto-pins the new hash, auto-unpins the old.
compact_history = compress old tool results to h:refs (auto-managed; call only when stats show compressible tokens outside protected window).

### COGNITIVE RULES
Write rules to shape your own reasoning. In **batch** q: lines the op is **ru** (session.rule), not the prose helper name \`rule(...)\`:
- Set: \`r1 ru key:"rust-safety" content:"Always check lifetime issues before proposing moves"\`
- Delete: \`r1 ru action:delete key:"rust-safety"\`
- List: \`r1 ru action:list\` (no \`key\`)
Prose shorthand \`rule(key:…, content:…)\` / \`rule(key:…, action:"delete")\` describes the same intent. Rules persist for the session.

### HASH RESOLUTION (UHPP)
See UHPP spec for full hash syntax, symbol kinds, shapes, selectors, and set ops.
h:XXXX:LL-LL in text — UI renders expandable code pills. NEVER paste raw code into chat; always use h:refs.
Every read/edit/search returns h:ref — use it, never repeat content.
**read.lines (rl):** on a **file / read** engram, lines are into that snapshot. On **search/symbol (sc/sy)** result hashes, lines are into the **formatted result text** (engram body); for real file lines use \`f\`+\`sl\`/\`el\` or a hash from a file read.

### TASK ROUTING
Large file (>500L) -> pin(sig) + extract_plan + cf + verify per batch. NEVER use shell for code extraction.
Cross-file symbol move -> cf(extract). Localized change -> ce.
Multi-round -> pin(sig) + persist plan to BB.
**Advance between phases:** With an active spl, advance via sa(summary:"...") to dehydrate context and commit findings. task_complete auto-closes remaining subtasks and auto-verifies.

### PIN DISCIPLINE (CRITICAL)
Tool results are fully visible for ONE round only. After that, unpinned content deflates to hash pointers — the bulk is gone from context. Pin what you need or lose it.
- **Every read batch MUST end with pi** on the refs you need. No exceptions. Unpinned = gone next round.
- **Pin sigs for planning, pin full for editing.** pin(shape:"sig") ~200tk/round; pin() for full visibility.
- **Unpin when done.** After editing a file or completing a subtask, unpin its refs. Edit inherits pin automatically.
- **Anti-loop guard:** If you find yourself reading the same file twice, STOP. You lost context because you didn't pin. Check dormant/staged first.
- **Pin budget:** Keep ≤15 pinned engrams. More than that = you're hoarding. Unpin older refs as you finish with them.
- **Recall:** Deflated content is not deleted — it's a hash pointer. Use rec(h:XXXX) to bring it back if needed.

### BB-FIRST WORKFLOW
BB survives everything — compaction, eviction, session boundaries. Use it as your anchor.

**Structured findings (required):** After examining any target (function, file, module), write exactly one:
  bb:finding:{file}:{symbol} = "clear — {one-sentence reason}" | "bug — {description at line N}" | "inconclusive — need {specific info}"
  bb:status = "Goal:X | Examined:A,B,C | Confirmed:list | Remaining:D,E"

Progress notes ("Reading X", "Now investigating Y") are NOT findings. They do not satisfy BB-first discipline.
You may not move to the next target until the current target has a finding entry.

1. **Update BB at phase transitions.** bb_write(key:"plan:current", "Goal:X|Done:A,B|Next:C,D").
2. **Read BB before re-searching.** sm greps all regions (dormant, archived, BB, staged, dropped).
3. **BB keys are stable handles.** h:bb:key usable in responses. Templates (tpl:NAME) reduce output tokens 80%.

### CONTEXT MANAGEMENT
1. Sigs are sufficient for planning. Full reads are for editing. rs(sig) is default for discovery.
2. rc type:smart|full (NOT raw). Sigs include [N lines] counts — use for size estimation.
3. Trust RECENT EDITS — h:refs from edit results are fresh. Do not re-read, re-search, or re-stage.
4. Trust RECENT READS — pinned/staged content is canonical. One full read per file per task. Re-read ONLY on stale_hash or after external mutation.
5. Action bias — per-target convergence:
  - After reading a target, write a structured BB finding before reading the next target.
  - "Same target" = same file, regardless of tool (rl, rc, rf, dr on that file are all the same target).
  - After 2 reads of the same target (any tool), you MUST: write a finding, make an edit, or call task_complete.
  - When a read is BLOCKED by spin detection, the content is already in your context. Do NOT try a different read tool. Analyze what you have.
6. compact_history: auto-managed. Manual only if stats show large compressible tokens.
7. Drop-after-distill at phase boundaries, not after every batch. unpin+drop when done. Unstage completed targets.
8. Budget: st every 5 turns. A lean 15k context > bloated 80k.

### ANTI-PATTERNS (NEVER DO THESE)
- Reading a file 3+ times without pinning or writing to BB.
- Issuing reads "to check" what you already have staged/pinned.
- Planning to pin without actually calling pi.
- Waiting for a "complete picture" before writing anything to BB.
- Re-reading after edit — the edit result h:ref IS the fresh content.
- Claiming a bug without evidence (wrong output, type error, unreachable code with impact, or logical contradiction).
- Claiming "bug —" without quoting the specific line(s) from tool output that prove the defect. Evidence lock: bug findings MUST cite verbatim h:ref lines. If tool output contradicts your hypothesis, the finding is "clear" or "inconclusive", not "bug".
- Making a change that has zero observable effect (adding unused parameters, dead imports, unreachable code paths).
- Running vb multiple times after it already passed with 0 errors — one pass is sufficient.
- Supplying line ranges from memory instead of from h:refs, search results, or prior read output. Use tool output coordinates, not guesses.

### ACTIVATION LIFECYCLE
Active (full, one round) → Deflated in history (hash pointer) → Dormant (digest ~60tk) → Archived (recall by hash) → Evicted (re-read).
Pin to keep active across rounds. BB to keep findings permanently. Everything else deflates after one round.

### CACHE LAYERS
Static prefix (5m TTL): system prompt + tool definitions. History: append-only conversation with deflated tool results (cache reads on prior turns). State block (1.0x): BB + dormant + staged + active engrams + workspace context + steering.
History is clean — no state embedded. Tool results deflate to hash pointers after one round, keeping history lean. State is assembled fresh each round in the uncached tail.

### PERSISTENT BUDGET
Stage (≤20k) + Rules (≤10k). BB is in the dynamic block (uncached, ~1-3k tokens).
70% warning in stats line. You manage retention via drop/compact_history/pin/unpin. Emergency eviction only at 90%+.

### TEMPLATE SHORTHAND
«tpl:NAME|val1|val2|...» in chat text → UI reads template from BB, fills positionally. h:refs render as pills.
Available: tpl:analysis, tpl:refactor, tpl:task, tpl:diff, tpl:issue, tpl:scope, tpl:status, tpl:complete.
h:refs as values render as pills. 80% output token savings vs prose.`;

/**
 * CONTEXT_CONTROL_V2 — slim cognitive core for agent_v2 mode.
 * Drops freshness-workaround rules that duplicate mechanical enforcement
 * (spin detection, [FRESH]/[STALE] labels, preflight gating, ie auto-retry).
 * Keeps: engram lifecycle, pin discipline, BB-first, evidence rules, task routing.
 */
export const CONTEXT_CONTROL_V2 = `## COGNITIVE CORE V2
You operate on a workspace of **engrams** — living, hash-addressed units of knowledge. Every read, edit, search, and tool result creates or updates an engram. Use hashes aggressively for recall and discovery.

### ENGRAM LIFECYCLE
YOU control: pin, unpin, compact, drop, stage, unstage, recall, compact_history, context_debug, rule.
SYSTEM shows 70% warning in stats line (consider drop/compact). Emergency eviction only at 90%+.
**Activation states:**
- **Active** — full content, visible this turn. Pin to keep active across turns.
- **Dormant** — digest only (still editable/recallable by h:ref). Unpinned engrams go dormant next turn.
- **Archived** — recallable by hash on demand. Created by unload or task_advance.
- **Evicted** — manifest only, re-read to access. Created by drop.
Edit inherits pin: editing a pinned engram auto-pins the new hash, auto-unpins the old.
compact_history = compress old tool results to h:refs (auto-managed; call only when stats show compressible tokens outside protected window).

### COGNITIVE RULES
Write rules to shape your own reasoning. In **batch** q: lines the op is **ru** (session.rule), not the prose helper name \`rule(...)\`:
- Set: \`r1 ru key:"rust-safety" content:"Always check lifetime issues before proposing moves"\`
- Delete: \`r1 ru action:delete key:"rust-safety"\`
- List: \`r1 ru action:list\` (no \`key\`)
Prose shorthand \`rule(key:…, content:…)\` / \`rule(key:…, action:"delete")\` describes the same intent. Rules persist for the session.

### HASH RESOLUTION (UHPP)
See UHPP spec for full hash syntax, symbol kinds, shapes, selectors, and set ops.
h:XXXX:LL-LL in text — UI renders expandable code pills. NEVER paste raw code into chat; always use h:refs.
Every read/edit/search returns h:ref — use it, never repeat content.
**read.lines (rl):** on a **file / read** engram, lines are into that snapshot. On **search/symbol (sc/sy)** result hashes, lines are into the **formatted result text** (engram body); for real file lines use \`f\`+\`sl\`/\`el\` or a hash from a file read.

### TASK ROUTING
Large file (>500L) -> pin(sig) + extract_plan + cf + verify per batch. NEVER use shell for code extraction.
Cross-file symbol move -> cf(extract). Localized change -> ce.
Multi-round -> pin(sig) + persist plan to BB.
**Advance between phases:** With an active spl, advance via sa(summary:"...") to dehydrate context and commit findings. task_complete auto-closes remaining subtasks and auto-verifies.

### PIN DISCIPLINE (CRITICAL)
Tool results are fully visible for ONE round only. After that, unpinned content deflates to hash pointers — the bulk is gone from context. Pin what you need or lose it.
- **Every read batch MUST end with pi** on the refs you need. No exceptions. Unpinned = gone next round.
- **Pin sigs for planning, pin full for editing.** pin(shape:"sig") ~200tk/round; pin() for full visibility.
- **Unpin when done.** After editing a file or completing a subtask, unpin its refs. Edit inherits pin automatically.
- **Pin budget:** Keep ≤15 pinned engrams. More than that = you're hoarding. Unpin older refs as you finish with them.
- **Recall:** Deflated content is not deleted — it's a hash pointer. Use rec(h:XXXX) to bring it back if needed.

### BB-FIRST WORKFLOW
BB survives everything — compaction, eviction, session boundaries. Use it as your anchor.

**Structured findings (required):** After examining any target (function, file, module), write exactly one:
  bb:finding:{file}:{symbol} = "clear — {one-sentence reason}" | "bug — {description at line N}" | "inconclusive — need {specific info}"
  bb:status = "Goal:X | Examined:A,B,C | Confirmed:list | Remaining:D,E"

Progress notes ("Reading X", "Now investigating Y") are NOT findings. They do not satisfy BB-first discipline.
You may not move to the next target until the current target has a finding entry.

1. **Update BB at phase transitions.** bb_write(key:"plan:current", "Goal:X|Done:A,B|Next:C,D").
2. **Read BB before re-searching.** sm greps all regions (dormant, archived, BB, staged, dropped).
3. **BB keys are stable handles.** h:bb:key usable in responses. Templates (tpl:NAME) reduce output tokens 80%.

### CONTEXT MANAGEMENT
1. Sigs are sufficient for planning. Full reads are for editing. rs(sig) is default for discovery.
2. rc type:smart|full (NOT raw). Sigs include [N lines] counts — use for size estimation.
3. compact_history: auto-managed. Manual only if stats show large compressible tokens.
4. Drop-after-distill at phase boundaries, not after every batch. unpin+drop when done. Unstage completed targets.
5. Budget: st every 5 turns. A lean 15k context > bloated 80k.

### ANTI-PATTERNS (NEVER DO THESE)
- Planning to pin without actually calling pi.
- Waiting for a "complete picture" before writing anything to BB.
- Claiming a bug without evidence (wrong output, type error, unreachable code with impact, or logical contradiction).
- Claiming "bug —" without quoting the specific line(s) from tool output that prove the defect. Evidence lock: bug findings MUST cite verbatim h:ref lines. If tool output contradicts your hypothesis, the finding is "clear" or "inconclusive", not "bug".
- Making a change that has zero observable effect (adding unused parameters, dead imports, unreachable code paths).
- Running vb multiple times after it already passed with 0 errors — one pass is sufficient.
- Supplying line ranges from memory instead of from h:refs, search results, or prior read output. Use tool output coordinates, not guesses.

### CACHE LAYERS
Static prefix (5m TTL): system prompt + tool definitions. History: append-only conversation with deflated tool results (cache reads on prior turns). State block (1.0x): BB + dormant + staged + active engrams + workspace context + steering.
History is clean — no state embedded. Tool results deflate to hash pointers after one round, keeping history lean. State is assembled fresh each round in the uncached tail.

### PERSISTENT BUDGET
Stage (≤20k) + Rules (≤10k). BB is in the dynamic block (uncached, ~1-3k tokens).
70% warning in stats line. You manage retention via drop/compact_history/pin/unpin. Emergency eviction only at 90%+.

### TEMPLATE SHORTHAND
«tpl:NAME|val1|val2|...» in chat text → UI reads template from BB, fills positionally. h:refs render as pills.
Available: tpl:analysis, tpl:refactor, tpl:task, tpl:diff, tpl:issue, tpl:scope, tpl:status, tpl:complete.
h:refs as values render as pills. 80% output token savings vs prose.`;

export const CONTEXT_CONTROL_DESIGNER = `## Context (Designer)
• pi(hashes:["h:XXXX",...]) — keep chunks in memory. h:XXXX from read/search results.
• bw(key, content) — persist findings. h:bb:key usable in output.
• spl / sa — structure your work.
• rc(file_paths) — load files. Returns h:ref per file.`;

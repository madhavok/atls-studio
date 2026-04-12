/**
 * Subagent prompts — unified template with role-specific cognitive cores.
 *
 * Each role gets: identity, tool syntax, execution protocol, anti-spin rules,
 * and (for coder/tester) hash-ref editing guide. ~1,000tk per role.
 */

// ---------------------------------------------------------------------------
// Shared tool syntax blocks — composed per-role
// ---------------------------------------------------------------------------

const READ_SEARCH_SYNTAX = `sc qs:term1,term2 ps?:path1,path2 limit?:N compact?:true
sy sn:name1,name2 limit?:N
su sn:name1,name2 filter?:pattern limit?:N
rc type:smart|full|sig|tree ps:path1,path2 depth?:N max_lines?:N
rs ps:path1,path2 shape:sig max_files?:N
rl hash:h:XXXX lines:L-M | f:path sl:N el:N
rf ps:path1,path2 type?:smart|full`;

const PIN_STAGE_SYNTAX = `pi hashes:h:H1,h:H2 — or in:stepId.refs
sg`;

const BB_SYNTAX = `bw key:name content:"text"
br keys:key1,key2`;

const EDIT_SYNTAX = `ce f:h:XXXX:L-M le:[{content:"new code"}]
  Hash ref = identity + line range; only content is required per le entry.
  Explicit form: f:path content_hash:h:XXXX le:[{line:N,end_line:M,content:"..."}]
  Path form: f:path:L-M le:[{content:"..."}] — trailing :L-M is split to path + range.
  action: replace (default) | insert_before | insert_after | delete | replace_body
  Response: edits_resolved:[{resolved_line,action,lines_affected}]. On failure: check suggestion field.
cc creates:[{path:p,content:c}]
cd ps:path1,path2 confirm?:true dry_run?:false`;

const VERIFY_SYNTAX = `vb|vt|vl|vk target_dir?:dir`;

const EXEC_SYNTAX = `xe cmd:"command text"`;

const ANALYZE_SYNTAX = `ad|at|ai ps:path1 filter?:pattern limit?:N`;

const INTENT_READ_SYNTAX = `iu ps:path1,path2 force?:true — reads sigs, stages, pins, analyzes deps
iv query:text ps?:path1 — search + sig-shaped reads, stages, caches to BB
srv directory:dir depth?:N — tree listing + sig-shaped reads (capped), caches to BB`;

const INTENT_EDIT_SYNTAX = `ie f:path le:[...] verify?:true force?:true — reads, edits, optionally verifies
im edits:[{f:p,le:[...]}] verify?:true — multi-file edits with shared verification`;

const INTENT_DIAG_SYNTAX = `id ps?:path1 severity?:high query?:text — discovers issues, reads context, analyzes impact
it source_file:path test_file?:path — reads source sigs + test context (read-only prep)`;

// ---------------------------------------------------------------------------
// Anti-spin rules — shared across all roles
// ---------------------------------------------------------------------------

const ANTI_SPIN_RULES = `
- **PIN IN SAME BATCH:** Every read returns VOLATILE refs that DIE after one round. Always include \`pi in:rN.refs\` in the SAME q: block as your reads. Never defer pinning to a later batch call.
- **2-read rule:** After 2 reads of the same file, you MUST write a BB finding, make an edit, or stop. Do not re-read hoping for different content.
- **Search once, act:** After completing a search, ACT on results. Do not re-search the same query.
- **BLOCKED = done:** If a read returns BLOCKED or a spin warning, you already have the content. Use what you have.
- **No tool-chaining on same file:** Do not chain rs -> rl -> rc -> rf on the same file. Pick one tool, pin, analyze, write finding.`;

// ---------------------------------------------------------------------------
// SUBAGENT_BASE — shared preamble for all roles
// ---------------------------------------------------------------------------

const SUBAGENT_BASE = `Use native batch() only. Format: STEP_ID <operation> key:val key:val (one step per line). The JSON field \`use\` must be a real operation (e.g. rc, read.shaped), not the literal "USE" from line-syntax column labels.
Arrays: comma-separated (ps:a.ts,b.ts). Quoted values: content:"const x = 1;"
Dataflow: in:stepId.path (e.g. in:r1.refs). Conditional: if:stepId.ok

**Primitives first** — use intents only when their multi-step expansion is worth the budget cost. A single intent can expand to 3-8 primitives; prefer 2-4 targeted primitives over 1 intent that reads more than you need.

## TOOL SYNTAX
{{TOOL_SYNTAX}}

## EXECUTION PROTOCOL
{{EXECUTION_PROTOCOL}}

Rules:
- Prefer targeted primitives over broad intents within your budget.
- **Pin after every read.** Every read/search batch MUST end with pi on refs you need. Unpinned results deflate to hash pointers after one round — pin or lose it.
- **Never re-read what's pinned or staged.** Check ## ENGRAMS CREATED and ## ALREADY STAGED before issuing reads.
- **BB-first:** After examining a target, write a structured finding to bw before reading the next target. "Reading X" is not a finding — write conclusions (clear/bug/inconclusive).
- **MANDATORY BB summary before stopping:** Your BB key is the primary handoff channel to the calling model. You MUST write to your BB key in your final batch before stopping. If you are stopped early by budget limits, write what you have — partial findings are better than none.
- **Budget awareness:** Check ## SUBAGENT WORKING STATE each round. Stop when pin budget is nearly full or token budget is running low.
- **Targeted reads only:** Never read "." or entire directories. Read specific files from search results. file_paths are capped at 15 per batch step.
- **No broad surveys:** Do not run srv on "." or the project root. Survey only specific subdirectories when needed.${ANTI_SPIN_RULES}{{EXTRA_RULES}}`;

export type SubagentRole = 'retriever' | 'design' | 'coder' | 'tester' | 'semantic';

export interface SubagentOpts {
  pinBudget?: number;
  focusFiles?: string;
  focusFileContext?: string;
  alreadyStaged?: string;
  bbKey?: string;
}

// ---------------------------------------------------------------------------
// Per-role tool syntax + execution protocol
// ---------------------------------------------------------------------------

function retrieverToolSyntax(): string {
  return [READ_SEARCH_SYNTAX, PIN_STAGE_SYNTAX, BB_SYNTAX, '', 'Intents (budget-heavy):', INTENT_READ_SYNTAX].join('\n');
}

function designToolSyntax(): string {
  return [READ_SEARCH_SYNTAX, PIN_STAGE_SYNTAX, BB_SYNTAX, ANALYZE_SYNTAX, '', 'Intents (budget-heavy):', INTENT_READ_SYNTAX, INTENT_DIAG_SYNTAX].join('\n');
}

function coderToolSyntax(): string {
  return [READ_SEARCH_SYNTAX, PIN_STAGE_SYNTAX, BB_SYNTAX, EDIT_SYNTAX, VERIFY_SYNTAX, EXEC_SYNTAX, '', 'Intents (budget-heavy):', INTENT_READ_SYNTAX, INTENT_EDIT_SYNTAX].join('\n');
}

function testerToolSyntax(): string {
  return [READ_SEARCH_SYNTAX, PIN_STAGE_SYNTAX, BB_SYNTAX, EDIT_SYNTAX, VERIFY_SYNTAX, EXEC_SYNTAX, '', 'Intents (budget-heavy):', INTENT_READ_SYNTAX, INTENT_DIAG_SYNTAX, INTENT_EDIT_SYNTAX].join('\n');
}

function semanticToolSyntax(): string {
  return [READ_SEARCH_SYNTAX, PIN_STAGE_SYNTAX, BB_SYNTAX, '', 'Intents (budget-heavy):', INTENT_READ_SYNTAX].join('\n');
}

const RETRIEVER_PROTOCOL = `Round 1 (search + read + pin + BB):
s1 sc qs:your_search_terms ps:relevant/dir limit:10
r1 rs ps:top_hit.ts shape:sig
p1 pi in:r1.refs
b1 bw key:"retriever:findings" content:"Found: [description]. Key refs: h:XXXX (file, Ntk). Answer: [direct answer — entry points, paths, line ranges or h: refs, resolution chain]."

Round 2 (only if round 1 was insufficient — refine and update BB):
s2 sc qs:refined_terms
r2 rs ps:new_hit.ts shape:sig
p2 pi in:r2.refs
b2 bw key:"retriever:findings" content:"Updated: [revised answer with new evidence]."

Round 3 (only if the BB still lacks a direct answer to the query): b3 bw key:"retriever:findings" content:"[Repair: same structured answer format; no meta, no placeholders.]" — add reads only if essential.

Then STOP. Do not paste a standalone essay: the BB entry is the answer. A tool-less final turn may be at most one sentence echoing the BB answer.`;

const DESIGN_PROTOCOL = `Round 1 (discover + pin + initial findings):
s1 sc qs:architecture_terms ps:relevant/dir
r1 rs ps:target1.ts,target2.ts shape:sig
p1 pi in:r1.refs
b1 bw key:"design:research" content:"Architecture: [what exists]. Dependencies: [list]. Initial assessment: [risks/gaps]."

Round 2 (analyze + refine findings):
a1 ad ps:target1.ts filter:pattern
r2 rs ps:dependency.ts shape:sig
p2 pi in:r2.refs
b2 bw key:"design:research" content:"Approach: [proposal]. Tradeoffs: [list]. Implementation steps: [1,2,3]. Impact: [files affected]."

Keep the final reply to 1-2 sentences.`;

const CODER_PROTOCOL = `Round 1 (read target + pin + initial BB):
r1 rl f:target_file.ts sl:START el:END
p1 pi in:r1.refs
b1 bw key:"coder:report" content:"Reading target. Function at lines L-M."

Round 2 (edit + verify + report):
e1 ce f:h:XXXX:L-M le:[{content:"new implementation code here"}]
v1 vb
b2 bw key:"coder:report" content:"Edited target_file.ts lines L-M. Verify: [pass/fail]. Changes: [description]."

Round 3 (only if verify failed — fix + re-verify):
e2 ce f:h:YYYY:L-M le:[{content:"fixed code"}]
v2 vb
b3 bw key:"coder:report" content:"Fix applied. Verify: [pass/fail]."`;

const TESTER_PROTOCOL = `Round 1 (read source + understand):
r1 rs ps:source_file.ts shape:sig
p1 pi in:r1.refs
b1 bw key:"tester:results" content:"Source read. Functions to test: [list]."

Round 2 (write tests + run):
c1 cc creates:[{path:"src/__tests__/target.test.ts",content:"import { fn } from '../target';\\ndescribe('fn', () => { it('handles edge case', () => { expect(fn('')).toBe(expected); }); });"}]
t1 vt
b2 bw key:"tester:results" content:"Tests written. Run: [pass/fail counts]."

Round 3 (only if tests failed — fix + re-run):
e1 ce f:src/__tests__/target.test.ts le:[{line:N,end_line:M,content:"fixed test code"}]
t2 vt
b3 bw key:"tester:results" content:"Fixed tests. Run: [pass/fail counts]."`;

const SEMANTIC_PROTOCOL = `Round 1 (search + pin + BB):
s1 sc qs:search_terms limit:10
r1 rs ps:top_hit.ts shape:sig
p1 pi in:r1.refs
g1 sg
b1 bw key:"retriever:results" content:"Found: [structured refs with h:XXXX citations]."

Reply briefly and cite h:bb:retriever:results.`;

// ---------------------------------------------------------------------------
// ROLE_CONFIG — per-role cognitive core
// ---------------------------------------------------------------------------

const ROLE_CONFIG: Record<SubagentRole, {
  identity: string;
  toolSyntax: () => string;
  executionProtocol: string;
  extraRules: string;
  hasBudgetSection: boolean;
  hasFocusSection: boolean;
  hasBbKeySection: boolean;
}> = {
  retriever: {
    identity: 'You are a code retrieval subagent. Your only job is to find relevant source code and pin it so the calling model can read it directly.',
    toolSyntax: retrieverToolSyntax,
    executionProtocol: RETRIEVER_PROTOCOL,
    extraRules: '\n- No edit, verify, git, exec, or blackboard writes except retriever:findings.',
    hasBudgetSection: true,
    hasFocusSection: true,
    hasBbKeySection: true,
  },
  design: {
    identity: 'You are a planning research subagent. Your job is to find relevant code and architecture for the planning query, pin it, and write structured findings to the blackboard.',
    toolSyntax: designToolSyntax,
    executionProtocol: DESIGN_PROTOCOL,
    extraRules: '\n- No edit, verify, git, exec, or refactor operations.\n- The main model reads h:bb:design:research, so keep that payload structured and concise.',
    hasBudgetSection: true,
    hasFocusSection: true,
    hasBbKeySection: true,
  },
  coder: {
    identity: 'You are an implementation subagent. Your job is to make code changes, verify them, and report results. You have a dedicated terminal for running commands.',
    toolSyntax: coderToolSyntax,
    executionProtocol: CODER_PROTOCOL,
    extraRules: '\n- Always verify after edits — never leave unverified changes.\n- Write coder:report before stopping.\n- Do not modify files outside your scope unless dependencies require it.',
    hasBudgetSection: true,
    hasFocusSection: true,
    hasBbKeySection: true,
  },
  tester: {
    identity: 'You are a testing subagent. Your job is to write tests, run them, and iterate on failures until they pass. You have a dedicated terminal for running commands.',
    toolSyntax: testerToolSyntax,
    executionProtocol: TESTER_PROTOCOL,
    extraRules: '\n- Focus on test quality — test edge cases, not just happy paths.\n- Write tester:results before stopping.\n- Do not modify source code — only test files.',
    hasBudgetSection: true,
    hasFocusSection: true,
    hasBbKeySection: true,
  },
  semantic: {
    identity: 'You are a code retrieval agent. Find relevant source code, pin it, stage the best lines, and write structured refs to the blackboard.',
    toolSyntax: semanticToolSyntax,
    executionProtocol: SEMANTIC_PROTOCOL,
    extraRules: '',
    hasBudgetSection: false,
    hasFocusSection: false,
    hasBbKeySection: false,
  },
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildSubagentPrompt(role: SubagentRole, opts?: SubagentOpts): string {
  const cfg = ROLE_CONFIG[role];

  const body = SUBAGENT_BASE
    .replace('{{TOOL_SYNTAX}}', cfg.toolSyntax())
    .replace('{{EXECUTION_PROTOCOL}}', cfg.executionProtocol)
    .replace('{{EXTRA_RULES}}', cfg.extraRules);

  const sections: string[] = [cfg.identity, ''];

  if (cfg.hasBudgetSection) {
    sections.push(`## TOKEN BUDGET\nYou may pin at most {{PIN_BUDGET}} tokens of code. Stay under this limit.\n`);
  }

  sections.push(body);

  if (cfg.hasBbKeySection && opts?.bbKey) {
    let findings = `\n## FINDINGS (REQUIRED)\nYou MUST write structured findings to bw key:"${opts.bbKey}" before your final round. The delegate step summary inlines blackboard text for the parent model alongside hash refs — if you do not write to BB, your work is lost. Write early and update incrementally; do not defer the BB write to the end.`;
    if (role === 'retriever') {
      findings += `\n\n**Retriever:** The BB body must directly answer the query: name entry points (functions/classes), file paths, line ranges or h: refs, and the resolution or data-flow chain. Forbidden in BB: meta-only lines ("Let me read…", "I will search…"), placeholders, or empty filler.`;
    }
    sections.push(findings);
  }

  if (cfg.hasFocusSection) {
    sections.push(`\n## FOCUS FILES\n{{FOCUS_FILES}}`);
  }

  let result = sections.join('\n');

  if (opts) {
    if (opts.pinBudget !== undefined) result = result.replace('{{PIN_BUDGET}}', String(opts.pinBudget));
    const focusContent = opts.focusFileContext || opts.focusFiles;
    if (focusContent !== undefined) result = result.replace('{{FOCUS_FILES}}', focusContent);
  }

  return result;
}

/** Pre-built template with {{PIN_BUDGET}}, {{FOCUS_FILES}} placeholders */
export const RETRIEVER_SUBAGENT_PROMPT_V2 = buildSubagentPrompt('retriever');

/** Pre-built template with {{PIN_BUDGET}}, {{FOCUS_FILES}} placeholders */
export const DESIGN_SUBAGENT_PROMPT_V2 = buildSubagentPrompt('design');

/** Static prompt used as retriever mode prompt (no template vars) */
export const SEMANTIC_SEARCH_SUBAGENT_PROMPT = buildSubagentPrompt('semantic');

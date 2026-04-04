/**
 * Subagent prompts — unified template with role-specific deltas.
 */

const SUBAGENT_BASE = `Use native batch() only.

**Prefer intents over primitives** — intents handle staging, pinning, and caching automatically.

Allowed intents (preferred):
- iu — reads sigs, stages, pins, analyzes deps
- iv — search + sig-shaped reads (not full smart per hit), stages, caches to BB
- srv — tree listing + sig-shaped reads (capped), caches to BB{{EXTRA_INTENTS}}

Allowed primitives (fallback):
- sc
- sy
- rc
- pi
- sg{{EXTRA_PRIMITIVES}}

Workflow:
1. Use iv for keyword searches.
2. Use iu for known files.
3. Use srv for directory exploration.{{EXTRA_WORKFLOW}}

Rules:
- Prefer 1-3 intent calls over 3-5 primitive calls.
- **Pin after every read.** Every read/search batch MUST end with pi on refs you need. Unpinned results deflate to hash pointers after one round — pin or lose it.
- **Never re-read what's pinned or staged.** Check ## ENGRAMS CREATED and ## ALREADY STAGED before issuing reads.
- **BB-first:** After examining a target, write a structured finding to bw before reading the next target. "Reading X" is not a finding — write conclusions (clear/bug/inconclusive).
- **Budget awareness:** Check ## SUBAGENT WORKING STATE each round. Stop when pin budget is nearly full or token budget is running low.
- **Targeted reads only:** Never read "." or entire directories. Read specific files from search results. file_paths are capped at 15 per batch step.
- **No broad surveys:** Do not run srv on "." or the project root. Survey only specific subdirectories when needed.{{EXTRA_RULES}}`;

export type SubagentRole = 'retriever' | 'design' | 'coder' | 'tester' | 'semantic';

interface SubagentOpts {
  pinBudget?: number;
  focusFiles?: string;
  alreadyStaged?: string;
  bbKey?: string;
}

const ROLE_CONFIG: Record<SubagentRole, {
  identity: string;
  extraIntents: string;
  extraPrimitives: string;
  extraWorkflow: string;
  extraRules: string;
  hasBudgetSection: boolean;
  hasFocusSection: boolean;
  hasBbKeySection: boolean;
}> = {
  retriever: {
    identity: 'You are a code retrieval subagent. Your only job is to find relevant source code and pin it so the calling model can read it directly.',
    extraIntents: '',
    extraPrimitives: '',
    extraWorkflow: '\n4. Write a structured findings summary to bw key:"retriever:findings" before stopping.\n5. Stop. Do not edit, explain, or summarize more than one sentence.',
    extraRules: '\n- No edit, verify, git, exec, or blackboard writes except retriever:findings.',
    hasBudgetSection: true,
    hasFocusSection: true,
    hasBbKeySection: true,
  },
  design: {
    identity: 'You are a planning research subagent. Your job is to find relevant code and architecture for the planning query, pin it, and write structured findings to the blackboard.',
    extraIntents: '\n- id — discovers issues, reads context, analyzes impact, caches\n- it — reads source sigs + test context, caches (read-only prep)',
    extraPrimitives: '\n- bw\n- ad\n- at\n- ai',
    extraWorkflow: '\n4. Use id for issue discovery.\n5. Write structured findings to bw key:"design:research".\n6. Keep the final reply to 1-2 sentences.',
    extraRules: '\n- No edit, verify, git, exec, or refactor operations.\n- The main model reads h:bb:design:research, so keep that payload structured and concise.',
    hasBudgetSection: true,
    hasFocusSection: true,
    hasBbKeySection: true,
  },
  coder: {
    identity: 'You are an implementation subagent. Your job is to make code changes, verify them, and report results. You have a dedicated terminal for running commands.',
    extraIntents: '\n- ie — reads, edits, optionally verifies\n- im — multi-file edits with shared verification',
    extraPrimitives: '\n- ce\n- cc\n- cd\n- cf\n- vb\n- vl\n- vk\n- xe\n- bw',
    extraWorkflow: '\n4. Read and understand files before editing.\n5. Make changes using ie or ce.\n6. Verify with vb / vl after changes.\n7. Write a report to bw key:"coder:report" with files changed, verification results, and any issues.\n8. If verification fails, iterate: read errors, fix, re-verify.',
    extraRules: '\n- Always verify after edits — never leave unverified changes.\n- Write coder:report before stopping.\n- Do not modify files outside your scope unless dependencies require it.',
    hasBudgetSection: true,
    hasFocusSection: true,
    hasBbKeySection: true,
  },
  tester: {
    identity: 'You are a testing subagent. Your job is to write tests, run them, and iterate on failures until they pass. You have a dedicated terminal for running commands.',
    extraIntents: '\n- it — reads source + test context, caches\n- ie — reads, edits, optionally verifies',
    extraPrimitives: '\n- ce\n- cc\n- vt\n- vb\n- xe\n- bw',
    extraWorkflow: '\n4. Read source code to understand what to test.\n5. Write or update test files using ce / cc.\n6. Run tests with vt.\n7. If tests fail, read errors, fix test code, re-run.\n8. Write results to bw key:"tester:results" with pass/fail counts and coverage notes.',
    extraRules: '\n- Focus on test quality — test edge cases, not just happy paths.\n- Write tester:results before stopping.\n- Do not modify source code — only test files.',
    hasBudgetSection: true,
    hasFocusSection: true,
    hasBbKeySection: true,
  },
  semantic: {
    identity: 'You are a code retrieval agent. Find relevant source code, pin it, stage the best lines, and write structured refs to the blackboard.',
    extraIntents: '',
    extraPrimitives: '\n- bw',
    extraWorkflow: '\n4. Write findings to bw key:"retriever:results".\n5. Reply briefly and cite h:bb:retriever:results.',
    extraRules: '',
    hasBudgetSection: false,
    hasFocusSection: false,
    hasBbKeySection: false,
  },
};

export function buildSubagentPrompt(role: SubagentRole, opts?: SubagentOpts): string {
  const cfg = ROLE_CONFIG[role];

  const body = SUBAGENT_BASE
    .replace('{{EXTRA_INTENTS}}', cfg.extraIntents)
    .replace('{{EXTRA_PRIMITIVES}}', cfg.extraPrimitives)
    .replace('{{EXTRA_WORKFLOW}}', cfg.extraWorkflow)
    .replace('{{EXTRA_RULES}}', cfg.extraRules);

  const sections: string[] = [cfg.identity, ''];

  if (cfg.hasBudgetSection) {
    sections.push(`## TOKEN BUDGET\nYou may pin at most {{PIN_BUDGET}} tokens of code. Stay under this limit.\n`);
  }

  sections.push(`## TOOLS\n${body}`);

  if (cfg.hasBbKeySection && opts?.bbKey) {
    sections.push(`\n## FINDINGS\nWrite your structured findings to bw key:"${opts.bbKey}" before completing.`);
  }

  if (cfg.hasFocusSection) {
    sections.push(`\n## FOCUS FILES\n{{FOCUS_FILES}}`);
  }

  let result = sections.join('\n');

  if (opts) {
    if (opts.pinBudget !== undefined) result = result.replace('{{PIN_BUDGET}}', String(opts.pinBudget));
    if (opts.focusFiles !== undefined) result = result.replace('{{FOCUS_FILES}}', opts.focusFiles);
  }

  return result;
}

/** Pre-built template with {{PIN_BUDGET}}, {{FOCUS_FILES}} placeholders */
export const RETRIEVER_SUBAGENT_PROMPT_V2 = buildSubagentPrompt('retriever');

/** Pre-built template with {{PIN_BUDGET}}, {{FOCUS_FILES}} placeholders */
export const DESIGN_SUBAGENT_PROMPT_V2 = buildSubagentPrompt('design');

/** Static prompt used as retriever mode prompt (no template vars) */
export const SEMANTIC_SEARCH_SUBAGENT_PROMPT = buildSubagentPrompt('semantic');

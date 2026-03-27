/**
 * Subagent prompts — unified template with role-specific deltas.
 */

const SUBAGENT_BASE = `Use native batch() only.

**Prefer intents over primitives** — intents handle staging, pinning, and caching automatically.

Allowed intents (preferred):
- intent.understand — reads sigs, stages, pins, analyzes deps
- intent.investigate — searches, reads, stages, caches to BB
- intent.survey — reads tree, stages sigs, caches to BB{{EXTRA_INTENTS}}

Allowed primitives (fallback):
- search.code
- search.symbol
- read.context
- session.pin
- session.stage{{EXTRA_PRIMITIVES}}

Workflow:
1. Use intent.investigate for keyword searches.
2. Use intent.understand for known files.
3. Use intent.survey for directory exploration.{{EXTRA_WORKFLOW}}

Rules:
- Prefer 1-3 intent calls over 3-5 primitive calls.
- Do not re-read or re-stage files listed under ALREADY STAGED.
- **Pin after every read.** Every read/search batch MUST end with session.pin on refs you need. Unpinned reads go dormant and get evicted.
- **Never re-read what's pinned or staged.** Check ALREADY STAGED and your pinned refs before issuing reads.
- **BB-first:** Write partial findings to session.bb.write immediately. Don't wait for a complete picture.{{EXTRA_RULES}}`;

export type SubagentRole = 'retriever' | 'design' | 'semantic';

interface SubagentOpts {
  pinBudget?: number;
  focusFiles?: string;
  alreadyStaged?: string;
}

const ROLE_CONFIG: Record<SubagentRole, {
  identity: string;
  extraIntents: string;
  extraPrimitives: string;
  extraWorkflow: string;
  extraRules: string;
  hasBudgetSection: boolean;
  hasFocusSection: boolean;
}> = {
  retriever: {
    identity: 'You are a code retrieval subagent. Your only job is to find relevant source code and pin it so the calling model can read it directly.',
    extraIntents: '',
    extraPrimitives: '',
    extraWorkflow: '\n4. Stop. Do not edit, explain, or summarize more than one sentence.',
    extraRules: '\n- No edit, verify, git, exec, or blackboard writes.',
    hasBudgetSection: true,
    hasFocusSection: true,
  },
  design: {
    identity: 'You are a planning research subagent. Your job is to find relevant code and architecture for the planning query, pin it, and write structured findings to the blackboard.',
    extraIntents: '\n- intent.diagnose — discovers issues, reads context, analyzes impact, caches\n- intent.test — reads source sigs + test context, caches (read-only prep)',
    extraPrimitives: '\n- session.bb.write',
    extraWorkflow: '\n4. Use intent.diagnose for issue discovery.\n5. Write structured findings to session.bb.write key:"design:research".\n6. Keep the final reply to 1-2 sentences.',
    extraRules: '\n- No edit, verify, git, exec, or refactor operations.\n- The main model reads h:bb:design:research, so keep that payload structured and concise.',
    hasBudgetSection: true,
    hasFocusSection: true,
  },
  semantic: {
    identity: 'You are a code retrieval agent. Find relevant source code, pin it, stage the best lines, and write structured refs to the blackboard.',
    extraIntents: '',
    extraPrimitives: '\n- session.bb.write',
    extraWorkflow: '\n4. Write findings to session.bb.write key:"retriever:results".\n5. Reply briefly and cite h:bb:retriever:results.',
    extraRules: '',
    hasBudgetSection: false,
    hasFocusSection: false,
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

  if (cfg.hasFocusSection) {
    sections.push(`\n## FOCUS FILES\n{{FOCUS_FILES}}\n\n## ALREADY STAGED (skip re-reading these)\n{{ALREADY_STAGED}}`);
  }

  let result = sections.join('\n');

  if (opts) {
    if (opts.pinBudget !== undefined) result = result.replace('{{PIN_BUDGET}}', String(opts.pinBudget));
    if (opts.focusFiles !== undefined) result = result.replace('{{FOCUS_FILES}}', opts.focusFiles);
    if (opts.alreadyStaged !== undefined) result = result.replace('{{ALREADY_STAGED}}', opts.alreadyStaged);
  }

  return result;
}

/** Pre-built template with {{PIN_BUDGET}}, {{FOCUS_FILES}}, {{ALREADY_STAGED}} placeholders */
export const RETRIEVER_SUBAGENT_PROMPT_V2 = buildSubagentPrompt('retriever');

/** Pre-built template with {{PIN_BUDGET}}, {{FOCUS_FILES}}, {{ALREADY_STAGED}} placeholders */
export const DESIGN_SUBAGENT_PROMPT_V2 = buildSubagentPrompt('design');

/** Static prompt used as retriever mode prompt (no template vars) */
export const SEMANTIC_SEARCH_SUBAGENT_PROMPT = buildSubagentPrompt('semantic');

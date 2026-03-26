/**
 * Rolling history distiller — extracts facts from rounds leaving the verbatim window
 * and formats a compact assistant summary message for the API payload.
 */

import { estimateTokens } from '../utils/contextHash';
import { ROLLING_SUMMARY_MAX_TOKENS } from './promptMemory';

export const ROLLING_SUMMARY_MARKER = '[Rolling Summary]';
export const MAX_SUMMARY_ITEMS_PER_ARRAY = 8;

export interface RollingSummary {
  decisions: string[];
  filesChanged: string[];
  userPreferences: string[];
  workDone: string[];
  findings: string[];
  errors: string[];
  /** What the model was working toward when rounds were distilled */
  currentGoal: string;
  /** Explicit next-step statements captured from model output */
  nextSteps: string[];
  /** Identified blockers or open questions */
  blockers: string[];
}

export type RoundFacts = RollingSummary;

export function emptyRollingSummary(): RollingSummary {
  return {
    decisions: [],
    filesChanged: [],
    userPreferences: [],
    workDone: [],
    findings: [],
    errors: [],
    currentGoal: '',
    nextSteps: [],
    blockers: [],
  };
}

export function isRollingSummaryMessage(msg: { role: string; content: unknown }): boolean {
  if (msg.role !== 'assistant') return false;
  if (typeof msg.content !== 'string') return false;
  return msg.content.trimStart().startsWith(ROLLING_SUMMARY_MARKER);
}

function dedupePush(arr: string[], item: string): void {
  const t = item.trim();
  if (!t || t.startsWith('[->')) return;
  const key = t.toLowerCase();
  if (arr.some((x) => x.toLowerCase() === key)) return;
  arr.push(t.length > 400 ? `${t.slice(0, 397)}...` : t);
}

function extractTextFromAssistantContent(content: unknown): string[] {
  const out: string[] = [];
  if (typeof content === 'string') {
    if (content.trim()) out.push(content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; content?: string };
    if (b.type === 'text') {
      const raw = typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '';
      if (raw.trim()) out.push(raw);
    }
  }
  return out;
}

function extractPathsFromToolInput(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const fp = input.file_paths;
  if (Array.isArray(fp)) {
    for (const p of fp) {
      if (typeof p === 'string' && p) paths.push(p);
    }
  }
  if (typeof input.file_path === 'string' && input.file_path) paths.push(input.file_path);
  const path = input.path;
  if (typeof path === 'string' && path) paths.push(path);
  const steps = input.steps as Array<{ use?: string; with?: Record<string, unknown> }> | undefined;
  if (Array.isArray(steps)) {
    for (const s of steps) {
      const w = s.with ?? {};
      const wfp = w.file_paths as string[] | undefined;
      if (Array.isArray(wfp)) {
        for (const p of wfp) {
          if (typeof p === 'string' && p) paths.push(p);
        }
      }
      if (typeof w.file_path === 'string' && w.file_path) paths.push(w.file_path);
      if (typeof w.path === 'string' && w.path) paths.push(w.path);
    }
  }
  return paths;
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; content?: string };
    if (b.type === 'tool_result') continue;
    if (b.type === 'text') {
      const t = typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '';
      if (t) parts.push(t);
    }
  }
  return parts.join('\n').trim();
}

const WORK_DONE_HINTS = /\b(done|fixed|implemented|completed|added|removed|refactor|merged|resolved)\b/i;
const FINDING_HINTS = /\b(found|discovered|noticed|problem is|root cause|because|stale|incorrect|bug|issue is|caused by|due to|the reason|turns out|actually)\b/i;
const ERROR_HINTS = /\b(error|failed|exception|traceback|panic|undefined|null ref)\b/i;
const GOAL_HINTS = /\b(goal|objective|working on|task is|aim(?:ing)?|plan(?:ning)?|need to|going to|will now|let me|I'll)\b/i;
const NEXT_STEP_HINTS = /\b(next|then|after that|following that|step \d|todo|remaining|still need|will then|should then)\b/i;
const BLOCKER_HINTS = /\b(block(?:ed|er|ing)?|stuck|can't|cannot|waiting|depends on|need.*first|prerequisite|missing|unclear|question)\b/i;

/**
 * Extract key facts from API messages for one tool-loop round (assistant + following user).
 */
export function distillRound(messages: Array<{ role: string; content: unknown }>): RoundFacts {
  const facts = emptyRollingSummary();

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (isRollingSummaryMessage(msg)) continue;
      const texts = extractTextFromAssistantContent(msg.content);
      for (const t of texts) {
        const line = t.replace(/\s+/g, ' ').trim();
        if (line.startsWith('[->')) continue;
        if (line.length > 20 && line.length < 500) {
          dedupePush(facts.decisions, line.slice(0, 280));
        }
        if (WORK_DONE_HINTS.test(t)) {
          dedupePush(facts.workDone, line.slice(0, 220));
        }
        if (FINDING_HINTS.test(t)) {
          dedupePush(facts.findings, line.slice(0, 220));
        }
        if (GOAL_HINTS.test(t) && line.length > 15) {
          facts.currentGoal = line.slice(0, 300);
        }
        if (NEXT_STEP_HINTS.test(t) && line.length > 10) {
          dedupePush(facts.nextSteps, line.slice(0, 220));
        }
        if (BLOCKER_HINTS.test(t) && line.length > 10) {
          dedupePush(facts.blockers, line.slice(0, 220));
        }
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
          if (b.type !== 'tool_use' || !b.input) continue;
          for (const p of extractPathsFromToolInput(b.input)) {
            dedupePush(facts.filesChanged, p);
          }
        }
      }
    } else if (msg.role === 'user') {
      const ut = extractUserText(msg.content);
      if (ut.length > 8) {
        if (ut.length < 400) dedupePush(facts.userPreferences, ut);
        else dedupePush(facts.userPreferences, ut.slice(0, 280) + '...');
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as { type?: string; content?: string };
          if (b.type !== 'tool_result' || typeof b.content !== 'string') continue;
          const c = b.content;
          if (c.startsWith('[->')) continue;
          if (ERROR_HINTS.test(c) || /"error"\s*:/i.test(c)) {
            dedupePush(facts.errors, c.replace(/\s+/g, ' ').trim().slice(0, 240));
          }
        }
      }
    }
  }

  return facts;
}

export function updateRollingSummary(existing: RollingSummary, newFacts: RoundFacts): RollingSummary {
  const merge = (a: string[], b: string[]) => {
    for (const x of b) dedupePush(a, x);
  };
  const next: RollingSummary = {
    decisions: [...existing.decisions],
    filesChanged: [...existing.filesChanged],
    userPreferences: [...existing.userPreferences],
    workDone: [...existing.workDone],
    findings: [...(existing.findings ?? [])],
    errors: [...existing.errors],
    currentGoal: newFacts.currentGoal || existing.currentGoal || '',
    nextSteps: [...(existing.nextSteps ?? [])],
    blockers: [...(existing.blockers ?? [])],
  };
  merge(next.decisions, newFacts.decisions);
  merge(next.filesChanged, newFacts.filesChanged);
  merge(next.userPreferences, newFacts.userPreferences);
  merge(next.workDone, newFacts.workDone);
  merge(next.findings, newFacts.findings);
  merge(next.errors, newFacts.errors);
  merge(next.nextSteps, newFacts.nextSteps);
  merge(next.blockers, newFacts.blockers);
  for (const key of ['decisions', 'filesChanged', 'userPreferences', 'workDone', 'findings', 'errors', 'nextSteps', 'blockers'] as const) {
    while (next[key].length > MAX_SUMMARY_ITEMS_PER_ARRAY) next[key].shift();
  }
  return next;
}

function section(title: string, items: string[]): string {
  if (items.length === 0) return '';
  const lines = items.map((s) => `- ${s}`);
  return `**${title}**\n${lines.join('\n')}`;
}

/**
 * Format rolling summary as a single assistant message for the API.
 */
export function formatSummaryMessage(summary: RollingSummary): { role: 'assistant'; content: string } {
  const trimmed = trimSummaryToTokenBudget(summary, ROLLING_SUMMARY_MAX_TOKENS);
  const goalLine = trimmed.currentGoal ? `**Current goal:** ${trimmed.currentGoal}` : '';
  const parts = [
    ROLLING_SUMMARY_MARKER,
    goalLine,
    section('Next steps', trimmed.nextSteps ?? []),
    section('Blockers', trimmed.blockers ?? []),
    section('Decisions', trimmed.decisions),
    section('Findings', trimmed.findings),
    section('Files', trimmed.filesChanged),
    section('User preferences', trimmed.userPreferences),
    section('Work done', trimmed.workDone),
    section('Errors', trimmed.errors),
  ].filter(Boolean);
  const content = parts.join('\n\n').trim();
  return { role: 'assistant', content: content || `${ROLLING_SUMMARY_MARKER}\n_(no distilled facts yet)_` };
}

/**
 * Drop oldest entries across arrays until formatted content is under maxTokens.
 */
export function trimSummaryToTokenBudget(summary: RollingSummary, maxTokens: number): RollingSummary {
  let s = { ...summary, decisions: [...summary.decisions], filesChanged: [...summary.filesChanged], userPreferences: [...summary.userPreferences], workDone: [...summary.workDone], findings: [...(summary.findings ?? [])], errors: [...summary.errors], currentGoal: summary.currentGoal || '', nextSteps: [...(summary.nextSteps ?? [])], blockers: [...(summary.blockers ?? [])] };
  let body = formatSummaryBody(s);
  let tok = estimateTokens(body);
  let guard = 0;
  // Trim order: expendable first; goal/nextSteps/findings last (most valuable for continuity)
  while (tok > maxTokens && guard++ < 500) {
    let cut = false;
    for (const key of ['userPreferences', 'filesChanged', 'errors', 'workDone', 'decisions', 'blockers', 'nextSteps', 'findings'] as const) {
      if (s[key].length > 0) {
        s[key].shift();
        cut = true;
        break;
      }
    }
    if (!cut) {
      if (s.currentGoal) { s.currentGoal = ''; cut = true; }
    }
    if (!cut) break;
    body = formatSummaryBody(s);
    tok = estimateTokens(body);
  }
  return s;
}

function formatSummaryBody(summary: RollingSummary): string {
  const goalLine = summary.currentGoal ? `**Current goal:** ${summary.currentGoal}` : '';
  const parts = [
    goalLine,
    section('Next steps', summary.nextSteps ?? []),
    section('Blockers', summary.blockers ?? []),
    section('Decisions', summary.decisions),
    section('Findings', summary.findings),
    section('Files', summary.filesChanged),
    section('User preferences', summary.userPreferences),
    section('Work done', summary.workDone),
    section('Errors', summary.errors),
  ].filter(Boolean);
  return `${ROLLING_SUMMARY_MARKER}\n\n${parts.join('\n\n')}`.trim();
}

export function isRollingSummaryEmpty(s: RollingSummary): boolean {
  return (
    s.decisions.length === 0
    && s.filesChanged.length === 0
    && s.userPreferences.length === 0
    && s.workDone.length === 0
    && (s.findings ?? []).length === 0
    && s.errors.length === 0
    && !s.currentGoal
    && (s.nextSteps ?? []).length === 0
    && (s.blockers ?? []).length === 0
  );
}

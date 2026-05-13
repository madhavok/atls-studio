import { useAppStore, type Message } from '../stores/appStore';
import { useContextStore } from '../stores/contextStore';
import type { AgentWindow } from '../stores/agentWindowStore';
import type { AgentRuntimeMessage } from '../stores/agentRuntimeStore';

export type DelegateRole = 'coder' | 'reviewer' | 'tester' | 'debugger' | 'researcher' | 'documenter' | 'custom';

const ROLE_INSTRUCTIONS: Record<DelegateRole, string> = {
  coder: 'Implement the delegated coding task. State assumptions, make focused changes, and report files touched.',
  reviewer: 'Review the delegated work for bugs, regressions, missing tests, and risky assumptions. Lead with findings.',
  tester: 'Verify behavior with focused tests or commands. Report exact commands, results, and remaining risk.',
  debugger: 'Trace the failure systematically. Identify likely cause, evidence, and the smallest fix path.',
  researcher: 'Gather relevant project context. Prefer concise source-grounded findings over broad speculation.',
  documenter: 'Produce clear documentation or explanation tied to the current implementation and user intent.',
  custom: 'Handle the delegated task using the provided context and report concise progress.',
};

function trimText(value: string, max = 1800): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 24)}\n...[truncated]`;
}

function summarizeMessages(messages: Array<Message | AgentRuntimeMessage>, maxMessages = 6): string {
  return messages
    .slice(-maxMessages)
    .map((message) => `${message.role}: ${trimText(message.content, 700)}`)
    .join('\n\n');
}

export function buildDelegationContext({
  parentWindow,
  childRole,
  task,
  parentMessages,
}: {
  parentWindow: AgentWindow;
  childRole?: string;
  task: string;
  parentMessages: Array<Message | AgentRuntimeMessage>;
}): string {
  const role = (childRole && childRole in ROLE_INSTRUCTIONS ? childRole : 'custom') as DelegateRole;
  const app = useAppStore.getState();
  const context = useContextStore.getState();
  const activeFile = app.activeFile ? `\nActive file: ${app.activeFile}` : '';
  const openFiles = app.openFiles.length > 0 ? `\nOpen files: ${app.openFiles.slice(0, 8).join(', ')}` : '';
  const project = app.projectPath ? `\nProject: ${app.projectPath}` : '';
  const blackboard = Array.from(context.blackboardEntries.entries())
    .filter(([key]) => !key.startsWith('__'))
    .slice(-6)
    .map(([key, entry]) => `${key}: ${trimText(entry.content, 240)}`)
    .join('\n');

  return [
    `You are a visible ${role} delegate window in ATLS Studio.`,
    ROLE_INSTRUCTIONS[role],
    '',
    `Parent session: ${parentWindow.title} (${parentWindow.sessionId})`,
    `Delegated task: ${trimText(task, 1200)}`,
    `${project}${activeFile}${openFiles}`.trim(),
    parentMessages.length > 0 ? `Recent parent context:\n${summarizeMessages(parentMessages)}` : '',
    blackboard ? `Relevant blackboard notes:\n${blackboard}` : '',
    'Return progress and final results in this child window. Do not paste the full parent transcript back; summarize only the result and evidence.',
  ].filter(Boolean).join('\n\n');
}

export function summarizeChildResult(messages: AgentRuntimeMessage[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant' && message.content.trim());
  return trimText(lastAssistant?.content ?? 'Child agent completed without a textual result.', 900);
}

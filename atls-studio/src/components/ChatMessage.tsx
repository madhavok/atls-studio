import { memo } from 'react';
import { MarkdownMessage } from './AiChat/MarkdownMessage';
import { TaskCompleteCard } from './AiChat/TemplateCard';
import type { Message, MessagePart } from '../stores/appStore';
import { getMessageParts } from '../stores/appStore';
import { parseTaskCompleteArgs, type TaskCompleteArgs } from '../utils/structuredOutput';

interface ChatMessageProps {
  message: Message;
  isStreaming?: boolean;
}

function isTaskCompleteCall(tc: { name: string; args?: Record<string, unknown> }): boolean {
  return tc.name === 'task_complete';
}

function getTaskCompleteArgs(tc: { args?: Record<string, unknown> }): TaskCompleteArgs {
  return parseTaskCompleteArgs(tc.args ?? {});
}

function getTaskCompleteFromParts(parts: MessagePart[]): TaskCompleteArgs | null {
  const taskCompletePart = parts.find((part): part is Extract<MessagePart, { type: 'tool' }> => {
    return part.type === 'tool' && isTaskCompleteCall(part.toolCall) && part.toolCall.status === 'completed';
  });
  return taskCompletePart ? getTaskCompleteArgs(taskCompletePart.toolCall) : null;
}

function parseInlineTaskCompleteContent(content: string): TaskCompleteArgs | null {
  const match = content.match(/task_complete\s*\(\s*(\{[\s\S]*\})\s*\)/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    return parseTaskCompleteArgs(parsed);
  } catch {
    return null;
  }
}

function parseTaskCompleteToolCall(message: Message): TaskCompleteArgs | null {
  const parts = getMessageParts(message);
  if (parts.length) {
    const fromParts = getTaskCompleteFromParts(parts);
    if (fromParts) return fromParts;
  }
  if (message.content) return parseInlineTaskCompleteContent(message.content);
  return null;
}

function normalizeContentForComparison(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function getTaskCompleteMarkdownContent(message: Message, taskCompleteData: TaskCompleteArgs | null): string | null {
  if (!message.content || !taskCompleteData) return message.content || null;

  const summary = taskCompleteData.summary.trim();
  if (!summary) return message.content;

  const normalizedContent = normalizeContentForComparison(message.content);
  const normalizedSummary = normalizeContentForComparison(summary);
  if (normalizedContent === normalizedSummary) return null;

  const summaryIndex = message.content.lastIndexOf(summary);
  if (summaryIndex >= 0) {
    const beforeSummary = message.content.slice(0, summaryIndex).trim();
    return beforeSummary || null;
  }

  const parts = getMessageParts(message);
  const textParts = parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text');
  if (textParts.length > 0) {
    const filtered = textParts
      .map(part => part.content)
      .filter(content => normalizeContentForComparison(content) !== normalizedSummary)
      .join('\n')
      .trim();
    return filtered || null;
  }

  return message.content;
}

export const ChatMessage = memo(function ChatMessage({ message, isStreaming = false }: ChatMessageProps) {
  const taskCompleteData = parseTaskCompleteToolCall(message);
  const markdownContent = getTaskCompleteMarkdownContent(message, taskCompleteData);

  return (
    <div className="min-w-0">
      {taskCompleteData && (
        <div className="mb-3">
          <TaskCompleteCard summary={taskCompleteData.summary} filesChanged={taskCompleteData.filesChanged} />
        </div>
      )}
      {markdownContent && !isStreaming && (
        <MarkdownMessage content={markdownContent} />
      )}
    </div>
  );
});

export default ChatMessage;

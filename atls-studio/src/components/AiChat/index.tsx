import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { processFileAttachment, formatAttachmentForLLM } from '../../utils/fileAttachments';
import { useAppStore, Message, ToolCall, MessageToolCall, MessageSegment, MessagePart, StreamPart, getMessageParts, type ToolCallStatus } from '../../stores/appStore';
import { useContextStore } from '../../stores/contextStore';
import { appendTextToSegments as _appendText, appendReasoningToSegments as _appendReasoning, closeBlockById as _closeBlock, upsertToolSegment as _upsertTool, resetStreamingState, clearStreamingState, type StreamingRefs } from './streamingHelpers';
import { useSwarmStore } from '../../stores/swarmStore';
import { useCostStore, formatCost, calculateCost, type AIProvider as CostProvider } from '../../stores/costStore';
import { useAttachmentStore, type ChatAttachment, consumeInternalDragPayload } from '../../stores/attachmentStore';
import { streamChat, stopChat, getProviderFromModel, resetStaticPromptCache, resetProjectTreeCache, type ChatMessage, type AIConfig, type AIProvider, type WorkspaceContext, type ChatMode } from '../../services/aiService';
import { orchestrator } from '../../services/orchestrator';
import { ModelModeSelector } from '../ModelModeSelector';
import { Settings } from '../Settings';
import { useAtls } from '../../hooks/useAtls';
import { useChatPersistence } from '../../hooks/useChatPersistence';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { MarkdownMessage } from './MarkdownMessage';
import { TaskCompleteCard } from './TemplateCard';
import { ToolTokenMetrics } from './ToolTokenMetrics';
import { HashRefText } from './HashRefInline';
import { SignatureView } from '../SignatureView';
import { ImageAttachment } from '../ImageAttachment';
import { formatTokens } from '../../utils/toolTokenMetrics';
import {
  getEffectiveContextWindow,
  getExtendedContextResolutionFromSettings,
  isExtendedContextEnabled,
  modelSupportsExtendedContext,
} from '../../utils/modelCapabilities';
import { useRoundHistoryStore } from '../../stores/roundHistoryStore';
import { parseTaskCompleteArgs } from '../../utils/structuredOutput';
import { selectRecentHistory } from '../../services/historySelector';
import { serializeForTokenEstimate } from '../../utils/toon';

function isTaskCompleteCall(tc: { name: string; args?: Record<string, unknown> }): boolean {
  return tc.name === 'task_complete';
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

/** Tauri v2 dialog may return a path string or `{ path: string }`. */
function dialogSelectedPath(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && 'path' in entry) {
    const p = (entry as { path: unknown }).path;
    if (typeof p === 'string') return p;
  }
  return null;
}

function getTaskCompleteArgs(tc: { args?: Record<string, unknown> }): { summary: string; filesChanged: string[] } {
  const parsed = parseTaskCompleteArgs(tc.args ?? {});

  if (parsed.filesChanged.length > 0) {
    return parsed;
  }

  const legacyFilesChanged = coerceStringArray(tc.args?.files_changed ?? tc.args?.filesChanged);
  return {
    summary: parsed.summary,
    filesChanged: legacyFilesChanged,
  };
}

function getTaskCompleteSummaryFromParts(parts: MessagePart[]): string {
  const textParts = parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => cleanStreamingContent(part.content).trim())
    .filter(Boolean);
  if (textParts.length > 0) return textParts.join('\n\n');
  const taskCompletePart = [...parts].reverse().find((part): part is Extract<MessagePart, { type: 'tool' }> => {
    return part.type === 'tool' && isTaskCompleteCall(part.toolCall);
  });
  if (!taskCompletePart) return '';
  return getTaskCompleteArgs(taskCompletePart.toolCall).summary.trim();
}

// Clean streaming content - remove JSON tool_use artifacts that may leak into text
function cleanStreamingContent(content: string): string {
  if (!content) return '';
  
  // Preserve chunk references like [-> hash, Ntk | desc]
  if (/^\s*\[->\s+.+\]\s*$/.test(content)) return content;
  
  const trimmed = content.trim();
  
  // Suppress partial JSON prefixes that leak during streaming
  // Anthropic: '[{"type"', '[{"type":"tool_use"' etc.
  // Gemini: '{"functionCall"', '{"functionResponse"' etc.
  if (/^\[?\{?"?(?:type)?:?"?(?:tool_use|tool_result|text)?"?\s*,?\s*$/s.test(trimmed)) {
    return '';
  }
  if (/^\{?\s*"?(?:functionCall|functionResponse)"?\s*:?\s*\{?\s*$/s.test(trimmed)) {
    return '';
  }
  if (trimmed === '[' || trimmed === '[{' || trimmed === '[]') {
    return '';
  }
  
  // Try to detect and parse JSON array format (Anthropic content blocks)
  if (trimmed.startsWith('[{') && trimmed.includes('"type"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        // If it's purely tool_use/tool_result blocks, suppress entirely
        const hasOnlyTools = parsed.every((b: any) => b.type === 'tool_use' || b.type === 'tool_result');
        if (hasOnlyTools) return '';
        
        // Extract only text blocks
        const textParts = parsed
          .filter((block: any) => block.type === 'text' && block.text)
          .map((block: any) => block.text);
        if (textParts.length > 0) {
          return textParts.join('\n');
        }
        return '';
      }
    } catch {
      // Not valid JSON, continue with pattern removal
    }
  }
  
  // Remove partial JSON tool_use blocks that may appear during streaming
  let cleaned = content;
  
  // Remove JSON array wrapper with tool_use
  cleaned = cleaned.replace(/\[\{"type":"text","text":"([^"]*)".*$/s, '$1');
  
  // Remove trailing tool_use JSON fragments
  cleaned = cleaned.replace(/,?\s*\{"type":"tool_use".*$/s, '');
  
  // Remove leading JSON artifacts
  cleaned = cleaned.replace(/^\[\{"type":"text","text":"/s, '');
  cleaned = cleaned.replace(/^"\},\s*\{"type":"tool_use".*$/s, '');
  
  // Gemini: suppress partial functionCall JSON that may leak into text during streaming
  cleaned = cleaned.replace(/\{\s*"functionCall"\s*:\s*\{[^}]*$/s, '');
  cleaned = cleaned.replace(/\{\s*"functionResponse"\s*:\s*\{[^}]*$/s, '');
  
  const cleanedTrimmed = cleaned.trim();

  try {
    const parsed = JSON.parse(cleanedTrimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          return String(item ?? '');
        })
        .join('');
    }

    if (typeof parsed === 'string') {
      return parsed;
    }
  } catch {
    // Ignore parse errors and fall back to text cleanup.
  }

  return cleaned;
}

// Context Panel - collapsible panel showing task plan, blackboard, chunks, budget
const ContextPanel = memo(function ContextPanel() {
  const taskPlan = useContextStore((s) => s.taskPlan);
  const chunks = useContextStore((s) => s.chunks);
  const bbEntries = useContextStore((s) => s.blackboardEntries);
  const maxTokens = useContextStore((s) => s.maxTokens);
  const freedTokens = useContextStore((s) => s.freedTokens);
  const getPromptTokens = useContextStore((s) => s.getPromptTokens);
  const getBlackboardTokenCount = useContextStore((s) => s.getBlackboardTokenCount);
  const [expanded, setExpanded] = useState(false);
  
  const wmTokens = useMemo(() => getPromptTokens(), [chunks, getPromptTokens]);
  const bbTokens = useMemo(() => getBlackboardTokenCount(), [bbEntries, getBlackboardTokenCount]);
  const pinnedCount = useMemo(() => {
    let n = 0;
    chunks.forEach((c) => {
      if (c.pinned) n++;
    });
    return n;
  }, [chunks]);
  
  const hasContent = chunks.size > 0 || bbEntries.size > 0 || taskPlan !== null;
  if (!hasContent) return null;
  
  // Align with prompt pressure: WM via getPromptTokens (excludes chat chunks, dormant rules) + blackboard
  const totalTokens = wmTokens + bbTokens;
  const percentage = Math.min(100, (totalTokens / maxTokens) * 100);
  const barColor = percentage >= 90 ? 'bg-red-500' : percentage >= 70 ? 'bg-yellow-500' : 'bg-blue-500';
  
  return (
    <div className="shrink-0 border-b border-studio-border">
      <button
        className="w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-studio-hover/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="text-studio-text-secondary font-medium">Context</span>
        <span className="text-studio-text-muted">{chunks.size} chunks</span>
        {pinnedCount > 0 && <span className="text-studio-text-muted">{pinnedCount} pinned</span>}
        {bbEntries.size > 0 && <span className="text-studio-text-muted">{bbEntries.size} bb</span>}
        {/* Budget bar */}
        <div className="flex-1 max-w-[80px] h-1.5 bg-studio-surface rounded-full overflow-hidden ml-auto">
          <div className={`h-full ${barColor} transition-all`} style={{ width: `${percentage}%` }} />
        </div>
        <span className="text-studio-text-muted">{(totalTokens / 1000).toFixed(0)}k/{(maxTokens / 1000).toFixed(0)}k</span>
        <svg className={`w-3 h-3 text-studio-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pb-2 text-xs space-y-2 max-h-60 overflow-y-auto">
          {/* Task Plan */}
          {taskPlan && (
            <div>
              <div className="text-studio-text-secondary font-medium mb-1">Task Plan</div>
              <div className="text-studio-text-muted ml-2">{taskPlan.goal}</div>
              {taskPlan.subtasks.map(st => (
                <div key={st.id} className="ml-2 flex items-center gap-1">
                  <span className={
                    st.status === 'done' ? 'text-green-400' :
                    st.status === 'active' ? 'text-blue-400' :
                    st.status === 'blocked' ? 'text-red-400' :
                    'text-studio-text-muted'
                  }>
                    {st.status === 'done' ? '[done]' : st.status === 'active' ? '[active]' : st.status === 'blocked' ? '[blocked]' : '[pending]'}
                  </span>
                  <span className="text-studio-text-muted">{st.title}</span>
                </div>
              ))}
            </div>
          )}
          
          {/* Blackboard — h:refs rendered as interactive pills */}
          {bbEntries.size > 0 && (
            <div>
              <div className="text-studio-text-secondary font-medium mb-1">Blackboard ({(bbTokens / 1000).toFixed(1)}k tokens)</div>
              {Array.from(bbEntries.entries()).map(([key, entry]) => (
                <div key={key} className="ml-2 text-studio-text-muted truncate" title={entry.content}>
                  <span className="text-studio-accent">{key}:</span>{' '}
                  <HashRefText text={entry.content.split('\n')[0].slice(0, 80)} />
                </div>
              ))}
            </div>
          )}
          
          {/* Chunks */}
          {chunks.size > 0 && (
            <div>
              <div className="text-studio-text-secondary font-medium mb-1">Working Memory ({chunks.size} chunks)</div>
              {Array.from(chunks.values())
                .sort((a, b) => (a.pinned === b.pinned ? b.lastAccessed - a.lastAccessed : a.pinned ? -1 : 1))
                .map(c => (
                <div key={c.hash} className="ml-2 text-studio-text-muted truncate flex items-center gap-1">
                  {c.pinned && <span className="text-yellow-400 text-[10px]">PIN</span>}
                  <span className="font-mono text-[10px]">{c.shortHash}</span>
                  <span>{c.type}</span>
                  <span className="text-studio-text-muted/60">{c.tokens}tk</span>
                  {c.source && <span className="truncate">{c.source}</span>}
                  {c.subtaskId && <span className="text-studio-text-muted/40">@{c.subtaskId}</span>}
                </div>
              ))}
            </div>
          )}
          
          {freedTokens > 0 && (
            <div className="text-studio-text-muted">Freed this session: {(freedTokens / 1000).toFixed(1)}k tokens</div>
          )}
        </div>
      )}
    </div>
  );
});

// Agent Status Card - fixed at top of chat, shows progress
const AgentStatusCard = memo(function AgentStatusCard() {
  const progress = useAppStore((s) => s.agentProgress);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const [expanded, setExpanded] = useState(false);
  const { runningTools, completedTools, failedTools } = useMemo(() => ({
    runningTools: progress.recentTools.filter((t) => t.status === 'running' || t.status === 'pending'),
    completedTools: progress.recentTools.filter((t) => t.status === 'completed'),
    failedTools: progress.recentTools.filter((t) => t.status === 'failed'),
  }), [progress.recentTools]);

  if (progress.status === 'idle' && !isGenerating) return null;

  const statusLabel = progress.status === 'thinking' ? 'Thinking...'
    : progress.status === 'executing' ? `Executing tools...`
    : progress.status === 'auto_continuing' ? `Auto-continuing...`
    : progress.status === 'stopped' ? (progress.stoppedReason === 'completed' ? 'Completed' : 'Stopped')
    : 'Working...';
  const statusColor = progress.status === 'stopped'
    ? (progress.stoppedReason === 'completed' ? 'text-green-400' : 'text-yellow-400')
    : 'text-blue-400';

  return (
    <div className="shrink-0 border-b border-studio-border bg-studio-bg-secondary/80 backdrop-blur-sm">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-studio-hover/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className={`${statusColor} font-medium`}>{statusLabel}</span>
        <span className="text-studio-text-muted">
          Round {progress.round}/{progress.maxRounds}
        </span>
        <span className="text-studio-text-muted">
          {progress.toolsCompleted}/{progress.toolsTotal} tools
        </span>
        {progress.currentTask && (
          <span className="text-studio-text-secondary truncate ml-auto max-w-[40%]" title={progress.currentTask}>
            {progress.currentTask}
          </span>
        )}
        <svg className={`w-3 h-3 text-studio-text-muted ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pb-2 text-xs space-y-1 max-h-40 overflow-y-auto">
          {runningTools.length > 0 && (
            <div>
              <span className="text-blue-400 font-medium">Running:</span>
              {runningTools.map((tc) => (
                <div key={tc.id} className="ml-2 text-studio-text-muted truncate">{tc.name}: {tc.detail} (R{tc.round})</div>
              ))}
            </div>
          )}
          {failedTools.length > 0 && (
            <div>
              <span className="text-red-400 font-medium">Failed:</span>
              {failedTools.map((tc) => (
                <div key={tc.id} className="ml-2 text-red-300/70 truncate">{tc.name}: {tc.detail} (R{tc.round})</div>
              ))}
            </div>
          )}
          {completedTools.length > 0 && (
            <div>
              <span className="text-green-400 font-medium">Completed ({completedTools.length}):</span>
              {completedTools.slice(-10).reverse().map((tc) => (
                <div key={tc.id} className="ml-2 text-studio-text-muted truncate">{tc.name}: {tc.detail} (R{tc.round})</div>
              ))}
              {completedTools.length > 10 && (
                <div className="ml-2 text-studio-text-muted">...and {completedTools.length - 10} more</div>
              )}
            </div>
          )}
          {progress.recentTools.length === 0 && (
            <div className="text-studio-text-muted italic">No tools executed yet</div>
          )}
        </div>
      )}
    </div>
  );
});

// Icons
const SendIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
  </svg>
);

const UserIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
  </svg>
);

const AIIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M10 2L12.5 8.5L19 6L14 11L20 14L12.5 13.5L10 22L8.5 13.5L2 14L7 11L2 6L8.5 8.5L10 2Z" />
  </svg>
);

const ClearIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

const StopIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="1" />
  </svg>
);

const ContinueIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
);

const ErrorIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

const EditIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
  </svg>
);

const UndoIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
  </svg>
);

// Suggested prompts per mode
const DEFAULT_SUGGESTED_PROMPTS = [
  'Find security vulnerabilities',
  'What does this file do?',
  'Explain these issues',
  'Fix all high severity issues',
  'Show me the dependency graph',
  'Find dead code',
];

const REFACTOR_SUGGESTED_PROMPTS = [
  'Find files over 500 lines and inventory them',
  'Analyze this file for refactoring opportunities',
  'Extract high-complexity methods from the current file',
  'Refactor by feature: group related methods',
  'Refactor by layer: separate data, business, and API',
  'Find duplicate code patterns to extract',
];

// Compact Context Meter Component - shown below chat input
// Now reads from context store for accurate chunk tracking
const ContextMeter = memo(function ContextMeter() {
  const chunks = useContextStore(state => state.chunks);
  const freedTokens = useContextStore(state => state.freedTokens);
  const lastFreed = useContextStore(state => state.lastFreed);
  const lastFreedAt = useContextStore(state => state.lastFreedAt);
  const clearLastFreed = useContextStore(state => state.clearLastFreed);
  
  const availableModels = useAppStore(state => state.availableModels);
  const selectedModel = useAppStore(state => state.settings.selectedModel);
  const extendedContext = useAppStore(state => state.settings.extendedContext);
  const extendedContextByModelId = useAppStore(state => state.settings.extendedContextByModelId);
  const extendedResolution = useMemo(
    () => getExtendedContextResolutionFromSettings({ extendedContext, extendedContextByModelId }),
    [extendedContext, extendedContextByModelId]
  );
  const pm = useAppStore(state => state.promptMetrics);
  
  const currentModel = availableModels.find(m => m.id === selectedModel);
  const maxTokens = currentModel
    ? (getEffectiveContextWindow(currentModel.id, currentModel.provider, currentModel.contextWindow, extendedResolution) ?? 200000)
    : 200000;
  
  const chunkCount = chunks.size;
  const getPromptTokens = useContextStore((s) => s.getPromptTokens);
  const wmTokens = useMemo(() => getPromptTokens(), [chunks, getPromptTokens]);
  const latestSnapshot = useRoundHistoryStore(s => s.snapshots.length > 0 ? s.snapshots[s.snapshots.length - 1] : undefined);
  const fallbackUsedTokens = wmTokens + (pm.totalOverheadTokens || 0);
  const usedTokens = latestSnapshot?.estimatedTotalPromptTokens ?? fallbackUsedTokens;
  const percentage = Math.min(100, (usedTokens / maxTokens) * 100);
  
  // Flash animation for freed tokens
  const [showFreed, setShowFreed] = useState(false);
  const [displayFreed, setDisplayFreed] = useState(0);
  
  useEffect(() => {
    if (lastFreed > 0 && lastFreedAt > 0) {
      setDisplayFreed(lastFreed);
      setShowFreed(true);
      
      // Clear animation after 2 seconds
      const timeout = setTimeout(() => {
        setShowFreed(false);
        clearLastFreed();
      }, 2000);
      
      return () => clearTimeout(timeout);
    }
  }, [lastFreed, lastFreedAt, clearLastFreed]);
  
  const getBarColor = () => {
    if (percentage >= 90) return 'bg-studio-error';
    if (percentage >= 70) return 'bg-studio-warning';
    return 'bg-studio-accent';
  };
  
  // Cost tracking from costStore
  const chatCostCents = useCostStore(state => state.chatCostCents);
  const sessionCostCents = useCostStore(state => state.sessionCostCents);
  const sessionInputTokens = useCostStore(state => state.sessionInputTokens);
  const sessionOutputTokens = useCostStore(state => state.sessionOutputTokens);
  const dailyUsage = useCostStore(state => state.dailyUsage);
  
  // Compute today's totals in useMemo to avoid infinite loop
  const todayTotalCents = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    return dailyUsage
      .filter(d => d.date === today)
      .reduce((sum, d) => sum + d.costCents, 0);
  }, [dailyUsage]);

  const promptOverhead = (pm.totalOverheadTokens || 0) - (pm.entryManifestTokens ?? 0);
  const hoverBreakdown = [
    'Context window budget:',
    `• Working memory: ${chunkCount} chunks → ${formatTokens(wmTokens)} (prompt WM)`,
    ...((pm.entryManifestTokens ?? 0) > 0
      ? [`• Entry manifest: ${formatTokens(pm.entryManifestTokens ?? 0)}`]
      : []),
    `• Prompt overhead: ${formatTokens(promptOverhead)}`,
    `    mode ${formatTokens(pm.modePromptTokens)} | tools ${formatTokens(pm.toolRefTokens)} | shell ${formatTokens(pm.shellGuideTokens)}`,
    `    ctx ${formatTokens(pm.contextControlTokens)} | workspace ${formatTokens(pm.workspaceContextTokens)}`,
    `    native ${formatTokens(pm.nativeToolTokens)} | primer ${formatTokens(pm.primerTokens)}`,
    `• Total: ${formatTokens(usedTokens)} / ${formatTokens(maxTokens)}`,
  ].join('\n');

  return (
    <div className="flex flex-col gap-0.5 px-2 py-0.5 text-[9px] text-studio-muted">
      {/* Token usage bar */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-studio-accent cursor-help" title={hoverBreakdown}>
          chunks:{chunkCount}{pm.totalOverheadTokens ? ` +${formatTokens(pm.totalOverheadTokens)}` : ''}
        </span>
        <div className="flex-1 h-1 bg-studio-border rounded-full overflow-hidden min-w-[40px] cursor-help" title={hoverBreakdown}>
          <div 
            className={`h-full transition-all duration-300 ${getBarColor()}`}
            style={{ width: `${percentage}%` }}
          />
        </div>
        <span className="shrink-0">{formatTokens(usedTokens)}/{formatTokens(maxTokens)}</span>
        {freedTokens > 0 && (
          <span className="shrink-0 text-studio-success">
            saved:{formatTokens(freedTokens)}
          </span>
        )}
        {showFreed && displayFreed > 0 && (
          <span className="shrink-0 text-studio-success animate-pulse font-medium">
            -{formatTokens(displayFreed)} freed!
          </span>
        )}
        {/* Input/output token split */}
        {(sessionInputTokens > 0 || sessionOutputTokens > 0) && (
          <span className="shrink-0 text-studio-text-secondary" title={`Session input: ${sessionInputTokens.toLocaleString()} | output: ${sessionOutputTokens.toLocaleString()}`}>
            in:{formatTokens(sessionInputTokens)} out:{formatTokens(sessionOutputTokens)}
          </span>
        )}
        {/* Cost display: chat | session | today */}
        <span className="shrink-0 text-studio-title" title={`Chat: ${formatCost(chatCostCents)} | Session: ${formatCost(sessionCostCents)} | Today: ${formatCost(todayTotalCents)}`}>
          {chatCostCents > 0 && (
            <span className="text-studio-accent">{formatCost(chatCostCents)}</span>
          )}
          {sessionCostCents > chatCostCents && (
            <span className="text-studio-text ml-1">{formatCost(sessionCostCents)}</span>
          )}
          {todayTotalCents > sessionCostCents && (
            <span className="text-studio-muted ml-1">{formatCost(todayTotalCents)}</span>
          )}
          {chatCostCents === 0 && sessionCostCents === 0 && todayTotalCents === 0 && (
            <span className="text-studio-muted">$0</span>
          )}
        </span>
      </div>
    </div>
  );
});

// Compact context metrics — prompt overhead breakdown + cumulative savings
type OverheadSegment = { label: string; tokens: number; color: string };
type BudgetBucket = { label: string; tokens: number; color: string };
const ContextMetrics = memo(function ContextMetrics() {
  const pm = useAppStore(state => state.promptMetrics);
  const cacheMetrics = useAppStore(state => state.cacheMetrics);
  const logicalCache = useAppStore(state => state.logicalCache);
  const freedTokens = useContextStore(state => state.freedTokens);
  const chunks = useContextStore(state => state.chunks);
  const getPromptTokens = useContextStore((s) => s.getPromptTokens);
  const availableModels = useAppStore(state => state.availableModels);
  const selectedModel = useAppStore(state => state.settings.selectedModel);
  const extendedContext = useAppStore(state => state.settings.extendedContext);
  const extendedContextByModelId = useAppStore(state => state.settings.extendedContextByModelId);
  const extendedResolution = useMemo(
    () => getExtendedContextResolutionFromSettings({ extendedContext, extendedContextByModelId }),
    [extendedContext, extendedContextByModelId]
  );
  const emDepth = useAppStore(state => state.settings.entryManifestDepth) ?? 'sigs';
  const [expanded, setExpanded] = useState(false);

  const currentModel = availableModels.find(m => m.id === selectedModel);
  const maxTokens = currentModel
    ? (getEffectiveContextWindow(currentModel.id, currentModel.provider, currentModel.contextWindow, extendedResolution) ?? 200000)
    : 200000;
  const provider = currentModel?.provider || getProviderFromModel(selectedModel);

  const latestSnapshot = useRoundHistoryStore(s => s.snapshots.length > 0 ? s.snapshots[s.snapshots.length - 1] : undefined);
  const wmTokens = useMemo(() => getPromptTokens(), [chunks, getPromptTokens]);
  const fallbackUsedTokens = wmTokens + (pm.totalOverheadTokens || 0);
  const usedTokens = latestSnapshot?.estimatedTotalPromptTokens ?? fallbackUsedTokens;

  const budgetSplitBuckets = useMemo((): BudgetBucket[] => {
    if (!latestSnapshot) return [];
    const s = latestSnapshot;
    return [
      { label: 'System', tokens: s.staticSystemTokens, color: 'bg-purple-500/70' },
      { label: 'History', tokens: s.conversationHistoryTokens, color: 'bg-violet-500/70' },
      { label: 'Staged', tokens: s.stagedBucketTokens, color: 'bg-fuchsia-500/70' },
      { label: 'WM', tokens: s.wmTokens, color: 'bg-studio-accent' },
      { label: 'Workspace', tokens: s.workspaceContextTokens, color: 'bg-amber-500/70' },
    ].filter((b) => b.tokens > 0);
  }, [latestSnapshot]);

  // Per-round savings = what we avoid sending each time the API is called
  const perRoundSavings = pm.compressionSavings + (pm.rollingSavings ?? 0) + freedTokens;
  // Cumulative = sum of perRoundSavings across all rounds (compounding effect)
  const { cumulativeInputSaved, roundCount } = pm;
  const hasData =
    pm.totalOverheadTokens > 0
    || perRoundSavings > 0
    || cumulativeInputSaved > 0
    || chunks.size > 0
    || latestSnapshot != null;

  const overheadPct = Math.min(100, (pm.totalOverheadTokens / maxTokens) * 100);
  const efficiency = usedTokens > 0
    ? Math.round((wmTokens / usedTokens) * 100)
    : 100;

  // Cost estimate using real model pricing on cumulative input tokens avoided
  const cumulativeCostCents = calculateCost(provider as CostProvider, selectedModel, cumulativeInputSaved, 0);

  const segments: OverheadSegment[] = useMemo(() => {
    const segs: OverheadSegment[] = [
      { label: 'Mode Prompt', tokens: pm.modePromptTokens, color: 'bg-purple-500' },
      { label: 'Tool Reference', tokens: pm.toolRefTokens, color: 'bg-blue-500' },
      { label: 'Shell Guide', tokens: pm.shellGuideTokens, color: 'bg-cyan-500' },
      { label: 'Native Tools', tokens: pm.nativeToolTokens, color: 'bg-rose-500' },
      { label: 'Context Control (BP1)', tokens: pm.contextControlTokens, color: 'bg-indigo-500' },
      { label: 'Workspace Ctx', tokens: pm.workspaceContextTokens, color: 'bg-amber-500' },
    ].filter(s => s.tokens > 0);
    if (emDepth !== 'off') {
      segs.push({ label: 'Entry Manifest', tokens: pm.entryManifestTokens ?? 0, color: 'bg-emerald-500' });
    }
    return segs;
  }, [pm.modePromptTokens, pm.toolRefTokens, pm.shellGuideTokens, pm.nativeToolTokens, pm.contextControlTokens, pm.workspaceContextTokens, pm.entryManifestTokens, emDepth]);

  return (
    <div className="px-2 text-[9px] text-studio-muted">
      <button
        className="w-full flex items-center gap-1.5 py-0.5 hover:text-studio-text transition-colors"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="text-studio-accent shrink-0">metrics</span>
        {hasData ? (
          <>
            <span className="shrink-0">overhead:{formatTokens(pm.totalOverheadTokens)}</span>
        {cumulativeInputSaved > 0 && (
          <span className="shrink-0 text-studio-success">saved:{formatTokens(cumulativeInputSaved)}</span>
        )}
        {roundCount > 0 && (
          <span className="shrink-0">r:{roundCount}</span>
        )}
        <span className="shrink-0">eff:{efficiency}%</span>
        {cacheMetrics.sessionRequests > 0 && (
          <span className="shrink-0 text-studio-success">cache:{Math.round(cacheMetrics.sessionHitRate * 100)}%</span>
        )}
        {provider === 'anthropic' && logicalCache.bp3Hit !== null && (
          <span className={`shrink-0 ${logicalCache.bp3Hit ? 'text-green-400' : 'text-red-400'}`}>
            bp3:{logicalCache.bp3Hit ? 'hit' : 'miss'}
          </span>
        )}
          </>
        ) : (
          <span className="shrink-0 text-studio-muted">no data yet</span>
        )}
        <svg className={`w-2.5 h-2.5 text-studio-text-muted transition-transform ml-auto ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {expanded && (
        <div className="pb-1 space-y-1.5">
          {/* Overhead breakdown bar */}
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-studio-text-secondary">Prompt Overhead</span>
              <span>{formatTokens(pm.totalOverheadTokens)} ({overheadPct.toFixed(1)}% of window)</span>
            </div>
            <div className="flex h-1.5 rounded-full overflow-hidden bg-studio-border">
              {segments.map((seg) => {
                const pct = pm.totalOverheadTokens > 0 ? (seg.tokens / pm.totalOverheadTokens) * 100 : 0;
                return (
                  <div
                    key={seg.label}
                    className={`${seg.color} transition-all`}
                    style={{ width: `${pct}%` }}
                    title={`${seg.label}: ${formatTokens(seg.tokens)}`}
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-x-2 gap-y-0 mt-0.5">
              {segments.map((seg) => (
                <span key={seg.label} className="flex items-center gap-0.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${seg.color}`} />
                  <span>{seg.label} {formatTokens(seg.tokens)}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Savings breakdown — per-round + cumulative */}
          {(perRoundSavings > 0 || cumulativeInputSaved > 0) && (
            <div className="border-t border-studio-border pt-1">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-studio-text-secondary">Context Savings</span>
                <span className="text-studio-text-muted">{roundCount} round{roundCount !== 1 ? 's' : ''}</span>
              </div>
              {/* Per-round breakdown */}
              <div className="flex flex-wrap gap-x-3 gap-y-0">
                <span className="text-studio-text-secondary">per round:</span>
                {pm.compressionSavings > 0 && (
                  <span>compression {formatTokens(pm.compressionSavings)} ({pm.compressionCount} items)</span>
                )}
                {(pm.rollingSavings ?? 0) > 0 && (
                  <span>rolling {formatTokens(pm.rollingSavings ?? 0)} ({pm.rolledRounds ?? 0} rounds distilled)</span>
                )}
                {freedTokens > 0 && (
                  <span>freed {formatTokens(freedTokens)}</span>
                )}
                {pm.orphanSummaryRemovals > 0 && (
                  <span>orphans {pm.orphanSummaryRemovals} removed</span>
                )}
                {perRoundSavings > 0 && (
                  <span className="text-studio-text-secondary">= {formatTokens(perRoundSavings)}/call</span>
                )}
              </div>
              {/* Cumulative — the real cost impact */}
              {cumulativeInputSaved > 0 && (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-studio-success font-medium">
                    cumulative: {formatTokens(cumulativeInputSaved)} input tokens avoided
                  </span>
                  {cumulativeCostCents > 0 && (
                    <span className="text-studio-success">
                      (~{formatCost(cumulativeCostCents)} saved)
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Cache performance */}
          {cacheMetrics.sessionRequests > 0 && (
            <div className="border-t border-studio-border pt-1">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-studio-text-secondary">Cache Performance</span>
                <span>{cacheMetrics.sessionRequests} request{cacheMetrics.sessionRequests !== 1 ? 's' : ''}</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0">
                <span className="text-studio-success font-medium">
                  hit rate: {Math.round(cacheMetrics.sessionHitRate * 100)}%
                </span>
                {cacheMetrics.sessionCacheReads > 0 && (
                  <span>reads: {formatTokens(cacheMetrics.sessionCacheReads)}</span>
                )}
                {cacheMetrics.sessionCacheWrites > 0 && (
                  <span>writes: {formatTokens(cacheMetrics.sessionCacheWrites)}</span>
                )}
                {cacheMetrics.sessionUncached > 0 && (
                  <span className="text-studio-text-secondary">uncached: {formatTokens(cacheMetrics.sessionUncached)}</span>
                )}
              </div>
              {cacheMetrics.sessionCacheReads > 0 && (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-studio-success">
                    ~{formatCost(calculateCost(provider as CostProvider, selectedModel, cacheMetrics.sessionCacheReads, 0) * (
                      provider === 'openai' ? 0.5
                      : (provider === 'google' || provider === 'vertex') ? 0.75
                      : 0.9
                    ))} saved via cache
                  </span>
                </div>
              )}
              {provider === 'anthropic' && logicalCache.staticHit !== null && (
                <div className="flex flex-wrap gap-x-3 gap-y-0 mt-0.5">
                  <span className="text-studio-text-secondary">expected:</span>
                  <span className={logicalCache.staticHit ? 'text-green-400' : 'text-red-400'}>
                    Static {logicalCache.staticHit ? 'HIT' : 'MISS'}
                  </span>
                  <span className={logicalCache.bp3Hit ? 'text-green-400' : 'text-red-400'}>
                    BP3 {logicalCache.bp3Hit ? 'HIT' : 'MISS'}
                    {logicalCache.bp3Reason && <span className="text-studio-muted"> ({logicalCache.bp3Reason})</span>}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Context budget split — buckets match aiService RoundSnapshot / getEstimatedTotalPromptTokens */}
          <div className="border-t border-studio-border pt-1">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-studio-text-secondary">Budget Split</span>
              <span>{formatTokens(usedTokens)} / {formatTokens(maxTokens)}</span>
            </div>
            {latestSnapshot && budgetSplitBuckets.length > 0 ? (
              <>
                <div className="flex h-1.5 rounded-full overflow-hidden bg-studio-border">
                  {budgetSplitBuckets.map((b) => (
                    <div
                      key={b.label}
                      className={`${b.color} transition-all`}
                      style={{ width: `${Math.min(100, (b.tokens / maxTokens) * 100)}%` }}
                      title={`${b.label}: ${formatTokens(b.tokens)}`}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0 mt-0.5">
                  {budgetSplitBuckets.map((b) => (
                    <span key={b.label} className="flex items-center gap-0.5">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${b.color}`} />
                      {b.label.toLowerCase()} {formatTokens(b.tokens)}
                    </span>
                  ))}
                  <span className="flex items-center gap-0.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-studio-border" />
                    free {formatTokens(Math.max(0, maxTokens - usedTokens))}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex h-1.5 rounded-full overflow-hidden bg-studio-border">
                  <div
                    className="bg-studio-accent/80 transition-all"
                    style={{ width: `${Math.min(100, maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0)}%` }}
                    title={`WM + overhead estimate: ${formatTokens(usedTokens)}`}
                  />
                </div>
                <div className="text-[9px] text-studio-text-muted mt-0.5">
                  {latestSnapshot
                    ? 'Bucket segments are zero; total above still reflects last round estimate.'
                    : 'No round snapshot yet — bar is WM + overhead estimate; bucketed split after the first completed round.'}
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0 mt-0.5">
                  <span className="flex items-center gap-0.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-studio-border" />
                    free {formatTokens(Math.max(0, maxTokens - usedTokens))}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

type RenderToolStatus = ToolCall['status'] | ToolCallStatus | MessageToolCall['status'];

type ToolCallLike = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  status: RenderToolStatus;
  thoughtSignature?: string;
  /** Per-step rows from batch execution (authoritative after tool completes). */
  syntheticChildren?: Array<{
    id: string;
    name: string;
    args?: Record<string, unknown>;
    result?: string;
    status?: string;
  }>;
};

type BatchStepCall = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  status: ToolCall['status'];
  thoughtSignature?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function formatLabelSegment(segment: string): string {
  return segment
    .split(/[_-]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

import { FAMILY_ICONS } from '../../services/batch/families';

function getFriendlyToolName(toolName: string): string {
  if (toolName === 'batch') return '⚡ ATLS';
  if (toolName === 'task_complete') return '✅ Task Complete';

  if (toolName.includes('.')) {
    const [family, action] = toolName.split('.', 2);
    const icon = FAMILY_ICONS[family] || '🔧';
    const label = [family, action]
      .filter(Boolean)
      .map(formatLabelSegment)
      .join(' ');
    return `${icon} ${label}`;
  }

  return `🔧 ${toolName}`;
}

function getToolDetail(toolName: string, params: Record<string, unknown>): string {
  if (params.file_paths && Array.isArray(params.file_paths) && params.file_paths[0]) {
    return String(params.file_paths[0]);
  }
  if (params.file_path) {
    return String(params.file_path);
  }
  if (params.file || params.path) {
    return String(params.file || params.path);
  }
  if (params.symbol_names && Array.isArray(params.symbol_names)) {
    return params.symbol_names.map(s => String(s)).join(', ');
  }
  if (params.queries && Array.isArray(params.queries) && params.queries[0]) {
    return String(params.queries[0]);
  }
  if (params.query) {
    return String(params.query);
  }
  if (params.operation) {
    return String(params.operation);
  }
  if (params.action) {
    return String(params.action);
  }
  return '';
}

function getBatchSteps(args?: Record<string, unknown>): Array<{ id: string; use: string; with: Record<string, unknown> }> {
  const steps = Array.isArray(args?.steps) ? args.steps : [];
  return steps.map((step, index) => {
    const record = asRecord(step) || {};
    const withParams = asRecord(record.with) || {};
    const use = typeof record.use === 'string' && record.use.trim()
      ? record.use
      : `step.${index + 1}`;
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id
      : `step-${index + 1}`;
    return { id, use, with: withParams };
  });
}

function truncateToolResult(result: string, maxLen: number = 240): string {
  if (!result) return '';
  const normalized = result.trim();
  if (normalized.length <= maxLen) return normalized;
  const headLength = Math.max(120, Math.floor(maxLen * 0.65));
  const head = normalized.slice(0, headLength).trimEnd();
  const omitted = Math.max(0, normalized.length - maxLen);
  const tailBudget = Math.max(40, maxLen - head.length - 24);
  const tail = omitted > 0 ? normalized.slice(-tailBudget).trimStart() : '';
  return tail
    ? `${head}\n…[truncated ${omitted} chars]…\n${tail}`
    : head;
}

function parseBatchStepLines(result?: string): Array<{ text: string; failed: boolean }> {
  if (!result) return [];
  return result
    .split(/\r?\n/g)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^\[(?:batch|atls)\]/i.test(line))
    .map(line => ({
      text: line,
      failed: /(?:^|:\s)ERROR\b/i.test(line),
    }));
}

function isBatchCall(call: { name: string; args?: Record<string, unknown> }): boolean {
  return call.name === 'batch';
}

function mapSyntheticStepStatus(raw: string | undefined): ToolCall['status'] {
  if (raw === 'failed') return 'failed';
  if (raw === 'running') return 'running';
  if (raw === 'pending') return 'pending';
  return 'completed';
}

function expandBatchToolCall(toolCall: ToolCallLike): BatchStepCall[] {
  if (!isBatchCall(toolCall)) {
    return [];
  }

  const synth = toolCall.syntheticChildren;
  if (synth && synth.length > 0) {
    return synth.map((child) => ({
      id: child.id,
      name: child.name,
      args: child.args,
      result: child.result,
      status: mapSyntheticStepStatus(child.status),
      thoughtSignature: toolCall.thoughtSignature,
    }));
  }

  const batchArgs = toolCall.args || {};
  const steps = getBatchSteps(batchArgs);
  if (steps.length === 0) {
    return [];
  }

  const stepLines = parseBatchStepLines(toolCall.result);
  const completedCount = stepLines.length;
  const runningIndex = Math.min(completedCount, Math.max(steps.length - 1, 0));

  return steps.map((step, index) => {
    const line = stepLines[index];
    let status: ToolCall['status'] = 'pending';
    let result = line?.text;

    if (line) {
      status = line.failed ? 'failed' : 'completed';
    } else if (toolCall.status === 'running') {
      status = index === runningIndex ? 'running' : index < runningIndex ? 'completed' : 'pending';
    } else if (toolCall.status === 'pending' || toolCall.status === 'input-streaming' || toolCall.status === 'input-available') {
      status = 'pending';
    } else if (toolCall.status === 'completed') {
      status = 'completed';
    } else if (toolCall.status === 'failed') {
      status = 'failed';
      result = result || 'Not executed because the ATLS batch stopped before this step.';
    }

    return {
      id: `${toolCall.id}::${step.id}`,
      name: step.use,
      args: step.with,
      result,
      status,
      thoughtSignature: toolCall.thoughtSignature,
    };
  });
}

function getBatchDisplayDetail(params: Record<string, unknown>): string {
  const goal = typeof params.goal === 'string' ? params.goal.trim() : '';
  if (goal) return goal;
  const steps = getBatchSteps(params);
  const firstStep = steps[0];
  if (!firstStep) return '';
  return getToolDetail(firstStep.use, firstStep.with) || firstStep.use || `${steps.length} steps`;
}

// Tool call display helper - shared between inline and message displays
function getToolDisplayInfo(call: { name: string; args?: Record<string, unknown> }) {
  const args = call.args || {};
  const toolName = (args.tool as string) || call.name;
  const params = (args.params as Record<string, unknown>) || args;

  const friendly = getFriendlyToolName(toolName);
  const detail = toolName === 'batch'
    ? getBatchDisplayDetail(params)
    : getToolDetail(toolName, params);

  return { friendly, detail, fullName: detail ? `${friendly}: ${detail}` : friendly };
}

const BatchGroupLabel = memo(function BatchGroupLabel({ stepCount }: { stepCount: number }) {
  return (
    <div className="px-1 pb-0.5">
      <span className="inline-flex items-center rounded-full border border-studio-accent/20 bg-studio-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-studio-accent">
        ATLS {stepCount > 1 ? `• ${stepCount} steps` : ''}
      </span>
    </div>
  );
});

const MessageBatchToolCalls = memo(function MessageBatchToolCalls({ toolCall }: { toolCall: MessageToolCall }) {
  const childCalls = useMemo(() => expandBatchToolCall(toolCall), [toolCall]);
  if (childCalls.length === 0) {
    return <MessageToolCallBubble toolCall={toolCall} />;
  }
  return (
    <div className="space-y-1">
      <BatchGroupLabel stepCount={childCalls.length} />
      {childCalls.map((childCall) => (
        <MessageToolCallBubble
          key={childCall.id}
          toolCall={{
            id: childCall.id,
            name: childCall.name,
            args: childCall.args,
            result: childCall.result,
            status:
              childCall.status === 'failed' ? 'failed'
              : childCall.status === 'running' ? 'running'
              : childCall.status === 'pending' ? 'pending'
              : 'completed',
            thoughtSignature: childCall.thoughtSignature,
          }}
        />
      ))}
    </div>
  );
});

const StreamingBatchToolCalls = memo(function StreamingBatchToolCalls({ toolCall }: { toolCall: ToolCall }) {
  const childCalls = useMemo(() => expandBatchToolCall(toolCall), [toolCall]);
  if (childCalls.length === 0) {
    return <ToolSegmentBubble toolCall={toolCall} />;
  }
  return (
    <div className="space-y-1">
      <BatchGroupLabel stepCount={childCalls.length} />
      {childCalls.map((childCall) => (
        <ToolSegmentBubble
          key={childCall.id}
          toolCall={{
            id: childCall.id,
            name: childCall.name,
            args: childCall.args,
            result: childCall.result,
            status: childCall.status,
            startTime: toolCall.startTime,
            endTime: toolCall.endTime,
            thoughtSignature: childCall.thoughtSignature,
          }}
        />
      ))}
    </div>
  );
});

// Tool call display in message bubble - memoized
const MessageToolCallBubble = memo(function MessageToolCallBubble({ toolCall }: { toolCall: MessageToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const { friendly, detail, fullName: _fullName } = getToolDisplayInfo(toolCall);
  
  const truncate = (text: unknown, maxLen: number = 50): string => {
    const str = String(text ?? '');
    return str.length <= maxLen ? str : str.substring(0, maxLen - 3) + '...';
  };
  
  return (
    <div className="my-0.5">
      <div 
        className={`flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer
          ${toolCall.status === 'completed' 
            ? 'bg-studio-accent/10 border border-studio-accent/30 text-studio-text/70' 
            : 'bg-studio-error/10 border border-studio-error/30 text-studio-error'
          }`}
        onClick={() => setExpanded(!expanded)}
      >
        {toolCall.status === 'completed' ? <CheckIcon /> : <ErrorIcon />}
        <span className="font-medium">{friendly}</span>
        {detail && <span className="text-studio-muted truncate max-w-[150px]">{truncate(detail)}</span>}
        <svg 
          className={`w-3 h-3 transition-transform ml-auto ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24" fill="currentColor"
        >
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </div>
      {expanded && toolCall.result && (
        <pre className="mt-1 p-2 text-[10px] bg-studio-bg rounded overflow-x-auto max-h-32 scrollbar-thin whitespace-pre-wrap">
          {truncateToolResult(toolCall.result)}
        </pre>
      )}
    </div>
  );
});

// Parse status markers like «st:working|step:1/3» into styled components
function parseStatusMarkers(text: string): (string | { type: 'status'; status: string; step?: string; next?: string })[] {
  const parts: (string | { type: 'status'; status: string; step?: string; next?: string })[] = [];
  // Match «...» markers with various formats
  const regex = /«([^»]+)»/g;
  let lastIndex = 0;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    // Add text before the marker
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    
    // Parse the marker content
    const markerContent = match[1];
    const parsed: { type: 'status'; status: string; step?: string; next?: string } = { type: 'status', status: '' };
    
    // Parse key:value pairs separated by |
    markerContent.split('|').forEach(pair => {
      const [key, value] = pair.split(':').map(s => s.trim());
      if (key === 'st') parsed.status = value;
      else if (key === 'step') parsed.step = value;
      else if (key === 'next') parsed.next = value;
    });
    
    parts.push(parsed);
    lastIndex = regex.lastIndex;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  
  return parts;
}

// Status badge component - blue box for working, green for done
// Labels unified with AgentStatusCard terminology
const STATUS_LABELS: Record<string, string> = { working: 'Working', done: 'Completed' };

const StatusBadge = memo(function StatusBadge({ 
  status, 
  step, 
  next 
}: { 
  status: string; 
  step?: string; 
  next?: string; 
}) {
  const isWorking = status === 'working';
  const isDone = status === 'done';
  const label = STATUS_LABELS[status] ?? status;
  
  return (
    <span className={`
      inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium
      ${isDone 
        ? 'bg-studio-title/20 text-studio-title border border-studio-title/30' 
        : 'bg-studio-title/15 text-studio-title border border-studio-title/25'
      }
    `}>
      {isWorking && (
        <span className="w-2 h-2 rounded-full bg-studio-title animate-pulse" />
      )}
      {isDone && (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      )}
      <span>{label}</span>
      {step && <span className="opacity-70">• {step}</span>}
      {next && <span className="opacity-70">→ {next}</span>}
    </span>
  );
});

// Text segment in finalized message - renders markdown
const MessageTextSegment = memo(function MessageTextSegment({ content, nextToolHint }: { content: string; nextToolHint?: string }) {
  const cleaned = useMemo(() => {
    let text = cleanStreamingContent(content);
    if (nextToolHint && text) {
      text = text.replace(
        /«(st:\s*working\|[^»]*)»/,
        `«$1|next:${nextToolHint}»`
      );
    }
    return text;
  }, [content, nextToolHint]);
  if (!cleaned) return null;
  
  return (
    <div className="p-3">
      <MarkdownMessage content={cleaned} />
    </div>
  );
});

// Memoized message bubble to prevent re-renders during streaming
interface MessageBubbleProps {
  message: Message;
  isEditing: boolean;
  onStartEdit: (messageId: string) => void;
  onSaveEdit: (messageId: string, content: string) => void;
  onCancelEdit: () => void;
}

const MessageBubble = memo(function MessageBubble({ message, isEditing, onStartEdit, onSaveEdit, onCancelEdit }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [editText, setEditText] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const isGenerating = useAppStore(state => state.isGenerating);

  useEffect(() => {
    if (isEditing) {
      setEditText(message.content);
      requestAnimationFrame(() => {
        if (editRef.current) {
          editRef.current.focus();
          editRef.current.style.height = 'auto';
          editRef.current.style.height = editRef.current.scrollHeight + 'px';
        }
      });
    }
  }, [isEditing, message.content]);
  
  const timeString = useMemo(() => message.timestamp.toLocaleTimeString(), [message.timestamp]);

  const handleMessageAction = useCallback((action: { type: 'view' | 'explain'; label: string; data: unknown }) => {
    const { addMessage } = useAppStore.getState();
    if (action.type === 'explain') {
      addMessage({ role: 'user', content: `Explain: ${action.label}` });
    } else if (action.type === 'view' && typeof action.data === 'string') {
      addMessage({ role: 'user', content: `Show details for: ${action.data}` });
    }
  }, []);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancelEdit();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (editText.trim()) onSaveEdit(message.id, editText.trim());
    }
  }, [editText, message.id, onSaveEdit, onCancelEdit]);
  
  const parts = getMessageParts(message);
  const hasRichContent = !isUser && parts.length > 0;

  // User messages: edit button sits outside the bubble, between bubble and avatar
  const editButton = isUser && !isEditing && !isGenerating ? (
    <button
      onClick={() => onStartEdit(message.id)}
      className="self-end p-1 rounded opacity-0 group-hover/msg:opacity-50 hover:!opacity-100 transition-opacity shrink-0"
      title="Edit and resend"
    >
      <EditIcon />
    </button>
  ) : null;

  return (
    <div className={`group/msg flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`
        w-8 h-8 rounded-full flex items-center justify-center shrink-0
        ${isUser ? 'bg-studio-accent' : 'bg-studio-surface'}
      `}>
        {isUser ? <UserIcon /> : <AIIcon />}
      </div>

      <div className={`
        max-w-[80%] rounded-lg
        ${isUser 
          ? 'bg-studio-accent-bright text-studio-bg p-3' 
          : 'bg-studio-surface border border-studio-border'
        }
      `}>
        {hasRichContent ? (
          <div className="space-y-2">
            {parts.map((part, idx, arr) => {
              if (part.type === 'text') {
                const next = arr[idx + 1];
                const nextTool = next?.type === 'tool' ? next.toolCall : undefined;
                const nextToolHint = nextTool ? getToolDisplayInfo(nextTool).friendly.replace(/^[^\w]*/, '') : undefined;
                return <MessageTextSegment key={`text-${idx}`} content={part.content} nextToolHint={nextToolHint} />;
              } else if (part.type === 'reasoning') {
                return <ReasoningBlock key={`reasoning-${idx}`} content={part.content} isStreaming={false} />;
              } else if (part.type === 'step-boundary') {
                return <StepBoundary key={`step-${idx}`} stepNumber={
                  arr.slice(0, idx).filter(p => p.type === 'step-boundary').length + 2
                } />;
              } else if (part.type === 'error') {
                return <ErrorPart key={`error-${idx}`} errorText={part.errorText} />;
              } else if (part.type === 'tool') {
                if (isTaskCompleteCall(part.toolCall)) {
                  const { summary, filesChanged } = getTaskCompleteArgs(part.toolCall);
                  return <TaskCompleteCard key={`task-complete-${idx}`} summary={summary} filesChanged={filesChanged} />;
                }
                const isSubagentCall = part.toolCall.name === 'subagent';
                if (isSubagentCall) {
                  return (
                    <div key={`subagent-${part.toolCall.id}`} className="px-2">
                      <SubAgentCard toolCall={part.toolCall as unknown as ToolCall} />
                    </div>
                  );
                }
                return (
                  <div key={`tool-${part.toolCall.id}`} className="px-2">
                    {isBatchCall(part.toolCall)
                      ? <MessageBatchToolCalls toolCall={part.toolCall} />
                      : <MessageToolCallBubble toolCall={part.toolCall} />}
                  </div>
                );
              }
              return null;
            })}
            <div className="p-3 pt-0">
              {message.actions && message.actions.length > 0 && (
                <div className="flex gap-2 mb-2 pt-2 border-t border-studio-border/30">
                  {message.actions.map((action, idx) => (
                    <button
                      key={idx}
                      className="text-xs px-2 py-1 bg-studio-accent/20 text-studio-accent rounded hover:bg-studio-accent/30 transition-colors"
                      onClick={() => handleMessageAction(action)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
              <span className="text-xs text-studio-muted/70 block">
                {timeString}
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className={!isUser ? 'p-3' : ''}>
              {isUser ? (
                isEditing ? (
                  <div className="space-y-2">
                    <textarea
                      ref={editRef}
                      value={editText}
                      onChange={(e) => {
                        setEditText(e.target.value);
                        e.target.style.height = 'auto';
                        e.target.style.height = e.target.scrollHeight + 'px';
                      }}
                      onKeyDown={handleEditKeyDown}
                      className="w-full bg-studio-bg/80 text-studio-text text-sm rounded p-2 resize-none focus:outline-none focus:ring-1 focus:ring-studio-accent min-h-[40px] max-h-[200px]"
                      rows={1}
                    />
                    <div className="flex gap-1.5 justify-end">
                      <button
                        onClick={onCancelEdit}
                        className="px-2 py-0.5 text-xs rounded bg-studio-bg/50 text-studio-text/70 hover:text-studio-text transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => { if (editText.trim()) onSaveEdit(message.id, editText.trim()); }}
                        disabled={!editText.trim()}
                        className="px-2 py-0.5 text-xs rounded bg-studio-bg/80 text-studio-accent hover:bg-studio-bg transition-colors disabled:opacity-40"
                      >
                        Save {'&'} Resend
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {message.attachments.map(att => (
                          att.fileType === 'code' ? (
                            <SignatureView key={att.id} attachment={att} />
                          ) : att.fileType === 'image' || att.type === 'image' ? (
                            <ImageAttachment key={att.id} attachment={att} />
                          ) : null
                        ))}
                      </div>
                    )}
                  </>
                )
              ) : (() => {
                const summary = getTaskCompleteSummaryFromParts(parts);
                if (summary && !String(message.content || '').trim()) return null;
                const contentTrimmed = String(message.content || '').trim();
                if (summary && contentTrimmed && contentTrimmed === summary) return null;
                return <MarkdownMessage content={message.content} />;
              })()}
              
              {message.actions && message.actions.length > 0 && (
                <div className="flex gap-2 mt-2 pt-2 border-t border-studio-border/30">
                  {message.actions.map((action, idx) => (
                    <button
                      key={idx}
                      className="text-xs px-2 py-1 bg-studio-accent/20 text-studio-accent rounded hover:bg-studio-accent/30 transition-colors"
                      onClick={() => handleMessageAction(action)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
              
              {!isEditing && (
                <span className={`text-xs mt-1 block ${isUser ? 'text-studio-bg/50' : 'text-studio-muted/70'}`}>
                  {timeString}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {editButton}
    </div>
  );
});

interface MessageListProps {
  messages: Message[];
  editingMessageId: string | null;
  onStartEdit: (messageId: string) => void;
  onSaveEdit: (messageId: string, content: string) => void;
  onCancelEdit: () => void;
}

const MessageList = memo(function MessageList({ messages, editingMessageId, onStartEdit, onSaveEdit, onCancelEdit }: MessageListProps) {
  return (
    <>
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          isEditing={editingMessageId === msg.id}
          onStartEdit={onStartEdit}
          onSaveEdit={onSaveEdit}
          onCancelEdit={onCancelEdit}
        />
      ))}
    </>
  );
});

// Streaming bubble with internal state - avoids parent re-renders
// Thinking pinwheel animation component
const ThinkingSpinner = memo(function ThinkingSpinner() {
  return (
    <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
      {/* Pinwheel blades */}
      <path d="M12 2C12 2 12 8 12 12C16 12 22 12 22 12C22 12 16 6 12 2Z" fill="currentColor" opacity="0.9" className="text-studio-accent" />
      <path d="M22 12C22 12 16 12 12 12C12 16 12 22 12 22C12 22 18 16 22 12Z" fill="currentColor" opacity="0.7" className="text-studio-accent" />
      <path d="M12 22C12 22 12 16 12 12C8 12 2 12 2 12C2 12 8 18 12 22Z" fill="currentColor" opacity="0.5" className="text-studio-accent" />
      <path d="M2 12C2 12 8 12 12 12C12 8 12 2 12 2C12 2 6 8 2 12Z" fill="currentColor" opacity="0.3" className="text-studio-accent" />
      {/* Center dot */}
      <circle cx="12" cy="12" r="2" fill="currentColor" className="text-studio-accent" />
    </svg>
  );
});

// Live research progress component - shows swarm research activity in chat
const SwarmResearchProgress = memo(function SwarmResearchProgress() {
  const status = useSwarmStore(state => state.status);
  const researchLogs = useSwarmStore(state => state.researchLogs);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  // Auto-scroll to latest log
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [researchLogs]);
  
  // Only show during research/planning phases
  if (status !== 'researching' && status !== 'planning') {
    return null;
  }
  
  return (
    <div className="flex gap-3 mb-4">
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-studio-accent/20">
        <ThinkingSpinner />
      </div>
      <div className="flex-1 max-w-[80%]">
        <div className="p-3 rounded-lg bg-studio-surface border border-studio-border">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-studio-accent">
              {status === 'researching' ? '🔍 Researching Codebase...' : '📋 Creating Plan...'}
            </span>
          </div>
          {researchLogs.length > 0 && (
            <div className="max-h-48 overflow-y-auto font-mono text-xs space-y-0.5 bg-studio-bg/50 rounded p-2">
              {researchLogs.slice(-15).map((log, i) => (
                <div key={i} className="text-studio-muted">{log}</div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// Live orchestration progress component - shows swarm execution in chat
const SwarmExecutionProgress = memo(function SwarmExecutionProgress() {
  const status = useSwarmStore(state => state.status);
  const tasks = useSwarmStore(state => state.tasks);
  const stats = useSwarmStore(state => state.stats);

  const { pending, running, completed, failed, total, progress } = useMemo(() => {
    const p = tasks.filter(t => t.status === 'pending');
    const r = tasks.filter(t => t.status === 'running');
    const c = tasks.filter(t => t.status === 'completed');
    const f = tasks.filter(t => t.status === 'failed');
    const tot = tasks.length;
    return {
      pending: p,
      running: r,
      completed: c,
      failed: f,
      total: tot,
      progress: tot > 0 ? Math.round((c.length / tot) * 100) : 0,
    };
  }, [tasks]);

  // Format cost
  const formatCostValue = (cents: number) => `$${(cents / 100).toFixed(4)}`;
  
  // Format time
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  // Only show during running phase (after hooks — Rules of Hooks)
  if (status !== 'running') {
    return null;
  }

  return (
    <div className="flex gap-3 mb-4">
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-studio-accent/20">
        <span className="text-lg">🐝</span>
      </div>
      <div className="flex-1 max-w-[80%]">
        <div className="p-3 rounded-lg bg-studio-surface border border-studio-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-studio-accent">
              Swarm Executing...
            </span>
            <span className="text-xs text-studio-muted">
              {progress}% • {formatTime(stats.elapsedMs)}
            </span>
          </div>
          
          {/* Progress bar */}
          <div className="h-2 bg-studio-bg rounded-full mb-3 overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-green-500 to-studio-accent transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          
          {/* Stats row */}
          <div className="flex gap-4 text-xs mb-3">
            <span className="text-yellow-400">⏳ {pending.length} pending</span>
            <span className="text-blue-400">🔄 {running.length} running</span>
            <span className="text-green-400">✅ {completed.length} done</span>
            {failed.length > 0 && <span className="text-red-400">❌ {failed.length} failed</span>}
          </div>
          
          {/* Running tasks */}
          {running.length > 0 && (
            <div className="space-y-1 mb-2">
              <div className="text-xs text-studio-muted font-medium">Active Agents:</div>
              {running.map(task => (
                <div key={task.id} className="flex items-center gap-2 text-xs bg-studio-bg/50 rounded px-2 py-1">
                  <ThinkingSpinner />
                  <span className="text-studio-title truncate flex-1">{task.title}</span>
                  <span className="text-studio-muted shrink-0">
                    {task.assignedRole}
                  </span>
                </div>
              ))}
            </div>
          )}
          
          {/* Recently completed */}
          {completed.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-studio-muted font-medium">Recently Completed:</div>
              {completed.slice(-3).map(task => (
                <div key={task.id} className="flex items-center gap-2 text-xs text-green-400/80">
                  <span>✓</span>
                  <span className="truncate">{task.title}</span>
                  {task.costCents > 0 && (
                    <span className="text-studio-muted ml-auto">{formatCostValue(task.costCents)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          
          {/* Total cost */}
          {stats.totalCostCents > 0 && (
            <div className="mt-2 pt-2 border-t border-studio-border/50 text-xs text-studio-muted">
              Total: {formatCostValue(stats.totalCostCents)} • {stats.totalTokensUsed.toLocaleString()} tokens
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// Typing cursor for streaming output
const TypingCursor = memo(function TypingCursor() {
  return (
    <span className="inline-block w-0.5 h-4 bg-studio-accent ml-0.5 animate-pulse" 
          style={{ animationDuration: '0.8s' }} />
  );
});

// Segment type for inline streaming display (extended with reasoning, step-boundary, error, status)
export type StreamSegment = 
  | { type: 'text'; id?: string; content: string; state?: 'streaming' | 'done' }
  | { type: 'reasoning'; id?: string; content: string; state?: 'streaming' | 'done' }
  | { type: 'tool'; toolCall: ToolCall }
  | { type: 'step-boundary' }
  | { type: 'error'; errorText: string }
  | { type: 'status'; message: string };

// ── ReasoningBlock: collapsible thinking display ────────────────────────
const ReasoningBlock = memo(function ReasoningBlock({ 
  content, 
  isStreaming 
}: { 
  content: string; 
  isStreaming: boolean;
}) {
  const [isOpen, setIsOpen] = useState(true);
  
  useEffect(() => {
    if (!isStreaming) setIsOpen(false);
  }, [isStreaming]);
  
  return (
    <details open={isOpen || undefined} className="group">
      <summary 
        className="flex items-center gap-2 cursor-pointer select-none text-xs text-studio-text-secondary hover:text-studio-text-primary transition-colors py-1"
        onClick={(e) => { e.preventDefault(); setIsOpen(!isOpen); }}
      >
        <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
        <span className="font-medium">
          {isStreaming ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-studio-accent animate-pulse" />
              Thinking...
            </span>
          ) : 'Thought'}
        </span>
      </summary>
      {isOpen && (
        <div className="mt-1 ml-5 pl-3 border-l-2 border-studio-border/30 text-sm text-studio-text-secondary italic whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
          {content}
        </div>
      )}
    </details>
  );
});

// ── StepBoundary: visual divider between LLM rounds ────────────────────
const StepBoundary = memo(function StepBoundary({ stepNumber }: { stepNumber: number }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="flex-1 h-px bg-studio-border/30" />
      <span className="text-[10px] font-medium text-studio-text-secondary/50 uppercase tracking-wider">
        Step {stepNumber}
      </span>
      <div className="flex-1 h-px bg-studio-border/30" />
    </div>
  );
});

// ── ErrorPart: inline error display (replaces fake error messages) ──────
const ErrorPart = memo(function ErrorPart({ errorText }: { errorText: string }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
      <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
      </svg>
      <div className="text-sm text-red-300">
        <span className="font-medium">Error: </span>
        {errorText}
      </div>
    </div>
  );
});

// Single text bubble component for segments
const TextSegmentBubble = memo(function TextSegmentBubble({ 
  content, 
  isLast, 
  isGenerating,
  nextToolHint
}: { 
  content: string; 
  isLast: boolean; 
  isGenerating: boolean;
  nextToolHint?: string;
}) {
  const cleaned = useMemo(() => {
    let text = cleanStreamingContent(content);
    if (nextToolHint && text) {
      text = text.replace(
        /«(st:\s*working\|[^»]*)»/,
        `«$1|next:${nextToolHint}»`
      );
    }
    return text;
  }, [content, nextToolHint]);
  
  if (!cleaned) return null;
  
  return (
    <div className="p-3 rounded-lg bg-studio-surface border border-studio-border">
      <MarkdownMessage content={cleaned} />
      {isLast && isGenerating && <TypingCursor />}
    </div>
  );
});

// SubAgent collapsible card — renders a richer view for subagent tool calls
const SUBAGENT_ROLE_LABELS: Record<string, string> = {
  retriever: 'Retriever',
  design: 'Design',
  coder: 'Coder',
  tester: 'Tester',
};
const SUBAGENT_STATUS_TEXT: Record<string, string> = {
  retriever: 'searching...',
  design: 'researching...',
  coder: 'implementing...',
  tester: 'testing...',
};

const SubAgentCard = memo(function SubAgentCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const args = toolCall.args || {};
  const subType = String(args.type || 'retriever');
  const query = String(args.query || '');
  const focusFiles = (args.focus_files as string[]) || [];

  const isRunning = toolCall.status === 'running' || toolCall.status === 'pending';
  const isFailed = toolCall.status === 'failed';
  const isComplete = toolCall.status === 'completed';

  // Parse result: new engram-first format (refs array) or legacy code blocks
  const { refCount, refTokens, resultBlocks } = useMemo(() => {
    if (!toolCall.result) return { refCount: 0, refTokens: 0, resultBlocks: [] as Array<{ path: string; content: string }> };

    // Try parsing as batch step output containing refs
    const refsMatch = toolCall.result.match(/(\d+) refs \((\d+(?:\.\d+)?k?) tk\)/);
    if (refsMatch) {
      const count = parseInt(refsMatch[1], 10);
      const tkStr = refsMatch[2];
      const tokens = tkStr.endsWith('k') ? parseFloat(tkStr) * 1000 : parseInt(tkStr, 10);
      return { refCount: count, refTokens: tokens, resultBlocks: [] };
    }

    // Legacy format: parse code blocks
    const blocks: Array<{ path: string; content: string }> = [];
    const blockRegex = /--- (.+?) ---\n([\s\S]*?)\n--- end ---/g;
    let match;
    while ((match = blockRegex.exec(toolCall.result)) !== null) {
      blocks.push({ path: match[1], content: match[2] });
    }
    return { refCount: blocks.length, refTokens: Math.ceil(toolCall.result.length / 4), resultBlocks: blocks };
  }, [toolCall.result]);

  const roleLabel = SUBAGENT_ROLE_LABELS[subType] || subType.charAt(0).toUpperCase() + subType.slice(1);
  const statusText = SUBAGENT_STATUS_TEXT[subType] || 'working...';

  const statusColor = isFailed
    ? 'border-studio-error/50 bg-studio-error/8'
    : isRunning
      ? 'border-teal-500/50 bg-teal-500/8'
      : 'border-teal-500/30 bg-teal-500/5';

  return (
    <div className={`rounded-lg border overflow-hidden transition-colors ${statusColor}`}>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:opacity-80"
        onClick={() => setExpanded(!expanded)}
      >
        {isRunning ? (
          <div className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
        ) : isFailed ? (
          <ErrorIcon />
        ) : (
          <svg className="w-3.5 h-3.5 text-teal-400" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        )}

        <span className="font-medium text-sm text-teal-300">
          {roleLabel}
        </span>

        {isRunning && (
          <span className="text-xs text-studio-muted italic animate-pulse">
            {statusText}
          </span>
        )}

        {isComplete && (
          <span className="text-xs text-studio-muted">
            {refCount} ref{refCount !== 1 ? 's' : ''}
            {refTokens > 0 && ` (${refTokens > 1000 ? `${(refTokens / 1000).toFixed(1)}k` : refTokens} tk)`}
          </span>
        )}

        {isFailed && (
          <span className="text-xs text-studio-error">failed</span>
        )}

        <svg
          className={`w-3 h-3 ml-auto transition-transform text-studio-muted ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24" fill="currentColor"
        >
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-studio-border/30 bg-studio-bg/50 p-3 space-y-3">
          {/* Query */}
          <div>
            <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">Query</div>
            <div className="text-xs text-studio-text/80">{query}</div>
          </div>

          {/* Focus files */}
          {focusFiles.length > 0 && (
            <div>
              <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">Focus Files</div>
              <div className="text-xs text-studio-text/60">{focusFiles.join(', ')}</div>
            </div>
          )}

          {/* Pinned code blocks */}
          {resultBlocks.length > 0 && (
            <div>
              <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">
                Pinned Code ({refCount} block{refCount !== 1 ? 's' : ''})
              </div>
              <div className="space-y-2 max-h-80 overflow-y-auto scrollbar-thin">
                {resultBlocks.map((block, i) => (
                  <div key={i} className="rounded border border-studio-border/20 overflow-hidden">
                    <div className="px-2 py-1 bg-studio-surface/50 text-[10px] text-teal-400/80 font-mono">
                      {block.path}
                    </div>
                    <pre className="text-[11px] p-2 overflow-x-auto whitespace-pre-wrap text-studio-text/70 max-h-40">
                      {block.content.length > 500 ? block.content.substring(0, 500) + '\n...' : block.content}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Raw result fallback */}
          {!resultBlocks.length && toolCall.result && (
            <div>
              <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">Result</div>
              <pre className="text-[11px] bg-studio-surface/50 rounded p-2 overflow-x-auto max-h-48 scrollbar-thin whitespace-pre-wrap">
                {toolCall.result}
              </pre>
            </div>
          )}
          {isFailed && toolCall.result && (
            <div className="text-xs text-studio-error">{toolCall.result}</div>
          )}
        </div>
      )}
    </div>
  );
});

// Inline tool call segment (shown between text bubbles) - expandable with rich lifecycle
const ToolSegmentBubble = memo(function ToolSegmentBubble({ toolCall }: { toolCall: ToolCall }) {
  const hasArgs = !!(toolCall.args && Object.keys(toolCall.args).length > 0);
  const hasResult = typeof toolCall.result === 'string'
    ? toolCall.result.trim().length > 0
    : toolCall.result != null;
  const hasDetails = hasArgs || hasResult;
  const [expanded, setExpanded] = useState(false);
  const { friendly, detail } = getToolDisplayInfo(toolCall);
  
  const truncate = (text: unknown, maxLen: number = 60): string => {
    const str = String(text ?? '');
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
  };
  
  const getStatusIcon = () => {
    switch (toolCall.status) {
      case 'pending':
        return <div className="w-3 h-3 rounded-full border-2 border-studio-accent/50 border-dashed animate-pulse" />;
      case 'running':
        return <div className="w-3 h-3 border-2 border-studio-accent border-t-transparent rounded-full animate-spin" />;
      case 'completed':
        return <CheckIcon />;
      case 'failed':
        return <ErrorIcon />;
      default:
        return <div className="w-3 h-3 rounded-full border-2 border-studio-muted animate-pulse" />;
    }
  };
  
  const getStatusStyles = () => {
    switch (toolCall.status) {
      case 'pending': return 'border-studio-accent/30 bg-studio-accent/5 text-studio-text/60';
      case 'running': return 'border-studio-title/50 bg-studio-title/10 text-studio-title';
      case 'completed': return 'border-studio-accent/40 bg-studio-accent/8 text-studio-text/70';
      case 'failed': return 'border-studio-error/50 bg-studio-error/10 text-studio-error';
      default: return 'border-studio-border bg-studio-surface';
    }
  };
  
  const getStatusLabel = () => {
    switch (toolCall.status) {
      case 'pending': return 'Preparing...';
      case 'running': return null;
      case 'completed': return null;
      case 'failed': return 'Failed';
      default: return null;
    }
  };

  // Format args for display
  const formatArgs = (args: Record<string, unknown> | undefined): string => {
    if (!args) return '';
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  };

  return (
    <div className="rounded-lg border overflow-hidden transition-colors">
      {/* Header - clickable to expand */}
      <div 
        className={`flex items-center gap-2 px-3 py-2 ${getStatusStyles()} ${hasDetails ? 'cursor-pointer hover:opacity-80' : ''}`}
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        {getStatusIcon()}
        <span className="font-medium text-sm">{friendly}</span>
        {getStatusLabel() && <span className="text-xs text-studio-muted italic">{getStatusLabel()}</span>}
        {detail && !getStatusLabel() && <span className="text-xs text-studio-muted truncate max-w-[200px]" title={detail}>{truncate(detail)}</span>}
        {hasDetails && (
          <svg 
            className={`w-3 h-3 ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24" fill="currentColor"
          >
            <path d="M7 10l5 5 5-5z" />
          </svg>
        )}
      </div>
      
      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="border-t border-studio-border/30 bg-studio-bg/50 p-2 space-y-2">
          {toolCall.args && (
            <div>
              <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">Arguments</div>
              <pre className="text-[11px] bg-studio-surface/50 rounded p-2 overflow-x-auto max-h-32 scrollbar-thin whitespace-pre-wrap">
                {formatArgs(toolCall.args)}
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div>
              <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">Result</div>
              <pre className="text-[11px] bg-studio-surface/50 rounded p-2 overflow-x-auto max-h-48 scrollbar-thin whitespace-pre-wrap">
                {toolCall.result.length > 1000 ? toolCall.result.substring(0, 1000) + '...' : toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const StreamingBubble = memo(function StreamingBubble({ 
  segmentsRef,
  revisionRef,
  isGenerating, 
  onScrollToBottom,
}: { 
  segmentsRef: React.RefObject<StreamSegment[]>;
  revisionRef: React.RefObject<number>;
  isGenerating: boolean;
  onScrollToBottom?: () => void;
}) {
  const [segments, setSegments] = useState<StreamSegment[]>([]);
  const [, startTransition] = useTransition();
  const rafRef = useRef<number | null>(null);
  const lastScrollRef = useRef<number>(0);
  const lastRevisionRef = useRef<number>(0);
  
  useEffect(() => {
    if (!isGenerating) {
      setSegments([]);
      lastRevisionRef.current = 0;
      return;
    }
    
    let mounted = true;
    
    const tick = () => {
      if (!mounted) return;
      
      const currentRevision = revisionRef.current;
      
      if (currentRevision !== lastRevisionRef.current) {
        lastRevisionRef.current = currentRevision;
        const currentSegments = segmentsRef.current || [];
        
        startTransition(() => {
          setSegments(currentSegments.map(s =>
            s.type === 'tool' ? { ...s, toolCall: { ...s.toolCall } } : { ...s }
          ));
        });
        
        const now = Date.now();
        if (onScrollToBottom && now - lastScrollRef.current > 50) {
          lastScrollRef.current = now;
          onScrollToBottom();
        }
      }
      
      if (isGenerating) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    
    rafRef.current = requestAnimationFrame(tick);
    
    return () => {
      mounted = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isGenerating, segmentsRef, revisionRef, onScrollToBottom]);
  
  // Check if we have any content
  const hasContent = segments.some(s => 
    (s.type === 'text' && s.content) || 
    s.type === 'tool' ||
    s.type === 'reasoning' ||
    s.type === 'error'
  );
  const hasOnlyReasoning = hasContent && segments.every(s => s.type === 'reasoning' || (s.type === 'text' && !s.content));
  const isThinking = isGenerating && (!hasContent || hasOnlyReasoning);
  
  if (!hasContent && !isGenerating) {
    return null;
  }
  
  return (
    <div className="flex gap-3">
      <div className={`
        w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors duration-300
        ${isThinking && !hasOnlyReasoning ? 'bg-studio-accent/20' : 'bg-studio-surface'}
      `}>
        {isThinking && !hasOnlyReasoning ? (
          <ThinkingSpinner />
        ) : (
          <AIIcon />
        )}
      </div>
      <div className="max-w-[80%] space-y-2">
        {/* Thinking indicator - shows before any output */}
        {isThinking && !hasOnlyReasoning && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-studio-accent/10 to-studio-surface/50 border border-studio-accent/30">
            <span className="text-sm text-studio-accent font-medium">Thinking...</span>
          </div>
        )}
        
        {/* Render segments in order */}
        {segments.map((segment, idx, arr) => {
          const isLast = idx === segments.length - 1;
          
          if (segment.type === 'text') {
            if (!segment.content) return null;
            const next = arr[idx + 1];
            const nextTool = next?.type === 'tool' ? next.toolCall : undefined;
            const toolHint = nextTool ? getToolDisplayInfo(nextTool).friendly.replace(/^[^\w]*/, '') : undefined;
            return (
              <TextSegmentBubble 
                key={`text-${segment.id || idx}`}
                content={segment.content}
                isLast={isLast}
                isGenerating={isGenerating}
                nextToolHint={toolHint}
              />
            );
          } else if (segment.type === 'reasoning') {
            return (
              <ReasoningBlock
                key={`reasoning-${segment.id || idx}`}
                content={segment.content}
                isStreaming={segment.state === 'streaming'}
              />
            );
          } else if (segment.type === 'step-boundary') {
            return (
              <StepBoundary key={`step-${idx}`} stepNumber={
                segments.slice(0, idx).filter(s => s.type === 'step-boundary').length + 2
              } />
            );
          } else if (segment.type === 'status') {
            return (
              <div key={`status-${idx}`} className="flex items-center gap-2 px-3 py-2 my-1 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-yellow-300 text-xs font-medium animate-pulse">
                <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4zm0 7a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z"/></svg>
                {segment.message}
              </div>
            );
          } else if (segment.type === 'error') {
            return (
              <ErrorPart key={`error-${idx}`} errorText={segment.errorText} />
            );
          } else if (segment.type === 'tool') {
            const isSubagent = segment.toolCall.name === 'subagent';
            if (isSubagent) {
              return (
                <SubAgentCard
                  key={`subagent-${segment.toolCall.id}`}
                  toolCall={segment.toolCall}
                />
              );
            }
            return isBatchCall(segment.toolCall) ? (
              <StreamingBatchToolCalls
                key={`tool-${segment.toolCall.id}`}
                toolCall={segment.toolCall}
              />
            ) : (
              <ToolSegmentBubble 
                key={`tool-${segment.toolCall.id}`}
                toolCall={segment.toolCall}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
});

// Icons for chat history
const NewChatIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
  </svg>
);

const HistoryIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
  </svg>
);

const TrashIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
  </svg>
);

const AttachIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
  </svg>
);

/** Map a FileAttachment result from processFileAttachment into the attachment store */
function addProcessedAttachment(
  store: ReturnType<typeof useAttachmentStore.getState>,
  name: string,
  path: string,
  attachment: Awaited<ReturnType<typeof processFileAttachment>>,
) {
  if (attachment.type === 'image') {
    const base64 = attachment.content?.split(',')[1] || '';
    const mediaType = attachment.metadata?.media_type || 'image/png';
    store.addImageAttachment(name, path, base64, mediaType, attachment.metadata);
  } else {
    store.addFileAttachment(name, path, attachment.content, attachment.type, attachment.metadata);
  }
}

/** Attachment chips displayed above the input textarea */
function AttachmentChips() {
  const attachments = useAttachmentStore(state => state.attachments);
  const removeAttachment = useAttachmentStore(state => state.removeAttachment);

  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      {attachments.map(att => (
        <div
          key={att.id}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-studio-bg border border-studio-border text-xs text-studio-text group max-w-[160px]"
          title={att.path || att.name}
        >
          {att.type === 'image' && att.thumbnailUrl ? (
            <img src={att.thumbnailUrl} alt={att.name} className="w-4 h-4 rounded object-cover shrink-0" />
          ) : (
            <svg className="w-3 h-3 shrink-0 text-studio-muted" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z" />
            </svg>
          )}
          <span className="truncate">{att.name}</span>
          <button
            onClick={() => removeAttachment(att.id)}
            className="ml-0.5 text-studio-muted hover:text-studio-error opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

export function AiChat() {
  // Use individual selectors to prevent unnecessary re-renders
  const messages = useAppStore(state => state.messages);
  const addMessage = useAppStore(state => state.addMessage);
  const clearMessages = useAppStore(state => state.clearMessages);
  const isGenerating = useAppStore(state => state.isGenerating);
  const setIsGenerating = useAppStore(state => state.setIsGenerating);
  const activeFile = useAppStore(state => state.activeFile);
  const upsertToolCall = useAppStore(state => state.upsertToolCall);
  const clearToolCalls = useAppStore(state => state.clearToolCalls);
  const setContextUsage = useAppStore(state => state.setContextUsage);
  const settings = useAppStore(state => state.settings);
  const projectPath = useAppStore(state => state.projectPath);
  const projectProfile = useAppStore(state => state.projectProfile);
  const openFiles = useAppStore(state => state.openFiles);
  const atlsInitialized = useAppStore(state => state.atlsInitialized);
  const chatSessions = useAppStore(state => state.chatSessions);
  const newChat = useAppStore(state => state.newChat);
  const chatMode = useAppStore(state => state.chatMode);
  const toolCalls = useAppStore(state => state.toolCalls);
  const agentProgress = useAppStore(state => state.agentProgress);
  
  // Use persistence hook for database-backed session operations
  const { loadSession, deleteSession, saveSession, createNewSession, saveRestorePoint, restoreToPoint, undoRestore } = useChatPersistence();
  const agentCanContinue = useAppStore(state => state.agentCanContinue);
  const restoreUndoStack = useAppStore(state => state.restoreUndoStack);
  const clearRestoreUndo = useAppStore(state => state.clearRestoreUndo);
  const setAgentCanContinue = useAppStore(state => state.setAgentCanContinue);
  const incrementChatSession = useAppStore(state => state.incrementChatSession);
  
  const { initAtls } = useAtls();

  // Context store actions
  const resetContextSession = useContextStore(state => state.resetSession);
  const setContextMaxTokens = useContextStore(state => state.setMaxTokens);
  
  const [input, setInput] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTokenMetrics, setShowTokenMetrics] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  
  // Streaming segments stored in ref - NO state updates during streaming!
  // StreamingBubble polls this ref directly for updates
  const streamingSegmentsRef = useRef<StreamSegment[]>([]);
  // Monotonic revision counter — bumped on every segment mutation so the
  // RAF-based StreamingBubble always detects changes (even when array length
  // and last-segment content happen to match a previous snapshot).
  const segmentsRevisionRef = useRef<number>(0);
  // Accumulate text from prior rounds before onClear; merged into final/partial message
  const accumulatedTextRef = useRef<string>('');
  const isStreamingRef = useRef(false);
  const mountedRef = useRef(true); // Track if component is mounted
  const updateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track seen tool call IDs to know when a new one starts
  const seenToolCallIds = useRef<Set<string>>(new Set());
  
  // Throttling refs for performance - prevents excessive state updates during streaming
  const lastUsageUpdateRef = useRef<number>(0);
  const lastToolCallUpdateRef = useRef<number>(0);
  const pendingToolCallsRef = useRef<Map<string, Partial<ToolCall>>>(new Map());
  const toolCallFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Message edit-and-resend state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const pendingResendRef = useRef<string | null>(null);

  const handleStartEdit = useCallback((messageId: string) => {
    if (isGenerating) return;
    setEditingMessageId(messageId);
  }, [isGenerating]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleSaveEdit = useCallback(async (messageId: string, editedContent: string) => {
    setEditingMessageId(null);
    const result = await restoreToPoint(messageId, editedContent);
    if (result !== null) {
      // Store in ref and set input — useEffect below will trigger handleSend
      pendingResendRef.current = editedContent;
      setInput(editedContent);
    }
  }, [restoreToPoint]);

  const handleUndoRestore = useCallback(async () => {
    await undoRestore();
  }, [undoRestore]);

  // Drag-and-drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Attachment store
  const attachments = useAttachmentStore(state => state.attachments);
  const clearAttachments = useAttachmentStore(state => state.clearAttachments);
  const isInternalDragActive = useAttachmentStore(state => state.isInternalDragActive);

  // Tauri native drag-drop listener for OS file drops (WebView2 blocks HTML5 dataTransfer.files)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    
    const setup = async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent(async (event) => {
          if (event.payload.type === 'over') {
            setIsDragOver(true);
          } else if (event.payload.type === 'drop') {
            setIsDragOver(false);
            const paths = event.payload.paths;
            if (!paths || paths.length === 0) return;
            
            const store = useAttachmentStore.getState();
            for (const filePath of paths) {
              const name = filePath.split(/[/\\]/).pop() || filePath;
              try {
                const attachment = await processFileAttachment(filePath, name);
                addProcessedAttachment(store, name, filePath, attachment);
              } catch (err) {
                console.error('Failed to process dropped file:', err);
                store.addFileAttachment(name, filePath);
              }
            }
          } else if (event.payload.type === 'leave') {
            setIsDragOver(false);
          }
        });
      } catch (err) {
        console.warn('Failed to setup Tauri drag-drop listener:', err);
      }
    };
    
    setup();
    return () => { unlisten?.(); };
  }, []);

  // Auto-scroll to bottom (debounced, instant during streaming)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Scroll to bottom callback - used by StreamingBubble during streaming
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);
  
  useEffect(() => {
    // Scroll on new messages
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      // Use instant scroll during streaming for smoothness, smooth scroll otherwise
      scrollToBottom(isStreamingRef.current ? 'instant' : 'smooth');
    }, isStreamingRef.current ? 16 : 100);
    
    return () => {
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, [messages, scrollToBottom]);
  
  // Also scroll when isGenerating changes to true (user sent new message)
  useEffect(() => {
    if (isGenerating) {
      // Immediately scroll when starting to generate
      scrollToBottom('smooth');
    }
  }, [isGenerating, scrollToBottom]);
  
  // Cleanup on unmount - save session before leaving
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (toolCallFlushTimeoutRef.current) {
        clearTimeout(toolCallFlushTimeoutRef.current);
      }
      // Save session on unmount
      const state = useAppStore.getState();
      if (state.messages.length > 0) {
        state.saveCurrentSession();
      }
    };
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // Sync context store max tokens with selected model (includes extended 1M when enabled)
  const availableModels = useAppStore(state => state.availableModels);
  const extendedResolution = useMemo(
    () =>
      getExtendedContextResolutionFromSettings({
        extendedContext: settings.extendedContext,
        extendedContextByModelId: settings.extendedContextByModelId,
      }),
    [settings.extendedContext, settings.extendedContextByModelId]
  );
  useEffect(() => {
    const model = availableModels.find(m => m.id === settings.selectedModel);
    const effectiveCtx = model && getEffectiveContextWindow(model.id, model.provider, model.contextWindow, extendedResolution);
    if (effectiveCtx) {
      setContextMaxTokens(effectiveCtx);
    }
  }, [settings.selectedModel, extendedResolution, availableModels, setContextMaxTokens]);

  const resetAgentProgress = useAppStore(state => state.resetAgentProgress);
  
  // Wrapped newChat that saves current session and resets context store
  const handleNewChat = useCallback(async () => {
    setEditingMessageId(null);
    await createNewSession();
    newChat();
    resetStaticPromptCache();
    resetProjectTreeCache();
    resetAgentProgress();
    useCostStore.getState().resetChat();
  }, [createNewSession, newChat, resetAgentProgress]);

  // Get API key for provider
  const getApiKeyForProvider = useCallback((provider: AIProvider): string => {
    switch (provider) {
      case 'anthropic': return settings.anthropicApiKey;
      case 'openai': return settings.openaiApiKey;
      case 'google': return settings.googleApiKey;
      case 'vertex': return settings.vertexAccessToken;
      case 'lmstudio': return settings.lmstudioBaseUrl;
      default: return '';
    }
  }, [settings]);

  const getSelectedModelProvider = useCallback((): AIProvider => {
    const selectedModelInfo = availableModels.find(m => m.id === settings.selectedModel);
    if (selectedModelInfo?.provider) return selectedModelInfo.provider;
    const heuristic = getProviderFromModel(settings.selectedModel);
    if (heuristic === 'google' && settings.selectedProvider === 'vertex') return 'vertex';
    return heuristic;
  }, [availableModels, settings.selectedModel, settings.selectedProvider]);

  const serializeAttachmentForDebug = useCallback((attachment: ChatAttachment) => ({
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    type: attachment.type,
    fileType: attachment.fileType,
    mediaType: attachment.mediaType,
    metadata: attachment.metadata,
    hasContent: Boolean(attachment.content),
    contentLength: attachment.content?.length ?? 0,
    hasBase64: Boolean(attachment.base64),
    base64Length: attachment.base64?.length ?? 0,
  }), []);

  const serializeMessageForDebug = useCallback((message: Message) => ({
    id: message.id,
    role: message.role,
    timestamp: message.timestamp instanceof Date ? message.timestamp.toISOString() : String(message.timestamp),
    content: message.content,
    parts: message.parts,
    segments: message.segments,
    toolCalls: message.toolCalls,
    chunkHash: message.chunkHash,
    isChunkRef: message.isChunkRef,
    attachments: message.attachments?.map(serializeAttachmentForDebug),
  }), [serializeAttachmentForDebug]);

  // Get AI config from settings (without system prompt - we'll build it with context)
  const getAIConfig = useCallback((): AIConfig => {
    const provider = getSelectedModelProvider();
    const anthropicBeta =
      provider === 'anthropic' &&
      isExtendedContextEnabled(
        settings.selectedModel,
        'anthropic',
        settings.extendedContextByModelId ?? {},
        settings.extendedContext
      ) &&
      modelSupportsExtendedContext(settings.selectedModel, 'anthropic')
        ? ['context-1m-2025-08-07']
        : undefined;
    return {
      provider,
      model: settings.selectedModel,
      apiKey: getApiKeyForProvider(provider),
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      projectId: settings.vertexProjectId,
      region: provider === 'vertex' ? settings.vertexRegion : undefined,
      baseUrl: provider === 'lmstudio' ? settings.lmstudioBaseUrl : undefined,
      anthropicBeta,
    };
  }, [settings, getApiKeyForProvider, getSelectedModelProvider]);

  // Detect OS and shell
  const getSystemInfo = useCallback(() => {
    const platform = navigator.platform.toLowerCase();
    let os: 'windows' | 'linux' | 'macos' = 'linux';
    let shell = 'bash';
    
    if (platform.includes('win')) {
      os = 'windows';
      shell = 'powershell';
    } else if (platform.includes('mac')) {
      os = 'macos';
      shell = 'zsh';
    }
    
    return { os, shell };
  }, []);

  // Build workspace context for AI
  const getWorkspaceContext = useCallback((): WorkspaceContext => {
    const { os, shell } = getSystemInfo();
    // Always pass the active focus profile so the AI knows what categories the user cares about
    const { focusProfile, focusProfileName } = useAppStore.getState();
    return {
      profile: projectProfile,
      activeFile,
      openFiles,
      os,
      shell,
      cwd: projectPath || undefined,
      atlsReady: atlsInitialized,
      focusProfile: { name: focusProfileName, matrix: focusProfile.matrix },
    };
  }, [projectProfile, activeFile, openFiles, projectPath, getSystemInfo, atlsInitialized]);

  // Check if API is configured
  const hasApiKey = useCallback(() => {
    const provider = getSelectedModelProvider();
    return Boolean(getApiKeyForProvider(provider));
  }, [getApiKeyForProvider, getSelectedModelProvider]);

  // --- Drag-and-drop handlers ---
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const store = useAttachmentStore.getState();

    // 1. Check shared internal drag payload (used by FileExplorer since WebView2 blocks dataTransfer)
    const internalPayload = consumeInternalDragPayload();
    if (internalPayload && internalPayload.length > 0) {
      for (const item of internalPayload) {
        if (item.type === 'directory') continue;
        try {
          const attachment = await processFileAttachment(item.path, item.name);
          addProcessedAttachment(store, item.name, item.path, attachment);
        } catch (err) {
          console.error('Failed to process file:', err);
          store.addFileAttachment(item.name, item.path);
        }
      }
      return;
    }

    // 2. Check for explorer files via dataTransfer (fallback for non-WebView2 environments)
    try {
      const atlsData = e.dataTransfer.getData('application/x-atls-files');
      if (atlsData) {
        const items = JSON.parse(atlsData) as Array<{ path: string; name: string; type: string }>;
        for (const item of items) {
          if (item.type === 'directory') continue;
          try {
            const attachment = await processFileAttachment(item.path, item.name);
            addProcessedAttachment(store, item.name, item.path, attachment);
          } catch (err) {
            console.error('Failed to process file:', err);
            store.addFileAttachment(item.name, item.path);
          }
        }
        return;
      }
    } catch { /* dataTransfer may be blocked */ }

    // 3. Handle OS file drops via HTML5 (fallback, Tauri onDragDropEvent is primary for OS drops)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      for (const file of Array.from(e.dataTransfer.files)) {
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            store.addImageFromDataUrl(file.name, dataUrl);
          };
          reader.onerror = () => console.error('FileReader failed for image drop:', file.name, reader.error);
          reader.readAsDataURL(file);
        } else {
          const reader = new FileReader();
          reader.onload = () => {
            const content = reader.result as string;
            store.addFileAttachment(file.name, file.name, content);
          };
          reader.onerror = () => console.error('FileReader failed for file drop:', file.name, reader.error);
          reader.readAsText(file);
        }
      }
    }
  }, []);

  // --- Clipboard paste handler (for images) ---
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const name = `pasted-image-${Date.now()}.${file.type.split('/')[1] || 'png'}`;
          useAttachmentStore.getState().addImageFromDataUrl(name, dataUrl);
        };
        reader.onerror = () => console.error('FileReader failed for pasted image:', reader.error);
        reader.readAsDataURL(file);
      }
    }
  }, []);

  // --- Attach file picker ---
  const handleAttachClick = useCallback(async () => {
    try {
      const result = await openFileDialog({
        multiple: true,
        filters: [
          { name: 'All Files', extensions: ['*'] },
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
          { name: 'Code', extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h'] },
        ],
      });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      for (const filePath of paths) {
        const p = dialogSelectedPath(filePath);
        if (!p) {
          console.warn('Attach: could not resolve path from file dialog entry', filePath);
          continue;
        }
        const name = p.split(/[/\\]/).pop() || p;
        try {
          const attachment = await processFileAttachment(p, name);
          addProcessedAttachment(useAttachmentStore.getState(), name, p, attachment);
        } catch (err) {
          console.error('Failed to process file:', err);
          useAttachmentStore.getState().addFileAttachment(name, p);
        }
      }
    } catch (err) {
      console.error('File picker error:', err);
    }
  }, []);

  const handleSend = async () => {
    const trimmedInput = input.trim();
    const currentAttachments = useAttachmentStore.getState().attachments;
    const hasAttachments = currentAttachments.length > 0;

    if (!trimmedInput && !hasAttachments) return;
    if (isGenerating) return;

    // Detect if this send was triggered by edit-and-resend (undo stack is fresh)
    const isEditResend = useAppStore.getState().restoreUndoStack !== null;

    if (!isEditResend) {
      // Normal send: clear any stale undo stack and save a restore point
      clearRestoreUndo();
      const appState = useAppStore.getState();
      if (appState.currentSessionId && appState.messages.length > 0) {
        const lastUserMsg = [...appState.messages].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          void saveRestorePoint(appState.currentSessionId, lastUserMsg.id);
        }
      }
    }
    // Edit-resend: keep the undo stack so user can revert; restore point already saved

    // Get context store for hashing
    const contextStore = useContextStore.getState();

    // Build LLM context from attachments using formatAttachmentForLLM
    let fileContextBlock = '';
    const imageBlocks: Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [];
    const attachmentSnapshot = hasAttachments ? [...currentAttachments] : undefined;

    for (const att of currentAttachments) {
      if (att.type === 'file') {
        let content = att.content;
        if (!content && att.path) {
          try {
            content = await invoke<string>('read_file_contents', { path: att.path, projectRoot: projectPath });
          } catch (err) {
            console.error('Failed to read file for attachment:', err);
            content = `[Error reading ${att.name}]`;
          }
        }
        if (content) {
          if (att.fileType === 'code' && att.metadata) {
            fileContextBlock += '\n' + formatAttachmentForLLM(att) + '\n';
          } else {
            fileContextBlock += `\n<file path="${att.path || att.name}">\n${content}\n</file>\n`;
          }
        }
      } else if (att.type === 'image' && att.base64 && att.mediaType) {
        imageBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: att.mediaType, data: att.base64 },
        });
      }
    }

    // Build the display message (what user sees in chat)
    const displayContent = trimmedInput
      + (hasAttachments ? `\n\n[Attached: ${currentAttachments.map(a => a.name).join(', ')}]` : '');

    // Clear attachments
    if (hasAttachments) clearAttachments();

    // Build the actual content to send to the AI
    const userTextContent = (fileContextBlock ? fileContextBlock + '\n' : '') + (trimmedInput || 'See attached files.');

    // Add user message to store with attachment snapshot for display rendering
    const userChunkHash = contextStore.addChunk(trimmedInput || 'See attached files.', 'msg:user');
    addMessage({ role: 'user', content: displayContent, attachments: attachmentSnapshot, chunkHash: userChunkHash });
    
    setInput('');
    setIsGenerating(true);
    streamingSegmentsRef.current = [];
    seenToolCallIds.current.clear();

    // Check for API key
    if (!hasApiKey()) {
      addMessage({ 
        role: 'assistant', 
        content: '⚠️ **Provider Required**\n\nPlease configure a provider in Settings (gear icon in the top right) to use the AI chat.\n\nSupported providers:\n- **Anthropic** (Claude models)\n- **OpenAI** (GPT models)\n- **Google AI** (Gemini models)\n- **Vertex AI** (Google Cloud)\n- **LM Studio** (Local models)',
      });
      setIsGenerating(false);
      return;
    }

    // Auto-initialize ATLS if we have a project path but not initialized
    if (projectPath && !atlsInitialized) {
      console.log('[AiChat] Auto-initializing ATLS for:', projectPath);
      try {
        await initAtls(projectPath);
      } catch (e) {
        console.warn('[AiChat] ATLS init failed, continuing without:', e);
      }
    }

    // Handle Refactor mode - requires project
    if (chatMode === 'refactor' && !projectPath) {
      addMessage({
        role: 'assistant',
        content: '⚠️ **Project Required**\n\nAI Refactor mode requires an open project folder. Please open a project first using **File → Open Project**.',
      });
      setIsGenerating(false);
      return;
    }

    // Handle Swarm mode - delegate to orchestrator
    if (chatMode === 'swarm') {
      console.log('[AiChat] Swarm mode detected, starting orchestrator...');
      
      if (!projectPath) {
        addMessage({
          role: 'assistant',
          content: '⚠️ **Project Required**\n\nSwarm mode requires an open project folder. Please open a project first.',
        });
        setIsGenerating(false);
        return;
      }
      
      // Show immediate feedback
      addMessage({
        role: 'assistant',
        content: '🐝 **Starting Swarm**\n\n🔍 **Researching codebase...** Watch the Swarm Panel above for live progress.',
      });
      
      try {
        // Get orchestrator config from swarm store
        const swarmStore = useSwarmStore.getState();
        const orchestratorConfig = swarmStore.agentConfigs.find(c => c.role === 'orchestrator');
        
        // Generate session ID if needed
        const sessionId = crypto.randomUUID();
        
        // Start orchestrator - it handles everything from here
        await orchestrator.start(
          sessionId,
          trimmedInput,
          projectPath,
          {
            model: orchestratorConfig?.model || settings.selectedModel,
            provider: orchestratorConfig?.provider || getSelectedModelProvider(),
            maxConcurrentAgents: swarmStore.maxConcurrentAgents, // Use store value
            autoApprove: false, // Require user approval of plan
          }
        );
        
        // Update with completion message
        addMessage({
          role: 'assistant',
          content: '📋 **Plan Ready!**\n\nReview the tasks in the Swarm Panel above and click **Approve Plan** to begin execution.',
        });
        
      } catch (error) {
        console.error('[AiChat] Swarm error:', error);
        addMessage({
          role: 'assistant',
          content: `❌ **Swarm Error**: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease try again or switch to Agent mode.`,
        });
      } finally {
        setIsGenerating(false);
      }
      return;
    }

    // Build chat history for API — token-budget-aware selection that preserves the
    // original task message and recent reasoning instead of a hard slice(-20) cap.
    const recentMessages = selectRecentHistory(messages);
    const chatMessages: ChatMessage[] = recentMessages.map(m => ({
      role: m.role,
      content: m.content,
      parts: m.parts,
      segments: m.segments,
    }));

    // Build the user message content -- multimodal if images are attached
    if (imageBlocks.length > 0) {
      const contentBlocks: any[] = [
        ...imageBlocks,
        { type: 'text', text: userTextContent },
      ];
      chatMessages.push({ role: 'user', content: contentBlocks as any });
    } else {
      chatMessages.push({ role: 'user', content: userTextContent });
    }

    // Stream response
    try {
      let fullResponse = '';
      const workspaceContext = getWorkspaceContext();
      
      // Track completed tool calls for this message
      const messageToolCalls: Map<string, MessageToolCall> = new Map();
      
      // Clear previous tool calls when starting new chat
      clearToolCalls();
      
      // Reset streaming segments and mark as streaming
      const streamRefs: StreamingRefs = { streamingSegmentsRef, segmentsRevisionRef, seenToolCallIds, accumulatedTextRef, isStreamingRef };
      resetStreamingState(streamRefs);
      
      // Active text/reasoning block IDs for the typed stream protocol
      let activeTextId: string | null = null;
      let activeReasoningId: string | null = null;
      
      // Bound helpers using shared streaming refs
      const appendTextToSegments = (text: string, blockId?: string) => _appendText(streamRefs, text, blockId);
      const appendReasoningToSegments = (text: string, blockId?: string) => _appendReasoning(streamRefs, text, blockId);
      const closeBlockById = (blockId: string, blockType: 'text' | 'reasoning') => _closeBlock(streamRefs, blockId, blockType);
      const upsertToolSegment = (toolCall: ToolCall) => _upsertTool(streamRefs, toolCall);
      
      // Flush pending tool calls to state (throttled batch update)
      const flushPendingToolCalls = () => {
        if (pendingToolCallsRef.current.size === 0) return;
        
        // Batch update all pending tool calls
        pendingToolCallsRef.current.forEach((update, id) => {
          upsertToolCall(id, update);
        });
        pendingToolCallsRef.current.clear();
        lastToolCallUpdateRef.current = Date.now();
      };
      
      await streamChat(getAIConfig(), chatMessages, {
        onToken: (token) => {
          fullResponse += token;
          appendTextToSegments(token, activeTextId || undefined);
        },
        onTextStart: (id) => { activeTextId = id; },
        onTextEnd: (id) => { closeBlockById(id, 'text'); activeTextId = null; },
        onReasoningStart: (id) => { activeReasoningId = id; },
        onReasoningDelta: (delta) => { appendReasoningToSegments(delta, activeReasoningId || undefined); },
        onReasoningEnd: (id) => { closeBlockById(id, 'reasoning'); activeReasoningId = null; },
        onToolInputStart: (toolCallId, toolName) => {
          upsertToolSegment({ id: toolCallId, name: toolName, status: 'pending', startTime: new Date() });
        },
        onToolInputDelta: () => {},
        onToolInputAvailable: (toolCallId, toolName, input, thoughtSignature) => {
          upsertToolSegment({ id: toolCallId, name: toolName, status: 'running', args: input, startTime: new Date(), thoughtSignature });
        },
        onStepEnd: () => { streamingSegmentsRef.current.push({ type: 'step-boundary' }); segmentsRevisionRef.current++; },
        onStreamError: (errorText) => { streamingSegmentsRef.current.push({ type: 'error', errorText }); segmentsRevisionRef.current++; },
        onStatus: (message) => {
          const segs = streamingSegmentsRef.current;
          const idx = segs.findIndex(s => s.type === 'status');
          if (message) {
            if (idx >= 0) { (segs[idx] as { type: 'status'; message: string }).message = message; }
            else { segs.push({ type: 'status', message }); }
          } else if (idx >= 0) {
            segs.splice(idx, 1);
          }
          segmentsRevisionRef.current++;
        },
        onClear: () => {
          fullResponse = '';
          const textFromCurrent = streamingSegmentsRef.current
            .filter((s): s is { type: 'text'; content: string } => s.type === 'text')
            .map(s => s.content)
            .join('');
          if (textFromCurrent) {
            const cleaned = cleanStreamingContent(textFromCurrent);
            if (cleaned) {
              accumulatedTextRef.current += (accumulatedTextRef.current ? '\n\n' : '') + cleaned;
            }
          }
          streamingSegmentsRef.current = streamingSegmentsRef.current.filter(s => s.type === 'tool');
          segmentsRevisionRef.current++;
        },
        onToolCall: (toolCall) => {
          const existing = messageToolCalls.get(toolCall.id);
          messageToolCalls.set(toolCall.id, {
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args || existing?.args,
            result: toolCall.result || existing?.result,
            status: (toolCall.status === 'completed' || toolCall.status === 'failed') 
              ? toolCall.status 
              : existing?.status || toolCall.status,
            thoughtSignature: toolCall.thoughtSignature || existing?.thoughtSignature,
            syntheticChildren: toolCall.syntheticChildren || existing?.syntheticChildren,
          });
          
          upsertToolSegment({
            id: toolCall.id,
            name: toolCall.name,
            status: toolCall.status,
            args: toolCall.args,
            result: toolCall.result,
            startTime: new Date(),
          });
          
          if (toolCall.status === 'running' && toolCall.args) {
            const callContent = `${toolCall.name}(${serializeForTokenEstimate(toolCall.args)})`;
            const tcArgs = toolCall.args as Record<string, unknown> | undefined;
            const tcGoal = tcArgs?.goal as string | undefined;
            const tcSteps = Array.isArray(tcArgs?.steps) ? tcArgs.steps as unknown[] : undefined;
            const callSummary = tcGoal
              ? `${toolCall.name}: ${tcGoal.slice(0, 80)}`
              : tcSteps
                ? `${toolCall.name} (${tcSteps.length} steps)`
                : toolCall.name;
            contextStore.addChunk(callContent, 'call', toolCall.name, undefined, callSummary);
          }
          
          pendingToolCallsRef.current.set(toolCall.id, {
            name: toolCall.name,
            status: toolCall.status,
            args: toolCall.args,
            result: toolCall.result,
            endTime: toolCall.status === 'completed' || toolCall.status === 'failed' ? new Date() : undefined,
          });
          
          // Throttle: flush every 100ms or immediately for completion/failure
          const now = Date.now();
          const isTerminal = toolCall.status === 'completed' || toolCall.status === 'failed';
          
          if (isTerminal || now - lastToolCallUpdateRef.current > 100) {
            // Clear any pending flush timeout
            if (toolCallFlushTimeoutRef.current) {
              clearTimeout(toolCallFlushTimeoutRef.current);
              toolCallFlushTimeoutRef.current = null;
            }
            flushPendingToolCalls();
          } else if (!toolCallFlushTimeoutRef.current) {
            // Schedule a flush if none pending
            toolCallFlushTimeoutRef.current = setTimeout(() => {
              toolCallFlushTimeoutRef.current = null;
              flushPendingToolCalls();
            }, 100);
          }
        },
        onToolResult: (id, result) => {
          // Update tracked tool call
          const existing = messageToolCalls.get(id);
          if (existing) {
            existing.result = result;
            existing.status = 'completed';
            
            // Batch handlers manage their own engrams — skip to avoid duplication
            if (!isBatchCall(existing)) {
              contextStore.addChunk(result, 'result', existing.name);
            }
          }
          
          // Immediate update for results (important feedback)
          upsertToolCall(id, {
            status: 'completed',
            result,
            endTime: new Date(),
          });
        },
        onUsageUpdate: (usage) => {
          // Throttle context usage updates to 100ms
          const now = Date.now();
          if (now - lastUsageUpdateRef.current > 100) {
            lastUsageUpdateRef.current = now;
            setContextUsage(usage);
          }
        },
        onError: (error) => {
          console.error('AI error:', error);
          addMessage({
            role: 'assistant',
            content: `❌ **Error**: ${error.message}\n\nPlease check your API key and try again.`,
          });
        },
        onDone: () => {
          isStreamingRef.current = false;
          
          // Clean up throttling timeouts
          if (toolCallFlushTimeoutRef.current) {
            clearTimeout(toolCallFlushTimeoutRef.current);
            toolCallFlushTimeoutRef.current = null;
          }
          
          // Flush any remaining pending tool calls
          if (pendingToolCallsRef.current.size > 0) {
            pendingToolCallsRef.current.forEach((update, id) => {
              upsertToolCall(id, update);
            });
            pendingToolCallsRef.current.clear();
          }
          
          // Guard against updates after unmount
          if (!mountedRef.current) return;
          
          // Convert streaming segments to rich MessageParts (new) and legacy MessageSegments
          const finalParts: MessagePart[] = [];
          const finalSegments: MessageSegment[] = [];
          
          if (accumulatedTextRef.current) {
            finalParts.push({ type: 'text', content: accumulatedTextRef.current });
            finalSegments.push({ type: 'text', content: accumulatedTextRef.current });
          }
          for (const seg of streamingSegmentsRef.current) {
            if (seg.type === 'text') {
              const cleaned = cleanStreamingContent(seg.content);
              if (cleaned) {
                finalParts.push({ type: 'text', content: cleaned });
                finalSegments.push({ type: 'text', content: cleaned });
              }
            } else if (seg.type === 'reasoning') {
              if (seg.content) {
                finalParts.push({ type: 'reasoning', content: seg.content });
              }
            } else if (seg.type === 'tool') {
              const tc = messageToolCalls.get(seg.toolCall.id);
              if (tc) {
                const toolPart = {
                  type: 'tool' as const,
                  toolCall: {
                    id: tc.id, name: tc.name, args: tc.args, result: tc.result,
                    status: tc.status, thoughtSignature: tc.thoughtSignature,
                    ...(tc.syntheticChildren?.length ? { syntheticChildren: tc.syntheticChildren } : {}),
                  },
                };
                finalParts.push(toolPart);
                finalSegments.push(toolPart);
              }
            } else if (seg.type === 'step-boundary') {
              finalParts.push({ type: 'step-boundary' });
            } else if (seg.type === 'error') {
              finalParts.push({ type: 'error', errorText: seg.errorText });
            }
          }
          
          const cleanedContent = finalParts
            .filter((s): s is { type: 'text'; content: string } => s.type === 'text')
            .map(s => s.content)
            .join('\n');
          const synthesizedTaskSummary = cleanedContent ? '' : getTaskCompleteSummaryFromParts(finalParts);
          if (synthesizedTaskSummary) {
            finalParts.unshift({ type: 'text', content: synthesizedTaskSummary });
            finalSegments.unshift({ type: 'text', content: synthesizedTaskSummary });
          }
          const resolvedContent = cleanedContent || synthesizedTaskSummary;
          const finalTaskSummary = synthesizedTaskSummary || getTaskCompleteSummaryFromParts(finalParts);
          
          const hasToolCalls = finalParts.some(s => s.type === 'tool');
          const hasErrors = finalParts.some(s => s.type === 'error');
          
          if (resolvedContent || hasToolCalls || hasErrors) {
            const asstChunkHash = resolvedContent
              ? contextStore.addChunk(resolvedContent, 'msg:asst')
              : undefined;
            
            addMessage({ 
              role: 'assistant', 
              content: resolvedContent || finalTaskSummary || '*(Tool execution completed)*',
              parts: finalSegments.length > 0 ? finalSegments : (finalParts.length > 0 ? finalParts : undefined),
              segments: finalSegments.length > 0 ? finalSegments : undefined,
              chunkHash: asstChunkHash,
            });
          }
          streamingSegmentsRef.current = [];
          accumulatedTextRef.current = '';
          seenToolCallIds.current.clear();
          setIsGenerating(false);
          clearToolCalls();
          if (useAppStore.getState().agentProgress.stoppedReason === 'completed') {
            setAgentCanContinue(false);
          }
        },
      }, workspaceContext, chatMode as ChatMode);
    } catch (error) {
      console.error('Chat error:', error);
      addMessage({
        role: 'assistant',
        content: `❌ **Error**: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease try again.`,
      });
      setIsGenerating(false);
      streamingSegmentsRef.current = [];
      seenToolCallIds.current.clear();
    }
  };

  // Auto-send after edit-and-resend: once input state has flushed with the edited content
  useEffect(() => {
    if (pendingResendRef.current && input === pendingResendRef.current && !isGenerating) {
      pendingResendRef.current = null;
      handleSend();
    }
  }, [input, isGenerating]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Continue agent - sends a follow-up message to prompt agent to keep working
  const handleContinue = useCallback(async () => {
    if (isGenerating || !agentCanContinue) return;
    
    // Clear continuation state
    setAgentCanContinue(false);
    
    const continuationPrompt = "Continue working. When fully done, either provide a brief final summary or call task_complete with a summary.";
    
    // Get context store for hashing
    const contextStore = useContextStore.getState();

    // Add user continuation message
    const contChunkHash = contextStore.addChunk(continuationPrompt, 'msg:user');
    addMessage({ role: 'user', content: continuationPrompt, chunkHash: contChunkHash });
    
    setIsGenerating(true);
    streamingSegmentsRef.current = [];
    seenToolCallIds.current.clear();

    // Auto-initialize ATLS if needed
    if (projectPath && !atlsInitialized) {
      try {
        await initAtls(projectPath);
      } catch (e) {
        console.warn('[AiChat] ATLS init failed, continuing without:', e);
      }
    }

    // Build chat history for API — same budget-aware selection as handleSend
    const recentMessages = [...selectRecentHistory(messages), { id: crypto.randomUUID(), role: 'user' as const, content: continuationPrompt, timestamp: new Date() }];
    const chatMessages: ChatMessage[] = recentMessages.map(m => ({
      role: m.role,
      content: m.content,
      parts: (m as any).parts,
      segments: (m as any).segments,
    }));

    // Track tool calls for this message
    const messageToolCalls: Map<string, MessageToolCall> = new Map();
    clearToolCalls();
    // Reset streaming segments and mark as streaming
    const streamRefs: StreamingRefs = { streamingSegmentsRef, segmentsRevisionRef, seenToolCallIds, accumulatedTextRef, isStreamingRef };
    resetStreamingState(streamRefs);

    // Active text/reasoning block IDs for the typed stream protocol
    let contActiveTextId: string | null = null;
    let contActiveReasoningId: string | null = null;

    // Bound helpers using shared streaming refs
    const appendTextToSegments = (text: string, blockId?: string) => _appendText(streamRefs, text, blockId);
    const appendReasoningToSegments = (text: string, blockId?: string) => _appendReasoning(streamRefs, text, blockId);
    const closeBlockById = (blockId: string, blockType: 'text' | 'reasoning') => _closeBlock(streamRefs, blockId, blockType);
    const upsertToolSegment = (toolCall: ToolCall) => _upsertTool(streamRefs, toolCall);

    try {
      let fullResponse = '';
      const workspaceContext = getWorkspaceContext();

      await streamChat(getAIConfig(), chatMessages, {
        onToken: (token) => {
          fullResponse += token;
          appendTextToSegments(token, contActiveTextId || undefined);
        },
        onTextStart: (id) => { contActiveTextId = id; },
        onTextEnd: (id) => { closeBlockById(id, 'text'); contActiveTextId = null; },
        onReasoningStart: (id) => { contActiveReasoningId = id; },
        onReasoningDelta: (delta) => { appendReasoningToSegments(delta, contActiveReasoningId || undefined); },
        onReasoningEnd: (id) => { closeBlockById(id, 'reasoning'); contActiveReasoningId = null; },
        onToolInputStart: (toolCallId, toolName) => {
          upsertToolSegment({ id: toolCallId, name: toolName, status: 'pending', startTime: new Date() });
        },
        onToolInputDelta: () => {},
        onToolInputAvailable: (toolCallId, toolName, input, thoughtSignature) => {
          upsertToolSegment({ id: toolCallId, name: toolName, status: 'running', args: input, startTime: new Date(), thoughtSignature });
        },
        onStepEnd: () => { streamingSegmentsRef.current.push({ type: 'step-boundary' }); segmentsRevisionRef.current++; },
        onStreamError: (errorText) => { streamingSegmentsRef.current.push({ type: 'error', errorText }); segmentsRevisionRef.current++; },
        onStatus: (message) => {
          const segs = streamingSegmentsRef.current;
          const idx = segs.findIndex(s => s.type === 'status');
          if (message) {
            if (idx >= 0) { (segs[idx] as { type: 'status'; message: string }).message = message; }
            else { segs.push({ type: 'status', message }); }
          } else if (idx >= 0) {
            segs.splice(idx, 1);
          }
          segmentsRevisionRef.current++;
        },
        onClear: () => {
          fullResponse = '';
          const textFromCurrent = streamingSegmentsRef.current
            .filter((s): s is { type: 'text'; content: string } => s.type === 'text')
            .map(s => s.content)
            .join('');
          if (textFromCurrent) {
            const cleaned = cleanStreamingContent(textFromCurrent);
            if (cleaned) {
              accumulatedTextRef.current += (accumulatedTextRef.current ? '\n\n' : '') + cleaned;
            }
          }
          streamingSegmentsRef.current = streamingSegmentsRef.current.filter(s => s.type === 'tool');
          segmentsRevisionRef.current++;
        },
        onToolCall: (toolCall) => {
          const existing = messageToolCalls.get(toolCall.id);
          messageToolCalls.set(toolCall.id, {
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args || existing?.args,
            result: toolCall.result || existing?.result,
            status: (toolCall.status === 'completed' || toolCall.status === 'failed') 
              ? toolCall.status 
              : existing?.status || toolCall.status,
            thoughtSignature: toolCall.thoughtSignature || existing?.thoughtSignature,
            syntheticChildren: toolCall.syntheticChildren || existing?.syntheticChildren,
          });
          
          // Add/update tool segment for inline display
          upsertToolSegment({
            id: toolCall.id,
            name: toolCall.name,
            status: toolCall.status,
            args: toolCall.args,
            result: toolCall.result,
            startTime: new Date(),
          });
          
          if (toolCall.status === 'running' && toolCall.args) {
            const callContent = `${toolCall.name}(${serializeForTokenEstimate(toolCall.args)})`;
            const tcArgs2 = toolCall.args as Record<string, unknown> | undefined;
            const tcGoal2 = tcArgs2?.goal as string | undefined;
            const tcSteps2 = Array.isArray(tcArgs2?.steps) ? tcArgs2.steps as unknown[] : undefined;
            const callSummary2 = tcGoal2
              ? `${toolCall.name}: ${tcGoal2.slice(0, 80)}`
              : tcSteps2
                ? `${toolCall.name} (${tcSteps2.length} steps)`
                : toolCall.name;
            contextStore.addChunk(callContent, 'call', toolCall.name, undefined, callSummary2);
          }
          
          upsertToolCall(toolCall.id, {
            name: toolCall.name,
            status: toolCall.status,
            args: toolCall.args,
            result: toolCall.result,
            endTime: toolCall.status === 'completed' || toolCall.status === 'failed' ? new Date() : undefined,
          });

          toolCall.syntheticChildren?.forEach((child) => {
            upsertToolCall(child.id, {
              name: child.name,
              status: child.status as 'completed' | 'failed' | 'pending' | 'running',
              args: child.args,
              result: child.result,
              endTime: child.status === 'completed' || child.status === 'failed' ? new Date() : undefined,
            });
          });
        },
        onToolResult: (id, result) => {
          const existing = messageToolCalls.get(id);
          if (existing) {
            existing.result = result;
            existing.status = 'completed';
            if (!isBatchCall(existing)) {
              contextStore.addChunk(result, 'result', existing.name);
            }
          }
          upsertToolCall(id, { status: 'completed', result, endTime: new Date() });
        },
        onUsageUpdate: (usage) => {
          setContextUsage(usage);
        },
        onError: (error) => {
          console.error('AI error:', error);
          addMessage({
            role: 'assistant',
            content: `❌ **Error**: ${error.message}\n\nPlease check your API key and try again.`,
          });
        },
        onDone: () => {
          isStreamingRef.current = false;
          if (!mountedRef.current) return;
          
          const finalParts: MessagePart[] = [];
          const finalSegments: MessageSegment[] = [];
          if (accumulatedTextRef.current) {
            finalParts.push({ type: 'text', content: accumulatedTextRef.current });
            finalSegments.push({ type: 'text', content: accumulatedTextRef.current });
          }
          for (const seg of streamingSegmentsRef.current) {
            if (seg.type === 'text') {
              const cleaned = cleanStreamingContent(seg.content);
              if (cleaned) {
                finalParts.push({ type: 'text', content: cleaned });
                finalSegments.push({ type: 'text', content: cleaned });
              }
            } else if (seg.type === 'reasoning' && seg.content) {
              finalParts.push({ type: 'reasoning', content: seg.content });
            } else if (seg.type === 'tool') {
              const tc = messageToolCalls.get(seg.toolCall.id);
              if (tc) {
                const toolPart = {
                  type: 'tool' as const,
                  toolCall: {
                    id: tc.id, name: tc.name, args: tc.args, result: tc.result,
                    status: tc.status, thoughtSignature: tc.thoughtSignature,
                    ...(tc.syntheticChildren?.length ? { syntheticChildren: tc.syntheticChildren } : {}),
                  },
                };
                finalParts.push(toolPart);
                finalSegments.push(toolPart);
              }
            } else if (seg.type === 'step-boundary') {
              finalParts.push({ type: 'step-boundary' });
            } else if (seg.type === 'error') {
              finalParts.push({ type: 'error', errorText: seg.errorText });
            }
          }
          
          const cleanedContent = finalParts
            .filter((s): s is { type: 'text'; content: string } => s.type === 'text')
            .map(s => s.content)
            .join('\n');
          const synthesizedTaskSummary = cleanedContent ? '' : getTaskCompleteSummaryFromParts(finalParts);
          if (synthesizedTaskSummary) {
            finalParts.unshift({ type: 'text', content: synthesizedTaskSummary });
            finalSegments.unshift({ type: 'text', content: synthesizedTaskSummary });
          }
          const resolvedContent = cleanedContent || synthesizedTaskSummary;
          const finalTaskSummary = synthesizedTaskSummary || getTaskCompleteSummaryFromParts(finalParts);
          
          const hasToolCalls = finalParts.some(s => s.type === 'tool');
          const hasErrors = finalParts.some(s => s.type === 'error');
          
          if (resolvedContent || hasToolCalls || hasErrors) {
            const contAsstHash = resolvedContent
              ? contextStore.addChunk(resolvedContent, 'msg:asst')
              : undefined;
            addMessage({ 
              role: 'assistant', 
              content: resolvedContent || finalTaskSummary || '*(Tool execution completed)*',
              parts: finalParts.length > 0 ? finalParts : undefined,
              segments: finalSegments.length > 0 ? finalSegments : undefined,
              chunkHash: contAsstHash,
            });
          }
          streamingSegmentsRef.current = [];
          accumulatedTextRef.current = '';
          seenToolCallIds.current.clear();
          setIsGenerating(false);
          clearToolCalls();
          if (useAppStore.getState().agentProgress.stoppedReason === 'completed') {
            setAgentCanContinue(false);
          }
        },
      }, workspaceContext, chatMode as ChatMode);
    } catch (error) {
      console.error('Chat error:', error);
      addMessage({
        role: 'assistant',
        content: `❌ **Error**: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease try again.`,
      });
      setIsGenerating(false);
      streamingSegmentsRef.current = [];
      seenToolCallIds.current.clear();
    }
  }, [isGenerating, agentCanContinue, setAgentCanContinue, messages, addMessage, setIsGenerating, projectPath, atlsInitialized, initAtls, getWorkspaceContext, getAIConfig, clearToolCalls, upsertToolCall, setContextUsage, chatMode]);

  return (
    <div
      data-drop-target="chat"
      className="h-full flex flex-col relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay - shown for HTML5 drag events OR internal file explorer drags */}
      {(isDragOver || isInternalDragActive) && (
        <div className="absolute inset-0 z-40 bg-studio-accent/15 border-2 border-dashed border-studio-accent rounded-lg flex items-center justify-center pointer-events-none animate-pulse">
          <div className="bg-studio-surface px-6 py-4 rounded-lg shadow-xl border border-studio-accent text-center">
            <svg className="w-10 h-10 mx-auto mb-2 text-studio-accent" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
            </svg>
            <p className="text-base font-semibold text-studio-accent">Drop files here to attach</p>
            <p className="text-xs text-studio-muted mt-1">Files, images, or folders</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="p-2 border-b border-studio-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-studio-title uppercase tracking-wide">
            AI Assistant
          </h2>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1 text-studio-muted hover:text-studio-text transition-colors"
            title="Settings"
          >
            <SettingsIcon />
          </button>
          <button
            onClick={async () => {
              const debugData = {
                provider: getSelectedModelProvider(),
                selectedProvider: settings.selectedProvider,
                model: settings.selectedModel,
                mode: chatMode,
                isGenerating,
                agentProgress,
                liveToolCalls: toolCalls,
                streamingSegments: streamingSegmentsRef.current,
                accumulatedText: accumulatedTextRef.current,
                messageCount: messages.length,
                messages: messages.map(serializeMessageForDebug),
              };
              await navigator.clipboard.writeText(JSON.stringify(debugData, null, 2));
            }}
            className="p-1 text-studio-muted hover:text-yellow-400 transition-colors"
            title="Copy raw chat debug data"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h2v-2h-2v2zm0-4h2V7h-2v6z" fill="currentColor" stroke="none"/>
            </svg>
          </button>
          <button
            onClick={() => setShowTokenMetrics(!showTokenMetrics)}
            className={`p-1 transition-colors ${showTokenMetrics ? 'text-studio-accent' : 'text-studio-muted hover:text-cyan-400'}`}
            title="Tool token metrics"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M4 20h2V10H4v10zm4 0h2V4H8v16zm4 0h2v-6h-2v6zm4 0h2V8h-2v12z"/>
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={`p-1 transition-colors ${showHistory ? 'text-studio-accent' : 'text-studio-muted hover:text-studio-text'}`}
            title="Chat history"
          >
            <HistoryIcon />
          </button>
          <button
            onClick={handleNewChat}
            className="p-1 text-studio-muted hover:text-studio-text transition-colors"
            title="New chat"
            disabled={isGenerating}
          >
            <NewChatIcon />
          </button>
          {messages.length > 0 && (
            <button
              onClick={clearMessages}
              className="p-1 text-studio-muted hover:text-studio-text transition-colors"
              title="Clear chat"
            >
              <ClearIcon />
            </button>
          )}
        </div>
      </div>

      {/* History Panel (slides in) */}
      {showHistory && (
        <div className="absolute inset-0 top-[72px] z-10 bg-studio-bg/95 backdrop-blur-sm flex flex-col">
          <div className="p-3 border-b border-studio-border">
            <h3 className="text-sm font-medium text-studio-title">Chat History</h3>
            <p className="text-xs text-studio-muted">{chatSessions.length} conversations</p>
          </div>
          <div className="flex-1 overflow-y-auto">
            {chatSessions.length === 0 ? (
              <div className="p-4 text-center text-studio-muted text-sm">
                No saved chats yet
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {chatSessions.map(session => (
                  <div
                    key={session.id}
                    className="group flex items-center gap-2 p-2 rounded hover:bg-studio-surface cursor-pointer"
                    onClick={async () => {
                      setEditingMessageId(null);
                      clearRestoreUndo();
                      await loadSession(session.id);
                      setShowHistory(false);
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-studio-text truncate">{session.title}</p>
                      <p className="text-xs text-studio-muted">
                        {session.contextUsage?.totalTokens ? `${Math.round(session.contextUsage.totalTokens / 1000)}k tokens` : 'New'}
                        {session.contextUsage?.costCents ? ` · $${(session.contextUsage.costCents / 100).toFixed(2)}` : ''}
                        {' '}• {new Date(session.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        await deleteSession(session.id);
                      }}
                      className="p-1 text-studio-muted hover:text-studio-error opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Delete"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="p-2 border-t border-studio-border">
            <button
              onClick={() => setShowHistory(false)}
              className="w-full px-3 py-1.5 text-sm text-studio-muted hover:text-studio-text bg-studio-surface rounded transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Agent Progress Status Card - fixed at top, outside scroll area */}
      <AgentStatusCard />
      
      {/* Context/Task/Blackboard Panel */}
      <ContextPanel />
      
      {/* Undo restore banner */}
      {restoreUndoStack && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-studio-info/10 border-b border-studio-info/20 text-xs">
          <span className="text-studio-info">Conversation restored to earlier message.</span>
          <button
            onClick={handleUndoRestore}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-studio-info hover:bg-studio-info/20 transition-colors font-medium"
          >
            <UndoIcon />
            Undo
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
        {messages.length === 0 && !isGenerating ? (
          <div className="h-full flex flex-col items-center justify-center text-studio-muted">
            <AIIcon />
            <p className="mt-2 text-sm text-studio-text">How can I help you today?</p>
            
            {/* API Key Warning */}
            {!hasApiKey() && (
              <div className="mt-4 p-3 bg-studio-warning/10 border border-studio-warning/30 rounded-lg text-xs text-studio-warning max-w-[240px] text-center">
                <p>⚠️ No API key configured</p>
                <p className="text-studio-muted mt-1">Add your key in Settings</p>
              </div>
            )}
            
            {/* Suggested prompts - mode-aware */}
            <div className="mt-4 flex flex-wrap justify-center gap-2 max-w-full">
              {(chatMode === 'refactor' ? REFACTOR_SUGGESTED_PROMPTS : DEFAULT_SUGGESTED_PROMPTS).map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => setInput(prompt)}
                  className="text-xs px-2 py-1 bg-studio-surface border border-studio-border rounded hover:border-studio-accent transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* Memoized message list - won't re-render during streaming */}
            <MessageList
              messages={messages}
              editingMessageId={editingMessageId}
              onStartEdit={handleStartEdit}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
            />

            {/* Live swarm research progress - shows during research/planning phases */}
            <SwarmResearchProgress />
            
            {/* Live swarm execution progress - shows during running phase */}
            <SwarmExecutionProgress />
            
            {/* Streaming response with inline tool calls */}
            <StreamingBubble
              segmentsRef={streamingSegmentsRef}
              revisionRef={segmentsRevisionRef}
              isGenerating={isGenerating}
              onScrollToBottom={() => scrollToBottom('instant')}
            />
            
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-studio-border">
        <div className="p-2">
          <div className="bg-studio-surface border border-studio-border rounded-lg p-2">
            {/* Attachment chips */}
            <AttachmentChips />
            <div className="flex items-end gap-2">
              {/* Attach button */}
              <button
                onClick={handleAttachClick}
                className="p-1.5 rounded text-studio-muted hover:text-studio-text hover:bg-studio-border/50 transition-colors shrink-0"
                title="Attach files or images"
              >
                <AttachIcon />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Ask me anything..."
                className="
                  flex-1 resize-none bg-transparent text-sm text-studio-text
                  focus:outline-none placeholder:text-studio-muted
                  max-h-[120px] min-h-[24px]
                "
                rows={1}
              />
            {isGenerating ? (
              <button
                onClick={() => {
                  // Increment session ID FIRST to invalidate all pending callbacks
                  incrementChatSession();
                  
                  // Then stop the chat
                  stopChat();
                  
                  // Clear any pending timeouts
                  if (updateTimeoutRef.current) {
                    clearTimeout(updateTimeoutRef.current);
                    updateTimeoutRef.current = null;
                  }
                  
                  // Save partial response - merge accumulated + current round, include segments
                  const currentText = streamingSegmentsRef.current
                    .filter((s): s is { type: 'text'; content: string } => s.type === 'text')
                    .map(s => s.content)
                    .join('');
                  const cleanedCurrent = cleanStreamingContent(currentText);
                  const fullText = accumulatedTextRef.current
                    ? accumulatedTextRef.current + (cleanedCurrent ? '\n\n' + cleanedCurrent : '')
                    : cleanedCurrent;
                  const partialParts: MessagePart[] = [];
                  if (accumulatedTextRef.current) {
                    partialParts.push({ type: 'text', content: accumulatedTextRef.current });
                  }
                  for (const seg of streamingSegmentsRef.current) {
                    if (seg.type === 'text') {
                      const cleaned = cleanStreamingContent(seg.content);
                      if (cleaned) partialParts.push({ type: 'text', content: cleaned });
                    } else if (seg.type === 'tool') {
                      const status = seg.toolCall.status;
                      partialParts.push({
                        type: 'tool',
                        toolCall: {
                          id: seg.toolCall.id,
                          name: seg.toolCall.name,
                          args: seg.toolCall.args,
                          result: seg.toolCall.result,
                          status: (status === 'completed' || status === 'failed' ? status : 'failed') as 'completed' | 'failed',
                        },
                      });
                    }
                  }
                  if (fullText || partialParts.length > 0) {
                    const taskCompleteSummary = fullText ? '' : getTaskCompleteSummaryFromParts(partialParts);
                    const content = fullText
                      ? fullText + '\n\n*[Stopped]*'
                      : (taskCompleteSummary ? taskCompleteSummary + '\n\n*[Stopped]*' : '*(Stopped)*');
                    const stopHash = content ? useContextStore.getState().addChunk(content, 'msg:asst') : undefined;
                    addMessage({
                      role: 'assistant',
                      content,
                      parts: partialParts.length > 0 ? partialParts : undefined,
                      chunkHash: stopHash,
                    });
                    saveSession();
                  }
                  
                  // Reset all state
                  setIsGenerating(false);
                  streamingSegmentsRef.current = [];
                  accumulatedTextRef.current = '';
                  seenToolCallIds.current.clear();
                  clearToolCalls();
                  setAgentCanContinue(false);
                }}
                className="p-2 rounded transition-colors shrink-0 bg-studio-error text-white hover:bg-studio-error/80"
                title="Stop generation"
              >
                <StopIcon />
              </button>
            ) : (
              <>
                {/* Continue button - shown when agent stopped naturally */}
                {agentCanContinue && (
                  <button
                    onClick={handleContinue}
                    className="p-2 rounded transition-colors shrink-0 bg-studio-success text-white hover:bg-studio-success/80"
                    title="Continue agent"
                  >
                    <ContinueIcon />
                  </button>
                )}
                <button
                  data-send-button
                  onClick={handleSend}
                  disabled={!input.trim() && !agentCanContinue && attachments.length === 0}
                  className={`
                    p-2 rounded transition-colors shrink-0
                    ${(input.trim() || attachments.length > 0)
                      ? 'bg-studio-accent-bright text-studio-bg hover:bg-studio-accent'
                      : 'bg-studio-border text-studio-muted cursor-not-allowed'
                    }
                  `}
                >
                  <SendIcon />
                </button>
              </>
            )}
            </div>
          </div>
        </div>
        
        {/* Model & Mode Selector Bar */}
        <ModelModeSelector />
        
        {/* Compact Context Meter + Metrics */}
        <ContextMeter />
        <ContextMetrics />
      </div>

      {/* Tool Token Metrics Modal */}
      {showTokenMetrics && (
        <ToolTokenMetrics onClose={() => setShowTokenMetrics(false)} />
      )}

      {/* Settings Modal */}
      <Settings isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}

export default AiChat;
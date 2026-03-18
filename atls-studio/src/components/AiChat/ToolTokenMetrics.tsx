/**
 * Tool Token Metrics Modal
 *
 * Displays per-tool token usage breakdown for current chat and all sessions.
 * Sorted by total tokens descending to surface the biggest optimization targets.
 */

import { memo, useState, useEffect, useCallback, useMemo } from 'react';
import { useAppStore } from '../../stores/appStore';
import { chatDb } from '../../services/chatDb';
import {
  analyzeToolTokens,
  analyzeDbSegments,
  mergeReports,
  formatTokens,
  type ToolTokenReport,
  type ToolTokenEntry,
} from '../../utils/toolTokenMetrics';
import type { DbSegment } from '../../services/chatDb';

// ============================================================================
// Sub-components
// ============================================================================

const SummaryBar = memo(function SummaryBar({ report }: { report: ToolTokenReport }) {
  const total = report.grandTotalTokens + report.textSegmentTokens + report.userMessageTokens;
  const toolPct = total > 0 ? ((report.grandTotalTokens / total) * 100).toFixed(1) : '0';
  const resultPct = report.grandTotalTokens > 0
    ? ((report.grandTotalResultTokens / report.grandTotalTokens) * 100).toFixed(0)
    : '0';

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
        <span>
          <span className="text-studio-muted">Tools:</span>{' '}
          <span className="text-studio-accent font-medium">{formatTokens(report.grandTotalTokens)}</span>
          <span className="text-studio-muted"> ({toolPct}% of chat)</span>
        </span>
        <span>
          <span className="text-studio-muted">Calls:</span>{' '}
          <span className="font-medium">{report.totalToolCalls}</span>
        </span>
        <span>
          <span className="text-studio-muted">Args:</span>{' '}
          <span className="text-blue-400">{formatTokens(report.grandTotalArgTokens)}</span>
        </span>
        <span>
          <span className="text-studio-muted">Results:</span>{' '}
          <span className="text-amber-400">{formatTokens(report.grandTotalResultTokens)}</span>
          <span className="text-studio-muted"> ({resultPct}%)</span>
        </span>
      </div>

      {/* Composition bar */}
      <div className="flex h-2 rounded-full overflow-hidden bg-studio-border">
        {report.userMessageTokens > 0 && (
          <div
            className="bg-emerald-600 transition-all"
            style={{ width: `${(report.userMessageTokens / total) * 100}%` }}
            title={`User messages: ${formatTokens(report.userMessageTokens)}`}
          />
        )}
        {report.textSegmentTokens > 0 && (
          <div
            className="bg-purple-500 transition-all"
            style={{ width: `${(report.textSegmentTokens / total) * 100}%` }}
            title={`Assistant text: ${formatTokens(report.textSegmentTokens)}`}
          />
        )}
        {report.grandTotalArgTokens > 0 && (
          <div
            className="bg-blue-500 transition-all"
            style={{ width: `${(report.grandTotalArgTokens / total) * 100}%` }}
            title={`Tool args: ${formatTokens(report.grandTotalArgTokens)}`}
          />
        )}
        {report.grandTotalResultTokens > 0 && (
          <div
            className="bg-amber-500 transition-all"
            style={{ width: `${(report.grandTotalResultTokens / total) * 100}%` }}
            title={`Tool results: ${formatTokens(report.grandTotalResultTokens)}`}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-x-2.5 gap-y-0 text-[9px] text-studio-muted">
        <span className="flex items-center gap-0.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-600" />
          User {formatTokens(report.userMessageTokens)}
        </span>
        <span className="flex items-center gap-0.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500" />
          Asst text {formatTokens(report.textSegmentTokens)}
        </span>
        <span className="flex items-center gap-0.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
          Tool args {formatTokens(report.grandTotalArgTokens)}
        </span>
        <span className="flex items-center gap-0.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
          Tool results {formatTokens(report.grandTotalResultTokens)}
        </span>
      </div>
    </div>
  );
});

const ToolRow = memo(function ToolRow({ entry, maxTotal }: { entry: ToolTokenEntry; maxTotal: number }) {
  const barWidth = maxTotal > 0 ? (entry.totalTokens / maxTotal) * 100 : 0;
  const argPct = entry.totalTokens > 0 ? (entry.totalArgTokens / entry.totalTokens) * 100 : 0;
  const ratio = entry.totalArgTokens > 0
    ? (entry.totalResultTokens / entry.totalArgTokens).toFixed(1)
    : '-';
  const isHot = Number(ratio) >= 10;

  return (
    <div className="group py-1 border-b border-studio-border/50 last:border-0">
      <div className="flex items-center gap-2 text-[10px]">
        <span className="font-mono text-studio-text w-28 truncate shrink-0" title={entry.toolName}>
          {entry.toolName}
        </span>
        <span className="text-studio-muted w-8 text-right shrink-0">{entry.callCount}x</span>
        <div className="flex-1 min-w-0">
          <div className="flex h-1.5 rounded-full overflow-hidden bg-studio-border/50">
            <div
              className="bg-blue-500 transition-all"
              style={{ width: `${barWidth * (argPct / 100)}%` }}
              title={`Args: ${formatTokens(entry.totalArgTokens)}`}
            />
            <div
              className="bg-amber-500 transition-all"
              style={{ width: `${barWidth * ((100 - argPct) / 100)}%` }}
              title={`Results: ${formatTokens(entry.totalResultTokens)}`}
            />
          </div>
        </div>
        <span className="text-blue-400 w-12 text-right shrink-0">{formatTokens(entry.totalArgTokens)}</span>
        <span className="text-amber-400 w-12 text-right shrink-0">{formatTokens(entry.totalResultTokens)}</span>
        <span className="text-studio-text w-12 text-right shrink-0 font-medium">{formatTokens(entry.totalTokens)}</span>
        <span className={`w-10 text-right shrink-0 ${isHot ? 'text-red-400 font-medium' : 'text-studio-muted'}`} title="Result/Arg ratio">
          {ratio}x
        </span>
      </div>
      {/* Expanded stats on hover */}
      <div className="hidden group-hover:flex gap-3 text-[9px] text-studio-muted mt-0.5 ml-28 pl-2">
        <span>avg result: {formatTokens(entry.avgResultTokens)}</span>
        <span>max result: {formatTokens(entry.maxResultTokens)}</span>
      </div>
    </div>
  );
});

// ============================================================================
// Main component
// ============================================================================

type MetricsTab = 'current' | 'all';

interface Props {
  onClose: () => void;
}

export const ToolTokenMetrics = memo(function ToolTokenMetrics({ onClose }: Props) {
  const messages = useAppStore(state => state.messages);
  const chatSessions = useAppStore(state => state.chatSessions);

  const [tab, setTab] = useState<MetricsTab>('current');
  const [allReport, setAllReport] = useState<ToolTokenReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState('');
  const [copied, setCopied] = useState(false);

  // Current chat analysis (synchronous)
  const currentReport = useMemo(() => analyzeToolTokens(messages), [messages]);

  // Load all sessions from DB
  const loadAllSessions = useCallback(async () => {
    if (!chatDb.isInitialized()) return;
    setLoading(true);
    setLoadProgress('Loading sessions...');

    try {
      const sessions = await chatDb.getSessions(100);
      const reports: ToolTokenReport[] = [];

      for (let i = 0; i < sessions.length; i++) {
        setLoadProgress(`Analyzing ${i + 1}/${sessions.length}...`);
        const dbMessages = await chatDb.getMessages(sessions[i].id);
        if (dbMessages.length === 0) continue;

        const segMap = new Map<string, DbSegment[]>();
        for (const msg of dbMessages) {
          const segs = await chatDb.getSegments(msg.id);
          if (segs.length > 0) segMap.set(msg.id, segs);
        }

        reports.push(analyzeDbSegments(dbMessages, segMap));
      }

      setAllReport(mergeReports(reports));
    } catch (err) {
      console.error('[ToolTokenMetrics] Failed to load sessions:', err);
    } finally {
      setLoading(false);
      setLoadProgress('');
    }
  }, []);

  useEffect(() => {
    if (tab === 'all' && !allReport && !loading) {
      loadAllSessions();
    }
  }, [tab, allReport, loading, loadAllSessions]);

  const activeReport = tab === 'current' ? currentReport : allReport;

  const handleCopy = useCallback(() => {
    if (!activeReport) return;
    navigator.clipboard.writeText(JSON.stringify(activeReport, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [activeReport]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const maxTotal = activeReport
    ? Math.max(...activeReport.entries.map(e => e.totalTokens), 1)
    : 1;

  return (
    <div className="absolute inset-0 z-20 bg-studio-bg/95 backdrop-blur-sm flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-studio-border">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-studio-title uppercase tracking-wide">Tool Token Metrics</h3>
          <div className="flex bg-studio-border/50 rounded-md p-0.5">
            <button
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                tab === 'current' ? 'bg-studio-accent/20 text-studio-accent' : 'text-studio-muted hover:text-studio-text'
              }`}
              onClick={() => setTab('current')}
            >
              Current
            </button>
            <button
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                tab === 'all' ? 'bg-studio-accent/20 text-studio-accent' : 'text-studio-muted hover:text-studio-text'
              }`}
              onClick={() => setTab('all')}
            >
              All ({chatSessions.length})
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="px-1.5 py-0.5 text-[10px] text-studio-muted hover:text-studio-text transition-colors"
            title="Copy report as JSON"
          >
            {copied ? 'Copied' : 'Copy JSON'}
          </button>
          <button
            onClick={onClose}
            className="p-1 text-studio-muted hover:text-studio-text transition-colors"
            title="Close"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {loading && (
          <div className="text-center text-[10px] text-studio-muted py-4">
            <div className="animate-pulse">{loadProgress || 'Loading...'}</div>
          </div>
        )}

        {activeReport && !loading && (
          <>
            <SummaryBar report={activeReport} />

            {activeReport.entries.length === 0 ? (
              <div className="text-center text-[10px] text-studio-muted py-4">
                No tool calls in {tab === 'current' ? 'this chat' : 'any session'}.
              </div>
            ) : (
              <div>
                {/* Column headers */}
                <div className="flex items-center gap-2 text-[9px] text-studio-muted uppercase tracking-wider pb-1 border-b border-studio-border">
                  <span className="w-28 shrink-0">Tool</span>
                  <span className="w-8 text-right shrink-0">Calls</span>
                  <span className="flex-1" />
                  <span className="w-12 text-right shrink-0">Args</span>
                  <span className="w-12 text-right shrink-0">Results</span>
                  <span className="w-12 text-right shrink-0">Total</span>
                  <span className="w-10 text-right shrink-0">R/A</span>
                </div>
                {activeReport.entries.map(entry => (
                  <ToolRow key={entry.toolName} entry={entry} maxTotal={maxTotal} />
                ))}
              </div>
            )}
          </>
        )}

        {!activeReport && !loading && tab === 'all' && (
          <div className="text-center text-[10px] text-studio-muted py-4">
            No session data available.
          </div>
        )}
      </div>
    </div>
  );
});

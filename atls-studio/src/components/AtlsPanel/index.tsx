import React from 'react';
import { useAppStore } from '../../stores/appStore';
import { useAtls } from '../../hooks/useAtls';
import { TerminalPanel } from '../Terminal';
import { AtlsIcon, TerminalIcon } from './icons';
import type { TabType } from './types';
import { IssuesTab } from './IssuesTab';
import { FileIntelTab } from './FileIntelTab';
import { PatternsTab } from './PatternsTab';
import { OverviewTab } from './OverviewTab';
import { HealthTab } from './HealthTab';
import { FocusProfilePopover } from './FocusProfilePopover';

const TAB_LABELS: Record<TabType, string> = {
  issues: 'Issues',
  file: 'File',
  patterns: 'Patterns',
  overview: 'Overview',
  health: 'Health',
};

export function AtlsPanel() {
  const projectPath = useAppStore((s) => s.projectPath);
  const activeRoot = useAppStore((s) => s.activeRoot);
  const issueCounts = useAppStore((s) => s.issueCounts);
  const scanStatus = useAppStore((s) => s.scanStatus);
  const terminalOpen = useAppStore((s) => s.terminalOpen);
  const setTerminalOpen = useAppStore((s) => s.setTerminalOpen);
  const terminalCollapsed = useAppStore((s) => s.terminalCollapsed);
  const toggleTerminalCollapsed = useAppStore((s) => s.toggleTerminalCollapsed);
  const activeTab = useAppStore((s) => s.atlsPanelTab);
  const setActiveTab = useAppStore((s) => s.setAtlsPanelTab);

  const { scanProject } = useAtls();
  const scanRoot = activeRoot ?? projectPath;
  const hasProject = !!scanRoot;

  const handleScan = () => {
    if (!scanRoot) return;
    scanProject(scanRoot, false);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Primary Header - ATLS Intelligence / Terminal tabs */}
      <div className="flex items-center border-b border-studio-border bg-studio-surface">
        <div className="flex-1 flex justify-start">
          {/* Panel header controls */}
          <button
            onClick={() => {
              if (terminalCollapsed) toggleTerminalCollapsed();
              setTerminalOpen(false);
            }}
            className={`
              flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wide transition-colors
              ${!terminalOpen
                ? 'text-studio-title border-b-2 border-studio-title bg-studio-bg'
                : 'text-studio-muted hover:text-studio-text'
              }
            `}
          >
            <AtlsIcon />
            ATLS Intelligence
          </button>
        </div>

        <button
          onClick={() => toggleTerminalCollapsed()}
          className="px-12 py-4 text-studio-muted hover:text-studio-text hover:bg-studio-border rounded transition-colors shrink-0"
          title={terminalCollapsed ? 'Expand panel' : 'Collapse panel'}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {terminalCollapsed ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            )}
          </svg>
        </button>

        <div className="flex-1 flex justify-end">
          <button
            onClick={() => {
              if (terminalCollapsed) toggleTerminalCollapsed();
              setTerminalOpen(true);
            }}
            className={`
              flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wide transition-colors
              ${terminalOpen
                ? 'text-studio-title border-b-2 border-studio-title bg-studio-bg'
                : 'text-studio-muted hover:text-studio-text'
              }
            `}
          >
            <TerminalIcon />
            Terminal
          </button>
        </div>
      </div>

      {/* ATLS Intelligence Content */}
      {!terminalOpen && (
        <>
          {/* Secondary row: Scan + Tabs + Issue counts */}
          <div className="flex items-center border-b border-studio-border px-2 py-1 gap-2">
            {/* Tab buttons */}
            {(Object.keys(TAB_LABELS) as TabType[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`
                  px-3 py-1 text-xs uppercase tracking-wide transition-colors rounded
                  ${activeTab === tab
                    ? 'text-studio-accent bg-studio-accent/10'
                    : 'text-studio-muted hover:text-studio-text'
                  }
                `}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}

            {/* Scan + Focus profile gear + Issue counts */}
            <div className="flex items-center gap-2 text-xs ml-auto">
              <button
                onClick={handleScan}
                disabled={!hasProject || scanStatus.isScanning}
                className={`
                  text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-50
                  ${scanStatus.isScanning
                    ? 'text-studio-accent'
                    : 'text-studio-title hover:text-studio-title/80'
                  }
                `}
              >
                {scanStatus.isScanning
                  ? (scanStatus.scanQueueTotal ?? 0) > 1
                    ? `Scanning ${(scanStatus.scanQueueCompleted ?? 0) + 1}/${scanStatus.scanQueueTotal}...`
                    : 'Scanning...'
                  : 'Scan'
                }
              </button>
              <FocusProfilePopover />
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-studio-text tabular-nums" title="Total issues">{issueCounts.total}</span>
              <span className="flex items-center gap-1" title="High severity">
                <span className="w-2 h-2 rounded-full bg-studio-error" />
                <span className="text-studio-error">{issueCounts.high}</span>
              </span>
              <span className="flex items-center gap-1" title="Medium severity">
                <span className="w-2 h-2 rounded-full bg-studio-warning" />
                <span className="text-studio-warning">{issueCounts.medium}</span>
              </span>
              <span className="flex items-center gap-1" title="Low severity">
                <span className="w-2 h-2 rounded-full bg-studio-muted" />
                <span className="text-studio-muted">{issueCounts.low}</span>
              </span>
            </div>

            {/* Scan progress (inline) */}
            {scanStatus.isScanning && (
              <div className="flex items-center gap-2 text-xs text-studio-accent ml-2 min-w-0">
                {/* Multi-repo queue badge */}
                {(scanStatus.scanQueueTotal ?? 0) > 1 && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded bg-studio-accent/15 text-studio-accent font-medium tabular-nums">
                    {(scanStatus.scanQueueCompleted ?? 0) + 1}/{scanStatus.scanQueueTotal} repos
                  </span>
                )}
                {scanStatus.phase && (
                  <span className="shrink-0 text-studio-muted">{scanStatus.phase}</span>
                )}
                <div className="w-16 h-1.5 bg-studio-border rounded-full overflow-hidden shrink-0">
                  <div
                    className="h-full bg-studio-accent transition-all"
                    style={{ width: `${scanStatus.progress}%` }}
                  />
                </div>
                <span className="tabular-nums shrink-0">
                  {scanStatus.filesProcessed}/{scanStatus.filesTotal}
                </span>
                {scanStatus.currentFile && (
                  <span className="truncate max-w-[120px] text-studio-muted" title={scanStatus.currentFile}>
                    {scanStatus.currentFile.split(/[/\\]/).pop()}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto scrollbar-thin flex flex-col">
            {activeTab === 'issues' && <IssuesTab />}
            {activeTab === 'file' && <FileIntelTab />}
            {activeTab === 'patterns' && <PatternsTab />}
            {activeTab === 'overview' && <OverviewTab />}
            {activeTab === 'health' && <HealthTab />}
          </div>
        </>
      )}

      {/* Terminal Content */}
      {terminalOpen && (
        <div className="flex-1 overflow-hidden">
          <TerminalPanel
            isOpen={true}
            onClose={() => setTerminalOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

export default AtlsPanel;

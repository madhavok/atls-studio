import { useState, useCallback } from 'react';
import { HppSection } from './sections/HppSection';
import { BlackboardSection } from './sections/BlackboardSection';
import { WorkingMemorySection } from './sections/WorkingMemorySection';
import { ContextMetricsSection } from './sections/ContextMetricsSection';
import { ToolTokenSection } from './sections/ToolTokenSection';
import { ContextTimelineSection } from './sections/ContextTimelineSection';
import { CostIOSection } from './sections/CostIOSection';
import { ContextTreemapSection } from './sections/ContextTreemapSection';
import { CacheCompositionSection } from './sections/CacheCompositionSection';
import { BatchEfficiencySection } from './sections/BatchEfficiencySection';
import { EntryManifestSection } from './sections/EntryManifestSection';
import { SubAgentSection } from './sections/SubAgentSection';

export const INTERNALS_TAB_ID = '__atls_internals__';

interface SectionDef {
  id: string;
  title: string;
  subtitle: string;
  component: React.FC;
}

const SECTIONS: SectionDef[] = [
  { id: 'hpp', title: 'HPP Protocol', subtitle: 'Hash Pointer materialization state machine', component: HppSection },
  { id: 'bb', title: 'Blackboard', subtitle: 'Persistent session knowledge store', component: BlackboardSection },
  { id: 'wm', title: 'Working Memory', subtitle: 'Ephemeral task-scoped context chunks', component: WorkingMemorySection },
  { id: 'ctx', title: 'Context Metrics', subtitle: 'Budget allocation and cache performance', component: ContextMetricsSection },
  { id: 'timeline', title: 'Context Timeline', subtitle: 'Context grow/shrink over rounds', component: ContextTimelineSection },
  { id: 'costio', title: 'Cost & I/O per Iteration', subtitle: 'Token I/O and cost per round', component: CostIOSection },
  { id: 'treemap', title: 'Context Composition', subtitle: 'Treemap of live context allocation', component: ContextTreemapSection },
  { id: 'cache', title: 'Cache Composition', subtitle: 'Provider cache regions and token layout', component: CacheCompositionSection },
  { id: 'batch', title: 'Batch Efficiency', subtitle: 'Batching ratio and non-batched cost comparison', component: BatchEfficiencySection },
  { id: 'tools', title: 'Tool Token Usage', subtitle: 'Per-tool token consumption breakdown', component: ToolTokenSection },
  { id: 'subagent', title: 'SubAgent Activity', subtitle: 'Retriever invocations, cost, and pin efficiency', component: SubAgentSection },
  { id: 'entry', title: 'Entry Manifest', subtitle: 'Entry point signatures and token scaling', component: EntryManifestSection },
];

const ChevronDown = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
  </svg>
);

const ChevronRight = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
  </svg>
);

const BrainIcon = () => (
  <svg className="w-5 h-5 text-studio-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
  </svg>
);

export function AtlsInternals() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [refreshKey, setRefreshKey] = useState(0);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const expandAll = useCallback(() => setCollapsed({}), []);
  const collapseAll = useCallback(() => {
    const c: Record<string, boolean> = {};
    SECTIONS.forEach((s) => { c[s.id] = true; });
    setCollapsed(c);
  }, []);

  return (
    <div className="h-full flex flex-col bg-studio-bg text-studio-text">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-studio-border bg-studio-surface/50">
        <BrainIcon />
        <div className="flex-1">
          <h2 className="text-sm font-semibold">ATLS Internals</h2>
          <p className="text-[10px] text-studio-muted">Live subsystem diagnostics</p>
        </div>
        <div className="flex gap-1">
          <button
            className="text-[10px] text-studio-muted hover:text-studio-text px-2 py-1 rounded hover:bg-studio-border/30"
            onClick={expandAll}
          >
            Expand All
          </button>
          <button
            className="text-[10px] text-studio-muted hover:text-studio-text px-2 py-1 rounded hover:bg-studio-border/30"
            onClick={collapseAll}
          >
            Collapse All
          </button>
          <button
            className="text-[10px] text-studio-muted hover:text-studio-text px-2 py-1 rounded hover:bg-studio-border/30"
            onClick={() => setRefreshKey((k) => k + 1)}
            title="Refresh all sections"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Sections */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2" key={refreshKey}>
        {SECTIONS.map((section) => {
          const isCollapsed = collapsed[section.id] ?? false;
          const Comp = section.component;
          return (
            <div
              key={section.id}
              className="border border-studio-border/40 rounded-lg bg-studio-surface/30 overflow-hidden"
            >
              {/* Section header */}
              <button
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-studio-border/20 transition-colors"
                onClick={() => toggle(section.id)}
              >
                <span className="text-studio-muted">
                  {isCollapsed ? <ChevronRight /> : <ChevronDown />}
                </span>
                <span className="text-xs font-medium text-studio-text">{section.title}</span>
                <span className="text-[10px] text-studio-muted">{section.subtitle}</span>
              </button>

              {/* Section content */}
              {!isCollapsed && (
                <div className="px-3 pb-3 border-t border-studio-border/20">
                  <div className="mt-2">
                    <Comp />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

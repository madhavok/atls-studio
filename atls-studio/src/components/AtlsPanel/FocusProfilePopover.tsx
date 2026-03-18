import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, ALL_CATEGORIES } from '../../stores/appStore';
import type { FocusMatrix, FocusProfile } from '../../stores/appStore';
import { useAtls } from '../../hooks/useAtls';

const SEVERITIES = ['high', 'medium', 'low'] as const;

const SEV_LABELS: Record<string, string> = { high: 'H', medium: 'M', low: 'L' };
const SEV_COLORS: Record<string, string> = {
  high: 'bg-studio-error/30 border-studio-error/50 text-studio-error',
  medium: 'bg-studio-warning/30 border-studio-warning/50 text-studio-warning',
  low: 'bg-studio-border/40 border-studio-border text-studio-muted',
};
const SEV_ACTIVE: Record<string, string> = {
  high: 'bg-studio-error/60 border-studio-error text-white',
  medium: 'bg-studio-warning/60 border-studio-warning text-white',
  low: 'bg-studio-muted/60 border-studio-muted text-white',
};

interface SavedProfiles {
  profiles: Record<string, { matrix: FocusMatrix }>;
  activeProfile: string;
}

/** Format category name for display */
function formatCategory(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function FocusProfilePopover() {
  const {
    focusProfile,
    focusProfileName,
    setFocusProfile,
    projectPath,
    activeRoot,
  } = useAppStore();
  const { scanProject } = useAtls();

  const [open, setOpen] = useState(false);
  const [savedProfiles, setSavedProfiles] = useState<SavedProfiles | null>(null);
  const [localMatrix, setLocalMatrix] = useState<FocusMatrix>({ ...focusProfile.matrix });
  const [localName, setLocalName] = useState(focusProfileName);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [dirty, setDirty] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  // Load saved profiles from disk on first open
  const loadProfiles = useCallback(async () => {
    try {
      const data = await invoke<SavedProfiles>('get_focus_profiles');
      setSavedProfiles(data);
    } catch (err) {
      console.error('Failed to load focus profiles:', err);
    }
  }, []);

  // Compute position and load data when opening
  useEffect(() => {
    if (open) {
      loadProfiles();
      setLocalMatrix({ ...focusProfile.matrix });
      setLocalName(focusProfileName);
      setDirty(false);
      // Position the popover above the gear button, aligned to its right edge
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        const popoverWidth = 320;
        let left = rect.right - popoverWidth;
        if (left < 8) left = 8;
        setPopoverPos({ top: rect.top, left });
      }
    }
  }, [open, focusProfile, focusProfileName, loadProfiles]);

  // Close on outside click (checks both button and portal popover)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current && !buttonRef.current.contains(target) &&
        popoverRef.current && !popoverRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggleSeverity = (category: string, severity: string) => {
    setLocalMatrix(prev => {
      const next = { ...prev };
      const current = next[category] || [];
      if (current.includes(severity)) {
        next[category] = current.filter(s => s !== severity);
        if (next[category].length === 0) {
          delete next[category];
        }
      } else {
        next[category] = [...current, severity];
      }
      return next;
    });
    setDirty(true);
  };

  const toggleCategoryAll = (category: string) => {
    setLocalMatrix(prev => {
      const next = { ...prev };
      const current = next[category] || [];
      if (current.length === SEVERITIES.length) {
        delete next[category];
      } else {
        next[category] = [...SEVERITIES];
      }
      return next;
    });
    setDirty(true);
  };

  const handleTemplateSelect = (name: string) => {
    if (!savedProfiles) return;
    const tmpl = savedProfiles.profiles[name];
    if (tmpl) {
      setLocalMatrix({ ...tmpl.matrix });
      setLocalName(name);
      setDirty(true);
    }
  };

  const handleApply = async () => {
    const profile: FocusProfile = { matrix: localMatrix };
    setFocusProfile(localName, profile);

    // Persist active profile
    if (savedProfiles) {
      const updated = {
        ...savedProfiles,
        activeProfile: localName,
      };
      try {
        await invoke('save_focus_profiles', { data: updated });
      } catch (err) {
        console.error('Failed to save focus profiles:', err);
      }
    }

    setDirty(false);
    setOpen(false);

    // Trigger re-scan with the updated focus profile
    const root = activeRoot ?? projectPath;
    if (root) {
      scanProject(root, true);
    }
  };

  const handleSaveTemplate = async () => {
    if (!newTemplateName.trim()) return;
    const name = newTemplateName.trim();
    const updated: SavedProfiles = savedProfiles
      ? { ...savedProfiles }
      : { profiles: {}, activeProfile: 'Full Scan' };
    
    updated.profiles[name] = { matrix: { ...localMatrix } };
    updated.activeProfile = name;

    try {
      await invoke('save_focus_profiles', { data: updated });
      setSavedProfiles(updated);
      setLocalName(name);
      setSaveDialogOpen(false);
      setNewTemplateName('');
    } catch (err) {
      console.error('Failed to save template:', err);
    }
  };

  const handleDeleteTemplate = async (name: string) => {
    if (!savedProfiles || name === 'Full Scan') return;
    const updated = { ...savedProfiles };
    delete updated.profiles[name];
    if (updated.activeProfile === name) {
      updated.activeProfile = 'Full Scan';
    }
    try {
      await invoke('save_focus_profiles', { data: updated });
      setSavedProfiles(updated);
      if (localName === name) {
        const fullScan = updated.profiles['Full Scan'];
        if (fullScan) {
          setLocalMatrix({ ...fullScan.matrix });
          setLocalName('Full Scan');
        }
      }
    } catch (err) {
      console.error('Failed to delete template:', err);
    }
  };

  // Count enabled categories
  const enabledCount = Object.keys(localMatrix).filter(k => (localMatrix[k]?.length ?? 0) > 0).length;

  return (
    <>
      {/* Gear button */}
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className={`
          p-1 rounded transition-colors
          ${open ? 'bg-studio-accent/20 text-studio-accent' : 'text-studio-muted hover:text-studio-text hover:bg-studio-border/30'}
        `}
        title="Focus Profile settings"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
      </button>

      {/* Popover via portal -- escapes any overflow:hidden ancestors */}
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          className="fixed z-[9999] w-80 bg-studio-surface border border-studio-border rounded-lg shadow-xl"
          style={{ bottom: `${window.innerHeight - popoverPos.top + 4}px`, left: `${popoverPos.left}px` }}
        >
          {/* Header */}
          <div className="px-3 py-2 border-b border-studio-border">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-studio-text">Focus Profile</span>
              <span className="text-[10px] text-studio-muted">
                {enabledCount}/{ALL_CATEGORIES.length} categories
              </span>
            </div>
          </div>

          {/* Template selector */}
          <div className="px-3 py-2 border-b border-studio-border">
            <select
              value={localName}
              onChange={e => handleTemplateSelect(e.target.value)}
              className="w-full text-xs bg-studio-bg border border-studio-border rounded px-2 py-1 text-studio-text focus:outline-none focus:ring-1 focus:ring-studio-accent"
            >
              {savedProfiles && Object.keys(savedProfiles.profiles).map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
              {!savedProfiles && <option value={localName}>{localName}</option>}
            </select>
          </div>

          {/* Category-severity matrix */}
          <div className="px-3 py-2 max-h-56 overflow-y-auto scrollbar-thin">
            {/* Column headers */}
            <div className="flex items-center mb-1">
              <span className="text-[10px] text-studio-muted uppercase flex-1">Category</span>
              {SEVERITIES.map(sev => (
                <span key={sev} className="text-[10px] text-studio-muted uppercase w-7 text-center">
                  {SEV_LABELS[sev]}
                </span>
              ))}
            </div>

            {/* Category rows */}
            {ALL_CATEGORIES.map(cat => {
              const enabled = localMatrix[cat] || [];
              const isOff = enabled.length === 0;
              return (
                <div key={cat} className="flex items-center py-0.5 group">
                  <button
                    onClick={() => toggleCategoryAll(cat)}
                    className={`
                      flex-1 text-left text-[11px] truncate pr-1 transition-colors
                      ${isOff ? 'text-studio-muted line-through' : 'text-studio-text'}
                      hover:text-studio-accent
                    `}
                    title={`Toggle all severities for ${formatCategory(cat)}`}
                  >
                    {formatCategory(cat)}
                  </button>
                  {SEVERITIES.map(sev => {
                    const active = enabled.includes(sev);
                    return (
                      <button
                        key={sev}
                        onClick={() => toggleSeverity(cat, sev)}
                        className={`
                          w-6 h-5 mx-0.5 rounded border text-[9px] font-bold transition-all
                          ${active ? SEV_ACTIVE[sev] : SEV_COLORS[sev] + ' opacity-40 hover:opacity-80'}
                        `}
                        title={`${formatCategory(cat)}: ${sev}`}
                      >
                        {SEV_LABELS[sev]}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Actions */}
          <div className="px-3 py-2 border-t border-studio-border flex items-center gap-2">
            {saveDialogOpen ? (
              <div className="flex items-center gap-1 flex-1">
                <input
                  type="text"
                  value={newTemplateName}
                  onChange={e => setNewTemplateName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveTemplate(); if (e.key === 'Escape') setSaveDialogOpen(false); }}
                  placeholder="Template name..."
                  className="flex-1 text-xs bg-studio-bg border border-studio-border rounded px-1.5 py-0.5 text-studio-text focus:outline-none focus:ring-1 focus:ring-studio-accent"
                  autoFocus
                />
                <button
                  onClick={handleSaveTemplate}
                  className="text-[10px] px-1.5 py-0.5 bg-studio-accent text-studio-bg rounded hover:opacity-90"
                >
                  Save
                </button>
                <button
                  onClick={() => setSaveDialogOpen(false)}
                  className="text-[10px] px-1 py-0.5 text-studio-muted hover:text-studio-text"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setSaveDialogOpen(true)}
                  className="text-[10px] px-2 py-1 bg-studio-border/40 text-studio-text rounded hover:bg-studio-border/60 transition-colors"
                >
                  Save Template
                </button>
                {localName !== 'Full Scan' && savedProfiles?.profiles[localName] && (
                  <button
                    onClick={() => handleDeleteTemplate(localName)}
                    className="text-[10px] px-1.5 py-1 text-studio-error hover:bg-studio-error/10 rounded transition-colors"
                    title="Delete this template"
                  >
                    Delete
                  </button>
                )}
                <button
                  onClick={handleApply}
                  className={`
                    ml-auto text-[10px] px-2.5 py-1 rounded font-semibold transition-colors
                    ${dirty
                      ? 'bg-studio-accent text-studio-bg hover:opacity-90'
                      : 'bg-studio-border/40 text-studio-muted cursor-default'}
                  `}
                  disabled={!dirty}
                >
                  Apply &amp; Scan
                </button>
              </>
            )}
          </div>

          {/* Note */}
          <div className="px-3 pb-2">
            <p className="text-[9px] text-studio-muted italic">Changes require re-scan to take effect</p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

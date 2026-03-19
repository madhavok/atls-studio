import { useState, useEffect, useCallback, useRef } from 'react';
import { getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window';
import { useOS } from '../../hooks/useOS';

export function WindowControls() {
  const { isMac, isWindows, isLinux } = useOS();
  const [maximized, setMaximized] = useState(false);
  const [hovering, setHovering] = useState(false);
  const appWindowRef = useRef<TauriWindow | null>(null);

  if (!appWindowRef.current) {
    try { appWindowRef.current = getCurrentWindow(); }
    catch { /* Tauri runtime not yet available */ }
  }

  useEffect(() => {
    const appWindow = appWindowRef.current;
    if (!appWindow) return;

    appWindow.isMaximized().then(setMaximized).catch(e => console.warn('[WindowControls] isMaximized failed:', e));

    let unlisten: (() => void) | undefined;
    const setup = async () => {
      const u1 = await appWindow.onResized(async () => {
        const m = await appWindow.isMaximized();
        setMaximized(m);
      });
      unlisten = u1;
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  const handleMinimize = useCallback(() => { appWindowRef.current?.minimize(); }, []);
  const handleMaximize = useCallback(() => { appWindowRef.current?.toggleMaximize(); }, []);
  const handleClose = useCallback(() => { appWindowRef.current?.close(); }, []);

  if (isMac) return <MacControls hovering={hovering} setHovering={setHovering} maximized={maximized} onMinimize={handleMinimize} onMaximize={handleMaximize} onClose={handleClose} />;
  if (isLinux) return <LinuxControls maximized={maximized} onMinimize={handleMinimize} onMaximize={handleMaximize} onClose={handleClose} />;
  if (isWindows) return <WindowsControls maximized={maximized} onMinimize={handleMinimize} onMaximize={handleMaximize} onClose={handleClose} />;
  return <WindowsControls maximized={maximized} onMinimize={handleMinimize} onMaximize={handleMaximize} onClose={handleClose} />;
}

// ---------------------------------------------------------------------------
// macOS Traffic Lights (left-aligned)
// ---------------------------------------------------------------------------

interface MacControlsProps {
  hovering: boolean;
  setHovering: (h: boolean) => void;
  maximized: boolean;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}

function MacControls({ hovering, setHovering, onMinimize, onMaximize, onClose }: MacControlsProps) {
  return (
    <div
      className="flex items-center gap-2 ml-3"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        onClick={onClose}
        className="w-3 h-3 rounded-full bg-[#ff5f57] flex items-center justify-center hover:brightness-90 transition-[filter]"
        aria-label="Close"
      >
        {hovering && (
          <svg className="w-[8px] h-[8px]" viewBox="0 0 12 12" fill="none" stroke="#4a0002" strokeWidth="1.5" strokeLinecap="round">
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
          </svg>
        )}
      </button>
      <button
        onClick={onMinimize}
        className="w-3 h-3 rounded-full bg-[#febc2e] flex items-center justify-center hover:brightness-90 transition-[filter]"
        aria-label="Minimize"
      >
        {hovering && (
          <svg className="w-[8px] h-[8px]" viewBox="0 0 12 12" fill="none" stroke="#985600" strokeWidth="1.5" strokeLinecap="round">
            <line x1="2" y1="6" x2="10" y2="6" />
          </svg>
        )}
      </button>
      <button
        onClick={onMaximize}
        className="w-3 h-3 rounded-full bg-[#28c840] flex items-center justify-center hover:brightness-90 transition-[filter]"
        aria-label="Maximize"
      >
        {hovering && (
          <svg className="w-[8px] h-[8px]" viewBox="0 0 12 12" fill="none" stroke="#006500" strokeWidth="1.5" strokeLinecap="round">
            <line x1="3" y1="9" x2="9" y2="3" />
            <polyline points="4,3 9,3 9,8" />
          </svg>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Windows Controls (right-aligned, flat rectangular)
// ---------------------------------------------------------------------------

interface ControlProps {
  maximized: boolean;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}

function WindowsControls({ maximized, onMinimize, onMaximize, onClose }: ControlProps) {
  const btnBase = "flex items-center justify-center w-[46px] h-full transition-colors";

  return (
    <div className="flex items-center h-full">
      {/* Minimize */}
      <button
        onClick={onMinimize}
        className={`${btnBase} text-studio-muted hover:bg-studio-border hover:text-studio-text`}
        aria-label="Minimize"
      >
        <svg className="w-[10px] h-[10px]" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
          <line x1="0" y1="5" x2="10" y2="5" />
        </svg>
      </button>

      {/* Maximize / Restore */}
      <button
        onClick={onMaximize}
        className={`${btnBase} text-studio-muted hover:bg-studio-border hover:text-studio-text`}
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? (
          <svg className="w-[10px] h-[10px]" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0" y="2" width="7" height="7" rx="0.5" />
            <polyline points="3,2 3,0.5 9.5,0.5 9.5,7 8,7" />
          </svg>
        ) : (
          <svg className="w-[10px] h-[10px]" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
          </svg>
        )}
      </button>

      {/* Close */}
      <button
        onClick={onClose}
        className={`${btnBase} text-studio-muted hover:bg-studio-error hover:text-white`}
        aria-label="Close"
      >
        <svg className="w-[10px] h-[10px]" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
          <line x1="0" y1="0" x2="10" y2="10" />
          <line x1="10" y1="0" x2="0" y2="10" />
        </svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linux GNOME-style Controls (right-aligned, rounded circles)
// ---------------------------------------------------------------------------

function LinuxControls({ maximized, onMinimize, onMaximize, onClose }: ControlProps) {
  const circleBase = "w-5 h-5 rounded-full flex items-center justify-center transition-colors border border-studio-border bg-studio-surface text-studio-muted";

  return (
    <div className="flex items-center gap-1.5 mr-2">
      {/* Minimize */}
      <button
        onClick={onMinimize}
        className={`${circleBase} hover:bg-studio-border hover:text-studio-text`}
        aria-label="Minimize"
      >
        <svg className="w-[8px] h-[8px]" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <line x1="2" y1="5" x2="8" y2="5" />
        </svg>
      </button>

      {/* Maximize / Restore */}
      <button
        onClick={onMaximize}
        className={`${circleBase} hover:bg-studio-border hover:text-studio-text`}
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? (
          <svg className="w-[8px] h-[8px]" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="0.5" y="2.5" width="6" height="6" rx="0.5" />
            <polyline points="3,2.5 3,1 8.5,1 8.5,6.5 7.5,6.5" />
          </svg>
        ) : (
          <svg className="w-[8px] h-[8px]" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="1" y="1" width="8" height="8" rx="0.5" />
          </svg>
        )}
      </button>

      {/* Close */}
      <button
        onClick={onClose}
        className={`${circleBase} hover:bg-[#c85050] hover:border-[#c85050] hover:text-white`}
        aria-label="Close"
      >
        <svg className="w-[8px] h-[8px]" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <line x1="2" y1="2" x2="8" y2="8" />
          <line x1="8" y1="2" x2="2" y2="8" />
        </svg>
      </button>
    </div>
  );
}

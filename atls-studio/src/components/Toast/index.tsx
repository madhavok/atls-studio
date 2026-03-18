import { useEffect, useCallback } from 'react';
import { useAppStore } from '../../stores/appStore';

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);

  return (
    <div className="fixed bottom-10 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={removeToast} />
      ))}
    </div>
  );
}

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  useEffect(() => {
    if (toast.duration === 0) return; // persistent toast
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration ?? 4000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  const handleDismiss = useCallback(() => onDismiss(toast.id), [toast.id, onDismiss]);

  const bgClass = {
    success: 'bg-green-800/90 border-green-600/50',
    error: 'bg-red-800/90 border-red-600/50',
    info: 'bg-studio-surface/95 border-studio-border',
    warning: 'bg-yellow-800/90 border-yellow-600/50',
  }[toast.type];

  const iconMap = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
    warning: '⚠',
  };

  return (
    <div
      className={`pointer-events-auto flex items-start gap-2 px-3 py-2 rounded-md border text-xs text-studio-text shadow-lg max-w-sm animate-fade-in ${bgClass}`}
      role="status"
    >
      <span className="shrink-0 mt-px">{iconMap[toast.type]}</span>
      <span className="flex-1">{toast.message}</span>
      <button
        onClick={handleDismiss}
        className="shrink-0 ml-1 text-studio-muted hover:text-studio-text transition-colors"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  /** Auto-dismiss duration in ms. 0 = persistent. Default 4000. */
  duration?: number;
}

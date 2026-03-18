/** Shared icon components for ATLS Intelligence Panel */

export const AlertIcon = ({ severity }: { severity: string }) => {
  const colors: Record<string, string> = {
    high: 'text-studio-error',
    medium: 'text-studio-warning',
    low: 'text-studio-muted',
  };
  return (
    <svg className={`w-4 h-4 ${colors[severity] || colors.low}`} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
    </svg>
  );
};

export const CheckIcon = () => (
  <svg className="w-4 h-4 text-studio-success" viewBox="0 0 24 24" fill="currentColor">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
);

export const RefreshIcon = ({ spinning }: { spinning?: boolean }) => (
  <svg className={`w-4 h-4 ${spinning ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
  </svg>
);

export const ArrowDownIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 10l5 5 5-5z" />
  </svg>
);

export const ArrowUpIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 14l5-5 5 5z" />
  </svg>
);

export const ImportIcon = () => (
  <svg className="w-4 h-4 text-studio-accent" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
  </svg>
);

export const ExportIcon = () => (
  <svg className="w-4 h-4 text-studio-success" viewBox="0 0 24 24" fill="currentColor">
    <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z" />
  </svg>
);

export const FileIcon = () => (
  <svg className="w-4 h-4 text-studio-muted" viewBox="0 0 24 24" fill="currentColor">
    <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z" />
  </svg>
);

export const SymbolIcon = ({ kind }: { kind: string }) => {
  const colors: Record<string, string> = {
    function: 'text-purple-400',
    class: 'text-yellow-400',
    interface: 'text-blue-400',
    type: 'text-cyan-400',
    const: 'text-orange-400',
    variable: 'text-green-400',
  };
  return (
    <span className={`text-xs font-mono ${colors[kind] || 'text-studio-muted'}`}>
      {kind.charAt(0).toUpperCase()}
    </span>
  );
};

export const TerminalIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z" />
  </svg>
);

export const AtlsIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 18.5L4 16V9l8 4v7.5zm0-9L4.5 7.5 12 4l7.5 3.5L12 11.5zm8 4.5l-7 3.5V12l7-3.5V16z" />
  </svg>
);

export const ShieldIcon = () => (
  <svg className="w-4 h-4 text-studio-accent" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
  </svg>
);

export const CodeIcon = () => (
  <svg className="w-4 h-4 text-studio-muted" viewBox="0 0 24 24" fill="currentColor">
    <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" />
  </svg>
);

export const SpinnerIcon = ({ className = 'w-6 h-6' }: { className?: string }) => (
  <div className={`${className} mx-auto border-2 border-studio-accent border-t-transparent rounded-full animate-spin`} />
);

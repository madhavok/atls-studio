import { memo, useEffect, useState } from 'react';

export const ReasoningBlock = memo(function ReasoningBlock({
  content,
  isStreaming,
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
        className="flex cursor-pointer select-none items-center gap-2 py-1 text-xs text-studio-text-secondary transition-colors hover:text-studio-text-primary"
        onClick={(event) => { event.preventDefault(); setIsOpen(!isOpen); }}
      >
        <svg className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
        <span className="font-medium">
          {isStreaming ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-studio-accent" />
              Thinking...
            </span>
          ) : 'Thought'}
        </span>
      </summary>
      {isOpen && (
        <div className="mt-1 ml-5 max-h-48 overflow-y-auto border-l-2 border-studio-border/30 pl-3 text-sm italic leading-relaxed text-studio-text-secondary whitespace-pre-wrap">
          {content}
        </div>
      )}
    </details>
  );
});

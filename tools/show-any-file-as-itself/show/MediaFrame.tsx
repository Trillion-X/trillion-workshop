import React, { type ReactNode } from 'react';

export type MediaFrameAction = {
  disabled?: boolean;
  label: string;
  onSelect?: () => void | Promise<void>;
};

export type MediaFrameMetadata = {
  label: string;
  value: ReactNode;
};

export type MediaFrameProps = {
  actions?: readonly MediaFrameAction[];
  children?: ReactNode;
  className?: string;
  emptyLabel?: string;
  metadata?: readonly MediaFrameMetadata[];
  summary?: ReactNode;
  title: ReactNode;
};

export function MediaFrame({
  actions = [],
  children,
  className = '',
  emptyLabel = 'No media surface selected.',
  metadata = [],
  summary,
  title,
}: MediaFrameProps) {
  return (
    <section
      className={`flex h-full min-h-0 w-full flex-col gap-3 ${className}`.trim()}
      data-ui-part="media-frame"
    >
      <header className="flex shrink-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-[-0.02em] text-[var(--text-strong)]">
            {title}
          </h2>
          {summary ? <p className="mt-0.5 text-sm text-[var(--text-muted)]">{summary}</p> : null}
        </div>
        {actions.length ? (
          <div className="flex shrink-0 items-center gap-2">
            {actions.map((action) => (
              <button
                className="rounded-full border border-[var(--border-primary)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-strong)] disabled:opacity-40"
                disabled={action.disabled || !action.onSelect}
                key={action.label}
                type="button"
                onClick={() => void action.onSelect?.()}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {metadata.length ? (
        <dl className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 text-xs">
          {metadata.map((item) => (
            <div className="flex items-baseline gap-1.5" key={item.label}>
              <dt className="text-[var(--text-muted)]">{item.label}</dt>
              <dd className="font-medium text-[var(--text-secondary)]">{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl">
        {children ?? (
          <p className="grid h-full place-items-center text-sm text-[var(--text-secondary)]">{emptyLabel}</p>
        )}
      </div>
    </section>
  );
}

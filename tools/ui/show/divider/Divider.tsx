// frontends/web/src/packages/ui/divider/Divider.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Minimal divider for separating controls and rows. Vertical (default) for
// inline control groups in config bars; horizontal for hairline separation
// between stacked rows (list/catalog anatomy).
//
// =============================================================================

import React from 'react';
export interface DividerProps {
  /** Vertical height — 'xs' (h-2), 'sm' (h-4), 'md' (h-6). Ignored when horizontal. */
  size?: 'xs' | 'sm' | 'md';
  /** 'vertical' (default): w-px inline tick. 'horizontal': full-width hairline. */
  orientation?: 'vertical' | 'horizontal';
}

export function Divider({ size = 'sm', orientation = 'vertical' }: DividerProps) {
  if (orientation === 'horizontal') {
    return <div className="h-px w-full bg-[var(--border-primary)]" />;
  }

  const heightClass =
    size === 'xs' ? 'h-2' : size === 'md' ? 'h-6' : 'h-4';

  return (
    <div
      className={`${heightClass} w-px bg-[var(--border-primary)]`}
    />
  );
}

// packages/ui/show/stat-strip/StatStrip.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure horizontal strip of 2–4 plain stat values (value over label). The
// caller owns the data, the labels, and any formatting — this component only
// arranges typography. Reference anatomy: Langdock quick-view stat
// strip (Conversations / Model / Creativity).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure renderer — no data reads, no calculations, no durable state
// 2. Empty stats list renders nothing
// 3. Typography through Text variants only — zero raw text styling
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';
import { Text } from '../text';

export interface StatStripItem {
  /** Short label under the value (e.g. "Conversations") */
  label: string;
  /** Pre-formatted display value (e.g. "12", "$0.42", "Claude Sonnet 4") */
  value: string;
}

export interface StatStripProps {
  /** Stats in display order. Empty = renders nothing. */
  stats: readonly StatStripItem[];
  className?: string;
}

export function StatStrip({ stats, className }: StatStripProps) {
  if (stats.length === 0) return null;
  return (
    <div
      className={cn(
        'flex flex-row items-stretch divide-x divide-[var(--border-primary)] rounded-[var(--radius-card)] border border-[var(--border-primary)]',
        className,
      )}
      role="group"
      aria-label="Stats"
    >
      {stats.map((stat) => (
        <div key={stat.label} className="flex min-w-0 flex-1 flex-col items-center gap-0.5 px-3 py-2">
          <Text variant="body" weight="semibold" truncate>{stat.value}</Text>
          <Text variant="caption" color="faint" truncate>{stat.label}</Text>
        </div>
      ))}
    </div>
  );
}

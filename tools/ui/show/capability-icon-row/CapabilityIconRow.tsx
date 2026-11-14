// packages/ui/show/capability-icon-row/CapabilityIconRow.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure inline row of small icons describing a set of capability names. The
// caller supplies the capability names AND the name→icon map — this component
// has zero knowledge of what a capability is. Each icon gets a tooltip with
// the caller-supplied label. Unknown capability names resolve through
// NamedIcon's fallback.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure renderer — no data reads, no target invokes, no durable state
// 2. Icon vocabulary is caller data (iconMap), never hardcoded here
// 3. Empty capability list renders nothing (no placeholder, no filler)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';
import { NamedIcon } from '../icon';
import { Tooltip } from '../tooltip';

export interface CapabilityIconRowItem {
  /** Capability identifier supplied by the caller (e.g. "vision") */
  capability: string;
  /** Lucide icon name to render for this capability */
  icon: string;
  /** Human tooltip label (e.g. "Vision") */
  label: string;
}

export interface CapabilityIconRowProps {
  /** Resolved capability items, in display order. Empty = renders nothing. */
  items: readonly CapabilityIconRowItem[];
  /** Icon size token passed to NamedIcon — defaults to 'xs' */
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

export function CapabilityIconRow({ items, size = 'xs', className }: CapabilityIconRowProps) {
  if (items.length === 0) return null;
  return (
    <div className={cn('flex flex-row items-center gap-1.5', className)} role="list" aria-label="Capabilities">
      {items.map((item) => (
        <Tooltip key={item.capability} label={item.label}>
          <span role="listitem" className="inline-flex text-[var(--text-faint)]">
            <NamedIcon name={item.icon} size={size} />
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

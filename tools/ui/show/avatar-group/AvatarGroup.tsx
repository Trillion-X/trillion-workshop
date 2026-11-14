// packages/ui/show/avatar-group/AvatarGroup.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Compact overlapping avatar stack for participant marks and other small
// identity glyphs. Consumers provide already-rendered avatar nodes; this
// component owns only the stacking, overlap, and same-surface ring treatment.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Avatar content is caller-owned — no assumptions about participant shape
// 2. Later avatars render above earlier avatars
// 3. Ring color is a named design token matching the surrounding surface
// 4. No white borders — the ring must read as a cutout in the parent surface
// 5. Each avatar is a true circle (corner-shape round, whatever corner shape the look gives other surfaces), clipped
//    to it, so a caller's node (initials on a fill) never spills onto its neighbour; the overlap leaves room for
//    two initials
//
// =============================================================================

import React from 'react';
import { ActionControl } from '../action-control/ActionControl';
import { cn } from '../cn';

type AvatarGroupSize = 'xs' | 'sm' | 'md';
type AvatarGroupRingToken = 'glass-subtle' | 'glass-nested' | 'glass-popover';

export interface AvatarGroupItem {
  key: string;
  node: React.ReactNode;
}

export interface AvatarGroupProps {
  items: readonly AvatarGroupItem[];
  size?: AvatarGroupSize;
  ringToken?: AvatarGroupRingToken;
  ariaLabel?: string;
  max?: number;
  onClick?: () => void;
  onOverflowClick?: () => void;
}

const GROUP_SIZE_CLASS: Record<AvatarGroupSize, string> = {
  xs: 'h-6',
  sm: 'h-8',
  md: 'h-10',
};

const ITEM_SIZE_CLASS: Record<AvatarGroupSize, string> = {
  xs: 'h-6 w-6',
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
};

const OVERLAP_CLASS: Record<AvatarGroupSize, string> = {
  xs: '-ml-2',
  sm: '-ml-1.5',
  md: '-ml-3',
};

const RING_CLASS: Record<AvatarGroupRingToken, string> = {
  'glass-subtle': 'ring-[var(--glass-bg-subtle)]',
  'glass-nested': 'ring-[var(--glass-bg-subtle)]',
  'glass-popover': 'ring-[var(--glass-bg-popover)]',
};

export function AvatarGroup({
  items,
  size = 'xs',
  ringToken = 'glass-subtle',
  ariaLabel,
  max = 4,
  onClick,
  onOverflowClick,
}: AvatarGroupProps) {
  if (items.length === 0) return null;

  const visibleCount = Math.max(0, max);
  const visibleItems = items.slice(0, visibleCount);
  const overflowCount = items.length - visibleItems.length;
  const hasClick = Boolean(onClick);

  return (
    <span
      className={cn('inline-flex items-center overflow-visible', GROUP_SIZE_CLASS[size], hasClick && 'cursor-pointer')}
      aria-label={ariaLabel}
      role={hasClick ? 'button' : undefined}
      tabIndex={hasClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={hasClick ? (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onClick?.();
      } : undefined}
    >
      {visibleItems.map((item, index) => (
        <span
          key={item.key}
          className={cn(
            'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full [corner-shape:round] ring-2',
            ITEM_SIZE_CLASS[size],
            RING_CLASS[ringToken],
            index > 0 && OVERLAP_CLASS[size],
          )}
        >
          {item.node}
        </span>
      ))}
      {overflowCount > 0 && (
        <ActionControl
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'relative inline-flex min-h-0 min-w-0 shrink-0 items-center justify-center rounded-full [corner-shape:round] p-0 ring-2 bg-[var(--glass-bg-subtle)] text-[var(--text-secondary)]',
            ITEM_SIZE_CLASS[size],
            RING_CLASS[ringToken],
            visibleItems.length > 0 && OVERLAP_CLASS[size],
          )}
          aria-label={`Show ${overflowCount} more participants`}
          onClick={(event) => {
            event.stopPropagation();
            (onOverflowClick ?? onClick)?.();
          }}
        >
          +{overflowCount}
        </ActionControl>
      )}
    </span>
  );
}

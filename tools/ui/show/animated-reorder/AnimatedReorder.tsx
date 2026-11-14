// packages/ui/show/animated-reorder/AnimatedReorder.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic FLIP (First-Last-Invert-Play) animator for an ordered list of items.
// When the items' on-screen positions change between renders — because the
// caller reordered them, added one, or removed one — each surviving item glides
// from its previous box to its new box instead of teleporting. The animation is
// purely visual: this component holds ZERO order/persistence state. The caller
// owns the order and gets the requested layout; this only makes the transition
// between two orders smooth.
//
// It is orientation-agnostic (the container's flex direction decides row vs
// column) and identity-driven (each item keyed by a stable `id`), so it works
// for the tab strip, a layer stack, a card grid, or anything with reorderable
// children — the L069 primitive for "animate a reorder."
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure visual — no persistence, no addresses, no feature vocabulary.
// 2. Only items present in BOTH the previous and current render animate; new
//    items appear in place, removed items are gone (caller may fade separately).
// 3. An item whose box did not move is untouched (no transform, no transition).
// 4. The transform is cleared after the play step, so layout/hit-testing and
//    nested drag-and-drop are unaffected once the glide completes.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';

export interface AnimatedReorderItem {
  /** Stable identity — the unit whose movement is animated. */
  id: string;
  /** The rendered node for this item. */
  node: React.ReactNode;
}

/** Flow direction of the animated list. */
export type AnimatedReorderDirection = 'row' | 'column';
/** Semantic gap between items (maps to a fixed flex gap class). */
export type AnimatedReorderGap = 'none' | 'tight' | 'normal' | 'loose';
/** Cross-axis alignment of items. */
export type AnimatedReorderAlign = 'start' | 'center' | 'stretch';

export interface AnimatedReorderProps {
  /** Items in their current (caller-owned) order. */
  items: readonly AnimatedReorderItem[];
  /** Row (default, tab-strip) or column (layer-stack). */
  direction?: AnimatedReorderDirection;
  /** Semantic gap between items. */
  gap?: AnimatedReorderGap;
  /** Cross-axis alignment. */
  align?: AnimatedReorderAlign;
  /** Glide duration in milliseconds. */
  durationMs?: number;
  /** CSS easing for the glide. */
  easing?: string;
  /** Extra classes for the flex container (ui/show callers only). */
  className?: string;
  /** Extra classes for each item wrapper (ui/show callers only). */
  itemClassName?: string;
}

const GAP_CLASS: Record<AnimatedReorderGap, string> = {
  none: 'gap-0',
  tight: 'gap-[2px]',
  normal: 'gap-2',
  loose: 'gap-4',
};
const ALIGN_CLASS: Record<AnimatedReorderAlign, string> = {
  start: 'items-start',
  center: 'items-center',
  stretch: 'items-stretch',
};

/**
 * Compute the FLIP step for one element given its remembered previous box.
 * Pure so it can be unit-tested without a DOM: returns the inverting transform
 * (or null when the box did not move).
 */
export function flipInvert(
  prev: { left: number; top: number } | undefined,
  next: { left: number; top: number },
): { dx: number; dy: number } | null {
  if (!prev) return null;
  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  if (dx === 0 && dy === 0) return null;
  return { dx, dy };
}

export function AnimatedReorder({
  items,
  direction = 'row',
  gap = 'tight',
  align = 'center',
  durationMs = 220,
  easing = 'cubic-bezier(0.2, 0, 0, 1)',
  className,
  itemClassName,
}: AnimatedReorderProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const prevRects = React.useRef<Map<string, { left: number; top: number }>>(new Map());

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const els = container.querySelectorAll<HTMLElement>('[data-flip-id]');
    const nextRects = new Map<string, { left: number; top: number }>();
    els.forEach((el) => {
      const id = el.getAttribute('data-flip-id');
      if (!id) return;
      const rect = el.getBoundingClientRect();
      const next = { left: rect.left, top: rect.top };
      nextRects.set(id, next);
      const invert = flipInvert(prevRects.current.get(id), next);
      if (!invert) return;
      // First→Last→Invert: jump back to the old position with no transition…
      el.style.transition = 'none';
      el.style.transform = `translate(${invert.dx}px, ${invert.dy}px)`;
      // …then Play: next frame, transition the transform away to 0.
      requestAnimationFrame(() => {
        el.style.transition = `transform ${durationMs}ms ${easing}`;
        el.style.transform = '';
      });
    });
    prevRects.current = nextRects;
  });

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex',
        direction === 'column' ? 'flex-col' : 'flex-row',
        GAP_CLASS[gap],
        ALIGN_CLASS[align],
        className,
      )}
      role="list"
    >
      {items.map((item) => (
        <div key={item.id} data-flip-id={item.id} className={cn('flex', itemClassName)}>
          {item.node}
        </div>
      ))}
    </div>
  );
}

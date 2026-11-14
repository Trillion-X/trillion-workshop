// packages/ui/show/reveal/Reveal.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Animated disclosure container: smoothly expands/collapses its content with
// a height transition (CSS grid 0fr → 1fr — animates to auto height with
// zero measurement code). Use for "show more" disclosures, inline guides,
// expandable rows. Binary mount/unmount toggles are the anti-pattern this
// replaces: content must GLIDE open, not pop.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Content stays mounted while closed (opacity + row collapse) so the
//    transition is symmetric both directions
// 2. overflow-hidden inner wrapper — required for the 0fr row to clip
// 3. Duration 200ms ease-out — fast enough to feel responsive, slow enough
//    to read as motion
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';

export interface RevealProps {
  /** True = expanded, false = collapsed */
  open: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Reveal({ open, children, className }: RevealProps) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

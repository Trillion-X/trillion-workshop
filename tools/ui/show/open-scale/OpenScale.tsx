// packages/ui/show/open-scale/OpenScale.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Shared origin-anchored open motion: content scales+fades in from the tile
// that spawned it (iOS-folder / Launchpad anatomy — the reference-locked
// open-folder motion for New-tab folder tiles and any future expanding tile).
// Elevated into ui/ because open-from-origin is a screen-wide primitive, never
// package-local CSS (package UI reference lock: missing primitives are shared
// UI work).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Transform-only animation (scale + opacity) — no layout thrash.
// 2. ~250ms ease-out, origin at the spawning tile via transform-origin.
// 3. Content stays mounted both ways so the motion is symmetric.
//
// =============================================================================

import React from 'react';
import { cn } from '../cn';

export interface OpenScaleProps {
  /** True = expanded/open, false = collapsed back into its origin. */
  open: boolean;
  /** CSS transform-origin (e.g. '25% 40%') — where the spawning tile sits. */
  origin?: string;
  children: React.ReactNode;
  className?: string;
}

export function OpenScale({ open, origin = '50% 50%', children, className }: OpenScaleProps) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        'transition-[transform,opacity] duration-[250ms] ease-out will-change-transform',
        open ? 'pointer-events-auto scale-100 opacity-100' : 'pointer-events-none scale-75 opacity-0',
        className,
      )}
      style={{ transformOrigin: origin }}
    >
      {children}
    </div>
  );
}

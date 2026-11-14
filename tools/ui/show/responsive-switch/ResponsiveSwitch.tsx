// bitfield/packages/ui/show/responsive-switch/ResponsiveSwitch.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One shared way to render a wide-layout subtree and a narrow-layout subtree
// without feature code touching breakpoint classes. Desktop tables with a
// mobile card alternative (the no-horizontal-overflow rule) compose this
// instead of hand-rolling visibility classes per package.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This is the ONLY place the wide/narrow visibility classes live — feature
//    code passes subtrees, never breakpoint class names
// 2. Pure rendering: no state, no measurement, CSS-only switching so server
//    and client output match
// 3. Both subtrees mount; visibility is CSS — callers keep state OUTSIDE the
//    subtrees when it must survive a viewport change
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';

export interface ResponsiveSwitchProps {
  /** Subtree for wide layouts (tables, multi-column). */
  wide: React.ReactNode;
  /** Subtree for narrow layouts (stacked cards, full-width actions). */
  narrow: React.ReactNode;
}

/**
 * CSS-only wide/narrow switch at the small breakpoint.
 */
export function ResponsiveSwitch({ wide, narrow }: ResponsiveSwitchProps): React.ReactElement {
  return (
    <>
      <div className="hidden sm:block">{wide}</div>
      <div className="sm:hidden">{narrow}</div>
    </>
  );
}

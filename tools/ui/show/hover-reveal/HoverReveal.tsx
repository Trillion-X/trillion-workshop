// packages/ui/show/hover-reveal/HoverReveal.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The hover-revealed-action affordance from the reference set (Raycast row
// actions, Amie's task overflow "…"): secondary and destructive controls stay
// invisible until the pointer is over their row (or anything inside the row
// has keyboard focus), keeping rows calm at rest.
//
// Usage:
//   <HoverRevealGroup layout="horizontal" gap="sm" alignItems="center">
//     ...always-visible row content...
//     <HoverRevealItem>
//       <Button variant="ghost" size="sm">Remove</Button>
//     </HoverRevealItem>
//   </HoverRevealGroup>
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic: no product vocabulary, no opinions about what is revealed.
// 2. Keyboard accessible: focus-within reveals exactly like hover, so tab
//    navigation never hides an action.
// 3. Reveal is opacity-only (no layout shift — the control keeps its space).
// 4. This is the ONLY sanctioned hover-reveal mechanism; feature code must
//    not hand-roll group/hover class compositions.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import { cn } from '../cn';
import { Container, type ContainerProps } from '../container';

export type HoverRevealGroupProps = ContainerProps & {
  children: React.ReactNode;
};

/** The row (or region) whose hover/focus state reveals its HoverRevealItems. */
export function HoverRevealGroup({ className, children, ...rest }: HoverRevealGroupProps) {
  return (
    <Container {...rest} className={cn('group/hover-reveal', className)}>
      {children}
    </Container>
  );
}

export type HoverRevealItemProps = {
  children: React.ReactNode;
  className?: string;
  revealed?: boolean;
};

/** Invisible at rest; fades in while the group is hovered or focus is inside. */
export function HoverRevealItem({ children, className, revealed = false }: HoverRevealItemProps) {
  return (
    <span
      className={cn(
        revealed ? 'opacity-100 transition-opacity duration-150' : 'opacity-0 transition-opacity duration-150',
        'group-hover/hover-reveal:opacity-100 group-focus-within/hover-reveal:opacity-100',
        'focus-within:opacity-100',
        className,
      )}
    >
      {children}
    </span>
  );
}

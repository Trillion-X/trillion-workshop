// bitfield-studio/frontends/web/src/packages/ui/card/index.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Barrel export for the Card component. Single import point for consumers.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Only exports public API — Card, cardVariants, CardProps
// 2. Internal helpers (if any) stay internal
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export { Card, cardVariants } from './Card';
export type { CardProps } from './Card';

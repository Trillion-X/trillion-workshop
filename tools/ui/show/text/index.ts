// frontends/web/src/packages/ui/text/index.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Barrel export for the Text component. Single import point for consumers.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Only exports public API — Text, textVariants, TextProps
// 2. Internal helpers (DEFAULT_ELEMENTS) stay internal
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export { Text, textVariants } from './Text';
export type { TextProps } from './Text';

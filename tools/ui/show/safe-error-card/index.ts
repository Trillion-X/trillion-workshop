// bitfield/packages/ui/show/safe-error-card/index.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Barrel export for the SafeErrorCard component. Single import point for consumers.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Only exports the public API
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export { SafeErrorCard, sanitizeErrorText } from './SafeErrorCard';
export { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
export type { SafeErrorCardProps } from './SafeErrorCard';

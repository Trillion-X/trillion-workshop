// bitfield/packages/ui/show/status-vocabulary/index.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Barrel export for the StatusVocabulary helpers. Single import point.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Only exports the public API — statusView and its types
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export { statusView } from './StatusVocabulary';
export type { StatusView, StatusTone, StatusOverrides } from './StatusVocabulary';

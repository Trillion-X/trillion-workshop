// frontends/web/src/packages/ui/diff-view/index.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Barrel export for the DiffView component and its types.
// This is the canonical import path for consumers.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All public types and components exported from this single file
// 2. Types use 'export type' for proper tree-shaking
// 3. No re-exports of transitive dependencies
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export { DiffView } from './DiffView';
export { computeUnifiedDiff } from './diff-logic';
export type { DiffViewProps } from './DiffView';
export type { DiffLine } from './diff-logic';

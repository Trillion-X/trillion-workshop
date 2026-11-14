// frontends/web/src/packages/ui/tabs/index.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Barrel export for the Tabs compound component. Single import point for consumers.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Only exports public API — Tabs, TabsList, TabsTrigger, TabsContent
// 2. Props types exported for consumer type safety
// 3. Internal context stays internal
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs';
export type { TabsProps, TabsListProps, TabsTriggerProps, TabsContentProps } from './Tabs';

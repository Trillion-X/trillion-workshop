// packages/ui/show/output-destination/read.ts
//
// Catalog merging for output destinations (mirrors mergeCatalog patterns
// throughout the codebase). Destinations are registered via their own
// DATA rows; the UI reads the merged set and never enumerates kinds.

import type { OutputDestination } from './types';

/**
 * Merge multiple destination catalogs into a single array.
 * Deduplicates by ID (later entries win). Mirrors the pattern from
 * GroupBoardPanel's mergeCatalog patterns.
 */
export function mergeOutputDestinations(
  ...catalogs: (readonly OutputDestination[] | undefined)[]
): OutputDestination[] {
  const merged = new Map<string, OutputDestination>();
  for (const catalog of catalogs) {
    if (!catalog) continue;
    for (const destination of catalog) {
      merged.set(destination.id, destination);
    }
  }
  return Array.from(merged.values());
}

/**
 * Find a destination by ID in the merged set.
 */
export function findOutputDestination(
  destinations: readonly OutputDestination[],
  id: string,
): OutputDestination | undefined {
  return destinations.find((d) => d.id === id);
}

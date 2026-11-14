// parts/ui/show/record-views/loading-layout.ts
//
// PURPOSE
//   Read the shape a list last chose from its local view preferences while its records load.
//
// INVARIANTS
//   The mapping is DATA. A list with no saved choice, an unlisted view, malformed data or blocked storage uses the
//   caller's fallback and never turns a loading state into an error.

import type { LoadingLayout } from '../screen-state/ScreenState';
import shapes from './loading-layouts.json';

const SHAPES = shapes.layouts as Readonly<Record<string, LoadingLayout>>;

export function loadingLayoutFor(preferenceKey: string, fallback: LoadingLayout = 'rows'): LoadingLayout {
  try {
    const stored = localStorage.getItem(preferenceKey);
    const view = stored ? (JSON.parse(stored) as { view?: unknown } | null)?.view : undefined;
    return (typeof view === 'string' ? SHAPES[view] : undefined) ?? fallback;
  } catch {
    return fallback;
  }
}

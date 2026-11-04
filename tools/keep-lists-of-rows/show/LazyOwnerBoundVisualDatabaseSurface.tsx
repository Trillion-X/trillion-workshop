// parts/visual-database/show/LazyOwnerBoundVisualDatabaseSurface.tsx
//
// PURPOSE
//   The owner-bound table (OwnerBoundVisualDatabaseSurface.tsx) for a screen whose table is not the first thing it draws:
//   its code (the whole table, its field editors and file renderers) is fetched when the table is first drawn, so the
//   screen opens without carrying it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Same props, same table: this file only defers the fetch (ui/show/load-later).

import { later } from '../../ui/show/load-later/later';

export const LazyOwnerBoundVisualDatabaseSurface = later(() => import('./OwnerBoundVisualDatabaseSurface'), module => module.OwnerBoundVisualDatabaseSurface);

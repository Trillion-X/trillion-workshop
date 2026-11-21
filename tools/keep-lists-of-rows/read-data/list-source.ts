// tools/keep-lists-of-rows/read-data/list-source.ts
//
// PURPOSE
//   Where the Lists screen reads and changes a person's lists. The page that mounts the screen picks the source once, at its
//   entry, the way it mounts its records source and its records door (setListSource): the Workshop page reads a person's lists
//   as the tables of their own databases (table-lists.ts, the default), and a site's members page reads its lists through the
//   page's own records door, where the site keeps them (workspace-screens list-records.ts). The screen names neither.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The source is read when a screen mounts, never when this file loads, so the page's entry picks it first.
//   2. Every source has the same functions and shapes: the screen never asks which one answers.
//   3. A page that picks none reads the person's tables; there is no other fallback.

import * as personsTables from './table-lists';

export type ListSource = typeof personsTables;

let mounted: ListSource = personsTables;

/** The page's list source, mounted once at its entry before any screen reads a list. */
export function setListSource(source: ListSource): void {
  mounted = source;
}

/** The list source the page picked (the person's tables when it picked none). */
export const activeListSource = (): ListSource => mounted;

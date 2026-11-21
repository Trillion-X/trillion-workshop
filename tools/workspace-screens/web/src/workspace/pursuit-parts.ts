// src/workspace/pursuit-parts.ts
//
// PURPOSE
//   Which screens belong in a pursuit: each screen whose row says `in_pursuit: true` (a Workshop tool's screen row, the
//   DATA its owner writes). They show as rows under the pursuit the workspace is about (the sidebar's focus,
//   scope-focus.ts); a pursuit that is not the focus shows none, so a person in several pursuits sees one pursuit's
//   screens, not all of them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a pursuit or a screen: the flag is the screen row's own DATA.
//   2. Only the pursuit the focus names shows parts; `partsOf` answers null for every other pursuit.

import spaceKinds from './space-kinds.json';
import { focusNow } from './scope-focus';

export type PursuitScreen = Record<string, unknown> & { id: string; in_pursuit?: unknown };

const bare = (id: string) => id.replace(/^pursuit:/, '');

/** Whether `pursuit` is the one the workspace is about: the focus's only value names it. */
function focused(pursuit: { id?: unknown }): boolean {
  const pursuits = focusNow()[spaceKinds.focus_param] ?? [];
  return pursuits.length === 1 && typeof pursuit.id === 'string' && bare(pursuits[0]) === bare(pursuit.id);
}

/** The screens of `screens` that belong in the pursuit, or null when the pursuit is not the focus. */
export function partsOf(pursuit: { id?: unknown }, screens: PursuitScreen[]): PursuitScreen[] | null {
  if (!focused(pursuit)) return null;
  return screens.filter(screen => screen.in_pursuit === true);
}

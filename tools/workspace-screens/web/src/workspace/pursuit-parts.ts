// src/workspace/pursuit-parts.ts
//
// PURPOSE
//   Which screens belong in a pursuit: each screen whose row says `in_pursuit: true` (a Workshop tool's screen row, the
//   DATA its owner writes). A screen shows under whichever pursuit the focus names. They show as rows under the pursuit the workspace is about (the sidebar's focus,
//   scope-focus.ts); a pursuit that is not the focus shows none, so a person in several pursuits sees one pursuit's
//   screens, not all of them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a pursuit or a screen: the flag is the row's own DATA.
//   2. Only the pursuit the focus names shows parts; `partsOf` answers null for every other pursuit. The focus is passed
//      in, so this module reads nothing and a test can drive it.

import spaceKinds from './space-kinds.json' with { type: 'json' };

export type PursuitScreen = Record<string, unknown> & { id: string; in_pursuit?: unknown };

const bare = (id: string) => id.replace(/^pursuit:/, '');

/** The id of the pursuit the focus names, or null when the focus is not exactly one pursuit. */
function focusedId(focus: Record<string, string[]>): string | null {
  const pursuits = focus[spaceKinds.focus_param] ?? [];
  return pursuits.length === 1 ? bare(pursuits[0]) : null;
}

/** The screens of `screens` that belong in the pursuit, or null when the pursuit is not the one `focus` names. */
export function partsOf(pursuit: { id?: unknown }, screens: PursuitScreen[], focus: Record<string, string[]>): PursuitScreen[] | null {
  const id = focusedId(focus);
  if (id === null || typeof pursuit.id !== 'string' || bare(pursuit.id) !== id) return null;
  return screens.filter(screen => screen.in_pursuit === true);
}

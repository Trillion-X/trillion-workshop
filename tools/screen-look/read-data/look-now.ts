// parts/screen-look/read-data/look-now.ts
//
// PURPOSE
//   The one look a screen wears for every screen; a screen that works out its own look repeats it. It is the one answer
//   to "which look does this screen wear right now": the worn look, or, while the person's look plan is
//   on and not held to the worn look, the plan's blend between two of their looks at this moment in this device's zone.
//   The workspace page (ScreenLookSurface) and every small page that paints itself (the file view an AI app draws) ask
//   this, so no surface can wear a different colour from another at the same moment.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: looks, worn look, plan, time and zone in; a look id and its values out. Nothing here holds a colour.
//   2. A plan point naming a look the caller does not hold falls back to the worn look, never to a guess.
//   3. Mid-blend the id is the nearer look's, so look-keyed rules follow the half the page is closer to.

import type { EditableScreenLookTheme } from './read-editable-screen-look-themes';
import { blendLookValues, lookAtTime, type LookPlan } from './look-over-time';

export type LookValues = Record<string, string>;

/** The look id and values a screen wears at `at` in `zone`; `valuesOf` resolves one look to its values. */
export function lookNow(
  looks: readonly EditableScreenLookTheme[],
  worn: EditableScreenLookTheme,
  plan: LookPlan | null | undefined,
  at: Date,
  zone: string,
  valuesOf: (look: EditableScreenLookTheme) => LookValues,
): { id: string; values: LookValues } {
  const now = lookAtTime(plan, at, zone);
  if (!now || now.held?.kind === 'worn') return { id: worn.id, values: valuesOf(worn) };
  const byId = (id: string) => looks.find(look => look.id === id) ?? worn;
  const [from, to] = [byId(now.from), byId(now.to)];
  if (from === to || now.t <= 0) return { id: from.id, values: valuesOf(from) };
  if (now.t >= 1) return { id: to.id, values: valuesOf(to) };
  return { id: now.t < 0.5 ? from.id : to.id, values: blendLookValues(valuesOf(from), valuesOf(to), now.t) };
}

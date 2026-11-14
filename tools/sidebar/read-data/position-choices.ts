// parts/sidebar/read-data/position-choices.ts
//
// PURPOSE
//   Where a sidebar frame may sit, as the person's show rules leave it. A rule of the frame's own subject (its controls
//   path, `sidebar` for the window's sidebar) with effect `change` sets `position_choices` (`set: [{ path:
//   ["position_choices"], value: ["left"] }]`), the same way screen arrangement reads its `constraints` from the
//   `arrangement` subject. The frame asks `showChanged(subject, { position_choices: EVERY_POSITION })` and reads the
//   answer here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a person, a preset or a rule; the positions are the part's DATA (../controls.json).
//   2. A value that names no known position (missing, not a list, empty, or only unknown words) limits nothing.
//   3. The rule's order is kept: its first choice is where the frame sits when its own home is not a choice.

import declared from '../controls.json' with { type: 'json' };
import type { SidebarPosition } from '../show/useSidebarPlacement';

/** Every place a sidebar frame can sit. */
export const EVERY_POSITION: readonly SidebarPosition[] = declared.position_choices.every as SidebarPosition[];

/** The places a rule's `position_choices` leaves, in its order; every place when it names none. */
export function readPositionChoices(value: unknown): readonly SidebarPosition[] {
  if (!Array.isArray(value)) return EVERY_POSITION;
  const choices = [...new Set(value)].filter((one): one is SidebarPosition => EVERY_POSITION.includes(one as SidebarPosition));
  return choices.length ? choices : EVERY_POSITION;
}

/** Where the frame sits given its home and the choices: its home when that is a choice, else the first choice. */
export function homeAmong(home: SidebarPosition, choices: readonly SidebarPosition[]): SidebarPosition {
  return choices.includes(home) ? home : choices[0]!;
}

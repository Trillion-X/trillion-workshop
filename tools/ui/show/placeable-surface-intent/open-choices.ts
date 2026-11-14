// parts/ui/show/placeable-surface-intent/open-choices.ts
//
// PURPOSE
//   The places besides its own a screen can be opened (open-choices.json), as menu items any caller offers, and the
//   request each one adds to an open. Also how a screen asks to be closed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a place: each choice's `request` is DATA laid over the open request, read by the one
//      request reader (readPlaceableSurfacePayloadFromUnknown), so a new place is a new row.
//   2. Each choice is the control `open.<id>` (show-of.ts controlShown): `shownOpenChoices` offers only those no show
//      rule hides, so a person given one screen at a time is never offered a new pane or a floating window.
//   3. A screen never closes itself by reaching into the arrangement: it sends one bubbling event from its own
//      element, and the container it is in decides (its tab closes, and a window holding nothing else with it).

import choices from 'trillion-workshop/tools/decide-when-things-show/read-data/open-choices.json' with { type: 'json' };
import { controlShown } from '../show-rules/show-of';

export interface OpenChoice {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Laid over the open request: `placement`, `open_placement` or any other request field. */
  readonly request: Readonly<Record<string, unknown>>;
}

export const OPEN_CHOICES: readonly OpenChoice[] = choices.choices;

/** The control path an open choice is decided under. */
export const openChoiceControl = (choice: OpenChoice): string => `open.${choice.id}`;

/** The open choices to offer now: every one no show rule hides. */
export const shownOpenChoices = (): readonly OpenChoice[] => OPEN_CHOICES.filter(choice => controlShown(openChoiceControl(choice)));

/** The open request `payload` sent to the place `choice` names. */
export const withOpenChoice = <T extends object>(payload: T, choice: OpenChoice): T & Readonly<Record<string, unknown>> => ({ ...payload, ...choice.request });

/** The event a screen sends (bubbling, from inside its own panel) to close itself: the container it is in closes
 * its tab, and a floating window holding nothing else closes with it (screen-arrangement ContainerHost). */
export const SURFACE_CLOSE_EVENT = 'screen-arrangement-close-surface';

/** Closes the screen drawn in `element`, as its tab's close would. */
export function closeOwnScreen(element: Element): void {
  element.dispatchEvent(new Event(SURFACE_CLOSE_EVENT, { bubbles: true }));
}

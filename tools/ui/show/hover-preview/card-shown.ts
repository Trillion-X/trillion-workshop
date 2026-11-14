// parts/ui/show/hover-preview/card-shown.ts
//
// PURPOSE
//   Whether a hover or preview card is drawn now. Every card is the control `cards.hover.<surface>` (show-rules
//   show-of.ts controlShown): its caller names its surface's path, so a rule about `cards.hover` hides every card and
//   one about `cards.hover.lists` hides the lists' cards alone. A card whose caller names no surface is the ui part's
//   `cards.default` (parts/ui/controls.json); `cards` names the ui part's own card kinds' controls too.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a surface: the path is the caller's, the default is DATA.
//   2. A hidden card leaves its trigger exactly as it is: the row, tile or tab keeps its own click and keyboard.

import controls from '../../controls.json' with { type: 'json' };
import { controlShown } from '../show-rules/show-of';

/** The control each of the ui part's own card kinds is decided under (`default`: a card whose caller names none). */
export const CARD_CONTROLS: Readonly<Record<string, string>> = controls.cards;

/** Whether the card at `control` (default: the ui part's) is drawn now. */
export const cardShown = (control: string = CARD_CONTROLS.default): boolean => controlShown(control);

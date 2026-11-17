//
// The tour library: the tours the person's AIs write, kept as a kept library of the group part
// (tools/make-screen-layouts-and-controls/parts/group/read-data/kept-library.ts) configured by its row, tour-library.json. Read the same way by the store that
// writes it (src/tours.mjs) and by the Tours screen, so both always agree.

import library from '../tour-library.json';
import type { KeptLibrary } from '../../organize-the-sidebar/read-data/kept-library.ts';

/** The tours the person's own AIs wrote (src/tours.mjs), read by this input name beside the app's own. */
export const OWN_WALKTHROUGHS_INPUT = 'own-walkthroughs';
/** An AI's ask to start one tour now (`{ tour_id, asked_at }`), read by this input name. */
export const WALKTHROUGH_SHOW_ASKED_INPUT = 'walkthrough-show-asked';

/** The row the tours' categories and Recent are kept by. */
export const TOUR_LIBRARY: KeptLibrary = library;

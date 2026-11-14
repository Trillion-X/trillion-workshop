// src/workspace/offered-screens.ts
//
// PURPOSE
//   Which screens this person is offered and the records every screen reads from the start, worked out the same way
//   wherever Trillion's screens are drawn: the signed-in page (main.tsx) and the screen view an AI app draws
//   (screen-view.tsx).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A screen whose row names an `audience` appears only to a viewer holding it, including a tool's replacement row
//      and navigation rows derived from an audience-limited screen. Access is checked on the final combined offer.
//   2. A tool screen that replaces one of the app's screens carries that screen's id, so it takes its place in the order.
//   3. The app's DATA comes first (its screens, its looks, the look a new account starts with), then the person's own
//      records, so a saved look or arrangement wins over the start.
//   4. The looks are their own content-named file, not part of the script every screen pays before it runs: it is asked
//      for the moment this module runs, so it arrives while the page reads the person's records, and the records every
//      screen reads start only once it is here (no screen ever paints without its look).

import { startRecords } from './records';
import surfaces from './screens.mjs';
import { oneRowPerId } from './one-row-per-id.mjs';
import { pursuitNavigationRows } from './pursuit-navigation-rows.mjs';
import { conversationNavigationRows } from './conversation-navigation-rows.mjs';

export type ScreenRow = Record<string, unknown> & { id: string };

/** The app's screens this viewer may see, then each tool's own screen, then a row per pursuit (and per part of the
 *  pursuit `partsOf` shows, pursuit-parts.ts) and per conversation, one row per id. `conversations` is
 *  /work/api/messages/threads' answer; when it has not been read, only the conversation every AI reads (All your AIs)
 *  has a row. */
export function offeredScreens(viewer: { access_refs: string[] }, toolScreens: ScreenRow[], pursuits: Record<string, unknown>[] = [], conversations: Record<string, unknown>[] = [], partsOf?: (pursuit: Record<string, unknown>) => { id: string; label: string; icon?: string; tool_id?: string }[] | null): ScreenRow[] {
  return oneRowPerId([
    ...(surfaces.surfaces as ScreenRow[]),
    ...toolScreens,
    ...pursuitNavigationRows(pursuits, surfaces.surfaces, partsOf),
    ...conversationNavigationRows(conversations, surfaces.surfaces),
  ]).filter(surface => !('audience' in surface) || viewer.access_refs.includes(`audience:${String(surface.audience)}`));
}

const looksRead = import('./looks.json').then(module => module.default);

/** Starts the records every screen reads: the offered screens, the looks, then the person's saved records. */
export async function startScreenRecords(offered: ScreenRow[], saved: Record<string, unknown>): Promise<void> {
  const looks = await looksRead;
  startRecords({
    [surfaces.address_label]: offered,
    'package::screen-look::published-records': looks.themes,
    'screen-look': [{ name: looks.start_with }],
  }, saved);
}

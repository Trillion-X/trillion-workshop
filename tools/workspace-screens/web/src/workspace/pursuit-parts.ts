// src/workspace/pursuit-parts.ts
//
// PURPOSE
//   Which parts of a pursuit the person's one sidebar shows under its row, beyond the room's own places
//   (space-kinds.json `places`): its turned-on places (Leaderboard, Classroom, Matches...) and the screens of the tools
//   added to it, from the one read of its turned-on parts (GET /work/api/community/<room>, the same read its screen
//   makes). Only the pursuit the workspace is about (the sidebar's focus, scope-focus.ts) shows its parts, so a person
//   in a hundred pursuits sees one pursuit's parts, not a hundred.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One read per room: a pursuit's screen hands over every read it makes (`rememberParts`), and the focus reads a
//      room only when nothing has read it yet on this page.
//   2. Nothing here names a place: the places come from community-places.ts over space-kinds.json DATA.
//   3. `partsOf` answers null for a pursuit whose parts are not shown, and [] while its read is on its way (its own
//      places show at once).
//   4. The page's first load does not carry the places table: it is fetched with the first read it reads
//      (scripts/workspace-budgets.json first_load).

import spaceKinds from './space-kinds.json';
import type { CommunityView, PartPlace, TurnedOn } from './community-places';
import { readAnswer } from './api';
import { focusNow, onFocusChange } from './scope-focus';

const OWN = (spaceKinds.places as { id: string }[]).map(place => place.id);
const TURNED_ON = spaceKinds.turned_on_places as Record<string, TurnedOn>;
const known = new Map<string, PartPlace[]>();
const reading = new Set<string>();
const listeners = new Set<() => void>();
const tell = () => { for (const listener of listeners) listener(); };
const same = (a: PartPlace[] | undefined, b: PartPlace[]) => JSON.stringify(a) === JSON.stringify(b);
const bare = (id: string) => id.replace(/^pursuit:/, '');

/** Keep what one room's turned-on parts answered (its screen's own read), so its sidebar rows follow it. */
export function rememberParts(spaceId: string, view: CommunityView): void {
  void import('./community-places').then(({ partPlacesOf }) => {
    const parts = partPlacesOf(view, TURNED_ON, OWN);
    if (same(known.get(spaceId), parts)) return;
    known.set(spaceId, parts);
    tell();
  });
}

/** Whether `pursuit` is the one the workspace is about: its id, or its room's, is the focus's only value. */
function focused(pursuit: { id?: unknown; space_id?: unknown }): boolean {
  const scope = focusNow();
  const pursuits = scope[spaceKinds.focus_param] ?? [];
  const rooms = scope[spaceKinds.room_focus_param] ?? [];
  return (pursuits.length === 1 && typeof pursuit.id === 'string' && bare(pursuits[0]) === bare(pursuit.id))
    || (rooms.length === 1 && rooms[0] === pursuit.space_id);
}

/** The parts the sidebar shows under `pursuit` beyond its room's own places, or null when it shows none. */
export function partsOf(pursuit: Record<string, unknown>): PartPlace[] | null {
  const room = typeof pursuit.space_id === 'string' ? pursuit.space_id : '';
  if (!room || !focused(pursuit)) return null;
  if (!known.has(room) && !reading.has(room)) {
    reading.add(room);
    void readAnswer<CommunityView>(`/work/api/community/${encodeURIComponent(room)}`)
      .then(answer => { if (answer.ok) rememberParts(room, answer.value); }, () => undefined)
      .finally(() => reading.delete(room));
  }
  return known.get(room) ?? [];
}

/** Listen for the shown parts changing (a read arrived, or the focus moved); returns the function that stops it. */
export function onPartsChange(listener: () => void): () => void {
  listeners.add(listener);
  const stopFocus = onFocusChange(listener);
  return () => { listeners.delete(listener); stopFocus(); };
}

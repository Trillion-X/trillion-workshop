// packages/group/show/use-surface-presence.ts
//
// Live presence for any shared view, not only a board: the people looking at the same view (a calendar, a list, the
// board) of the same shared room, each with a cursor placed in the view's own box and what they have picked out. A
// cursor travels as fractions of the box's width and height, so two screens of different sizes point at the same
// place on the view; it is drawn back in this screen's pixels. The room is the space's own (src/board-room.mjs over
// openPresenceRoom), which gives each person the name they show in that space; `view` keeps one view's cursors off
// another's.
//
// Composition of proven parts (L093): the presence model (read-data/presence.ts: merge, staleness, order), the room
// transport (presence-channel.ts openPresenceRoom) and the shared people overlay and roster
// (parts/ui/show/live-surface-people), which only paint.
//
// Identity comes from the room, never from this page: a person cannot show up as someone else. Presence is never kept.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { LiveSurfacePersonView } from '../../ui/show/live-surface-people';
import { EMPTY_PRESENCE, activeParticipants, colorForParticipant, pruneStale, upsertPresence, type PresenceState } from '../read-data/presence.ts';
import { openPresenceRoom } from './presence-channel.ts';

const TTL_MS = 10_000;
const HEARTBEAT_MS = 3_000;
const CURSOR_THROTTLE_MS = 80;

export interface SurfacePresence {
  /** Everyone else on this view now, ready for LiveSurfacePeopleOverlay and LiveSurfacePeopleRoster. */
  readonly people: readonly LiveSurfacePersonView[];
}

/**
 * Join `view` of `room` (a space id) while `room` is set: publish this screen's pointer over `surface` and what is
 * `selected`, and hear everyone else's. With no room (nothing shared to be present in) nobody is joined.
 */
export function useSurfacePresence(room: string | null, view: string, surface: RefObject<HTMLElement | null>, selected: readonly string[] = []): SurfacePresence {
  const [state, setState] = useState<PresenceState>(EMPTY_PRESENCE);
  const [, setSize] = useState(0);
  const cursor = useRef<{ x: number; y: number } | undefined>(undefined);
  const selection = useRef<readonly string[]>(selected);
  const told = useRef<(() => void) | null>(null);
  selection.current = selected;

  useEffect(() => {
    setState(EMPTY_PRESENCE);
    if (!room) return undefined;
    const channel = openPresenceRoom(room, update => setState(current => upsertPresence(current, update)), view);
    // The room names this person; what is sent is only where they point and what they picked.
    const publish = () => channel.publish({ id: 'self', name: '', ...(cursor.current ? { cursor: cursor.current } : {}), selection: selection.current, ts: Date.now() });
    told.current = publish;
    let lastMove = 0;
    const onMove = (event: PointerEvent) => {
      const box = surface.current?.getBoundingClientRect();
      if (!box || !box.width || !box.height) return;
      const x = (event.clientX - box.left) / box.width;
      const y = (event.clientY - box.top) / box.height;
      cursor.current = x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : undefined;
      const now = Date.now();
      if (now - lastMove < CURSOR_THROTTLE_MS) return;
      lastMove = now;
      publish();
    };
    window.addEventListener('pointermove', onMove);
    const heartbeat = setInterval(() => { publish(); setState(current => pruneStale(current, Date.now(), TTL_MS)); }, HEARTBEAT_MS);
    // Drawn again when the box changes size, so a cursor stays on the same part of the view.
    const watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => setSize(count => count + 1));
    if (surface.current) watcher?.observe(surface.current);
    publish();
    return () => { told.current = null; window.removeEventListener('pointermove', onMove); clearInterval(heartbeat); watcher?.disconnect(); channel.close(); };
  }, [room, view, surface]);

  // Picking something out is told at once, not at the next heartbeat.
  const picked = selected.join('\n');
  useEffect(() => { told.current?.(); }, [picked]);

  const box = surface.current?.getBoundingClientRect();
  const people = useMemo<readonly LiveSurfacePersonView[]>(() => activeParticipants(state, Date.now(), TTL_MS).map(person => ({
    key: person.id,
    label: person.name,
    color: colorForParticipant(person.id),
    point: person.cursor && box ? { x: person.cursor.x * box.width, y: person.cursor.y * box.height } : undefined,
    selectedRefs: person.selection,
  })), [state, box?.width, box?.height]);
  return { people };
}

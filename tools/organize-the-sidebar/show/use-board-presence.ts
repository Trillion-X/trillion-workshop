// packages/group/show/use-board-presence.ts
//
// The board's presence LOOP: publish this window's participant update
// (cursor in world coords + current selection) over the presence channel,
// merge every peer's updates through the pure presence model, and hand the
// panel a live `Participant[]` for the PresenceLayer + PresenceRoster.
//
// Composition of already-proven parts (L093/L069 — zero new model logic):
//   • model = read-data/presence.ts (upsertPresence merge, pruneStale ttl,
//     activeParticipants ordering, colorForParticipant);
//   • transport = show/presence-channel.ts (same-origin BroadcastChannel,
//     no-op where unavailable — the hook then renders nobody, zero cost);
//   • the cursor is published in WORLD coords (the caller's screenToWorld),
//     matching the world-space container PresenceLayer renders into.
//
// Identity is per-WINDOW and ephemeral (a fresh id each mount): presence is
// transient awareness, never persisted (L039 — a cursor is not content).

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_PRESENCE,
  activeParticipants,
  pruneStale,
  upsertPresence,
  type Participant,
  type PresenceState,
} from '../read-data/presence';
import { openPresenceChannel } from './presence-channel';

const TTL_MS = 10_000; // a peer quiet for 10s drops off (heartbeat is 3s)
const HEARTBEAT_MS = 3_000;
const CURSOR_THROTTLE_MS = 80; // ~12 updates/s while moving — smooth, not chatty

export interface BoardPresence {
  /** Every OTHER live participant on this board (self excluded, stable order). */
  readonly peers: readonly Participant[];
}

export function useBoardPresence(
  boardId: string,
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number },
  selectedIds: ReadonlySet<string>,
  options: { readonly room?: boolean } = {},
): BoardPresence {
  const room = options.room === true;
  // per-window ephemeral identity — never persisted, new each mount
  const self = useMemo(() => {
    const id = `peer-${Math.random().toString(36).slice(2, 10)}`;
    return { id, name: `Guest ${id.slice(5, 9)}` };
  }, []);
  const [state, setState] = useState<PresenceState>(EMPTY_PRESENCE);
  const cursorRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const selectionRef = useRef<readonly string[]>([]);
  selectionRef.current = [...selectedIds];
  const screenToWorldRef = useRef(screenToWorld);
  screenToWorldRef.current = screenToWorld;

  useEffect(() => {
    const channel = openPresenceChannel(boardId, (p) => {
      if (p.id !== self.id) setState((s) => upsertPresence(s, p));
    }, { room });
    const publish = () => channel.publish({
      id: self.id,
      name: self.name,
      ...(cursorRef.current ? { cursor: cursorRef.current } : {}),
      selection: selectionRef.current,
      ts: Date.now(),
    });

    let lastMove = 0;
    const onMove = (e: PointerEvent) => {
      const now = Date.now();
      if (now - lastMove < CURSOR_THROTTLE_MS) return;
      lastMove = now;
      cursorRef.current = screenToWorldRef.current(e.clientX, e.clientY);
      publish();
    };
    window.addEventListener('pointermove', onMove);
    const heartbeat = setInterval(() => {
      publish();
      setState((s) => pruneStale(s, Date.now(), TTL_MS));
    }, HEARTBEAT_MS);
    publish(); // announce immediately so a peer opening later still sees us via heartbeat

    return () => {
      window.removeEventListener('pointermove', onMove);
      clearInterval(heartbeat);
      channel.close();
    };
  }, [boardId, room, self]);

  const peers = useMemo(
    // signature is (state, now, ttlMs, selfId?) — passing selfId where `now`
    // goes makes every `now - ts` NaN and silently filters ALL peers out
    () => activeParticipants(state, Date.now(), TTL_MS, self.id),
    [state, self.id],
  );
  return { peers };
}

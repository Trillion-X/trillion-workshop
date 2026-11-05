// packages/group/show/presence-channel.ts
//
// The SAME-ORIGIN presence transport: participant updates travel between
// windows/tabs/panes of the same browser profile over a BroadcastChannel —
// a pure browser primitive (no server, no network owner). This is the
// self-contained half of R16's transport story: two studio windows showing
// the same board see each other's live cursors TODAY; a future networked
// transport (the peer↔peer owner boundary) feeds the SAME `onUpdate` with
// the SAME `Participant` shape — this leaf never needs to change.
//
// Blind + fail-open: the channel carries opaque Participant updates (the
// presence model in read-data/presence.ts owns merge/staleness/colour); an
// environment without BroadcastChannel (older shells, some test runners)
// gets a NO-OP channel — the board works identically, just solo (SP5's
// fail-closed is for security boundaries; presence is an additive signal,
// so absence degrades to "nobody else visible", never a crash).

import type { Participant } from '../read-data/presence.ts';

export interface PresenceChannel {
  /** Broadcast this window's participant update to every sibling window. */
  readonly publish: (p: Participant) => void;
  /** Stop listening and release the channel. */
  readonly close: () => void;
}

const NOOP: PresenceChannel = { publish: () => {}, close: () => {} };

/** A participant update is accepted only in the exact wire shape — a stray
 *  message on the channel (another app, a stale sender) is dropped, never
 *  merged (fail-closed on the DATA boundary even though absence fails open). */
function isParticipant(v: unknown): v is Participant {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === 'string' && p.id.length > 0
    && typeof p.name === 'string'
    && typeof p.ts === 'number' && Number.isFinite(p.ts);
}

/**
 * Open the presence channel for one board. The channel name is scoped by
 * board id, so two windows only see each other when they are on the SAME
 * board. Returns a no-op channel where BroadcastChannel is unavailable.
 */
export function openPresenceChannel(
  boardId: string,
  onUpdate: (p: Participant) => void,
  options: { readonly room?: boolean } = {},
): PresenceChannel {
  const room = options.room ? openPresenceRoom(boardId, onUpdate) : NOOP;
  if (typeof BroadcastChannel === 'undefined') return room;
  const channel = new BroadcastChannel(`group.presence::${boardId}`);
  channel.onmessage = (e: MessageEvent) => {
    if (isParticipant(e.data)) onUpdate(e.data);
  };
  return {
    publish: (p) => {
      try { channel.postMessage(p); } catch { /* a closing channel never throws into the board */ }
      room.publish(p);
    },
    close: () => { channel.close(); room.close(); },
  };
}

// TRILLION: the networked transport the header names. A board whose id is a space the person is in reaches the
// space's board room (src/board-room.mjs, /work/live/board/<id>), which relays each member's updates to the others
// under the name they show in that space. Only a caller whose board has a room (`options.room`, mount DATA) opens it;
// a person's own board meets only their other windows and never asks the room. An update
// from the room is stamped with this window's clock on arrival, so another computer's clock never ages it out.
const ROOM_RETRY_MS = 2_000;
// A page that reaches the room for every window (a public app's page editor) opens only the room, so the person's own
// other tab is not drawn twice, once from each transport.
// `view` names which shared view of the room this is (the board, a calendar): only people on the same view see each
// other's cursors, since a point means something only on the view it was made on.
export function openPresenceRoom(boardId: string, onUpdate: (p: Participant) => void, view?: string): PresenceChannel {
  if (typeof WebSocket === 'undefined' || typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return NOOP;
  const address = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/work/live/board/${encodeURIComponent(boardId)}${view ? `?view=${encodeURIComponent(view)}` : ''}`;
  let socket: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    let opened = false;
    const next = new WebSocket(address);
    socket = next;
    next.onopen = () => { opened = true; };
    next.onmessage = (e: MessageEvent) => {
      let update: unknown;
      try { update = JSON.parse(String(e.data)); } catch { return; }
      if (isParticipant(update)) onUpdate({ ...update, ts: Date.now() });
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      if (!closed && opened) retry = setTimeout(connect, ROOM_RETRY_MS);
    };
  };
  connect();
  return {
    publish: (p) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ ...(p.cursor ? { cursor: p.cursor } : {}), selection: p.selection ?? [], ...(p.target ? { target: p.target } : {}), ...(p.doing ? { doing: p.doing } : {}), ...(p.passive ? { passive: true } : {}) })); } catch { /* a closing socket misses one update */ }
    },
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}

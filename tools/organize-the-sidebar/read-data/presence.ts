// packages/group/read-data/presence.ts
//
// Ephemeral multiplayer PRESENCE: who else is on this board right now, where their cursor
// is, and what they have selected. This is the visible half of "multiplayer" — the live
// cursors + name tags you see in Figma/Miro/FigJam.
//
// Presence is TRANSIENT awareness, never persisted: it is broadcast peer→peer and dropped
// when a peer goes quiet (staleness ttl). It never touches the log — persisting a cursor
// would be a category error (L039: a cursor is not board content).
//
// Pure & deterministic:
//  • merge ignores out-of-order updates (a newer `ts` for a participant always wins) so the
//    same set of updates converges to the same state regardless of arrival order;
//  • each participant's colour is a deterministic hash of their id — a stable per-person
//    colour with ZERO configuration (L083 maximally-capable default: you never pick colours).
//
// The TRANSPORT (how presence updates travel between peers) is the owner/engine boundary —
// this leaf is the model + staleness rule + colour assignment, all provable with no network.

export interface Cursor {
  readonly x: number;
  readonly y: number;
}

export interface Participant {
  readonly id: string;
  readonly name: string;
  readonly cursor?: Cursor;
  readonly selection?: readonly string[]; // memberIds this peer currently has selected
  readonly target?: { readonly selector?: string; readonly text?: string }; // TRILLION: what they are changing on a page
  readonly doing?: string; // TRILLION: a short word for it, such as "Editing"
  readonly passive?: boolean; // TRILLION: connected but not present (hidden or idle tab)
  readonly gone?: boolean; // TRILLION: the room says this peer left; drawn by nobody
  readonly ts: number; // last-heard-from wall time (ms) — drives staleness
}

export type PresenceState = Readonly<Record<string, Participant>>;

export const EMPTY_PRESENCE: PresenceState = {};

/** Apply one participant update. A stale (older-ts) update for a known participant is
 *  ignored, so out-of-order delivery never rewinds someone's cursor. */
export function upsertPresence(state: PresenceState, p: Participant): PresenceState {
  const prev = state[p.id];
  if (prev && prev.ts > p.ts) return state;
  return { ...state, [p.id]: p };
}

/** Drop a participant (explicit leave). No-op if absent. */
export function removePresence(state: PresenceState, id: string): PresenceState {
  if (!(id in state)) return state;
  const next = { ...state };
  delete next[id];
  return next;
}

/** The participants to DRAW: heard-from within `ttlMs`, excluding self, in a deterministic
 *  order (by id) so overlapping cursors stack the same way every render. */
export function activeParticipants(
  state: PresenceState,
  now: number,
  ttlMs: number,
  selfId?: string,
): Participant[] {
  return Object.values(state)
    .filter((p) => p.id !== selfId && !p.gone && now - p.ts <= ttlMs)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Prune every stale participant (housekeeping between renders). Returns the same object
 *  when nothing changed, so callers can skip re-renders on identity. */
export function pruneStale(state: PresenceState, now: number, ttlMs: number): PresenceState {
  let changed = false;
  const next: Record<string, Participant> = {};
  for (const p of Object.values(state)) {
    if (now - p.ts <= ttlMs) next[p.id] = p;
    else changed = true;
  }
  return changed ? next : state;
}

/** Deterministic, evenly-spread hue from the participant id → a stable per-person colour.
 *  FNV-1a 32-bit → hue; fixed saturation/lightness keep every colour legible on a light
 *  board. Same id always yields the same colour, on every peer, with no coordination. */
export function colorForParticipant(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = (h >>> 0) % 360;
  return `hsl(${hue} 68% 45%)`;
}


/** Human summary for a presence badge ("3 people here"). */
export function presenceSummary(count: number): string {
  if (count <= 0) return 'Only you';
  if (count === 1) return '1 other here';
  return `${count} others here`;
}

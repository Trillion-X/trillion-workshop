// src/workspace/pending-changes.ts
//
// PURPOSE
//   Changes a person made that the store has not yet acknowledged, laid over what a screen reads until it has. A screen
//   that moves a post draws it at once; if the store tells the page "something changed" and the screen reads again before
//   the write has landed, that read still holds the old place and would snap the post back. Here the change stays as a
//   pending modifier on that read and is applied to every answer of it until the write is acknowledged or fails, so the
//   screen only ever shows what the person did, then what the store says.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A modifier is applied only to the read it names, in the order they were added, and only while it is pending.
//   2. A modifier ends when its write ends, acknowledged or refused: `optimistic` removes it in `finally`, so a refused
//      write rolls back by the next read showing the store's own answer, and nothing stays laid over a screen for ever.
//   3. A modifier that throws is skipped for that answer: a screen shows the store's answer rather than nothing.
//   4. The same key on the same read replaces the earlier modifier (a post moved twice is moved to where it last went).
//   5. Modifiers are laid in layers (pending-layers.json, lowest first): what the store last said stays under what the
//      page has not sent yet, and that under what the person is doing now. Inside a layer, the order they were added.
//   6. A modifier whose result equals what it was given (the store already shows the change) ends there and then: the
//      overlay never outlives the store catching up, and a screen cannot be held on a stale layer.

import layers from './pending-layers.json' with { type: 'json' };

type Modifier = (value: never) => unknown;
type Laid = { modifier: Modifier; layer: number };
const pending = new Map<string, Map<string, Laid>>();
const rankOf = (layer: string): number => { const rank = layers.order.indexOf(layer); return rank < 0 ? layers.order.indexOf(layers.default) : rank; };

/** Lays `modifier` over every answer of `read` (in `layer`, one of pending-layers.json) until the returned function is called. */
export function addPending<T>(read: string, key: string, modifier: (value: T) => T, layer: string = layers.default): () => void {
  const held = pending.get(read) ?? new Map<string, Laid>();
  pending.set(read, held);
  held.delete(key);
  const laid: Laid = { modifier: modifier as Modifier, layer: rankOf(layer) };
  held.set(key, laid);
  return () => {
    if (held.get(key) === laid) held.delete(key);
    if (!held.size && pending.get(read) === held) pending.delete(read);
  };
}

/** An answer of `read` with every pending modifier of it applied, in order. */
export function applyPending<T>(read: string, value: T): T {
  const held = pending.get(read);
  if (!held) return value;
  let shown = value;
  // Array sort is stable: inside a layer the modifiers stay in the order they were added.
  for (const [key, laid] of [...held].sort((a, b) => a[1].layer - b[1].layer)) {
    try {
      const next = (laid.modifier as (value: T) => T)(shown);
      // The store already shows this change: the modifier has nothing left to say (invariant 6).
      if (JSON.stringify(next) === JSON.stringify(shown)) { held.delete(key); continue; }
      shown = next;
    } catch { /* shown as the store has it (invariant 3) */ }
  }
  if (!held.size && pending.get(read) === held) pending.delete(read);
  return shown;
}

/** Whether anything is pending for `read`. */
export const hasPending = (read: string): boolean => (pending.get(read)?.size ?? 0) > 0;

/** Lays the change over `read`, runs the write, and takes the change off when the write ends either way. */
export async function optimistic<T, R>(read: string, key: string, modifier: (value: T) => T, write: () => Promise<R>, layer?: string): Promise<R> {
  const settle = addPending(read, key, modifier, layer);
  try { return await write(); } finally { settle(); }
}

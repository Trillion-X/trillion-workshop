// src/workspace/memory-budget.ts
//
// PURPOSE
//   A page that has read many lists holds each last answer's text in memory so it can tell an unchanged answer without
//   writing it again. That memory has a budget (first-answers.json `kept.max_text_chars`): above it, the answers used
//   longest ago are let go from memory. They are still on the device's disk, so reading one again costs one disk read,
//   never a wrong answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The map's order is use order: `touch` moves an entry to the end; the front is let go first.
//   2. Only an entry the caller says can be let go is ever removed (one being written, or standing for a refusal, stays).
//   3. Nothing is removed while the total is within budget, and the entry just used is never removed by its own use.

/** Moves `key` to the most recently used place. */
export function touch<K, V>(map: Map<K, V>, key: K): void {
  if (!map.has(key)) return;
  const value = map.get(key) as V;
  map.delete(key);
  map.set(key, value);
}

/** Lets go the least recently used entries that `evictable` accepts until the sizes total at most `budget`; answers how many went. */
export function trimToBudget<K, V>(map: Map<K, V>, sizeOf: (value: V) => number, evictable: (value: V) => boolean, budget: number): number {
  let total = 0;
  for (const value of map.values()) total += sizeOf(value);
  let gone = 0;
  const newest = [...map.keys()].at(-1);
  for (const [key, value] of [...map]) {
    if (total <= budget) break;
    if (key === newest || !evictable(value)) continue;
    total -= sizeOf(value);
    map.delete(key);
    gone += 1;
  }
  return gone;
}

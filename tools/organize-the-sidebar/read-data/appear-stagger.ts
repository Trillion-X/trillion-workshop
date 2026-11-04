// packages/group/read-data/appear-stagger.ts
//
// Pure arrival-order entrance staggering for canvas items. When a batch of items
// appears at once (a producer landing N notes, a paste of many lines, a multi-file
// drop) the board should bring them to life PIECE BY PIECE — each new item rises in
// ~70ms after the previous — instead of dumping all at once.
//
// This is the pure decision layer: given the current item ids and the set of ids
// that were already present at the last commit, it returns a per-id entrance delay
// (ms) for ONLY the genuinely-new ids, in their board order. Items that were already
// present (board open / reload / a re-render that didn't add anything) get NO entry
// (instant). The renderer (CanvasNode.appearDelayMs) plays the one-time animation.
//
// Physics: "things that just appeared cascade in". Zero domain vocabulary — it works
// for any id-bearing list, never knows what an item IS.

/** The cascade step between consecutive new items, in milliseconds. */
export const APPEAR_STEP_MS = 70;

/** Cap the cascade tail so a huge batch never delays the last item by seconds. */
export const APPEAR_MAX_STEPS = 11;

/**
 * Compute entrance delays for newly-appeared ids.
 *
 * @param currentIds ids in board order (e.g. items.map(i => i.memberId))
 * @param previousIds the id set present at the last commit, or null on first paint
 * @returns Map of id → delayMs, containing ONLY ids absent from previousIds.
 *          Empty when previousIds is null (first paint = no stagger) or nothing is new.
 */
export function computeAppearDelays(
  currentIds: readonly string[],
  previousIds: ReadonlySet<string> | null,
): Map<string, number> {
  const delays = new Map<string, number>();
  if (!previousIds) return delays; // first paint — everything is "already here", no cascade
  let order = 0;
  for (const id of currentIds) {
    if (!previousIds.has(id)) {
      delays.set(id, Math.min(order, APPEAR_MAX_STEPS) * APPEAR_STEP_MS);
      order += 1;
    }
  }
  return delays;
}

// parts/addressed-marks/read-data/ink-fade.ts
//
// INK THAT FADES: A MARK IS FULLY SEEN FOR A WHILE AFTER IT IS MADE, THEN GOES, ALL FROM THE MARK'S OWN TIME.
//
// Purpose: annotations drawn live over a screen while it is being recorded or shown should not pile up. A mark carries the time it
// was made (`createdAt`); this answers how visible it is at any later instant, so a layer can draw it at that opacity and drop
// it once it is gone. Nothing is deleted from the record: the mark is still the person's record, only no longer drawn.
//
// Non-negotiable invariants:
//   1. Pure: the answer depends only on the mark's time, the instant asked about and the fade rules; no clock is read here.
//   2. The rules (how long a mark holds, how long it fades, how often a layer looks again) are DATA the caller passes in.
//   3. A mark with no usable time never fades: unknown is shown, not hidden.
//   4. Opacity is 1 until `hold_ms` has passed, falls in a straight line to 0 over `fade_ms`, and stays 0 after.

export type InkFade = { hold_ms: number; fade_ms: number; tick_ms: number };

/** How visible a mark made at `createdAt` is at instant `now` (ms since the epoch): 1 fully seen, 0 gone. */
export function inkOpacity(createdAt: string | undefined, now: number, fade: InkFade): number {
  const made = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(made)) return 1;
  const age = now - made;
  if (age <= fade.hold_ms) return 1;
  if (fade.fade_ms <= 0) return 0;
  return Math.max(0, 1 - (age - fade.hold_ms) / fade.fade_ms);
}

/** The instant after which a mark made at `createdAt` is gone, or null when it never goes. */
export function inkGoneAt(createdAt: string | undefined, fade: InkFade): number | null {
  const made = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(made) ? made + fade.hold_ms + fade.fade_ms : null;
}

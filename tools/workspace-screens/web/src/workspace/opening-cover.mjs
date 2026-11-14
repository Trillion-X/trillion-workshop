// src/workspace/opening-cover.mjs
//
// PURPOSE
//   When the opening cover lifts off the workspace page (src/workspace/main.tsx invariant 8): once the open screens have
//   painted, or, whatever the person's store is doing, at the latest `mostMs` after the page started. A store that
//   answers one request at a time and slowly held the cover for 34.6 to 108 s on one busy account (2026-10-07) because
//   the first reads, then the screens' own reads, were waited on one after the other with no bound over the whole.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The cover lifts exactly once, and the page is marked open (what moves behind the page may show) only after that
//      lift has finished and only when the page opened (painted, or the bound passed), never when it failed to open:
//      a failed open lifts the cover to say so (`failed`) and leaves the page unmarked, as before.
//   2. The bound is measured from the page's start (`now()` counts from it), not from when this was set up, so time the
//      first reads already took is part of it.
//   3. At the bound, nothing is waited for. What is drawn is what shows; a screen still reading shows its own loading
//      state, and when the workspace itself is not drawn yet `showNote` puts a plain loading note in its place, which
//      `hideNote` removes the moment the workspace (or its failure) is drawn. It never claims anything is loaded.
//   4. After the bound or a failure, a later `opened` or `failed` changes nothing more than it already did.
//

/** @param {{ mostMs: number, now: () => number, lift: () => Promise<void>, markOpen: () => void, showNote: () => void,
 *  hideNote: () => void, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} how
 *  @returns {{ opened(): Promise<void>, failed(): Promise<void>, gaveUp(): boolean }} */
export function coverLifting({ mostMs, now, lift, markOpen, showNote, hideNote, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let lifting = null;
  let marking = null;
  let gaveUp = false;
  let failedOpen = false;
  let markedOpen = false;
  const liftOnce = () => (lifting ??= lift());
  const opened = () => {
    clearTimer(timer);
    if (failedOpen) return liftOnce();
    return (marking ??= liftOnce().then(() => {
      // A failed start can arrive while the deadline's lift is still pending.
      // Failure wins until this callback commits the page-open decision.
      if (!failedOpen && !markedOpen) { markedOpen = true; markOpen(); }
    }));
  };
  const timer = setTimer(() => {
    gaveUp = true;
    try { showNote(); }
    finally { void opened(); }
  }, Math.max(0, mostMs - now()));
  const failed = () => {
    clearTimer(timer);
    if (!markedOpen) failedOpen = true;
    try { hideNote(); }
    finally { void liftOnce(); }
    return liftOnce();
  };
  return { opened, failed, gaveUp: () => gaveUp };
}

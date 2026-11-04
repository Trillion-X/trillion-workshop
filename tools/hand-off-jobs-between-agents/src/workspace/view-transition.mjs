// src/workspace/view-transition.mjs
//
// Purpose: a screen change inside the workspace crossfades through the browser's own view transition instead of
// cutting, at the look's pace (--motion-sheet and --ease-move, written by parts/screen-look/read-data/
// resolve-screen-look-palette.js; the ::view-transition rules are in parts/screen-look/show/surfaces.css).
//
// Non-negotiable invariants
//   1. The change itself always happens, whether or not a transition does: a browser without document.startViewTransition,
//      a person who asked for reduced motion, or a transition the browser skips, all run `change` exactly once.
//   2. `change` is the whole change. The transition waits two animation frames after it so the screen the change asked for
//      is drawn before the browser takes the new picture.
//   3. Nothing here names a screen or an address.

const SETTLE_FRAMES = 2;
const afterFrames = (frames, win) => new Promise(done => {
  const step = left => (left === 0 ? done() : win.requestAnimationFrame(() => step(left - 1)));
  step(frames);
});

/** Runs `change` inside a view transition when the browser offers one and motion is wanted; otherwise just runs it. */
export function withViewTransition(change, win = globalThis.window) {
  const doc = win?.document;
  const reduced = win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  if (!doc || typeof doc.startViewTransition !== 'function' || reduced) { change(); return null; }
  let ran = false;
  const once = () => { if (!ran) { ran = true; change(); } };
  try {
    const transition = doc.startViewTransition(async () => { once(); await afterFrames(SETTLE_FRAMES, win); });
    // A skipped or failed transition has already run (or will run) the change through its callback; a rejection of its
    // finished promise is only the browser saying it did not animate.
    transition.finished?.catch?.(() => {});
    transition.ready?.catch?.(() => {});
    return transition;
  } catch { once(); return null; }
}

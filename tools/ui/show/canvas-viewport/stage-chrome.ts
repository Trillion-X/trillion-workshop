// packages/ui/show/canvas-viewport/stage-chrome.ts
//
// =============================================================================
// PURPOSE — the generic "this press is on CHROME, not the canvas" contract
// =============================================================================
//
// A canvas stage (board, workflow canvas, screen-arrangement) interprets a
// pointer press on EMPTY canvas as a marquee/pan, and to make the drag smooth it
// calls `setPointerCapture` on the stage element. That capture is correct for a
// press that really landed on the canvas background — but WRONG for a press that
// landed on a floating panel drawn OVER the canvas (a walkthrough card, a metric
// popover, a comment thread). Those panels are CHROME: their buttons are not
// canvas gestures. Yet because they are positioned children of the same stage
// and do not stop propagation, their pointerdown bubbles to the stage, the stage
// captures the pointer, and the panel's button never receives its click — a
// dead button (the R42/R54 root).
//
// Interactable NODES already opt out by stamping `data-node-ref` and handling
// (and stopping) their own pointer events. CHROME needs the symmetric contract:
// stamp `data-stage-chrome` on the panel root, and the stage's pointer
// interpreter bails the moment a press originates inside a marked element. One
// attribute, one guard — every current and future floating panel is immune to
// the capture-steals-the-click bug with zero per-panel handler code.
//
// Generic: no domain vocabulary. Any canvas that owns a marquee/pan interpreter
// calls `pressIsOnStageChrome(target)` at the top of its pointerdown handler; any
// panel that floats over a canvas marks its root with `STAGE_CHROME_ATTR`.
// =============================================================================

/** The DOM attribute a floating panel stamps on its root so a canvas stage's
 *  marquee/pan interpreter ignores presses that land on it. Value is irrelevant
 *  (presence is the signal), but `''` keeps the rendered attribute minimal. */
export const STAGE_CHROME_ATTR = 'data-stage-chrome';

/** Props spread onto a floating panel root to mark it as stage chrome.
 *  `<div {...stageChromeProps()}>` reads better than a bare string literal at the
 *  call site and keeps the attribute name in ONE place (this module). */
export function stageChromeProps(): { readonly [STAGE_CHROME_ATTR]: '' } {
  return { [STAGE_CHROME_ATTR]: '' };
}

/**
 * Did this pointer press originate on stage chrome (a floating panel), rather
 * than on the canvas itself? Walks from the event target up through ancestors
 * looking for `data-stage-chrome`. A canvas stage calls this FIRST in its
 * pointerdown handler and returns early when true, so it never begins a
 * marquee/pan (and never captures the pointer) on a press meant for a panel.
 *
 * Accepts the raw `EventTarget` (React synthetic events type `target` as
 * `EventTarget`); non-Element targets (never chrome) answer false.
 */
export function pressIsOnStageChrome(target: EventTarget | null | undefined): boolean {
  const el = target as Element | null | undefined;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(`[${STAGE_CHROME_ATTR}]`) !== null;
}

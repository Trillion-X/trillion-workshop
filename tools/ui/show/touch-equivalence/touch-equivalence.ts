// parts/ui/show/touch-equivalence/touch-equivalence.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One document-level mapping that gives a finger every gesture a mouse has, so a
// control drawn for a mouse works on a phone with no change of its own:
//
//   mouse                         finger
//   pointer resting on X (hover)  the last tap landed in X (held until the next tap)
//   right click (contextmenu)     long press
//   double click (dblclick)       double tap
//   button pressed (:active)      a short press flash on what the tap landed on
//
// A tap marks the element it landed on and every ancestor with
// `data-touch-hover`, exactly the chain a resting mouse makes `:hover`, and the
// workspace stylesheet's `hover` variant (screen-look coss-workspace.css) matches
// that attribute as well as `:hover`. So every `hover:` and `group-hover:` reveal
// in every part (pane controls, a tab's close, row actions) shows on a tap, and
// stays until the person taps somewhere else, the way iPadOS keeps hover.
// Long press and double tap dispatch the same `contextmenu` and `dblclick` events
// a mouse sends, so the menus and double-click actions already wired to them run.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Only touch pointers are mapped (`pointerType === 'touch'`). A mouse or a pen
//    keeps its own hover, right click and double click untouched.
// 2. One held chain at a time: a new tap clears the previous chain first.
// 3. A long press never also clicks or lifts: the finger's lift (pointerup,
//    touchend) and the click that follow it reach nothing else, so a menu the
//    long press opened stays open when the finger comes up, as a right-clicked
//    menu stays open when the mouse button comes up. The listeners sit on the
//    window in the capture phase, ahead of every document and element listener.
// 4. A gesture the browser already sends (Android's long-press contextmenu, a
//    native dblclick) is never sent twice: whichever comes first wins and the
//    other is stopped.
// 5. Text fields keep their own long press (the caret magnifier and text
//    selection) and their own double tap (select a word).
// 6. Timings are DATA (touch-equivalence.json), never constants in the handler.
// 7. Installing twice on one document is a no-op returning the first teardown.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import timings from './touch-equivalence.json';

/** The attribute a tap leaves on the element it landed on and its ancestors (the finger's `:hover`). */
export const TOUCH_HOVER_ATTRIBUTE = 'data-touch-hover';
/** The attribute a press leaves for a moment on the control it landed on (the finger's `:active`). */
export const TOUCH_PRESS_ATTRIBUTE = 'data-touch-press';

export type TouchTimings = typeof timings;

// What a press flashes on: the nearest thing a person presses, else the element itself.
const PRESSABLE = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="separator"], [data-tab-draggable], summary, label';
// Fields that keep their own long press and double tap.
const TEXT_FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

const installed = new WeakMap<Document, () => void>();

/** Maps touch gestures onto the mouse gestures every control already answers; returns the teardown. */
export function installTouchEquivalence(doc: Document = document, settings: TouchTimings = timings): () => void {
  const existing = installed.get(doc);
  if (existing) return existing;
  const view = doc.defaultView;
  if (!view) return () => {};

  let held: Element[] = [];
  let pressed: Element | null = null;
  let pressTimer = 0;
  let longTimer = 0;
  let down: { id: number; x: number; y: number; target: Element; at: number } | null = null;
  let longPressed = false;
  let swallowClick = false;
  let swallowLift = false;
  let lastTap: { x: number; y: number; at: number } | null = null;
  let sentContextMenuAt = -Infinity;
  let sentDoubleClickAt = -Infinity;
  let nativeContextMenuAt = -Infinity;
  let hoverAfterClick: Element | null = null;

  const hold = (target: Element) => {
    for (const element of held) element.removeAttribute(TOUCH_HOVER_ATTRIBUTE);
    held = [];
    for (let element: Element | null = target; element && element !== doc.documentElement; element = element.parentElement) {
      element.setAttribute(TOUCH_HOVER_ATTRIBUTE, '');
      held.push(element);
    }
  };
  const release = () => {
    if (pressed) pressed.removeAttribute(TOUCH_PRESS_ATTRIBUTE);
    pressed = null;
  };
  const flash = (target: Element) => {
    view.clearTimeout(pressTimer);
    release();
    pressed = target.closest(PRESSABLE) ?? target;
    pressed.setAttribute(TOUCH_PRESS_ATTRIBUTE, '');
  };
  const endFlash = () => {
    view.clearTimeout(pressTimer);
    pressTimer = view.setTimeout(release, settings.press_flash_ms);
  };
  const mouseLike = (type: string, from: { x: number; y: number }, detail: number, button: number) => new view.MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true, view, detail, button, buttons: 0,
    clientX: from.x, clientY: from.y, screenX: from.x, screenY: from.y,
  });

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !event.isPrimary || !(event.target instanceof view.Element)) return;
    const target = event.target;
    // Revealing pane controls on pointerdown can make WebKit drop the control's
    // synthesized click. A control acts first; its hover chain appears after.
    hoverAfterClick = target.closest(PRESSABLE) ? target : null;
    if (!hoverAfterClick) hold(target);
    flash(target);
    longPressed = false;
    swallowLift = false;
    down = { id: event.pointerId, x: event.clientX, y: event.clientY, target, at: event.timeStamp };
    view.clearTimeout(longTimer);
    if (target.closest(TEXT_FIELD)) return;
    longTimer = view.setTimeout(() => {
      const from = down;
      if (!from || nativeContextMenuAt >= from.at) return;
      longPressed = true;
      swallowClick = true;
      swallowLift = true;
      sentContextMenuAt = view.performance.now();
      from.target.dispatchEvent(mouseLike('contextmenu', from, 0, 2));
    }, settings.long_press_ms);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!down || event.pointerId !== down.id) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) <= settings.move_slop_px) return;
    // A finger that moves is scrolling or dragging, never pressing or pointing.
    view.clearTimeout(longTimer);
    release();
    down = null;
    hoverAfterClick = null;
    lastTap = null;
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!down || event.pointerId !== down.id) return;
    view.clearTimeout(longTimer);
    endFlash();
    const from = down;
    down = null;
    if (longPressed) {
      hoverAfterClick = null;
      lastTap = null;
      if (swallowLift) event.stopImmediatePropagation();
      return;
    }
    const tap = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    const previous = lastTap;
    lastTap = tap;
    if (!previous || tap.at - previous.at > settings.double_tap_ms) return;
    if (Math.hypot(tap.x - previous.x, tap.y - previous.y) > settings.double_tap_distance_px) return;
    lastTap = null;
    if (from.target.closest(TEXT_FIELD)) return;
    // The second tap's own click still arrives first, as a mouse's second click arrives before its dblclick.
    view.setTimeout(() => {
      if (view.performance.now() - sentDoubleClickAt < settings.double_tap_ms) return;
      sentDoubleClickAt = view.performance.now();
      from.target.dispatchEvent(mouseLike('dblclick', tap, 2, 0));
    }, 0);
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (!down || event.pointerId !== down.id) return;
    view.clearTimeout(longTimer);
    release();
    down = null;
    hoverAfterClick = null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (!swallowLift) return;
    swallowLift = false;
    // No compatibility mouseup or click follows a lift that ended a long press.
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onClick = (event: MouseEvent) => {
    if (swallowClick) {
      swallowClick = false;
      hoverAfterClick = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const target = hoverAfterClick;
    hoverAfterClick = null;
    if (target) view.setTimeout(() => { if (target.isConnected) hold(target); }, 0);
  };
  const onContextMenu = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    // The browser's own long-press menu event: the synthetic one is either already sent (stop this one) or not needed.
    if (view.performance.now() - sentContextMenuAt < settings.long_press_ms) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    nativeContextMenuAt = event.timeStamp;
    if (down) { longPressed = true; swallowClick = true; swallowLift = true; view.clearTimeout(longTimer); }
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (view.performance.now() - sentDoubleClickAt < settings.double_tap_ms * 2) { event.stopImmediatePropagation(); return; }
    sentDoubleClickAt = view.performance.now();
  };

  const capture = { capture: true } as const;
  const passive = { capture: true, passive: true } as const;
  view.addEventListener('pointerdown', onPointerDown, passive);
  view.addEventListener('pointermove', onPointerMove, passive);
  view.addEventListener('pointerup', onPointerUp, passive);
  view.addEventListener('pointercancel', onPointerCancel, passive);
  view.addEventListener('touchend', onTouchEnd, capture);
  view.addEventListener('click', onClick, capture);
  view.addEventListener('contextmenu', onContextMenu, capture);
  view.addEventListener('dblclick', onDoubleClick, capture);
  const teardown = () => {
    view.removeEventListener('pointerdown', onPointerDown, passive);
    view.removeEventListener('pointermove', onPointerMove, passive);
    view.removeEventListener('pointerup', onPointerUp, passive);
    view.removeEventListener('pointercancel', onPointerCancel, passive);
    view.removeEventListener('touchend', onTouchEnd, capture);
    view.removeEventListener('click', onClick, capture);
    view.removeEventListener('contextmenu', onContextMenu, capture);
    view.removeEventListener('dblclick', onDoubleClick, capture);
    view.clearTimeout(longTimer);
    view.clearTimeout(pressTimer);
    release();
    hoverAfterClick = null;
    for (const element of held) element.removeAttribute(TOUCH_HOVER_ATTRIBUTE);
    held = [];
    installed.delete(doc);
  };
  installed.set(doc, teardown);
  return teardown;
}

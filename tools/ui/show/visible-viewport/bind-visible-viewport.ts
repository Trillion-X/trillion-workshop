// parts/ui/show/visible-viewport/bind-visible-viewport.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Keeps an app shell sized to the part of the window a person can actually see.
// When a phone's keyboard opens, the browser shrinks the visible area and pans
// the page to show the field being typed in. A shell pinned to the window then
// slides under the status bar and the page underneath shows below it. This
// writes the visible area onto the document as CSS values the shell reads, and
// keeps the window itself from scrolling, so the shell shrinks above the
// keyboard instead of moving, and the field being typed in is scrolled into view
// inside its own scrolling area.
// A host can reserve a bottom band for controls outside the shell. Every shell
// and body-portalled frame then reads the same remaining area; reservations do
// not change whether the browser's actual visible area indicates a keyboard.
//
//   --visible-viewport-top     px from the window's top to the visible area's top
//   --visible-viewport-height  px of the visible area after host reservations
//   --visible-viewport-bottom  px below the shell (the keyboard, typing bar and reserved host controls)
//   --visible-viewport-keyboard  1 while a keyboard covers the bottom, else 0
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The window's own scroll stays at 0: only scrolling areas inside the shell
//    move, so nothing can drag the whole page off its background.
// 2. Values are written only when they change (one write per visual change).
// 3. Without visualViewport (an old browser), the window's height and resize
//    event supply the visible area, so host reservations still apply.
// 4. Installing twice on one document is a no-op returning the first teardown.
// 5. Each owner reserves its own bottom band; changing or releasing it changes
//    no other owner's band. A stale cleanup cannot clear a newer reservation.
// 6. Teardown cancels pending work and detaches reservation listeners; remaining
//    reservations are still owned by their callers and apply if rebound.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

const installed = new WeakMap<Document, () => void>();
type Reservation = { height: number; release: () => void };
type Reservations = { owners: Map<object, Reservation>; listeners: Set<() => void> };
const reservations = new WeakMap<Document, Reservations>();
const noReservation = () => {};
function reservationsFor(doc: Document): Reservations {
  let current = reservations.get(doc);
  if (!current) { current = { owners: new Map(), listeners: new Set() }; reservations.set(doc, current); }
  return current;
}

/**
 * Reserve a bottom band for this owner's controls. Independent bands add together; the same owner replaces its
 * prior height, and zero releases it. The returned cleanup releases only this reservation, never a newer one.
 * It is safe before binding; the shared viewport binder applies current reservations whenever it is installed.
 */
export function reserveVisibleViewportBottom(owner: object, height: number, doc: Document = document): () => void {
  const held = reservationsFor(doc);
  const pixels = Math.max(0, Number.isFinite(height) ? Math.ceil(height) : 0);
  const current = held.owners.get(owner);
  if (current?.height === pixels) return current.release;
  const changed = () => { for (const listener of held.listeners) listener(); };
  if (!pixels) {
    if (current) { held.owners.delete(owner); changed(); }
    return noReservation;
  }
  const reservation: Reservation = { height: pixels, release: () => {
    if (held.owners.get(owner) !== reservation) return;
    held.owners.delete(owner);
    changed();
  } };
  held.owners.set(owner, reservation);
  changed();
  return reservation.release;
}

// A visible area this much shorter than the window is a keyboard, not a browser bar sliding away.
const KEYBOARD_MIN_PX = 120;
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** Writes the visible area onto `doc` as CSS values and holds the window's scroll at 0; returns the teardown. */
export function bindVisibleViewport(doc: Document = document): () => void {
  const existing = installed.get(doc);
  if (existing) return existing;
  const view = doc.defaultView;
  const visual = view?.visualViewport;
  if (!view) return () => {};
  const held = reservationsFor(doc);
  const style = doc.documentElement.style;
  let written = '';
  let frame = 0;
  let focusFrame = 0;
  let disposed = false;
  let keyboardOn = false;

  const apply = () => {
    frame = 0;
    if (disposed) return;
    if (view.scrollX !== 0 || view.scrollY !== 0) view.scrollTo(0, 0);
    const actualHeight = visual?.height ?? view.innerHeight;
    const actualTop = visual?.offsetTop ?? 0;
    const top = Math.max(0, Math.round(actualTop));
    const visibleHeight = Math.max(0, Math.round(actualHeight));
    const reserved = Math.min(visibleHeight, [...held.owners.values()].reduce((sum, item) => sum + item.height, 0));
    const height = visibleHeight - reserved;
    const keyboard = visual && view.innerHeight - actualHeight > KEYBOARD_MIN_PX ? 1 : 0;
    keyboardOn = keyboard === 1;
    const bottom = (keyboard ? Math.max(0, Math.round(view.innerHeight - actualTop - actualHeight)) : 0) + reserved;
    const next = `${top}/${height}/${keyboard}/${bottom}`;
    if (next === written) return;
    const opened = keyboard && written.split('/')[2] !== '1';
    written = next;
    style.setProperty('--visible-viewport-top', `${top}px`);
    style.setProperty('--visible-viewport-height', `${height}px`);
    style.setProperty('--visible-viewport-keyboard', String(keyboard));
    style.setProperty('--visible-viewport-bottom', `${bottom}px`);
    // The field being typed in stays in view inside its own scrolling area once the shell has shrunk.
    if (opened) focusFrame = view.requestAnimationFrame(() => {
      focusFrame = 0;
      if (disposed || !keyboardOn) return;
      const active = doc.activeElement;
      if (active instanceof view.HTMLElement && active.closest(EDITABLE)) active.scrollIntoView({ block: 'nearest' });
    });
  };
  const schedule = () => { if (!frame) frame = view.requestAnimationFrame(apply); };

  visual?.addEventListener('resize', schedule);
  visual?.addEventListener('scroll', schedule);
  view.addEventListener('resize', schedule);
  view.addEventListener('scroll', schedule, { passive: true });
  held.listeners.add(schedule);
  apply();
  const teardown = () => {
    if (disposed) return;
    disposed = true;
    visual?.removeEventListener('resize', schedule);
    visual?.removeEventListener('scroll', schedule);
    view.removeEventListener('resize', schedule);
    view.removeEventListener('scroll', schedule);
    held.listeners.delete(schedule);
    if (frame) view.cancelAnimationFrame(frame);
    if (focusFrame) view.cancelAnimationFrame(focusFrame);
    for (const name of ['--visible-viewport-top', '--visible-viewport-height', '--visible-viewport-keyboard', '--visible-viewport-bottom']) style.removeProperty(name);
    installed.delete(doc);
  };
  installed.set(doc, teardown);
  return teardown;
}

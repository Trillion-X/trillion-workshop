// parts/ui/show/happened/observe-handling.ts
//
// PURPOSE
//   Says what the person's hands just did anywhere on the page, from one delegated listener each, so no control is
//   wired one by one: choosing a row in a menu or a list says `chosen`, picking something up to drag it says `lifted`,
//   letting it go over a place that takes it says `dropped`. Whoever answers (parts/feel plays a touch, a sound, a
//   motion) hears it on the happened channel with the element it happened to as `target`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only presses that pick something are said: a menu row, an option, a radio, a tab or a switch. A press that only
//      opens more choices (aria-haspopup) or asks not to be reported ([data-feedback=none]) is not.
//   2. A drop counts only where the page took it (a handler called preventDefault on the dragover before it, which is
//      what makes a browser deliver the drop); dropping onto nothing says nothing.
//   3. Listening is in the capture phase, so a control that stops its own event's spread is still heard.
//
// The extensive documentation in this codebase is a critical design feature. You are forbidden from simplifying
// or removing it.

import { sayHappened } from './happened';

const CHOICE_CONTROLS = '[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=radio],[role=tab],[role=switch]';

/** Starts listening under `root`; returns the call that stops it. */
export function observeHandling(root: Document | HTMLElement = document): () => void {
  const chose = (event: Event) => {
    const control = (event.target as Element | null)?.closest?.(CHOICE_CONTROLS);
    if (!control || control.getAttribute('aria-disabled') === 'true' || (control as HTMLButtonElement).disabled) return;
    if (control.hasAttribute('aria-haspopup') || control.closest('[data-feedback=none]')) return;
    sayHappened({ event_kind: 'chosen', target: control });
  };
  const lifted = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.closest?.('[data-feedback=none]')) return;
    sayHappened({ event_kind: 'lifted', target });
  };
  const dropped = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.closest?.('[data-feedback=none]')) return;
    sayHappened({ event_kind: 'dropped', target });
  };
  root.addEventListener('click', chose, true);
  root.addEventListener('dragstart', lifted, true);
  root.addEventListener('drop', dropped, true);
  return () => {
    root.removeEventListener('click', chose, true);
    root.removeEventListener('dragstart', lifted, true);
    root.removeEventListener('drop', dropped, true);
  };
}

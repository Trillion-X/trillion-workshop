// parts/ui/show/happened/happened.ts
//
// PURPOSE
//   The one channel a screen uses to say that something good happened for the person: a tour they finished, a
//   job a button finished, anything a part chooses to report. Whoever wants to answer it (parts/delight-moments plays
//   a small moment) listens on the window; the screen that says it never knows who listens, and nothing breaks when
//   nobody does.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An event is `{ event_kind, ...fields }`; the kind is a plain string the sayer chooses, never a list kept here.
//   2. Saying is fire-and-forget: no return value, no wait, no error when nobody listens.
//   3. No React and no DOM beyond the window event, so any part, test or worker-side check can import it.
//
// The extensive documentation in this codebase is a critical design feature. You are forbidden from simplifying
// or removing it.

/** The window event every happened event travels on. */
export const HAPPENED_EVENT = 'trillion:happened';

/** Something that happened: its kind and whatever fields describe it. */
export type Happened = { event_kind: string } & Record<string, unknown>;

/** Say that something happened. Does nothing outside a browser. */
export function sayHappened(detail: Happened): void {
  if (typeof window === 'undefined' || !detail?.event_kind) return;
  window.dispatchEvent(new CustomEvent<Happened>(HAPPENED_EVENT, { detail }));
}

/** Listen to every happened event; returns the call that stops listening. */
export function onHappened(listen: (detail: Happened) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<Happened>).detail;
    if (detail?.event_kind) listen(detail);
  };
  window.addEventListener(HAPPENED_EVENT, handler);
  return () => window.removeEventListener(HAPPENED_EVENT, handler);
}

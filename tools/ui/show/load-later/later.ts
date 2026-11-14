// packages/ui/show/load-later/later.ts
//
// Purpose: a component drawn only after a person acts (a layer's editor, a notification row, a side screen) need not
// travel with the first paint. `lazyPart(load, pick)` is that component fetched the first time it is drawn, so a page
// that never draws it never carries it; `later(load, pick)` is the same part inside its own boundary, for a caller that
// shows nothing while it arrives.
//
// Non-negotiable invariants:
// - The component takes the same props as the one `pick` takes from the module `load` imports.
// - `lazyPart` waits the way React.lazy does (it suspends to the nearest Suspense, whose fallback shows meanwhile);
//   `later` draws nothing while it waits, inside its own Suspense, so its caller needs no boundary.
// - With an explicit module picker, code is fetched once, on first draw, through the one loader (./load-code): a failed fetch is mended by itself
//   while the page is shown and online. Every later draw uses the same arrived component.
// - A fetch that could not be mended never breaks the screen around it: the part draws a small inline notice in its
//   place (words in ./load-words.json), with Try again when asking again can help and Reload page when only that can.
// - Every place the part is drawn shows the same state: Try again in one place asks once for all of them, an answer
//   from an ask that a newer ask replaced is let go of, and code that was unreached is asked again by itself when the
//   device comes back online.
import React from 'react';
import { ScreenState } from '../screen-state/ScreenState';
import { CodeLoadFailure, loadCode, whenOnline, type CodeLoadReason } from './load-code';
import words from './load-words.json';

/** The notice for code that did not arrive: `why` it did not, what the person does `then`, and the one action: Try
 *  again asks again in place, Reload page fetches the page anew. */
export function codeFailureNotice(reason: CodeLoadReason, retry: () => void): { why: string; then: string; action: { label: string; run: () => void } } {
  const said = words.reasons[reason];
  return { why: said.why, then: said.then, action: reason === 'unreached' ? { label: words.retry, run: retry } : { label: words.reload, run: () => location.reload() } };
}

type Arrival<P> = { status: 'waiting' } | { status: 'ready'; component: React.ComponentType<P> } | { status: 'failed'; reason: CodeLoadReason };

export function lazyPart<M, P extends object>(load: () => Promise<M>, pick: (module: M) => React.ComponentType<P>): React.FC<P> {
  let arrival: Arrival<P> = { status: 'waiting' };
  // Settles (never refuses) once the code arrived or could not be had; one ask at a time for every place it is drawn.
  let arriving: Promise<void> | null = null;
  let stopWaitingForOnline = () => {};
  const watchers = new Set<() => void>();
  const watch = (changed: () => void) => { watchers.add(changed); return () => { watchers.delete(changed); }; };
  const settle = (next: Arrival<P>) => { arrival = next; for (const changed of watchers) changed(); };
  const askAgain = () => { stopWaitingForOnline(); arriving = null; settle({ status: 'waiting' }); };
  const arrive = () => {
    if (arriving) return arriving;
    const asked: Promise<void> = loadCode(load, pick).then(
      component => { if (arriving === asked) settle({ status: 'ready', component }); },
      error => {
        if (arriving !== asked) return;
        const reason = error instanceof CodeLoadFailure ? error.reason : 'broken';
        settle({ status: 'failed', reason });
        if (reason === 'unreached') stopWaitingForOnline = whenOnline(askAgain);
      },
    );
    arriving = asked;
    return asked;
  };
  return function LazyPart(props: P) {
    const now = React.useSyncExternalStore(watch, () => arrival, () => arrival);
    if (now.status === 'ready') return React.createElement(now.component, props);
    if (now.status === 'failed') {
      const notice = codeFailureNotice(now.reason, askAgain);
      return React.createElement(ScreenState, { state: { status: 'unavailable', inline: true, title: notice.why, description: notice.then, retry: notice.action } });
    }
    React.use(arrive());
    return null;
  };
}

/** The original one-argument form already projects a component, so its existing lazy contract stays intact.
 *  Recovery needs the explicit module picker: a fresh module cannot safely reconstruct an arbitrary old projection. */
export function later<P extends object>(load: () => Promise<React.ComponentType<P>>): React.FC<P>;
export function later<M, P extends object>(load: () => Promise<M>, pick: (module: M) => React.ComponentType<P>): React.FC<P>;
export function later<M, P extends object>(load: () => Promise<M>, pick?: (module: M) => React.ComponentType<P>): React.FC<P> {
  if (!pick) {
    const Loaded = React.lazy(() => (load() as Promise<React.ComponentType<P>>).then(component => ({ default: component })));
    return props => React.createElement(React.Suspense, { fallback: null }, React.createElement(Loaded, props));
  }
  const Part = lazyPart(load, pick);
  return props => React.createElement(React.Suspense, { fallback: null }, React.createElement(Part, props));
}

// src/workspace/routed-open.mjs
//
// PURPOSE
//   The screens the page's address asks for, opened once the arrangement takes them. The address is resolved against the
//   screens offered at each try (addresses.mjs, the same resolution the Worker answers the address with), so a screen a
//   catalogue read offers later still opens at its address.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A request is asked again until the arrangement takes it (the open answers true): the wait is for the arrangement,
//      not a frame count, because the arrangement places a screen only once its lists are ready.
//   2. Stopping is decided by what the page knows (`settled`: the catalogue is complete) and by OPEN_WAIT_MS, never by a
//      screen's own name. Once settled, an address that opens nothing stops at once.
//   3. Requests open in the order the address names them, each one beside the ones before it.

import { screensAtAddress } from './addresses.mjs';

export const OPEN_RETRY_MS = 250;
export const OPEN_WAIT_MS = 120000;

/** The open requests the address names among the screens offered: the row itself, or the row with its query's input. */
export function routedRequests(offered, pathname, search = '') {
  return screensAtAddress(offered, pathname, search).map(({ row, input }) =>
    (input ? { id: row.id, surfaceInput: { ...(row.surface_input ?? {}), ...input } } : row));
}

/** Asks `open` for each routed request in turn until it is taken. `resolve` gives the requests the address names now;
 *  `settled` says the page has finished reading the screens offered. `open` answers true when the arrangement took it. */
export function openRouted(resolve, open, settled, { now = () => Date.now(), later = fn => setTimeout(fn, OPEN_RETRY_MS), waitMs = OPEN_WAIT_MS } = {}) {
  const started = now();
  const taken = new Set();
  const key = request => request.id ?? request;
  const tick = () => {
    const wanted = resolve().filter(request => !taken.has(key(request)));
    if (!wanted.length) {
      if (!settled() && now() - started < waitMs) later(tick);
      return;
    }
    if (open(wanted[0])) {
      taken.add(key(wanted[0]));
      later(tick);
      return;
    }
    if (now() - started >= waitMs) return;
    later(tick);
  };
  tick();
}

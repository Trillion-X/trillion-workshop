// extension/src/keep-awake.mjs
//
// PURPOSE
//   Keeps the background worker running while it does something the person started and may not wait to watch (a page
//   read on Trillion, a recording being saved). The browser stops an extension's worker after about thirty seconds
//   without an extension call; one small call every twenty seconds is an extension call.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every keepAwake() is ended by the function it returns, in a finally, so nothing keeps the worker up for nothing.

const EVERY_MS = 20_000;

/** Starts keeping the worker awake; call what it returns when the work is over. */
export function keepAwake() {
  const timer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, EVERY_MS);
  return () => clearInterval(timer);
}

// computer/deliver-until-acknowledged.mjs
//
// Purpose
//   Hands something to another process (an address to the Mac app, a message to a window that is still starting) and
//   does not assume the first hand-over landed: it asks the receiver whether it took it, and hands it over again
//   until it did, a bounded number of times. The first user is the web page to Mac app bridge
//   (computer/open-from-web.mjs).
//
// Non-negotiable invariants
//   1. Bounded: at most `most_attempts` hand-overs, `every_ms` apart; then it says plainly that it was not acknowledged
//      (acknowledged: false). It never loops without end and never reports a delivery it did not see acknowledged.
//   2. What counts as an acknowledgment is the caller's `acknowledged()`; this file knows neither the receiver nor the
//      thing handed over. A hand-over that throws counts as an attempt and is tried again, its error kept.
//   3. The wait is handed in so the whole of it is tested without waiting.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** { acknowledged, attempts, errors } after handing over with `send(attempt)` until `acknowledged()` is true. */
export async function deliverUntilAcknowledged({ send, acknowledged, every_ms, most_attempts, wait = ms => new Promise(done => setTimeout(done, ms)) }) {
  if (!Number.isInteger(most_attempts) || most_attempts < 1) throw new Error('most_attempts must be a whole number of at least 1');
  const errors = [];
  for (let attempt = 1; attempt <= most_attempts; attempt += 1) {
    try { await send(attempt); } catch (error) { errors.push(String(error?.message ?? error)); }
    await wait(every_ms);
    let taken = false;
    try { taken = (await acknowledged(attempt)) === true; } catch (error) { errors.push(String(error?.message ?? error)); }
    if (taken) return { acknowledged: true, attempts: attempt, errors };
  }
  return { acknowledged: false, attempts: most_attempts, errors };
}

// tools/records-door/read-data/settled-write.mjs
//
// The one wait until a write the door keeps is settled. The door answers `{ accepted, pending }` until the writer settles
// it, and the same request key then answers the outcome: a commit, or the writer's refusal, which `send` throws. Every
// caller that sends a write (the records client, `trillion op`) reads it to its outcome through here, so a write is never
// reported as kept while it is pending. A copy is packed into each caller that needs it (identity.mjs is packed the same way).
//
// A write is asked again every SETTLE_POLL_MS (the engine's renew_every_ms, the cadence of the account timer that settles its
// queue) until SETTLE_WAIT_MS (the engine's pending_writes.settle_max_age_ms: past it the writer completes the command as
// refused, so one ask after it is final). trillion-rust src/account/computers/settings.json.
export const SETTLE_POLL_MS = 3000;
export const SETTLE_WAIT_MS = 600_000;

const pause = ms => new Promise(done => setTimeout(done, ms));

/**
 * `send(key)` asks the door under `key` and returns its answer, or throws the writer's refusal. `pending(answer)` says the
 * answer is still kept; `expired()` is the error thrown when a write is still pending after SETTLE_WAIT_MS.
 */
export async function settledWrite(send, key, { sleep = pause, pending = answer => Boolean(answer?.pending), expired } = {}) {
  for (let waited = 0; ; waited += SETTLE_POLL_MS) {
    const answer = await send(key);
    if (!pending(answer)) return answer;
    if (waited >= SETTLE_WAIT_MS) throw expired();
    await sleep(SETTLE_POLL_MS);
  }
}

/**
 * packages/group/read-data/producer-timeout.ts
 *
 * Fail-closed timeout decision for a pending producer card — the pure predicates
 * the board's status poll composes (L063/L117/SP5). A producer that never writes
 * a result/error record would otherwise spin forever; once it has been pending
 * past its DATA limit it becomes a normal, removable error card.
 *
 * Non-negotiable invariant: the clock measures from the owner's HONEST dispatch
 * stamp — `extra.started_at` (epoch ms), the SAME single source the elapsed-time
 * display reads (item-renderers `useElapsedSeconds`). The poll historically read
 * a phantom `submittedAtMs` written nowhere, so the clock silently fell back to
 * "when this session first saw the card" for EVERY producer — a reopened orphan
 * got a fresh limit each time. These helpers make the submit stamp the truth and
 * keep the first-seen instant only as the fallback for stamp-less legacy orphans.
 *
 * Pure: no I/O, no clock, no state. The stateful first-seen Map lives in the
 * component; here we only decide, given numbers, so the decision is unit-provable.
 */

/** Default limit when the owner's producer descriptor sets none (epoch ms span). */
export const PRODUCER_TIMEOUT_MS_DEFAULT = 180_000;

/**
 * The instant a pending producer's fail-closed clock starts.
 *
 * @param submitStamp opaque `extra.started_at` — the owner's dispatch epoch ms
 *                    when a positive number, else anything (undefined/null/0/…).
 * @param firstSeenMs fallback the caller supplies (when THIS session first saw
 *                    the card) so pre-existing stamp-less orphans still resolve.
 */
export function producerStartMs(submitStamp: unknown, firstSeenMs: number): number {
  // Require a FINITE positive stamp: Infinity would pass `> 0` and make `now - Infinity` = -Infinity,
  // so the card never times out (fail-OPEN — a pending producer spins forever), the opposite of the
  // fail-closed intent. A non-finite/absent stamp falls back to the first-seen instant.
  return typeof submitStamp === 'number' && Number.isFinite(submitStamp) && submitStamp > 0 ? submitStamp : firstSeenMs;
}

/**
 * The DATA limit for a producer: the owner's descriptor value when a positive
 * number, else the default. `timeoutMs` rides opaque DATA, hence `unknown`.
 */
export function producerLimitMs(timeoutMs: unknown): number {
  // Finite positive only — Infinity would pass `> 0` and make the limit unbounded (fail-OPEN).
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PRODUCER_TIMEOUT_MS_DEFAULT;
}

/** Has a pending producer outlived its limit? (strict — exactly-at-limit is not yet out) */
export function producerTimedOut(startMs: number, nowMs: number, limitMs: number): boolean {
  return nowMs - startMs > limitMs;
}

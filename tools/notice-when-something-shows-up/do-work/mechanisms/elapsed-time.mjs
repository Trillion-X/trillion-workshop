#!/usr/bin/env node
/**
 * packages/notice-when-something-shows-up/do-work/mechanisms/elapsed-time.mjs
 *
 * Purpose
 *   One waiting mechanism: wait for a stretch of time to pass, and report that it
 *   passed. This is the smallest thing anyone can wait for, and it is the reason
 *   this package exists at all. The system already knew how to wait for this one
 *   thing and named the whole ability after it.
 *
 * Non-negotiable invariants
 *   - This leaf knows nothing about any other leaf. It imports none of them and
 *     names none of them.
 *   - It knows nothing about what will react to what it reports. It hands each
 *     transition to its caller and forgets it.
 *   - It never writes to the log, never opens a socket, and never dispatches.
 *   - It contributes only the fields named in describeMechanism().detail_fields.
 *
 * Key concepts
 *   describeMechanism()    the declared identity of this leaf plus the exact
 *                          payload field names it contributes.
 *   watchForTransitions()  the resident wait. Returns only when the caller's
 *                          abort signal fires.
 *
 * Security
 *   No credential, no network, no filesystem access. Hostile settings can only
 *   change how long this sleeps.
 */

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::elapsed-time";

/** The declared identity of this leaf and the payload fields it contributes.
 *
 *  The emitter compares mechanism_ref against the reference the descriptor row
 *  declared, so a DATA row can never silently point a capability name at a
 *  different leaf. */
export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["iso_time", "epoch_ms", "counter", "every"],
    conditions: ["became-reachable"],
  };
}

/** Read this leaf's settings from a descriptor row, with declared fallbacks.
 *
 *  Pure and exported so the fallbacks are a tested surface rather than a set of
 *  scattered expressions inside the loop. */
export function readSettings(settings = {}) {
  const intervalSeconds = Number(settings.interval_seconds);
  const every = typeof settings.every === "string" && settings.every.trim()
    ? settings.every.trim()
    : "interval";
  return {
    interval_seconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds
      : 60,
    every,
  };
}

/** Build the detail this leaf contributes for one elapsed stretch.
 *
 *  counter continues from the sequence the caller resumed out of the log, so a
 *  restart does not reset it and no file on disk is needed to remember it. */
export function buildDetail(settings, sequence, nowMs) {
  const resolved = readSettings(settings);
  const moment = new Date(nowMs);
  return {
    iso_time: moment.toISOString(),
    epoch_ms: moment.getTime(),
    counter: sequence,
    every: resolved.every,
  };
}

/**
 * Wait, repeatedly, and report each passage of the declared stretch.
 *
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers
 * @param {(transition:object)=>Promise<void>} handlers.onTransition called once per transition
 * @param {AbortSignal} handlers.signal stops the wait
 * @param {number} handlers.nextSequence the sequence the next transition will carry
 * @param {()=>number} [handlers.nowMs] injected clock, for tests
 * @param {(ms:number, signal:AbortSignal)=>Promise<void>} [handlers.sleep] injected sleep, for tests
 */
export async function watchForTransitions(settings, handlers) {
  const resolved = readSettings(settings);
  const nowMs = handlers.nowMs ?? (() => Date.now());
  const sleep = handlers.sleep ?? defaultSleep;
  const signal = handlers.signal;
  let sequence = Number.isInteger(handlers.nextSequence) ? handlers.nextSequence : 0;

  while (!signal?.aborted) {
    await sleep(resolved.interval_seconds * 1000, signal);
    if (signal?.aborted) return;
    await handlers.onTransition({
      condition: "became-reachable",
      observed_identity: {
        elapsed_seconds: resolved.interval_seconds,
        every: resolved.every,
      },
      detail: buildDetail(settings, sequence, nowMs()),
    });
    sequence += 1;
  }
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

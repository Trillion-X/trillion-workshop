// src/optional-read.mjs
//
// PURPOSE
//   A supporting read of a screen: one that can fail or stall without keeping the person's main screen in its loading
//   state. The account routes (src/account-routes.mjs) and the read tools of catalogue screens (src/screen-reads.mjs,
//   src/business-screen.mjs) use this one owner.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The read answers its own value, or `fallback` when it failed or did not answer within `waitMs`.
//   2. The timer is always cleared, so a fast read leaves nothing waiting.

export const OPTIONAL_READ_MS = 8000;

/** `read()`'s value, or `fallback` when it threw or took longer than `waitMs`. */
export async function optionalRead(read, fallback, waitMs = OPTIONAL_READ_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise(resolve => { timer = setTimeout(() => resolve(fallback), waitMs); }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// src/workspace/upload-progress.mjs
//
// HOW FAR ALONG AN UPLOAD IS, TOLD HONESTLY, AND WHEN IT TRIES AGAIN.
//
// Purpose: a bar that reaches the end when the last byte leaves is a lie while the server is still keeping the file. This keeps
// the end of the bar for the server's word that the file is stored, and decides, from the status alone, whether a failed send is
// worth trying again or is a refusal the person must read. The numbers are DATA (./upload-progress.json).
//
// Non-negotiable invariants:
//   1. Pure: the clock and the randomness are handed in; nothing here reads either.
//   2. Progress is never above `parts_share` while bytes are still being sent, never above 1 until the file is stored, and never
//      goes backwards for a given phase as its inputs grow.
//   3. A refusal (a status that is neither a server error nor named in `retry_also`) is never tried again.
//   4. Waits grow by doubling from `base_ms`, plus jitter in [0, jitter_ms), and an upload makes at most `attempts` tries.
//
// Key concepts: `partsProgress(bytes, size)`, `finishingProgress(elapsed_ms)`, `retryAfter({ attempt, status, jitter })`.
import rules from './upload-progress.json' with { type: 'json' };

/** How far along (0 to `parts_share`) when `bytes` of `size` have been sent. */
export function partsProgress(bytes, size, settings = rules) {
  if (!(size > 0)) return 0;
  return Math.min(settings.parts_share, Math.max(0, bytes / size) * settings.parts_share);
}

/** How far along (`parts_share` to 1) `elapsed_ms` after the last byte, while the server has not yet said stored. */
export function finishingProgress(elapsed_ms, settings = rules) {
  const through = Math.min(1, Math.max(0, elapsed_ms / settings.finish_ms));
  return settings.parts_share + (1 - settings.parts_share) * through * 0.99;
}

/**
 * Whether a send that failed is tried again, and after how long. `attempt` counts the tries made so far (1 after the first);
 * `status` is the HTTP status or null for a dropped connection; `jitter` is a number in [0, 1) from the caller.
 * -> { retry: false, refused: boolean } or { retry: true, wait_ms }
 */
export function retryAfter({ attempt, status, jitter = 0 }, settings = rules) {
  const worth = status === null || status === undefined || status >= settings.retry_from_status || settings.retry_also.includes(status);
  if (!worth) return { retry: false, refused: true };
  if (attempt >= settings.attempts) return { retry: false, refused: false };
  return { retry: true, wait_ms: settings.base_ms * 2 ** (attempt - 1) + Math.floor(jitter * settings.jitter_ms) };
}

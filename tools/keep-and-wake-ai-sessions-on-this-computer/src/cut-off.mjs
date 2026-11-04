// src/cut-off.mjs
//
// A call the platform cut off in passing: a deploy reset the Durable Object it was talking to, the object was
// overloaded, or the connection dropped (Cloudflare marks these retryable). A reset or dropped connection can use
// one fresh handle for repeatable work. An overloaded object must not get an immediate second request: return 503
// with Retry-After so its queue can drain.
// A call cut off this way that is not repeated here answers 503 with this Retry-After, at the Worker's one catch
// (somethingBroke in src/worker.mjs), so its sender sends it again.
import { failureOf } from './failure.mjs';

export const SEND_AGAIN_AFTER_SECONDS = failureOf({ failure_code: 'service-busy' }).retry_after_seconds;
// What the sender of such a call is told, over HTTP (somethingBroke) and as an MCP tool's answer (src/tools.mjs).
export const SEND_AGAIN_WORDS = 'The service was busy for a moment; send this again.';
// An object reset because it ran out of memory is marked retryable too, but it is never in passing: the same call
// needs the same memory, so repeating it resets the object again and drops every other call it was answering.
// A store still on another build than its caller (src/resource-host.mjs) is in passing too: the rollout reaches it shortly.
export const passing = error => ['service-interrupted', 'service-busy', 'peer-version-behind'].includes(failureOf(error).code);

/** Runs call(handle); a transient cut-off gets one fresh handle, while an overloaded object gets breathing room. */
export async function onceMore(call, handle, fresh) {
  try { return await call(handle); }
  catch (error) {
    if (!failureOf(error).fresh_handle_retry) throw error;
    console.error(JSON.stringify({ sent_again_after: String(error?.message ?? error).slice(0, 300) }));
    return call(fresh());
  }
}

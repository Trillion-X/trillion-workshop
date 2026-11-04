import { WorkFailure } from '../../shared-code/src/failure.mjs';

/** A call to another object, given up on after `ms` as the busy answer (a retry, never a failure): a call whose callee was reset
 * (a deploy, an eviction) is never answered, and the wake that awaited it held the object for the platform's whole wall limit
 * (240 to 900 s with no CPU on a follower, 2026-10-20 4:19 and 4:30 AM PDT). */
export function waitedFor(call, ms) {
  let timer;
  const gone = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new WorkFailure('service-busy', 'The call did not answer in time. Try again shortly.'), { timed_out: true })), ms); });
  return Promise.race([call, gone]).finally(() => clearTimeout(timer));
}

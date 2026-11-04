// One Space's read for a list, bounded in how long the list waits for it (src/space-list-read.json). A read that is not done in
// time is not dropped: it goes on in the background and the next list takes its answer, so a slow Space is shown late, never never.
import wait from '../../../space-list-read/src/space-list-read.json' with { type: 'json' };
import { spaceMountingRefusal } from '../../../tweak-live-controls/failure.mjs';

const reads = new Map();
const settle = (entry, state, value) => { entry.state = state; entry.value = value; entry.settledAt = Date.now(); };

/** The Space read under `key`: its finished answer when an earlier list left one, else the answer within `until` (a time in ms, so a
 *  list shares one wait among its Spaces; `stillAllowed()` says whether the person still has access, asked before a kept answer is shown), else the busy-Space refusal with when to ask again. `keep` receives the background read. */
export async function readSpaceForList(key, start, { until = Date.now() + wait.wait_ms, keep = null, stillAllowed = null } = {}) {
  for (const [old, entry] of reads) if (entry.state !== 'pending' && Date.now() - entry.settledAt > wait.keep_ms) reads.delete(old);
  let entry = reads.get(key);
  // A read an earlier list left, finished: shown only to a person who still has access to that Space now.
  if (entry && entry.state !== 'pending' && stillAllowed && !(await stillAllowed())) { reads.delete(key); entry = undefined; }
  if (!entry) {
    entry = { state: 'pending' };
    entry.promise = Promise.resolve().then(start).then(value => settle(entry, 'ok', value), error => settle(entry, 'failed', error));
    reads.set(key, entry);
    keep?.(entry.promise);
  }
  if (entry.state === 'pending') {
    let timer;
    await Promise.race([entry.promise, new Promise(done => { timer = setTimeout(done, Math.max(0, until - Date.now())); })]);
    clearTimeout(timer);
  }
  if (entry.state === 'pending') throw Object.assign(spaceMountingRefusal(), { retry_after_ms: wait.retry_after_ms });
  reads.delete(key);
  if (entry.state === 'failed') throw entry.value;
  return entry.value;
}

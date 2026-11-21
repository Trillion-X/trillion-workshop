// tools/social-posts/read-data/poll-until-finished.mjs
//
// Purpose: the one status loop a media container is waited on by. A media container an app creates (an Instagram reel or
// story, for example) is processed in the background: it is IN_PROGRESS until the app says FINISHED, and publishing it before
// that fails. This asks the caller's own status reader for the container's status_code every few seconds, up to maxTries
// asks, and answers FINISHED with the number of tries. It answers ERROR or EXPIRED at once, and the last status when the cap
// is reached. The reader decides how the status is read (a Composio proxy request, or a Graph request with a held token); this
// loop only waits, counts and reads the answer. It publishes nothing and changes nothing.
//
// Non-negotiable invariants:
// 1. A status other than FINISHED is never taken as finished: only FINISHED answers ok.
// 2. ERROR and EXPIRED stop the loop at once; they are never waited on.
// 3. The number of asks is bounded by maxTries, so a container that never finishes ends the loop with its last status.

const FAILED = ['ERROR', 'EXPIRED'];

/** Waits for a container's status. Answers {ok, status_code, tries}: ok only when the status is FINISHED. */
export async function pollUntilFinished({
  readStatus,
  maxTries,
  everySeconds,
  sleep = ms => new Promise(done => setTimeout(done, ms)),
}) {
  let last = null;
  for (let tries = 1; tries <= maxTries; tries += 1) {
    last = await readStatus();
    if (last === 'FINISHED') return { ok: true, status_code: last, tries };
    if (FAILED.includes(last)) return { ok: false, status_code: last, tries };
    if (tries < maxTries) await sleep(everySeconds * 1000);
  }
  return { ok: false, status_code: last, tries: maxTries };
}

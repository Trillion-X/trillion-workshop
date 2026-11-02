// tools/keep-the-last-good-answer/read-data/ask-and-keep.mjs
//
// tool:ask-a-web-address-or-give-the-last-answer: ask a web address for its answer; when it cannot answer, give back the
// last answer it gave, kept in the person's own records. The primitive is do-work/keep-the-last-good-answer.mjs; this file
// is the three collaborators it asks for (the live read, the kept read, the keep) bound to the web and to the records door
// (tools/records-door), and the words of the answer. Run through the door's `run-an-export.mjs`:
//
//   { id: "kept-answer:<key>", type: "kept-answer", value: { address, answer, kept_at } }
//
// One record per key, replaced by each good answer. A source that answers with nothing (an empty body) has not answered:
// it never replaces what was kept. A failure to keep never costs the caller the answer it already holds.
import { keepTheLastGoodAnswer, FROM_THE_SOURCE, FROM_WHAT_WAS_KEPT } from '../do-work/keep-the-last-good-answer.mjs';

export const KIND = 'kept-answer';
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MOST_BYTES = 256 * 1024;
const WAIT_SECONDS = 20;

const MOST_RETRY_AFTER_SECONDS = 24 * 60 * 60;

const reason = error => String(error?.message ?? error);

/**
 * How long a source that said "not now" (429 Too Many Requests, 503 Service Unavailable) asked to be left alone, from its
 * Retry-After header: whole seconds, or an HTTP date measured from `now`. Null when there is no such header or it cannot be
 * read; a date already past is 0; anything longer than a day is held to a day, so a wrong header cannot park a caller.
 */
export function retryAfterSeconds(header, now = new Date()) {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  if (value === '') return null;
  let seconds;
  if (/^\d+$/.test(value)) seconds = Number(value);
  else {
    const at = Date.parse(value);
    // An HTTP date starts with the day's name ("Sun, 01 Nov 2026 12:00:00 GMT"); other date shapes are not Retry-After.
    if (!Number.isFinite(at) || !/^[a-z]{3},? /i.test(value)) return null;
    seconds = Math.ceil((at - now.getTime()) / 1000);
  }
  return Math.min(Math.max(seconds, 0), MOST_RETRY_AFTER_SECONDS);
}

/** The answer's body: JSON when the source says it is JSON, text otherwise, and nothing for an empty body. */
async function bodyOf(reply, now) {
  if (!reply.ok) {
    const failure = new Error(`the address answered ${reply.status}`);
    if (reply.status === 429 || reply.status === 503) failure.retryAfterSeconds = retryAfterSeconds(reply.headers.get('retry-after'), now());
    throw failure;
  }
  const bytes = Buffer.from(await reply.arrayBuffer());
  if (bytes.length > MOST_BYTES) throw new Error(`the answer is larger than the ${MOST_BYTES} bytes this tool keeps`);
  const words = bytes.toString('utf8');
  if (words.trim() === '') return null;
  return /json/i.test(reply.headers.get('content-type') ?? '') ? JSON.parse(words) : words;
}

/** tool:ask-a-web-address-or-give-the-last-answer. */
export async function askAndKeep(input, { door, fetch: ask = globalThis.fetch, now = () => new Date() } = {}) {
  let address;
  try { address = new URL(String(input?.address)); } catch { address = null; }
  if (!address || !['http:', 'https:'].includes(address.protocol)) throw new Error('Give address: a web address that starts with http:// or https://.');
  if (typeof input.key !== 'string' || !KEY.test(input.key)) throw new Error('Give key: a short name for this answer, lower-case letters, digits and hyphens (such as "daily-prices"), so the last answer can be found again.');
  const seconds = input.wait_seconds === undefined ? WAIT_SECONDS : input.wait_seconds;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw new Error('wait_seconds is how long to wait for the address, 1 to 120.');

  const id = `${KIND}:${input.key}`;
  let keptAt = null;
  const answerNow = keepTheLastGoodAnswer({
    askTheSource: async () => bodyOf(await ask(address, { headers: { accept: 'application/json, text/*;q=0.9' }, signal: AbortSignal.timeout(seconds * 1000) }), now),
    readWhatWasKept: async () => {
      const held = await door.read(KIND, id);
      keptAt = held?.kept_at ?? null;
      return held?.answer ?? null;
    },
    keepThisAnswer: async answer => {
      const stamp = now().toISOString();
      // The same answer kept at the same moment is the same write.
      await door.write([{ id, type: KIND, value: { address: address.href, answer, kept_at: stamp } }], { key: `${KIND}:keep:${input.key}:${stamp}` });
      keptAt = stamp;
    },
  });

  const got = await answerNow();
  const sourceFailure = got.sourceFailure ? reason(got.sourceFailure) : null;
  const waitFor = Number.isInteger(got.sourceFailure?.retryAfterSeconds) ? got.sourceFailure.retryAfterSeconds : null;
  const askAgain = waitFor === null ? '' : ` It asked not to be asked again for ${waitFor} second${waitFor === 1 ? '' : 's'}.`;
  const said = got.origin === FROM_THE_SOURCE
    ? `The address answered${got.keepFailure ? `, but the answer could not be kept (${reason(got.keepFailure)})` : ' and the answer is kept'}.`
    : got.origin === FROM_WHAT_WAS_KEPT
      ? `The address could not answer (${sourceFailure ?? 'it answered with nothing'}), so this is the last answer it gave, kept ${keptAt}.`
      : `The address could not answer (${sourceFailure ?? 'it answered with nothing'}) and no answer was ever kept for ${input.key}.`;
  const saidAll = `${said}${askAgain}`;
  return {
    origin: got.origin,
    answer: got.value,
    kept_at: keptAt,
    source_failure: sourceFailure,
    keep_failure: got.keepFailure ? reason(got.keepFailure) : null,
    kept_failure: got.keptFailure ? reason(got.keptFailure) : null,
    retry_after_seconds: waitFor,
    said: saidAll,
  };
}

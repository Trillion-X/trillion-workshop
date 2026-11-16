// tools/keep-the-last-good-answer/read-data/ask-and-keep.mjs
//
// tool:ask-a-web-address-or-give-the-last-answer: ask a web address for its answer; when it cannot answer, give back the
// last answer it gave, which the caller hands in as `last_answer`. The tool keeps nothing: it returns the answer and, when
// the address answered, `to_keep`, the one record the person's own write can keep under the key
//
//   { id: "kept-answer:<key>", type: "kept-answer", value: { address, answer, kept_at } }
//
// The primitive is do-work/keep-the-last-good-answer.mjs; this file is the two collaborators it asks for (the live read
// bound to the web and the kept read bound to `last_answer`) and the words of the answer. A source that answers with
// nothing (an empty body) has not answered: it never replaces what the caller holds.
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

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The answer handed back as `last_answer`: the `to_keep` record this tool returned, or its value; null when none was given. */
function lastAnswerOf(input) {
  const held = input.last_answer;
  if (held === undefined || held === null) return null;
  const value = object(held) && object(held.value) ? held.value : held;
  if (!object(value) || !Object.hasOwn(value, 'answer')) throw new Error('last_answer is the record this tool gave back as to_keep, or its value: { answer, kept_at }.');
  return { answer: value.answer, keptAt: typeof value.kept_at === 'string' ? value.kept_at : null };
}

/** tool:ask-a-web-address-or-give-the-last-answer. */
export async function askAndKeep(input, { fetch: ask = globalThis.fetch, now = () => new Date() } = {}) {
  let address;
  try { address = new URL(String(input?.address)); } catch { address = null; }
  if (!address || !['http:', 'https:'].includes(address.protocol)) throw new Error('Give address: a web address that starts with http:// or https://.');
  if (typeof input.key !== 'string' || !KEY.test(input.key)) throw new Error('Give key: a short name for this answer, lower-case letters, digits and hyphens (such as "daily-prices"), so the last answer can be found again.');
  const seconds = input.wait_seconds === undefined ? WAIT_SECONDS : input.wait_seconds;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw new Error('wait_seconds is how long to wait for the address, 1 to 120.');
  const last = lastAnswerOf(input);

  let keptAt = null;
  const answerNow = keepTheLastGoodAnswer({
    askTheSource: async () => bodyOf(await ask(address, { headers: { accept: 'application/json, text/*;q=0.9' }, signal: AbortSignal.timeout(seconds * 1000) }), now),
    readWhatWasKept: async () => {
      keptAt = last?.keptAt ?? null;
      return last?.answer ?? null;
    },
  });

  const got = await answerNow();
  const sourceFailure = got.sourceFailure ? reason(got.sourceFailure) : null;
  const waitFor = Number.isInteger(got.sourceFailure?.retryAfterSeconds) ? got.sourceFailure.retryAfterSeconds : null;
  const askAgain = waitFor === null ? '' : ` It asked not to be asked again for ${waitFor} second${waitFor === 1 ? '' : 's'}.`;
  const answeredAt = got.origin === FROM_THE_SOURCE ? now().toISOString() : keptAt;
  const said = got.origin === FROM_THE_SOURCE
    ? 'The address answered; to_keep is the record that keeps the answer.'
    : got.origin === FROM_WHAT_WAS_KEPT
      ? `The address could not answer (${sourceFailure ?? 'it answered with nothing'}), so this is the last answer it gave, kept ${keptAt}.`
      : `The address could not answer (${sourceFailure ?? 'it answered with nothing'}) and no last_answer was given for ${input.key}.`;
  return {
    origin: got.origin,
    answer: got.value,
    kept_at: answeredAt,
    to_keep: got.origin === FROM_THE_SOURCE ? { id: `${KIND}:${input.key}`, type: KIND, value: { address: address.href, answer: got.value, kept_at: answeredAt } } : null,
    source_failure: sourceFailure,
    retry_after_seconds: waitFor,
    said: `${said}${askAgain}`,
  };
}

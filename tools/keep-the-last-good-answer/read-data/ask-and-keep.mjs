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

const reason = error => String(error?.message ?? error);

/** The answer's body: JSON when the source says it is JSON, text otherwise, and nothing for an empty body. */
async function bodyOf(reply) {
  if (!reply.ok) throw new Error(`the address answered ${reply.status}`);
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
    askTheSource: async () => bodyOf(await ask(address, { headers: { accept: 'application/json, text/*;q=0.9' }, signal: AbortSignal.timeout(seconds * 1000) })),
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
  const said = got.origin === FROM_THE_SOURCE
    ? `The address answered${got.keepFailure ? `, but the answer could not be kept (${reason(got.keepFailure)})` : ' and the answer is kept'}.`
    : got.origin === FROM_WHAT_WAS_KEPT
      ? `The address could not answer (${sourceFailure ?? 'it answered with nothing'}), so this is the last answer it gave, kept ${keptAt}.`
      : `The address could not answer (${sourceFailure ?? 'it answered with nothing'}) and no answer was ever kept for ${input.key}.`;
  return {
    origin: got.origin,
    answer: got.value,
    kept_at: keptAt,
    source_failure: sourceFailure,
    keep_failure: got.keepFailure ? reason(got.keepFailure) : null,
    kept_failure: got.keptFailure ? reason(got.keptFailure) : null,
    said,
  };
}

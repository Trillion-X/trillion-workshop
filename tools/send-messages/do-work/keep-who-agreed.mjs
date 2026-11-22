import { realpathSync } from 'node:fs';
// tools/send-messages/do-work/keep-who-agreed.mjs
//
// PURPOSE
//   Works out who agreed to get which emails. The seam between the email-course consent logic
//   (read-data/email-course.mjs, ported as it was) and the rows the caller hands in. The tools keep nothing: the
//   caller's AI reads the rows a run needs from the person's store and hands them in (`records`), the run reads and
//   changes them in memory (read-data/rows-handed-in.mjs), and its answer holds the rows to keep (`keep`). Sending a
//   lesson goes through the sending seam (send-a-message.mjs). Each tool row runs one export by name, from the bottom of this file.
//
// ROW KINDS (the caller reads them from the person's own records and hands them in)
//   email-course-subscription  one per subscriber and course: consent text and version, when and from where, the
//                              unsubscribe token, which lessons were sent
//   email-course-token         unsubscribe token -> subscription
//   email-course-interest      one per address and list: consent to one update if a course becomes available
//   contact-point              the address behind a subscriber; the subscription holds only the contact's id
//   email-lesson-due           a lesson that falls due at a time; sendDueEmailLessons delivers it and answers it removed
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is sent without a recorded consent; a lesson is sent only while the subscription is active, and once.
//   2. The provider's key is on a private descriptor (4 and up) and goes only to the sending seam's adapter. It is never
//      in a record, the request or the answer.
//   3. A change whose expected current row differs from the row handed in is refused (`ExpectedCurrentMismatch`) and
//      the winner is read back by the logic. Each row in `keep` carries `expected`, the row as it was handed in, so the
//      caller's own write is refused too if the row moved meanwhile.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicEmailCourse } from '../read-data/email-course.mjs';
import { rowsHandedIn } from '../read-data/rows-handed-in.mjs';
import { heldKeys, providerOf, sendMessage } from './send-a-message.mjs';

export const KEY_FIRST_DESCRIPTOR = 4;
const SUBSCRIPTION = 'email-course-subscription';
const INTEREST = 'email-course-interest';
const CONTACT = 'contact-point';
const DUE = 'email-lesson-due';
const MOST_DUE_PER_RUN = 50;

const digest = value => makeHashCodeHexFromBytes(new TextEncoder().encode(value)).slice('1f:'.length);
const hashOf = value => `1f:${digest(JSON.stringify(value))}`;
// The record kind an address belongs to: `email-course.subscription::<hash>` is an `email-course-subscription`.
const kindOfAddress = address => String(address).split('::')[0].replace('.', '-');

/** The provider's keys, read from descriptors 4 and up in the order its row lists them. */
export function heldKeysFrom(provider, read = descriptor => readFileSync(descriptor, 'utf8')) {
  return heldKeys({ ...provider, credentials: provider.credentials.map((item, index) => ({ ...item, fd: KEY_FIRST_DESCRIPTOR + index })) }, read);
}

/**
 * The sending seam as the logic asks for it: one lesson to one address through the named provider, answered with the
 * provider's receipt or an error that says why.
 */
export function sendThrough(providerId, credentials, options = {}, extra = {}) {
  return async request => {
    const answer = await sendMessage({ ...extra, ...request }, { providerId, credentials, ...options });
    const [first] = answer.sent;
    if (first?.error) throw new Error(first.error);
    return { ok: true, provider_message_id: first?.messageId };
  };
}

/** The logic's needs, from the rows handed in, the sending seam and the clock. */
export function makeCourse({ rows, send, now = () => new Date(), mintToken = () => randomBytes(32).toString('base64url') }) {
  async function readCurrent(address) {
    const payload = await rows.read(kindOfAddress(address), address);
    return payload === null ? { found: false } : { found: true, payload, content_hash: hashOf(payload) };
  }

  async function writeBatch(writes) {
    for (const write of writes) {
      const current = await readCurrent(write.address_label);
      if ((current.found ? current.content_hash : null) !== write.expected_current.content_hash) return { ok: false, error: 'ExpectedCurrentMismatch' };
    }
    const records = writes.map(write => ({ id: write.address_label, type: write.path_labels.at(-1), value: write.payload }));
    // The same batch is the same request, so a retry answers the receipt it already has.
    return rows.write(records);
  }

  async function invokeTarget(target, input) {
    if (target === 'contact-points.import') {
      const imported = [];
      for (const row of input.rows) {
        const id = `contact-point:${digest(row.email)}`;
        if ((await rows.read(CONTACT, id)) === null) {
          await rows.write([{ id, type: CONTACT, value: { email: row.email, source: input.source, source_ref: row.source_ref, at: row.at } }]);
        }
        imported.push({ account_id: id, status: 'imported' });
      }
      return { rows: imported };
    }
    if (target === 'contact-points.resolve') return { address: (await rows.read(CONTACT, input.account_id))?.email };
    if (target === 'lesson.schedule') {
      await rows.write([{ id: input.record_id, type: DUE, value: input }]);
      return { status: 'scheduled' };
    }
    if (target === 'send-email') return send(input);
    throw new Error(`Unexpected target ${target}`);
  }

  return createPublicEmailCourse({ readCurrent, writeBatch, invokeTarget, now, mintToken });
}

// The course for a run: sending only when the request names a provider (consent and unsubscribe never send).
function courseFor(input, rows, options = {}) {
  const provider = typeof input.provider === 'string' ? providerOf(input.provider) : null;
  const send = provider
    ? sendThrough(provider.id, heldKeysFrom(provider, options.read), options.send, typeof input.region === 'string' ? { region: input.region } : {})
    : async () => { throw new Error('No sending provider was named.'); };
  return makeCourse({ rows, send, ...(options.now ? { now: options.now } : {}) });
}

// One run over the rows handed in: the tool's answer, and the rows to keep as the run left them.
async function over(input, options, work) {
  const rows = rowsHandedIn(input?.records);
  const answer = await work(courseFor(input, rows, options), rows);
  return { ...answer, keep: rows.keep() };
}

/** tool:sign-someone-up-for-an-email-course: works out the consent, the later lessons to queue and sends the first. */
export const enrollInEmailCourse = (input, options) => over(input, options, course => course.enroll({ email: input.email, consent: input.consent, course: input.course, source: input.source }));

/** tool:save-interest-in-an-email-update: works out consent to one update. Sends nothing. */
export const saveEmailInterest = (input, options) => over({ ...input, provider: undefined }, options, course => course.captureInterest({ email: input.email, consent: input.consent, course: input.course, source: input.source }));

/** tool:stop-an-email-course: the unsubscribe link's token ends the subscription; nothing further is sent. */
export const unsubscribeFromEmailCourse = (input, options) => over({ ...input, provider: undefined }, options, course => course.unsubscribe(input.token));

/**
 * tool:send-due-email-lessons: delivers each lesson that has fallen due, once, and answers its due row removed. A
 * failed send has already scheduled its own later retry (up to three), so its row is removed too.
 */
export function sendDueEmailLessons(input, options = {}) {
  const now = options.now ?? (() => new Date());
  return over(input, options, async (course, rows) => {
    const most = Math.min(MOST_DUE_PER_RUN, Math.max(1, Number(input.limit) || MOST_DUE_PER_RUN));
    const due = [];
    for await (const record of rows.list({ type: DUE })) if (Date.parse(record.value.due_at) <= now().getTime()) due.push(record);
    due.sort((a, b) => Date.parse(a.value.due_at) - Date.parse(b.value.due_at));
    const results = [];
    for (const record of due.slice(0, most)) {
      const { token, lesson_index: lessonIndex, retry } = record.value;
      try {
        const outcome = await course.deliver({ token, lesson_index: lessonIndex, retry });
        results.push({ lesson_index: lessonIndex, owner_ref: record.value.owner_ref, status: outcome.status });
      } catch (error) {
        results.push({ lesson_index: lessonIndex, owner_ref: record.value.owner_ref, status: 'failed', why: error.message });
      }
      await rows.write([{ id: record.id, type: DUE, value: null }]);
    }
    const sent = results.filter(item => item.status === 'sent').length;
    const failed = results.filter(item => item.status === 'failed').length;
    return { results, said: `${due.length} ${due.length === 1 ? 'lesson' : 'lessons'} due; ${sent} sent, ${failed} failed${due.length > most ? `, ${due.length - most} left for the next run` : ''}.` };
  });
}

/**
 * tool:who-agreed-to-get-which-emails: everyone with a consent in the rows handed in: who, for which list, since when,
 * in what words they agreed, and whether they still do. `agreed` is the addresses to send to now.
 */
export async function whoAgreedToGetEmails(input) {
  const rows = rowsHandedIn(input?.records);
  const people = [];
  for await (const record of rows.list({ type: SUBSCRIPTION })) {
    const state = record.value;
    if (input.list && state.course?.id !== input.list) continue;
    const email = (await rows.read(CONTACT, state.account_id))?.email ?? null;
    people.push({ email, list: state.course?.id, kind: 'course', status: state.status, consented_at: state.consented_at, consent_text: state.consent_text, consent_version: state.consent_version, source: state.source, lessons_sent: Object.keys(state.sent ?? {}).length });
  }
  for await (const record of rows.list({ type: INTEREST })) {
    const state = record.value;
    if (input.list && state.course_id !== input.list) continue;
    people.push({ email: state.email, list: state.course_id, kind: 'update', status: state.status, consented_at: state.consented_at, consent_text: state.consent_text, consent_version: state.consent_version, source: state.source });
  }
  const wanted = input.status ? people.filter(item => item.status === input.status) : people;
  const agreed = [...new Set(people.filter(item => item.email && (item.status === 'active' || item.status === 'pending')).map(item => item.email))];
  return { people: wanted, agreed, said: `${wanted.length} ${wanted.length === 1 ? 'person' : 'people'}${input.status ? ` ${input.status}` : ''}; ${agreed.length} can be sent to now.` };
}

// The command each tool row runs: node keep-who-agreed.mjs <export name> < input.json, answering { result } or { error }.
const EXPORTS = { enrollInEmailCourse, saveEmailInterest, unsubscribeFromEmailCourse, sendDueEmailLessons, whoAgreedToGetEmails };
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const run = EXPORTS[process.argv[2]];
    if (!run) throw new Error(`usage: keep-who-agreed.mjs <${Object.keys(EXPORTS).join(' | ')}> < input.json`);
    console.log(JSON.stringify({ result: await run(JSON.parse(readFileSync(0, 'utf8') || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}

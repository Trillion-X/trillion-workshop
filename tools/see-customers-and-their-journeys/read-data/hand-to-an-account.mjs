// Source-first port; configuration is supplied by authenticated list rows.
import { makeHashCodeHexFromBytes } from 'trillion-workshop/tools/content-identity/read-data/identity.mjs';

export function createHandToAccount(reports, { reportKindOf }) {
// src/hand-to-an-account.mjs
//
// NO PRIOR: searched bitfield-packages/packages for "feedback", "bug report", "hand to account", "send to makers" and
// "inbox". packages/bug-reports keeps a three-field bug report through a workflow action; it is not ported, because
// problems, feedback and ideas are one thing here and land as one row. The landing reuses what Trillion already has: a
// list in the receiving account, a file in its Files and a notice, the same way an application reaches a program's host.
//
// Purpose
//   Handing what a person picked in their tray (things, a note, the screen they were on, a picture of it, their
//   browser) to another account, as one row of a list there and a notice to that account. Which account, which list
//   and which notice are the tool row's own DATA (records/workshop-tray-tool-records.json, invoke
//   { kind: "account-action", action: "hand-to-an-account", to: { setting }, list, notice, picture_folder, said }):
//   "Tell the people who make Trillion" is one such row, aimed at the operator account; another destination is another row.
//   Any other words the row's input_schema takes (what the note is: a bug report, feedback, an idea) travel as `more`
//   and land in the list's field of the same id; a field the row's list gained is added to a list already made. A row's
//   `hand_off` ({ job, said }, filled from the note) also hands each note to the receiving account's AIs as work.
//
// This module decides values only. It keeps nothing and reads nothing: the receiving account's report row is kept by
// workflow:keep-reports-once-per-submission (the person's own store), and the sender's picture, identity and delivery
// are given to it by its caller. planHandOff and finishHandOff say what must be kept, in which order; the caller keeps it.
//
// Non-negotiable invariants
//   1. Nothing here names an account, a list, a field or a notice: all of it comes from the tool row.
//   2. The receiving account acts only on a row the platform ships: a hand-off whose invoke is not one of the shipped
//      rows' invokes is refused, so a tool someone saves cannot write into another account's lists.
//   3. The account is named by a setting ending in _ACCOUNT_ID; any other setting is refused.
//   4. The sender's own words, things and picture are all that travel; the picture's bytes are read by the sender's
//      caller and kept by the receiver's caller, so the receiver never reads the sender's store.
//   5. The list is made in the receiving account the first time, from the row's list; later hand-offs add rows to it.
//   6. A managed task and its authenticated sending account name one submission across retries. The row's DATA
//      `trace` maps receipt facts to list fields. A conflicting replay is refused; a retry restores missing joins
//      without rewriting the report, review or outcome. Being received or handed to work never means fixed.
//   7. A receiver keeps its own canonical source and work references. A sender's execution reference is only an
//      attributed reference, not a grant to read the sender's private task, conversation or evidence.
//   8. `sent_by` (ai or screen), `harness` (the AI app) and the person's `their_words` come only from the calling code
//      (the sidebar executor sends none, so it is `screen`; src/tell-us.mjs `tellTheMakers` sends `ai`), never from the input an AI or
//      person typed. `their_words` travel only when the sender's `content` choice is on, and an AI report is sent at all
//      only when its `activity` choice is on.
//   9. An account handing to itself (the operator reporting to itself) keeps the row directly, never by calling its own delivery.
//  10. A row whose invoke names a `journey` also tells the sender's journey a report happened, kept only as that account allows.
//

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const ACTION = 'hand-to-an-account';
const LIMITS = { things: 50, label: 200, note: 8000, address: 2000, browser: 400, picture_bytes: 8 * 1024 * 1024, more: 20, more_text: 2000, harness: reports.limits.harness, their_words: reports.limits.their_words };
// The inputs every hand-off reads by name; any other words in the input travel as `more`. `sent_by`, `harness` and
// `their_words` are never read from the input: only the sending side's own code sets them (see the action below).
const NAMED = new Set(['things', 'note', 'where', 'screen', 'browser', 'picture', 'sent_by', 'harness', 'their_words']);
const SETTING = /^[A-Z][A-Z0-9_]*_ACCOUNT_ID$/;
const hash = value => makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(value))).slice(3);
const reference = value => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 8192) throw new HandOffError('A source reference must be text of at most 8192 characters; it was not truncated.');
  return value;
};
const traceValues = (invoke, values) => Object.fromEntries(Object.entries(values)
  .filter(([key, value]) => typeof invoke.trace?.[key] === 'string' && value != null)
  .map(([key, value]) => [invoke.trace[key], value]));

class HandOffError extends Error {}

const sameInvoke = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The things as plain lines a person reads in one cell: "Row: Launch plan (on Decisions, in Studio team)". */
function thingLines(things) {
  return things.map(thing => {
    const where = [thing.screen_label ? `on ${thing.screen_label}` : null, thing.place ? `in ${thing.place}` : null].filter(Boolean).join(', ');
    return `${thing.kind}: ${thing.label}${where ? ` (${where})` : ''}`;
  }).join('\n');
}

/** What the sender's tool input says, checked and cut to size. */
function readHandOff(input) {
  if (!object(input)) throw new HandOffError('Send { things, note } with what you picked.');
  const things = Array.isArray(input.things) ? input.things.filter(object).slice(0, LIMITS.things).map(thing => ({
    kind: text(thing.kind, 60) || 'thing',
    label: text(thing.label, LIMITS.label) || 'Untitled',
    ...(text(thing.screen_label, 120) ? { screen_label: text(thing.screen_label, 120) } : {}),
    ...(text(thing.place, 120) ? { place: text(thing.place, 120) } : {}),
    ...(text(thing.address, LIMITS.address) ? { address: text(thing.address, LIMITS.address) } : {}),
    ...(reference(thing.id) ? { id: reference(thing.id) } : {}),
  })) : [];
  const note = text(input.note, LIMITS.note);
  if (!things.length && !note) throw new HandOffError('Pick something or write a note first.');
  // Any other words the tool's input_schema takes (what the note is: a bug report, feedback, an idea) travel as they
  // are; the receiving list keeps those its fields name, so a new detail is one input and one field, never code here.
  const more = Object.fromEntries(Object.entries(input).filter(([key, value]) => !NAMED.has(key) && typeof value === 'string' && value.trim()).slice(0, LIMITS.more).map(([key, value]) => [key, text(value, LIMITS.more_text)]));
  return { things, note, where: text(input.where, 200), screen: text(input.screen, LIMITS.address), browser: text(input.browser, LIMITS.browser), picture: text(input.picture, 200), more };
}

/**
 * The account action of a sender's side. Its effects are the caller's, given by name:
 *   recipients     the account each setting names (from the row's settings)
 *   identity       { ref, user(), name() } of the sending account
 *   readPicture    (name) → the sender's file: { name, byte_length, media_type, stream() }
 *   receive        (message) → the receiving account's result, when the receiver is this account
 *   deliver        (account, message) → the receiving account's result, when it is another account
 *   recordJourney  (account, events) → the sender's journey keeps the events, as that account allows
 *   reportKindOf   the report kind a words-kind is told as (from the row's kinds)
 */
const handToAccountActions = ({ recipients, identity, readPicture, receive, deliver, recordJourney }) => ({
  // `sentBy` (`ai` or `screen`), `harness` (the AI app) and `theirWords` come only from the caller's own code, never from
  // the input a person or an AI typed, so a sidebar report cannot claim to be an AI's and the reverse.
  [ACTION]: async (input, invocation, { task = null, sentBy = null, harness = '', theirWords = '' } = {}) => {
    const setting = invocation?.to?.setting;
    if (typeof setting !== 'string' || !SETTING.test(setting)) throw new HandOffError('This tool does not name an account to send to.');
    const account = recipients[setting];
    if (!account) throw new HandOffError('There is nowhere to send this yet.');
    const handOff = readHandOff(input);
    let picture = null;
    if (handOff.picture) {
      const file = await readPicture(handOff.picture);
      if (file.byte_length > LIMITS.picture_bytes) throw new HandOffError('The picture is too large to send; take a smaller one.');
      picture = { name: file.name.split('/').pop(), media_type: file.media_type ?? 'image/png', bytes: new Uint8Array(await new Response(file.stream()).arrayBuffer()) };
    }
    const from = { ref: identity.ref, user: await identity.user(), name: (await identity.name()) ?? null };
    // Only the authenticated executor supplies task identity and capture origin. User input `more` cannot turn
    // a fixture into a real report or supply a different actor. No private transcript or authorization travels.
    const capture = {
      submission_id: reference(task?.task_id),
      execution_ref: reference(task?.execution_ref),
      origin: ['real', 'synthetic', 'unknown'].includes(task?.execution?.origin) ? task.execution.origin : 'unknown',
    };
    const sent = { sent_by: reports.sent_by.includes(sentBy) ? sentBy : reports.default_sent_by, harness: text(harness, LIMITS.harness), their_words: text(theirWords, LIMITS.their_words) };
    const message = { invoke: invocation, from, ...handOff, ...sent, picture, capture, at: task?.started_at ?? task?.execution?.captured_at ?? new Date().toISOString() };
    const kept = account === from.user ? await receive(message) : await deliver(account, message);
    // A row's `journey` (DATA) is the journey kind this hand-off is told as; kept if the sender's account shares its activity.
    if (typeof invocation.journey === 'string') {
      await recordJourney(from.user, [{ kind: invocation.journey, facts: { kind: reportKindOf(handOff.more.kind), sent_by: sent.sent_by, harness: sent.harness }, words: { where: handOff.where, note: handOff.note, their_words: sent.their_words } }]);
    }
    return { ...kept, said: fill(invocation.said, {}) || 'Sent.' };
  },
});

/** The fields a report row holds that the Customers screen reads (the operator's list, read by the caller). */
const REPORT_FIELDS = ['note', 'kind', 'from', 'account', 'where', 'screen', 'sent_at', 'sent_by', 'harness', 'their_words', 'origin', 'intake_state', 'work_ref'];

/** Where one hand-off's row is kept, from the message alone: the caller reads the row kept there (its `previous`) before it plans. */
function handOffAddress(invoke, { from, capture, at }) {
  const submission = reference(capture?.submission_id);
  const rowId = submission ? `submission-${hash([from.ref, submission])}` : `${at.replace(/[:.]/g, '-')}-${String(from?.ref ?? '').slice(0, 12)}`;
  return { list_id: invoke.list.id, row_id: rowId, source_ref: `record:${invoke.list.row_type ?? invoke.list.id}:${rowId}` };
}

/**
 * What the receiving account must keep for one hand-off, as values, in the order the caller keeps them:
 *   1. list: the list to create (`create`) or the fields to add to the kept list (`add_fields`), or null when nothing changes;
 *   2. picture: the file to keep under `picture.name`, when the row names one;
 *   3. row: the first row, kept only if nothing is kept for this submission yet (`previous` is null);
 *   4. notice: told after the row is kept (its key makes a repeat a no-op);
 *   5. work: the hand-off to the receiving account's AIs, when the row's invoke asks for one and none is recorded yet.
 * Pass what the work step returned to finishHandOff, which gives the joins still missing and the result.
 * `keptList` is the receiving list as it is kept (null when none); `previous` is the row kept for this submission (null when none).
 */
function planHandOff(tools, { keptList, previous, message }) {
  const { invoke, from, things, note, where, screen, browser, picture, more, capture, at, sent_by, harness, their_words } = message;
  if (!object(invoke) || invoke.action !== ACTION || !tools.some(tool => sameInvoke(tool.invoke, invoke))) throw new HandOffError('This hand-off is not one the platform sends.');
  const { list, notice } = invoke;
  const addFields = keptList ? list.fields.filter(field => !(keptList.fields ?? []).some(have => have.id === field.id)) : null;
  const listChange = !keptList ? { create: list } : (addFields.length ? { add_fields: [...keptList.fields, ...addFields] } : null);
  const submission = reference(capture?.submission_id);
  if (submission && !from?.ref) throw new HandOffError('A managed submission needs its authenticated sending account.');
  const { row_id: rowId, source_ref: sourceRef } = handOffAddress(invoke, { from, capture, at });
  const fingerprint = hash({ things, note, where, screen, browser, more: object(more) ? Object.fromEntries(Object.entries(more).sort(([a], [b]) => a.localeCompare(b))) : {},
    picture: picture?.bytes?.byteLength ? { name: picture.name, media_type: picture.media_type, bytes: makeHashCodeHexFromBytes(picture.bytes).slice(3) } : null });
  const fingerprintField = invoke.trace?.input_fingerprint;
  if (previous && fingerprintField && previous[fingerprintField] && previous[fingerprintField] !== fingerprint) throw new HandOffError('This submission already holds a different report. Use a new task for a new report; the original was kept.');
  const receivedAt = previous?.sent_at ?? at;
  const stamp = receivedAt.replace(/[:.]/g, '-');
  const pictureNamed = !previous?.picture && picture?.bytes?.byteLength ? `${invoke.picture_folder ?? '/Pictures'}/${submission ? rowId : stamp} ${picture.name}` : null;
  const pictureName = previous?.picture ?? pictureNamed;
  const who = previous?.from || from?.name || (from?.user ? `A member (${String(from.user).slice(0, 8)})` : 'A member');
  const origin = previous?.[invoke.trace?.origin] ?? (['real', 'synthetic', 'unknown'].includes(capture?.origin) ? capture.origin : 'unknown');
  const receipt = { source_ref: sourceRef, execution_ref: reference(capture?.execution_ref), origin, input_fingerprint: fingerprint, intake_state: 'received' };
  const protectedFields = new Set(Object.values(invoke.trace ?? {}));
  const extra = object(more) ? Object.fromEntries(Object.entries(more).filter(([key]) => !protectedFields.has(key))) : {};
  const sent = { sent_by: reports.sent_by.includes(sent_by) ? sent_by : reports.default_sent_by, harness: text(harness, LIMITS.harness), their_words: text(their_words, LIMITS.their_words) };
  const values = { ...extra, from: who, account: from?.user ?? '', note, where, things: thingLines(things), screen, browser, ...sent, sent_at: receivedAt, ...(pictureName ? { picture: pictureName } : {}), ...traceValues(invoke, receipt) };
  const fields = new Set(list.fields.map(field => field.id));
  const current = previous ?? Object.fromEntries(Object.entries(values).filter(([key, value]) => fields.has(key) && value));
  const words = { ...values, from: who, count: things.length, note: note || thingLines(things), list: list.label, row: rowId };
  const key = `${ACTION}:${list.id}:${rowId}`;
  return {
    list_id: list.id,
    fields,
    row_id: rowId,
    source_ref: sourceRef,
    origin,
    replay_coverage: submission ? 'task_and_account' : 'arrival_time_only',
    list: listChange,
    picture: pictureNamed ? { name: pictureNamed, media_type: picture.media_type, bytes: picture.bytes } : null,
    row: previous ? null : { id: rowId, values: current },
    current,
    notice: { kind: notice.kind, title: fill(notice.title, words), body: fill(notice.body, words), key, refs: { list: list.id, row: rowId } },
    work_ref: invoke.trace?.work_ref ? current[invoke.trace.work_ref] ?? null : null,
    work: object(invoke.hand_off) && !(invoke.trace?.work_ref ? current[invoke.trace.work_ref] : null)
      ? { job: fill(invoke.hand_off.job, words), said: fill(invoke.hand_off.said, words), from_agent: 'trillion-members', request_key: key, input: { list: list.id, row: rowId, source_ref: sourceRef, origin } }
      : null,
    trace: invoke.trace ?? {},
    receipt,
    actor: { by: 'trillion', from: from?.ref ?? null, ...(submission ? { task_id: submission } : {}) },
    picture_name: pictureName,
  };
}

/**
 * After the caller has kept the plan's list, picture, row and notice, and (when the plan asked for work) has the
 * work's reference: the joins still missing on the kept row, and the result. A replay attaches only missing joins;
 * review fields, the original report and later outcome evidence stay as they are.
 */
function finishHandOff(plan, { workRef = null } = {}) {
  if (plan.work && !workRef) throw new HandOffError('The report was kept, but no work reference was returned. Retry this same submission to recover.');
  const ref = plan.work_ref ?? workRef;
  const joined = traceValues({ trace: plan.trace }, { ...plan.receipt, ...(ref ? { work_ref: ref, intake_state: 'work_created' } : {}) });
  const missing = Object.fromEntries(Object.entries(joined).filter(([field, value]) => plan.fields.has(field) && (plan.current[field] == null || (field === plan.trace.intake_state && plan.current[field] === 'received' && value === 'work_created'))));
  return {
    joins: Object.keys(missing).length ? { id: plan.row_id, values: missing, actor: plan.actor } : null,
    result: { kept: true, list_id: plan.list_id, row_id: plan.row_id, source_ref: plan.source_ref, origin: plan.origin,
      intake_state: ref ? 'work_created' : 'received', replay_coverage: plan.replay_coverage,
      ...(ref ? { handoff_id: ref, work_ref: ref } : {}) },
  };
}

return { HandOffError, thingLines, readHandOff, handToAccountActions, handOffAddress, planHandOff, finishHandOff, REPORT_FIELDS };
}

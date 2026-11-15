// Source-first port; configuration is supplied by authenticated list rows.
import { listsOverDoor } from 'trillion-workshop/tools/records-door/read-data/lists-door.mjs';
import { makeHashCodeHexFromBytes } from 'trillion-workshop/tools/content-identity/read-data/identity.mjs';

export function createHandToAccount(reports, { recordJourney, reportKindOf }) {
// src/hand-to-an-account.mjs
//
// NO PRIOR: searched bitfield-packages/packages for "feedback", "bug report", "hand to account", "send to makers" and
// "inbox". packages/bug-reports keeps a three-field bug report through a workflow action; it is not ported, because
// problems, feedback and ideas are one thing here and land as one row. The landing reuses what Trillion already has: a
// list in the receiving account (src/lists.mjs), a file in its Files (src/namespace.mjs keepStream) and a notice
// (src/tell-the-person.mjs), the same way an application reaches a program's host (src/client-program.mjs).
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
// Non-negotiable invariants
//   1. Nothing here names an account, a list, a field or a notice: all of it comes from the tool row.
//   2. The receiving account acts only on a row Trillion ships (loadWorkshopRows): a hand-off whose invoke is not one of
//      the shipped rows' invokes is refused, so a tool someone saves cannot write into another account's lists.
//   3. The account is named by a Worker setting ending in _ACCOUNT_ID; any other setting is refused.
//   4. The sender's own words, things and picture are all that travel; the picture's bytes are read from the sender's
//      own Files and kept in the receiver's Files, so the receiver never reads the sender's store.
//   5. The list is made in the receiving account the first time, from the row's list; later hand-offs add rows to it.
//   6. A managed task and its authenticated sending account name one submission across retries. The row's DATA
//      `trace` maps receipt facts to list fields. A conflicting replay is refused; a retry restores missing joins
//      without rewriting the report, review or outcome. Being received or handed to work never means fixed.
//   7. A receiver keeps its own canonical source and work references. A sender's execution reference is only an
//      attributed reference, not a grant to read the sender's private task, conversation or evidence.
//   8. `sent_by` (ai or screen), `harness` (the AI app) and the person's `their_words` come only from the calling code
//      (the sidebar executor sends none, so it is `screen`; src/tell-us.mjs `tellTheMakers` sends `ai`), never from the input an AI or
//      person typed. `their_words` travel only when the sender's `content` choice is on (src/hq-sharing.mjs), and an AI
//      report is sent at all only when its `activity` choice is on.
//   9. An account handing to itself (the operator reporting to HQ) keeps the row directly, never by calling its own stub.
//  10. A row whose invoke names a `journey` also tells the sender's journey a report happened (src/journey.mjs), kept
//      only as that account allows.
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

/** The account action of a sender's store: hand the tray to the account its row names. */
const handToAccountActions = store => ({
  // `sentBy` (`ai` or `screen`), `harness` (the AI app) and `theirWords` come only from the caller's own code, never from
  // the input a person or an AI typed, so a sidebar report cannot claim to be an AI's and the reverse.
  [ACTION]: async (input, invocation, { task = null, sentBy = null, harness = '', theirWords = '' } = {}) => {
    const setting = invocation?.to?.setting;
    if (typeof setting !== 'string' || !SETTING.test(setting)) throw new HandOffError('This tool does not name an account to send to.');
    const account = store.recipients[setting];
    if (!account) throw new HandOffError('There is nowhere to send this yet.');
    const handOff = readHandOff(input);
    let picture = null;
    if (handOff.picture) {
      const file = await store.openFile(handOff.picture);
      if (file.byte_length > LIMITS.picture_bytes) throw new HandOffError('The picture is too large to send; take a smaller one.');
      picture = { name: file.name.split('/').pop(), media_type: file.media_type ?? 'image/png', bytes: new Uint8Array(await new Response(file.stream()).arrayBuffer()) };
    }
    const from = { ref: store.accountRef, user: await store.ownerUserId(), name: (await store.accountName()) ?? null };
    // Only the authenticated executor supplies task identity and capture origin. User input `more` cannot turn
    // a fixture into a real report or supply a different actor. No private transcript or authorization travels.
    const capture = {
      submission_id: reference(task?.task_id),
      execution_ref: reference(task?.execution_ref),
      origin: ['real', 'synthetic', 'unknown'].includes(task?.execution?.origin) ? task.execution.origin : 'unknown',
    };
    const sent = { sent_by: reports.sent_by.includes(sentBy) ? sentBy : reports.default_sent_by, harness: text(harness, LIMITS.harness), their_words: text(theirWords, LIMITS.their_words) };
    const message = { invoke: invocation, from, ...handOff, ...sent, picture, capture, at: task?.started_at ?? task?.execution?.captured_at ?? new Date().toISOString() };
    // The operator reporting to itself keeps the report in its own store directly: it never calls its own stub.
    const kept = account === from.user ? await store.receiveHandOff(message) : await store.deliver(account, message);
    // A row's `journey` (DATA) is the journey kind this hand-off is told as; kept if the sender's account shares its activity.
    if (typeof invocation.journey === 'string') {
      await recordJourney(store.journeyContext, from.user, [{ kind: invocation.journey, facts: { kind: reportKindOf(handOff.more.kind), sent_by: sent.sent_by, harness: sent.harness }, words: { where: handOff.where, note: handOff.note, their_words: sent.their_words } }]);
    }
    return { ...kept, said: fill(invocation.said, {}) || 'Sent.' };
  },
});

/**
 * The receiving side, over what it needs: tools (the rows Trillion ships), eeaf (the receiving store's records), keep
 * (keeps one file in its Files) and tell (its tell-the-person). Answers which list and row now hold the hand-off.
 */
async function keepHandOff({ tools, eeaf, lists, putFirstRow, keep, tell, handOff }, { invoke, from, things, note, where, screen, browser, picture, more, capture, at, sent_by, harness, their_words }) {
  if (!object(invoke) || invoke.action !== ACTION || !tools.some(tool => sameInvoke(tool.invoke, invoke))) throw new HandOffError('This hand-off is not one Trillion sends.');
  const { list, notice } = invoke;
  const kept = await lists.find(list.id);
  if (!kept) await lists.save(list, { actor: { by: 'trillion' } });
  else {
    // A field the row's list has gained since the list was made (what the note is) is added to the kept list; the
    // person's own fields and views stay.
    const missing = list.fields.filter(field => !(kept.fields ?? []).some(have => have.id === field.id));
    if (missing.length) await lists.save({ id: list.id, fields: [...kept.fields, ...missing] }, { actor: { by: 'trillion' } });
  }
  const submission = reference(capture?.submission_id);
  if (submission && !from?.ref) throw new HandOffError('A managed submission needs its authenticated sending account.');
  const rowId = submission ? `submission-${hash([from.ref, submission])}` : `${at.replace(/[:.]/g, '-')}-${String(from?.ref ?? '').slice(0, 12)}`;
  const sourceRef = `record:${list.row_type ?? list.id}:${rowId}`;
  const previous = await eeaf.read(sourceRef);
  const fingerprint = hash({ things, note, where, screen, browser, more: object(more) ? Object.fromEntries(Object.entries(more).sort(([a], [b]) => a.localeCompare(b))) : {},
    picture: picture?.bytes?.byteLength ? { name: picture.name, media_type: picture.media_type, bytes: makeHashCodeHexFromBytes(picture.bytes).slice(3) } : null });
  const fingerprintField = invoke.trace?.input_fingerprint;
  if (previous && fingerprintField && previous[fingerprintField] && previous[fingerprintField] !== fingerprint) throw new HandOffError('This submission already holds a different report. Use a new task for a new report; the original was kept.');
  const receivedAt = previous?.sent_at ?? at;
  const stamp = receivedAt.replace(/[:.]/g, '-');
  let pictureName = previous?.picture ?? null;
  if (!pictureName && picture?.bytes?.byteLength) {
    const name = `${invoke.picture_folder ?? '/Pictures'}/${submission ? rowId : stamp} ${picture.name}`;
    const kept = await keep({ name, size: picture.bytes.byteLength, open: async () => [picture.bytes], media_type: picture.media_type });
    pictureName = kept?.name ?? name;
  }
  const who = previous?.from || from?.name || (from?.user ? `A member (${String(from.user).slice(0, 8)})` : 'A member');
  const origin = previous?.[invoke.trace?.origin] ?? (['real', 'synthetic', 'unknown'].includes(capture?.origin) ? capture.origin : 'unknown');
  const receipt = { source_ref: sourceRef, execution_ref: reference(capture?.execution_ref), origin, input_fingerprint: fingerprint, intake_state: 'received' };
  const protectedFields = new Set(Object.values(invoke.trace ?? {}));
  const extra = object(more) ? Object.fromEntries(Object.entries(more).filter(([key]) => !protectedFields.has(key))) : {};
  const sent = { sent_by: reports.sent_by.includes(sent_by) ? sent_by : reports.default_sent_by, harness: text(harness, LIMITS.harness), their_words: text(their_words, LIMITS.their_words) };
  const values = { ...extra, from: who, account: from?.user ?? '', note, where, things: thingLines(things), screen, browser, ...sent, sent_at: receivedAt, ...(pictureName ? { picture: pictureName } : {}), ...traceValues(invoke, receipt) };
  const fields = new Set(list.fields.map(field => field.id));
  const row = { id: rowId, values: previous ?? Object.fromEntries(Object.entries(values).filter(([key, value]) => fields.has(key) && value)) };
  const actor = { by: 'trillion', from: from?.ref ?? null, ...(submission ? { task_id: submission } : {}) };
  if (!previous) await putFirstRow(sourceRef, row.values);
  const words = { ...values, from: who, count: things.length, note: note || thingLines(things), list: list.label, row: row.id };
  const key = `${ACTION}:${list.id}:${row.id}`;
  await tell({ kind: notice.kind, title: fill(notice.title, words), body: fill(notice.body, words), key, refs: { list: list.id, row: row.id } });
  // The row's `hand_off` (DATA: job and said, filled from the note) hands the note to the receiving account's AIs as work.
  let workRef = invoke.trace?.work_ref ? row.values[invoke.trace.work_ref] : null;
  if (object(invoke.hand_off) && !workRef) {
    if (!handOff) throw new HandOffError('The report was kept, but its work could not be created. Retry this same submission to recover.');
    const work = await handOff({ job: fill(invoke.hand_off.job, words), said: fill(invoke.hand_off.said, words), from_agent: 'trillion-members', request_key: key,
      input: { list: list.id, row: row.id, source_ref: sourceRef, origin } });
    workRef = work?.handoff?.handoff_id ?? null;
    if (!workRef) throw new HandOffError('The report was kept, but no work reference was returned. Retry this same submission to recover.');
  }
  const joined = traceValues(invoke, { ...receipt, ...(workRef ? { work_ref: workRef, intake_state: 'work_created' } : {}) });
  // Replays attach only missing joins. Review fields, the original report and later outcome evidence stay intact.
  const missingJoins = Object.fromEntries(Object.entries(joined).filter(([field, value]) => fields.has(field) && (row.values[field] == null || (field === invoke.trace?.intake_state && row.values[field] === 'received' && value === 'work_created'))));
  if (Object.keys(missingJoins).length) await lists.putRows(list.id, { rows: [{ id: row.id, values: missingJoins }] }, { actor });
  return { kept: true, list_id: list.id, row_id: row.id, source_ref: sourceRef, origin,
    intake_state: workRef ? 'work_created' : 'received', replay_coverage: submission ? 'task_and_account' : 'arrival_time_only',
    ...(workRef ? { handoff_id: workRef, work_ref: workRef } : {}) };
}

/** The receiving store's side (mixed into PersonStore like src/client-program.mjs). */
const handToAccountMethods = {
  async receiveHandOff(handOff) {
    const tools = await this.shippedTools();
    return keepHandOffOverDoor({ tools, door: this.door, keep: file => this.keepFile(file), tell: notice => this.tell(notice), handOff: input => this.handOff(input) }, handOff);
  },

  /** The reports this (operator) account has received, newest first, for Trillion HQ's Customers screen (src/customers-hq.mjs). */
  async memberReports({ limit = reports.screen.reports_limit } = {}) {
    if (!this.isOperator()) return [];
    const lists = listsOverDoor(this.door);
    if (!await lists.find(reports.list_id)) return [];
    const { rows } = await lists.read(reports.list_id, { only: ['note', 'kind', 'from', 'account', 'where', 'screen', 'sent_at', 'sent_by', 'harness', 'their_words', 'origin', 'intake_state', 'work_ref'] });
    return rows.map(row => ({ id: row.id, ...row.values })).sort((a, b) => String(b.sent_at ?? '').localeCompare(String(a.sent_at ?? ''))).slice(0, Math.max(1, limit));
  },
};



/** Actual records-door seam. A new submission uses absence CAS, so simultaneous conflicting reports cannot merge. */
async function keepHandOffOverDoor({ door, tools, keep, tell, handOff }, message) {
  const lists = listsOverDoor(door);
  const rowType = id => `record:${id.split(':')[1]}`;
  return keepHandOff({ tools, lists,
    eeaf: { read: id => door.read(rowType(id), id) },
    putFirstRow: (id, value) => door.write([{ id, type: rowType(id), value, expected: null }]),
    keep, tell, handOff }, message);
}

return { keepHandOffOverDoor, HandOffError, thingLines, readHandOff, handToAccountActions, keepHandOff, handToAccountMethods };
}

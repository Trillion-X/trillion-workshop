// tools/gather-words-from-people/test/gather-words.test.mjs
//
// The four tools over a made-up list of praise for a made-up bakery, held in a small in-memory door. Nothing here is a real
// person's words: every name, address and line is invented for the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askPeopleForWords, keepTheWordsAPersonGave, approveWordsToShow, readWordsThatMayShow } from '../do-work/gather-words-on-the-records-door.mjs';
import { readGathers } from '../read-data/gathered-words.mjs';

const LIST = 'list:bakery-praise';
const TYPE = 'record:bakery-praise';

const gathers = () => ({
  fields: { words: 'words', who: 'who', person: 'person', consent: 'consent', consent_note: 'consent_note', status: 'status', case: 'case', win: 'win', asked_at: 'asked_at', approved_identity: 'approved_identity' },
  consents: [
    { id: 'full-name', label: 'Show my words with my full name', may_show: true, name_use: 'full' },
    { id: 'first-name', label: 'Show my words with my first name only', may_show: true, name_use: 'first' },
    { id: 'no-name', label: 'Show my words with no name', may_show: true, name_use: 'none' },
    { id: 'private', label: 'Keep my words private', may_show: false },
  ],
  anonymous_heading: 'A customer',
  states: { asked: 'asked', received: 'received', approved: 'approved', declined: 'declined', withdrawn: 'withdrawn' },
  ask: { subject: 'How did the cake go, {name}?', body: 'Hi {name}, you told us the cake was a success. Would you tell us in your own words? Reply only if you want to.' },
});

const listValue = (extra = {}) => ({
  label: 'Bakery praise',
  row_type: 'bakery-praise',
  fields: ['words', 'who', 'person', 'consent', 'consent_note', 'status', 'case', 'win', 'asked_at', 'approved_identity'].map(id => ({ id, kind: 'text', label: id })),
  gathers: gathers(),
  ...extra,
});

// A door that keeps records in memory and refuses a write whose `expected` is not what is held, as the engine's does.
function door(records = []) {
  const held = new Map(records.map(record => [record.id, structuredClone(record)]));
  const writes = [];
  return {
    held,
    writes,
    async read(type, id) {
      const record = held.get(id);
      return record && record.type === type ? structuredClone(record.value) : null;
    },
    async *list({ type }) {
      for (const record of [...held.values()].filter(row => row.type === type)) yield structuredClone(record);
    },
    async write(rows) {
      for (const row of rows) {
        if ('expected' in row) {
          const now = held.get(row.id) ?? null;
          const same = row.expected === null ? now === null : now !== null && now.type === row.expected.type && JSON.stringify(now.value) === JSON.stringify(row.expected.value);
          if (!same) throw new Error(`write refused: ${row.id} is not as expected`);
        }
      }
      writes.push(rows);
      for (const row of rows) held.set(row.id, { id: row.id, type: row.type, value: structuredClone(row.value) });
      return [];
    },
  };
}

const fresh = () => door([{ id: LIST, type: 'list', value: listValue() }]);
const call = { list: LIST, type: TYPE };
const people = [{ id: 'p1', name: 'Ada Example', address: 'ada@example.com', win: 'message:made-up-1' }, { id: 'p2', name: 'Bo Sample', address: 'bo@example.com', win: 'message:made-up-2' }];

test('a list with no gathers block is refused, and every problem with a block is named', () => {
  assert.throws(() => readGathers(listValue({ gathers: undefined })), /gathers/);
  const bad = gathers();
  bad.fields.consent = 'not-a-field';
  bad.consents.push({ id: 'no-name' });
  bad.consents.push({ label: 'no id', may_show: true });
  delete bad.states.approved;
  delete bad.anonymous_heading;
  assert.throws(() => readGathers(listValue({ gathers: bad })), error => {
    for (const piece of ['not-a-field', 'no-name', 'consents[5]', 'approved', 'anonymous_heading']) assert.match(error.message, new RegExp(piece.replace('[', '\\[').replace(']', '\\]')));
    return true;
  });
});

test('the call must name the list and its row type, and the row type must be the list\'s own', async () => {
  await assert.rejects(askPeopleForWords({ ...call, type: 'record:other', people, case: 'c1' }, { door: fresh() }), /record:bakery-praise/);
  await assert.rejects(askPeopleForWords({ list: 'list:missing', type: TYPE, people, case: 'c1' }, { door: fresh() }), /list:missing/);
});

test('asking writes one asked row per person, returns each draft, and sends nothing', async () => {
  const d = fresh();
  const out = await askPeopleForWords({ ...call, people, case: 'cake-2026', now: '2026-11-12T20:00:00Z' }, { door: d });
  assert.equal(out.asked.length, 2);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.asked[0].draft, { to: 'ada@example.com', subject: 'How did the cake go, Ada Example?', body: 'Hi Ada Example, you told us the cake was a success. Would you tell us in your own words? Reply only if you want to.' });
  const row = d.held.get(out.asked[0].row_id);
  assert.equal(row.type, TYPE);
  assert.deepEqual(row.value, { who: 'Ada Example', person: 'p1', status: 'asked', case: 'cake-2026', win: 'message:made-up-1', asked_at: '2026-11-12T20:00:00Z' });
  assert.ok(!JSON.stringify(row).includes('ada@example.com'), 'the address is in the draft only, never in the kept row');
});

test('a person is asked once for a case: the second ask is skipped and the row is left as it was', async () => {
  const d = fresh();
  await askPeopleForWords({ ...call, people, case: 'cake-2026', now: '2026-11-12T20:00:00Z' }, { door: d });
  const before = JSON.stringify([...d.held.values()]);
  const again = await askPeopleForWords({ ...call, people, case: 'cake-2026', now: '2026-11-13T20:00:00Z' }, { door: d });
  assert.deepEqual(again.asked, []);
  assert.deepEqual(again.skipped.map(skip => [skip.person, skip.reason]), [['p1', 'already_asked'], ['p2', 'already_asked']]);
  assert.equal(JSON.stringify([...d.held.values()]), before);
  const other = await askPeopleForWords({ ...call, people: [people[0]], case: 'wedding-2027' }, { door: d });
  assert.equal(other.asked.length, 1, 'the same person may be asked for another case');
});

test('a person with no reference to their own positive word is not asked, and nothing is written for them', async () => {
  const d = fresh();
  const out = await askPeopleForWords({ ...call, people: [{ id: 'p3', name: 'Cy Made', address: 'cy@example.com' }, people[0]], case: 'c' }, { door: d });
  assert.deepEqual(out.skipped.map(skip => [skip.person, skip.reason]), [['p3', 'no_win']]);
  assert.equal(out.asked.length, 1);
  assert.equal([...d.held.values()].filter(row => row.type === TYPE).length, 1);
});

const asked = async (d, person = people[0]) => (await askPeopleForWords({ ...call, people: [person], case: 'c' }, { door: d })).asked[0].row_id;

test('keeping words records them with the consent given and the words that gave it, and marks the row received', async () => {
  const d = fresh();
  const id = await asked(d);
  const out = await keepTheWordsAPersonGave({ ...call, row_id: id, words: 'The cake was the best part of the day.', consent: 'first-name', consent_note: 'Replied: yes, first name is fine' }, { door: d });
  assert.equal(out.status, 'received');
  const row = d.held.get(id).value;
  assert.equal(row.words, 'The cake was the best part of the day.');
  assert.equal(row.consent, 'first-name');
  assert.equal(row.consent_note, 'Replied: yes, first name is fine');
  assert.equal(row.status, 'received');
  assert.equal(row.person, 'p1');
});

test('words without a declared consent, an empty answer, or an unknown consent are refused with the options', async () => {
  const d = fresh();
  const id = await asked(d);
  await assert.rejects(keepTheWordsAPersonGave({ ...call, row_id: id, words: 'Nice.', consent: 'maybe', consent_note: 'x' }, { door: d }), /full-name, first-name, no-name, private/);
  await assert.rejects(keepTheWordsAPersonGave({ ...call, row_id: id, words: '  ', consent: 'private', consent_note: 'x' }, { door: d }), /words/);
  await assert.rejects(keepTheWordsAPersonGave({ ...call, row_id: id, words: 'Nice.', consent: 'private' }, { door: d }), /consent_note/);
  assert.equal(d.held.get(id).value.status, 'asked');
});

test('words nobody asked for need who and become a received row, kept once however many times they are sent', async () => {
  const d = fresh();
  const input = { ...call, who: 'Di Volunteer', words: 'Loved the bread.', consent: 'no-name', consent_note: 'Wrote: any way is fine' };
  const one = await keepTheWordsAPersonGave(input, { door: d });
  const two = await keepTheWordsAPersonGave(input, { door: d });
  assert.equal(one.row_id, two.row_id);
  assert.equal([...d.held.values()].filter(row => row.type === TYPE).length, 1);
  await assert.rejects(keepTheWordsAPersonGave({ ...input, who: undefined }, { door: d }), /who/);
});

test('a withdrawn row takes no more words', async () => {
  const d = fresh();
  const id = await asked(d);
  await keepTheWordsAPersonGave({ ...call, row_id: id, words: 'Fine.', consent: 'full-name', consent_note: 'yes' }, { door: d });
  await approveWordsToShow({ ...call, row_id: id, decision: 'withdraw' }, { door: d });
  await assert.rejects(keepTheWordsAPersonGave({ ...call, row_id: id, words: 'Fine again.', consent: 'full-name', consent_note: 'yes' }, { door: d }), /withdrawn/);
});

const received = async (d, { words = 'The cake was the best part of the day.', consent = 'full-name', person = people[0] } = {}) => {
  const id = await asked(d, person);
  await keepTheWordsAPersonGave({ ...call, row_id: id, words, consent, consent_note: 'replied yes' }, { door: d });
  return id;
};

test('approval takes the exact words that were reviewed and pins them', async () => {
  const d = fresh();
  const id = await received(d);
  await assert.rejects(approveWordsToShow({ ...call, row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part.' }, { door: d }), /reviewed/);
  assert.equal(d.held.get(id).value.status, 'received');
  const out = await approveWordsToShow({ ...call, row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' }, { door: d });
  assert.equal(out.status, 'approved');
  assert.match(d.held.get(id).value.approved_identity, /^1f:[0-9a-f]{64}$/);
});

test('words the person asked to keep private are never approved, and only received rows are', async () => {
  const d = fresh();
  const privateId = await received(d, { consent: 'private' });
  await assert.rejects(approveWordsToShow({ ...call, row_id: privateId, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' }, { door: d }), /private/);
  const askedOnly = await asked(d, people[1]);
  await assert.rejects(approveWordsToShow({ ...call, row_id: askedOnly, decision: 'approve', reviewed_words: 'x' }, { door: d }), /received/);
});

test('declining and withdrawing change the state and clear the pin', async () => {
  const d = fresh();
  const id = await received(d);
  await approveWordsToShow({ ...call, row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' }, { door: d });
  const out = await approveWordsToShow({ ...call, row_id: id, decision: 'withdraw' }, { door: d });
  assert.equal(out.status, 'withdrawn');
  assert.equal('approved_identity' in d.held.get(id).value, false);
  const id2 = await received(d, { person: people[1] });
  assert.equal((await approveWordsToShow({ ...call, row_id: id2, decision: 'decline' }, { door: d })).status, 'declined');
});

test('what may show is only approved words whose consent allows showing and whose pin still matches, named as the consent says', async () => {
  const d = fresh();
  const full = await received(d, { consent: 'full-name', words: 'Words one.' });
  const first = await received(d, { consent: 'first-name', words: 'Words two.', person: people[1] });
  const noName = await received(d, { consent: 'no-name', words: 'Words three.', person: { id: 'p3', name: 'Cy Made', win: 'message:made-up-3' } });
  const notApproved = await received(d, { consent: 'full-name', words: 'Words four.', person: { id: 'p4', name: 'Di Made', win: 'message:made-up-4' } });
  for (const [id, words] of [[full, 'Words one.'], [first, 'Words two.'], [noName, 'Words three.']]) await approveWordsToShow({ ...call, row_id: id, decision: 'approve', reviewed_words: words }, { door: d });
  const out = await readWordsThatMayShow({ ...call }, { door: d });
  const byBody = Object.fromEntries(out.items.map(item => [item.body, item.heading]));
  assert.deepEqual(byBody, { 'Words one.': 'Ada Example', 'Words two.': 'Bo', 'Words three.': 'A customer' });
  assert.deepEqual(out.held_back, { not_approved: 1 });
  assert.ok(!JSON.stringify(out).includes('Words four.'), 'held-back words never leave');
  assert.ok(!JSON.stringify(out).includes('Cy Made') && !JSON.stringify(out).includes('Bo Sample'), 'a name goes out only as its consent says');
  assert.ok(notApproved);
});

test('words changed after approval, or a consent changed after approval, stop showing at once', async () => {
  const d = fresh();
  const a = await received(d, { words: 'Original words.' });
  const b = await received(d, { words: 'Other words.', person: people[1] });
  for (const [id, words] of [[a, 'Original words.'], [b, 'Other words.']]) await approveWordsToShow({ ...call, row_id: id, decision: 'approve', reviewed_words: words }, { door: d });
  // A hand edit straight to the row, bypassing the tools.
  d.held.get(a).value.words = 'Edited after approval.';
  d.held.get(b).value.consent = 'private';
  const out = await readWordsThatMayShow({ ...call }, { door: d });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.held_back, { changed_since_approved: 2 });
});

test('a row whose status says approved but has no pin is held back, and a withdrawn row never shows', async () => {
  const d = fresh();
  d.held.set('record:bakery-praise:hand-made', { id: 'record:bakery-praise:hand-made', type: TYPE, value: { who: 'Ed Made', words: 'Typed in by hand.', consent: 'full-name', status: 'approved' } });
  const id = await received(d);
  await approveWordsToShow({ ...call, row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' }, { door: d });
  await approveWordsToShow({ ...call, row_id: id, decision: 'withdraw' }, { door: d });
  const out = await readWordsThatMayShow({ ...call }, { door: d });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.held_back, { changed_since_approved: 1, not_approved: 1 });
});

test('rows with none of the declared fields (a list that already holds words) are held back, not shown', async () => {
  const d = fresh();
  d.held.set('record:bakery-praise:old-1', { id: 'record:bakery-praise:old-1', type: TYPE, value: { who: 'Fy Made', words: 'Old words with no consent.' } });
  const out = await readWordsThatMayShow({ ...call }, { door: d });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.held_back, { not_approved: 1 });
});

test('the items are exactly what a page proof section takes, and a limit keeps the first ones', async () => {
  const d = fresh();
  const ids = [];
  for (const [n, person] of [['one', people[0]], ['two', people[1]]]) ids.push([await received(d, { words: `Words ${n}.`, person }), `Words ${n}.`]);
  for (const [id, words] of ids) await approveWordsToShow({ ...call, row_id: id, decision: 'approve', reviewed_words: words }, { door: d });
  const out = await readWordsThatMayShow({ ...call, limit: 1 }, { door: d });
  assert.equal(out.items.length, 1);
  assert.deepEqual(Object.keys(out.items[0]).sort(), ['body', 'heading', 'row_id']);
  assert.equal(out.shown, 1);
  assert.equal(out.may_show_total, 2);
});

test('a write the door refuses because the row changed underneath is reported, and nothing else changes', async () => {
  const d = fresh();
  const id = await received(d);
  const original = d.write;
  d.write = async rows => { d.held.get(id).value.words = 'Changed by someone else.'; return original(rows); };
  await assert.rejects(approveWordsToShow({ ...call, row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' }, { door: d }), /not as expected/);
  assert.equal(d.held.get(id).value.status, 'received');
});

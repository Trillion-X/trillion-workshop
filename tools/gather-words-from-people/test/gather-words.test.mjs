// tools/gather-words-from-people/test/gather-words.test.mjs
//
// The four tools over a made-up list of praise for a made-up bakery. The list's definition and rows are handed in as
// input and a tool that changes a row answers `keep`; a small in-memory store stands in for the caller's AI putting that
// answer in a store, refusing a write whose `expected` is not what is held, as a store does. Nothing here is a real
// person's words: every name, address and line is invented for the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askPeopleForWords, keepTheWordsAPersonGave, approveWordsToShow, readWordsThatMayShow } from '../do-work/gather-words.mjs';
import { readGathers } from '../read-data/gathered-words.mjs';

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

// The caller's store: the rows it holds, and the answers' `keep` put in it, each refused when its `expected` is not what is held.
function store(rows = []) {
  const held = new Map(rows.map(row => [row.id, structuredClone(row.value)]));
  return {
    held,
    rows: () => [...held].map(([id, value]) => ({ id, value: structuredClone(value) })),
    put(answer) {
      for (const row of answer.keep ?? []) {
        const now = held.get(row.id) ?? null;
        const same = row.expected === null ? now === null : now !== null && JSON.stringify(now) === JSON.stringify(row.expected.value);
        if (!same) throw new Error(`write refused: ${row.id} is not as expected`);
        assert.equal(row.type, TYPE);
      }
      for (const row of answer.keep ?? []) held.set(row.id, structuredClone(row.value));
      return answer;
    },
  };
}

// A tool called with the list and the store's rows, its answer put in the store.
const call = (tool, s, input) => s.put(tool({ list: listValue(), rows: s.rows(), ...input }));
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

test('the call must hand in the list\'s definition', () => {
  assert.throws(() => askPeopleForWords({ people, case: 'c1' }), /list/);
  assert.throws(() => askPeopleForWords({ list: 'list:bakery-praise', people, case: 'c1' }), /list/);
  assert.throws(() => askPeopleForWords({ list: listValue({ gathers: undefined }), rows: [], people, case: 'c1' }), /gathers/);
});

test('a call that leaves out the rows is refused, never read as an empty list; rows given as [] are answered', () => {
  assert.throws(() => askPeopleForWords({ list: listValue(), people, case: 'c1' }), /rows/);
  assert.throws(() => keepTheWordsAPersonGave({ list: listValue(), row_id: 'record:bakery-praise:x', words: 'Nice.', consent: 'full-name', consent_note: 'yes' }), /rows/);
  assert.throws(() => approveWordsToShow({ list: listValue(), row_id: 'record:bakery-praise:x', decision: 'approve', reviewed_words: 'Nice.' }), /rows/);
  assert.throws(() => readWordsThatMayShow({ list: listValue() }), /rows/);
  assert.deepEqual(readWordsThatMayShow({ list: listValue(), rows: [] }), { items: [], shown: 0, may_show_total: 0, held_back: {} });
});

test('asking answers one asked row to keep per person with each draft, writes nothing itself and sends nothing', () => {
  const s = store();
  const out = askPeopleForWords({ list: listValue(), rows: s.rows(), people, case: 'cake-2026', now: '2026-11-12T20:00:00Z' });
  assert.equal(out.asked.length, 2);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.asked[0].draft, { to: 'ada@example.com', subject: 'How did the cake go, Ada Example?', body: 'Hi Ada Example, you told us the cake was a success. Would you tell us in your own words? Reply only if you want to.' });
  assert.equal(s.held.size, 0, 'the tool keeps nothing');
  assert.equal(out.keep.length, 2);
  const row = out.keep[0];
  assert.equal(row.id, out.asked[0].row_id);
  assert.equal(row.type, TYPE);
  assert.equal(row.expected, null);
  assert.deepEqual(row.value, { who: 'Ada Example', person: 'p1', status: 'asked', case: 'cake-2026', win: 'message:made-up-1', asked_at: '2026-11-12T20:00:00Z' });
  assert.ok(!JSON.stringify(row).includes('ada@example.com'), 'the address is in the draft only, never in the row to write');
});

test('a person is asked once for a case: the second ask is skipped and writes nothing', () => {
  const s = store();
  call(askPeopleForWords, s, { people, case: 'cake-2026', now: '2026-11-12T20:00:00Z' });
  const before = JSON.stringify([...s.held]);
  const again = call(askPeopleForWords, s, { people, case: 'cake-2026', now: '2026-11-13T20:00:00Z' });
  assert.deepEqual(again.asked, []);
  assert.deepEqual(again.keep, []);
  assert.deepEqual(again.skipped.map(skip => [skip.person, skip.reason]), [['p1', 'already_asked'], ['p2', 'already_asked']]);
  assert.equal(JSON.stringify([...s.held]), before);
  const other = call(askPeopleForWords, s, { people: [people[0]], case: 'wedding-2027' });
  assert.equal(other.asked.length, 1, 'the same person may be asked for another case');
});

test('a person with no reference to their own positive word is not asked, and no row is answered for them', () => {
  const out = askPeopleForWords({ list: listValue(), rows: [], people: [{ id: 'p3', name: 'Cy Made', address: 'cy@example.com' }, people[0]], case: 'c' });
  assert.deepEqual(out.skipped.map(skip => [skip.person, skip.reason]), [['p3', 'no_win']]);
  assert.equal(out.asked.length, 1);
  assert.equal(out.keep.length, 1);
});

const asked = (s, person = people[0]) => call(askPeopleForWords, s, { people: [person], case: 'c' }).asked[0].row_id;

test('keeping words answers the received row with the consent given and the words that gave it', () => {
  const s = store();
  const id = asked(s);
  const out = keepTheWordsAPersonGave({ list: listValue(), rows: s.rows(), row_id: id, words: 'The cake was the best part of the day.', consent: 'first-name', consent_note: 'Replied: yes, first name is fine' });
  assert.equal(out.status, 'received');
  assert.equal(out.changed, true);
  assert.equal(s.held.get(id).status, 'asked', 'the tool keeps nothing');
  const [kept] = out.keep;
  assert.equal(kept.id, id);
  assert.deepEqual(kept.expected, { type: TYPE, value: s.held.get(id) });
  assert.equal(kept.value.words, 'The cake was the best part of the day.');
  assert.equal(kept.value.consent, 'first-name');
  assert.equal(kept.value.consent_note, 'Replied: yes, first name is fine');
  assert.equal(kept.value.status, 'received');
  assert.equal(kept.value.person, 'p1');
});

test('words without a declared consent, an empty answer, or an unknown consent are refused with the options', () => {
  const s = store();
  const id = asked(s);
  const input = { list: listValue(), rows: s.rows(), row_id: id };
  assert.throws(() => keepTheWordsAPersonGave({ ...input, words: 'Nice.', consent: 'maybe', consent_note: 'x' }), /full-name, first-name, no-name, private/);
  assert.throws(() => keepTheWordsAPersonGave({ ...input, words: '  ', consent: 'private', consent_note: 'x' }), /words/);
  assert.throws(() => keepTheWordsAPersonGave({ ...input, words: 'Nice.', consent: 'private' }), /consent_note/);
  assert.equal(s.held.get(id).status, 'asked');
});

test('words nobody asked for need who and become a received row, kept once however many times they are sent', () => {
  const s = store();
  const input = { who: 'Di Volunteer', words: 'Loved the bread.', consent: 'no-name', consent_note: 'Wrote: any way is fine' };
  const one = call(keepTheWordsAPersonGave, s, input);
  const two = call(keepTheWordsAPersonGave, s, input);
  assert.equal(one.row_id, two.row_id);
  assert.equal(one.changed, true);
  assert.equal(two.changed, false);
  assert.deepEqual(two.keep, []);
  assert.equal(s.held.size, 1);
  assert.throws(() => keepTheWordsAPersonGave({ list: listValue(), rows: s.rows(), ...input, who: undefined }), /who/);
});

test('a withdrawn row takes no more words', () => {
  const s = store();
  const id = asked(s);
  call(keepTheWordsAPersonGave, s, { row_id: id, words: 'Fine.', consent: 'full-name', consent_note: 'yes' });
  call(approveWordsToShow, s, { row_id: id, decision: 'withdraw' });
  assert.throws(() => keepTheWordsAPersonGave({ list: listValue(), rows: s.rows(), row_id: id, words: 'Fine again.', consent: 'full-name', consent_note: 'yes' }), /withdrawn/);
});

const received = (s, { words = 'The cake was the best part of the day.', consent = 'full-name', person = people[0] } = {}) => {
  const id = asked(s, person);
  call(keepTheWordsAPersonGave, s, { row_id: id, words, consent, consent_note: 'replied yes' });
  return id;
};

test('approval takes the exact words that were reviewed and answers the pinned row', () => {
  const s = store();
  const id = received(s);
  assert.throws(() => approveWordsToShow({ list: listValue(), rows: s.rows(), row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part.' }), /reviewed/);
  assert.equal(s.held.get(id).status, 'received');
  const out = approveWordsToShow({ list: listValue(), rows: s.rows(), row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' });
  assert.equal(out.status, 'approved');
  assert.equal(s.held.get(id).status, 'received', 'the tool keeps nothing');
  assert.match(out.keep[0].value.approved_identity, /^1f:[0-9a-f]{64}$/);
});

test('words the person asked to keep private are never approved, and only received rows are', () => {
  const s = store();
  const privateId = received(s, { consent: 'private' });
  assert.throws(() => approveWordsToShow({ list: listValue(), rows: s.rows(), row_id: privateId, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' }), /private/);
  const askedOnly = asked(s, people[1]);
  assert.throws(() => approveWordsToShow({ list: listValue(), rows: s.rows(), row_id: askedOnly, decision: 'approve', reviewed_words: 'x' }), /received/);
});

test('declining and withdrawing change the state and clear the pin', () => {
  const s = store();
  const id = received(s);
  call(approveWordsToShow, s, { row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' });
  const out = call(approveWordsToShow, s, { row_id: id, decision: 'withdraw' });
  assert.equal(out.status, 'withdrawn');
  assert.equal('approved_identity' in s.held.get(id), false);
  const id2 = received(s, { person: people[1] });
  assert.equal(call(approveWordsToShow, s, { row_id: id2, decision: 'decline' }).status, 'declined');
});

test('what may show is only approved words whose consent allows showing and whose pin still matches, named as the consent says', () => {
  const s = store();
  const full = received(s, { consent: 'full-name', words: 'Words one.' });
  const first = received(s, { consent: 'first-name', words: 'Words two.', person: people[1] });
  const noName = received(s, { consent: 'no-name', words: 'Words three.', person: { id: 'p3', name: 'Cy Made', win: 'message:made-up-3' } });
  received(s, { consent: 'full-name', words: 'Words four.', person: { id: 'p4', name: 'Di Made', win: 'message:made-up-4' } });
  for (const [id, words] of [[full, 'Words one.'], [first, 'Words two.'], [noName, 'Words three.']]) call(approveWordsToShow, s, { row_id: id, decision: 'approve', reviewed_words: words });
  const out = readWordsThatMayShow({ list: listValue(), rows: s.rows() });
  const byBody = Object.fromEntries(out.items.map(item => [item.body, item.heading]));
  assert.deepEqual(byBody, { 'Words one.': 'Ada Example', 'Words two.': 'Bo', 'Words three.': 'A customer' });
  assert.deepEqual(out.held_back, { not_approved: 1 });
  assert.ok(!JSON.stringify(out).includes('Words four.'), 'held-back words never leave');
  assert.ok(!JSON.stringify(out).includes('Cy Made') && !JSON.stringify(out).includes('Bo Sample'), 'a name goes out only as its consent says');
  assert.equal('keep' in out, false, 'reading answers items and nothing to write');
});

test('words changed after approval, or a consent changed after approval, stop showing at once', () => {
  const s = store();
  const a = received(s, { words: 'Original words.' });
  const b = received(s, { words: 'Other words.', person: people[1] });
  for (const [id, words] of [[a, 'Original words.'], [b, 'Other words.']]) call(approveWordsToShow, s, { row_id: id, decision: 'approve', reviewed_words: words });
  // A hand edit straight to the row, bypassing the tools.
  s.held.get(a).words = 'Edited after approval.';
  s.held.get(b).consent = 'private';
  const out = readWordsThatMayShow({ list: listValue(), rows: s.rows() });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.held_back, { changed_since_approved: 2 });
});

test('a row whose status says approved but has no pin is held back, and a withdrawn row never shows', () => {
  const s = store([{ id: 'record:bakery-praise:hand-made', value: { who: 'Ed Made', words: 'Typed in by hand.', consent: 'full-name', status: 'approved' } }]);
  const id = received(s);
  call(approveWordsToShow, s, { row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' });
  call(approveWordsToShow, s, { row_id: id, decision: 'withdraw' });
  const out = readWordsThatMayShow({ list: listValue(), rows: s.rows() });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.held_back, { changed_since_approved: 1, not_approved: 1 });
});

test('rows with none of the declared fields (a list that already holds words) are held back, not shown', () => {
  const s = store([{ id: 'record:bakery-praise:old-1', value: { who: 'Fy Made', words: 'Old words with no consent.' } }]);
  const out = readWordsThatMayShow({ list: listValue(), rows: s.rows() });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.held_back, { not_approved: 1 });
});

test('the items are exactly what a page proof section takes, and a limit keeps the first ones', () => {
  const s = store();
  const ids = [];
  for (const [n, person] of [['one', people[0]], ['two', people[1]]]) ids.push([received(s, { words: `Words ${n}.`, person }), `Words ${n}.`]);
  for (const [id, words] of ids) call(approveWordsToShow, s, { row_id: id, decision: 'approve', reviewed_words: words });
  const out = readWordsThatMayShow({ list: listValue(), rows: s.rows(), limit: 1 });
  assert.equal(out.items.length, 1);
  assert.deepEqual(Object.keys(out.items[0]).sort(), ['body', 'heading', 'row_id']);
  assert.equal(out.shown, 1);
  assert.equal(out.may_show_total, 2);
});

test('a write the store refuses because the row changed underneath is refused whole, and nothing else changes', () => {
  const s = store();
  const id = received(s);
  const out = approveWordsToShow({ list: listValue(), rows: s.rows(), row_id: id, decision: 'approve', reviewed_words: 'The cake was the best part of the day.' });
  s.held.get(id).words = 'Changed by someone else.';
  assert.throws(() => s.put(out), /not as expected/);
  assert.equal(s.held.get(id).status, 'received');
});

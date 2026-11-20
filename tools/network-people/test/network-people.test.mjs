// The Network rows, run as the process runs them with the rows handed in and no store. Profiles change and keep their rows; a search
// ranks by meaning at the Network's own thresholds, and by shared words only when the need has no embedding; the paths compare shown
// pursuits by meaning; a contact is answered only while an introduction is in a released state, and each rule is checked both ways.
// Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };
import introductionStates from '../../introduce-two-people/src/introduction-states.json' with { type: 'json' };
import { cosine, findNetworkPeople, KNOWN_STATES, networkProfile, onMyPath, readNetworkContact, RELEASED } from '../do-work/network-people.mjs';
import { runNetworkAction } from '../do-work/network-profile-sql.mjs';
import { KINDS, rowId } from '../read-data/profile-rows.mjs';

const ANA = 'person:ana';
const BO = 'person:bo';
const CARL = 'person:carl';
const DEE = 'person:dee';
const profile = (subject, value) => ({ type: KINDS.profile, id: rowId('profile', subject), value: { subject, findable: true, open_to_messages: true, show_pursuits: false, links: [], pursuits: [], written: [], ...value } });
// Vectors made up for the test: close pairs point the same way, far pairs do not.
const BAKING = [1, 0.2, 0];
const NEARBY = [0.9, 0.3, 0.05];
const FAR = [0, 0.1, 1];
const ana = profile(ANA, { handle: 'ana_bakes', name: 'Ana', offering: 'Sourdough baking classes at home', seeking: 'Pastry sales help', about: 'Bread teacher', contact: 'ana@example.com', embedding: BAKING, show_pursuits: true, pursuits: [{ title: 'sourdough bread classes', embedding: BAKING }] });
const bo = profile(BO, { handle: 'bo_flour', name: 'Bo', offering: 'Flour milling', seeking: 'Sourdough baking teachers', embedding: FAR, show_pursuits: true, pursuits: [{ title: 'grain milling for bakers', embedding: FAR }] });
const carl = profile(CARL, { handle: 'carl_hidden', name: 'Carl', offering: 'Sourdough baking everything', findable: false, embedding: BAKING });

test('a person changes their profile; only the fields sent change, a changed field is listed in written, and the row is kept', () => {
  const made = networkProfile({ subject: ANA, records: [ana], about: 'Bread teacher, weekends', contact: 'ana.new@example.com' });
  assert.deepEqual(made.changed, ['about', 'contact']);
  assert.equal(made.keep[0].expected.value.about, 'Bread teacher');
  assert.equal(made.profile.contact, undefined);
  assert.equal(made.profile.contact_set, true);
  assert.deepEqual(made.keep[0].value.written, ['about', 'contact']);
});

test('the same words again keep nothing; an invalid handle, a taken handle and a bad link are refused', () => {
  assert.equal(networkProfile({ subject: ANA, records: [ana], name: 'Ana' }).keep, undefined);
  assert.throws(() => networkProfile({ subject: ANA, records: [ana], handle: 'x' }), /handle is 3 to 30/);
  assert.throws(() => networkProfile({ subject: ANA, records: [ana, bo], handle: 'bo_flour' }), /taken/);
  assert.throws(() => networkProfile({ subject: ANA, records: [ana], links: ['ftp://example.com'] }), /web address/);
});

test('a profile keeps its embedding and its pursuits\' embeddings, and neither is answered to a reader', () => {
  const made = networkProfile({ subject: ANA, records: [], embedding: BAKING, pursuits: [{ title: 'sourdough bread classes', embedding: BAKING }] });
  assert.deepEqual(made.keep[0].value.embedding, BAKING);
  assert.equal(made.profile.embedded, true);
  assert.equal(made.profile.embedding, undefined);
  assert.equal(made.profile.pursuits[0].embedding, undefined);
  assert.throws(() => networkProfile({ subject: ANA, records: [], embedding: ['a'] }), /list of numbers/);
});

test('a search by meaning answers the listings at least min_similarity close, and not the ones below it', () => {
  const near = findNetworkPeople({ subject: BO, records: [ana, bo, carl], need: 'where can I learn sourdough baking', embedding: NEARBY });
  assert.equal(near.matched_by, 'meaning');
  assert.deepEqual(near.people.map(person => person.handle), ['ana_bakes']);
  const far = findNetworkPeople({ subject: ANA, records: [ana, bo, carl], need: 'where can I learn sourdough baking', embedding: FAR });
  assert.deepEqual(far.people.map(person => person.handle), ['bo_flour']);
  assert.ok(cosine(NEARBY, BAKING) >= 0.5 && cosine(FAR, BAKING) < 0.5);
});

test('without an embedding for the need, a search answers by shared words; a hidden or not-findable person never answers', () => {
  const found = findNetworkPeople({ subject: BO, records: [ana, bo, carl], need: 'where can I learn sourdough baking' });
  assert.equal(found.matched_by, 'words');
  assert.deepEqual(found.people.map(person => person.handle), ['ana_bakes']);
  assert.equal(JSON.stringify(found).includes('ana@example.com'), false);
});

test('a person who labelled someone unwanted-requests does not find them again', () => {
  const label = { type: KINDS.label, id: rowId('label', 'bo-ana'), value: { relay: ANA, by: BO, label: 'unwanted-requests' } };
  assert.deepEqual(findNetworkPeople({ subject: BO, records: [ana, label], need: 'sourdough', embedding: BAKING }).people, []);
});

test('a path compares shown pursuits by meaning at the path\'s own threshold, and only for people who show their pursuits', () => {
  const dee = profile(DEE, { handle: 'dee_grain', name: 'Dee', show_pursuits: true, pursuits: [{ title: 'bread and grain', embedding: NEARBY }] });
  const near = onMyPath({ subject: ANA, records: [ana, dee] });
  assert.deepEqual(near.people.map(person => [person.handle, person.their_pursuit, person.your_pursuit]), [['dee_grain', 'bread and grain', 'sourdough bread classes']]);
  const hidden = profile(DEE, { handle: 'dee_grain', show_pursuits: false, pursuits: [{ title: 'bread and grain', embedding: NEARBY }] });
  assert.deepEqual(onMyPath({ subject: ANA, records: [ana, hidden] }).people, []);
  const far = profile(DEE, { handle: 'dee_grain', show_pursuits: true, pursuits: [{ title: 'accounting', embedding: FAR }] });
  assert.deepEqual(onMyPath({ subject: ANA, records: [ana, far] }).people, []);
  const plain = profile(DEE, { handle: 'dee_grain', show_pursuits: true, pursuits: [{ title: 'bread and grain' }] });
  assert.deepEqual(onMyPath({ subject: ANA, records: [ana, plain] }).people, []);
  assert.deepEqual(onMyPath({ subject: BO, records: [ana, bo] }).people, []);
});

test('the released states are states of the introduction owner, and the rest are not released', () => {
  for (const state of RELEASED) assert.ok(KNOWN_STATES.includes(state), `${state} is a state`);
  const notReleased = ['proposed', 'one_yes', 'sent', 'declined', 'passed', 'expired'];
  for (const state of notReleased) assert.ok(KNOWN_STATES.includes(state) && !RELEASED.includes(state), `${state} is not released`);
  assert.deepEqual([...RELEASED, ...notReleased].sort(), [...KNOWN_STATES].sort());
  assert.ok(Object.keys(introductionStates.states).length >= KNOWN_STATES.length);
});

function introduction(state, between = [ANA, BO]) {
  const pair = [...between].sort();
  return { type: KINDS.introduction, id: rowId('introduction', ...pair), value: { between: pair, state } };
}

test('a released state gives the contact to the other person: accepted, waiting for AIs, introduced, talked', () => {
  for (const state of ['accepted', 'waiting_for_ais', 'introduced', 'talked']) {
    const answer = readNetworkContact({ subject: BO, of: ANA, records: [ana, introduction(state)] });
    assert.equal(answer.contact, 'ana@example.com', state);
    assert.equal(answer.state, state);
  }
});

test('an unreleased or ended state refuses the contact: proposed, one yes, sent, declined, passed, expired', () => {
  for (const state of ['proposed', 'one_yes', 'sent', 'declined', 'passed', 'expired']) {
    assert.throws(() => readNetworkContact({ subject: BO, of: ANA, records: [ana, introduction(state)] }), /after both people agree to meet and while both stay connected/, state);
  }
});

test('a stranger, an introduction between other people, and a person with no contact kept are each refused', () => {
  assert.throws(() => readNetworkContact({ subject: CARL, of: ANA, records: [ana, introduction('talked')] }), /after both people agree/);
  assert.throws(() => readNetworkContact({ subject: BO, of: ANA, records: [ana, introduction('talked', [CARL, ANA])] }), /after both people agree/);
  assert.throws(() => readNetworkContact({ subject: BO, of: BO, records: [bo, introduction('talked')] }), /No contact is kept/);
});

test('the four tool rows run the one process with their function named', () => {
  const expect = { 'tool:network-profile': 'networkProfile', 'tool:find-network-people': 'findNetworkPeople', 'tool:on-my-path': 'onMyPath', 'tool:read-a-network-contact': 'readNetworkContact' };
  for (const [id, fn] of Object.entries(expect)) {
    const row = rows.records.find(record => record.payload.id === id);
    assert.ok(row, `${id} exists`);
    assert.equal(row.payload.invoke.argv.at(-1), fn);
    assert.ok(row.payload.invoke.credential_mounts.some(mount => mount.fd === 3));
  }
});

test('the action writes the changed row with the value it read, and refuses a row that moved since', async () => {
  const seen = [];
  const client = {
    async query(text, values) {
      seen.push([text.split('(')[0].trim().slice(0, 40), values]);
      if (text.startsWith('SELECT')) return { rows: [{ id: rowId('profile', ANA), type: KINDS.profile, value: ana.value }], rowCount: 1 };
      if (text.startsWith('UPDATE')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const made = await runNetworkAction('networkProfile', { subject: ANA, about: 'Bread teacher, weekends' }, client);
  assert.equal(made.stored, 1);
  assert.ok(seen.some(([text]) => text.startsWith('CREATE TABLE IF NOT EXISTS')));
  assert.ok(seen.some(([text]) => text.startsWith('UPDATE network_records')));
  const moved = { async query(text) { if (text.startsWith('SELECT')) return { rows: [{ id: rowId('profile', ANA), type: KINDS.profile, value: ana.value }], rowCount: 1 }; if (text.startsWith('UPDATE')) return { rows: [], rowCount: 0 }; return { rows: [], rowCount: 0 }; } };
  await assert.rejects(runNetworkAction('networkProfile', { subject: ANA, about: 'changed' }, moved), /changed since it was read/);
});

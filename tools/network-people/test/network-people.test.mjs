// The Network rows run as the container runs them, with the profile rows handed in and no store: a person changes their profile
// and the change comes back under `keep`; a search answers people by handle and never by contact; the paths answer shared pursuits
// between people who chose to show them. Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };
import { findNetworkPeople, networkProfile, onMyPath } from '../do-work/network-people.mjs';
import { KINDS, rowId } from '../read-data/profile-rows.mjs';

const ANA = 'person:ana';
const BO = 'person:bo';
const CARL = 'person:carl';
const profile = (subject, value) => ({ type: KINDS.profile, id: rowId('profile', subject), value: { subject, findable: true, open_to_messages: true, show_pursuits: false, links: [], pursuits: [], written: [], ...value } });
const ana = profile(ANA, { handle: 'ana_bakes', name: 'Ana', offering: 'Sourdough baking classes at home', seeking: 'Pastry sales help', about: 'Bread teacher', contact: 'ana@example.com', show_pursuits: true, pursuits: ['sourdough bread classes'] });
const bo = profile(BO, { handle: 'bo_flour', name: 'Bo', offering: 'Flour milling', seeking: 'Sourdough baking teachers', pursuits: ['grain milling for bakers'], show_pursuits: true });
const carl = profile(CARL, { handle: 'carl_hidden', name: 'Carl', offering: 'Sourdough baking everything', findable: false, show_pursuits: true, pursuits: ['sourdough baking'] });

test('a person changes their profile; only the fields sent change, and the answer keeps the row and names what was written', () => {
  const made = networkProfile({ subject: ANA, records: [ana], about: 'Bread teacher, weekends', contact: 'ana.new@example.com' });
  assert.deepEqual(made.changed, ['about', 'contact']);
  assert.equal(made.keep.length, 1);
  assert.equal(made.keep[0].id, rowId('profile', ANA));
  assert.equal(made.keep[0].expected.value.about, 'Bread teacher');
  assert.equal(made.profile.contact_set, true);
  assert.equal(made.profile.contact, undefined);
  assert.deepEqual(made.keep[0].value.written, ['about', 'contact']);
});

test('the same words again keep nothing, and an invalid handle or a taken handle is refused', () => {
  assert.equal(networkProfile({ subject: ANA, records: [ana], name: 'Ana' }).keep, undefined);
  assert.throws(() => networkProfile({ subject: ANA, records: [ana], handle: 'x' }), /handle is 3 to 30/);
  assert.throws(() => networkProfile({ subject: ANA, records: [ana, bo], handle: 'bo_flour' }), /taken/);
  assert.throws(() => networkProfile({ subject: ANA, records: [ana], links: ['ftp://example.com'] }), /web address/);
  assert.throws(() => networkProfile({ subject: ANA, records: [ana], findable: 'yes' }), /true or false/);
});

test('a search answers people by handle, by the words of the need, and never by contact; hidden profiles do not answer', () => {
  const found = findNetworkPeople({ subject: BO, records: [ana, bo, carl], need: 'where can I learn sourdough baking' });
  assert.deepEqual(found.people.map(person => person.handle), ['ana_bakes']);
  assert.equal(found.people[0].contact, undefined);
  assert.equal(JSON.stringify(found).includes('ana@example.com'), false);
  assert.throws(() => findNetworkPeople({ subject: BO, records: [ana], need: '' }), /need says/);
});

test('a person who labelled someone unwanted-requests does not find them again', () => {
  const label = { type: KINDS.label, id: rowId('label', 'bo-ana'), value: { relay: ANA, by: BO, label: 'unwanted-requests' } };
  assert.deepEqual(findNetworkPeople({ subject: BO, records: [ana, label], need: 'sourdough' }).people, []);
});

test('the paths answer shared pursuits between people who show them, each with both pursuits beside each other', () => {
  const path = onMyPath({ subject: ANA, records: [ana, bo, carl] });
  assert.deepEqual(path.people, []);
  const fromBo = onMyPath({ subject: BO, records: [ana, bo, carl] });
  assert.equal(fromBo.people.length, 0);
  const shared = profile('person:dee', { handle: 'dee_grain', name: 'Dee', show_pursuits: true, pursuits: ['grain milling and bread'] });
  const near = onMyPath({ subject: BO, records: [bo, shared] });
  assert.deepEqual(near.people.map(person => [person.handle, person.their_pursuit, person.your_pursuit]), [['dee_grain', 'grain milling and bread', 'grain milling for bakers']]);
});

test('the three tool rows sit beside each other and run their functions', () => {
  const expect = { 'tool:network-profile': 'networkProfile', 'tool:find-network-people': 'findNetworkPeople', 'tool:on-my-path': 'onMyPath' };
  for (const [id, fn] of Object.entries(expect)) {
    const row = rows.records.find(record => record.payload.id === id);
    assert.ok(row, `${id} exists`);
    assert.equal(row.payload.invoke.argv.at(-1), fn);
  }
});

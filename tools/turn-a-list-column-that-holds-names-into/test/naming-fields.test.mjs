// test/naming-fields.test.mjs
// A field that names a thing is a link to it (src/naming-fields.mjs, src/lists.mjs invariant 10): a list field whose
// words are the names of another list's rows, or one the rules say names a company, becomes a link over that list at
// idle, every row's words replaced by the row ids (a row made for a name none has), what holds each row answered by the
// EEAF model; a field read by its words never moves, and the idle look runs only after a change marked it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { makeNamingFields } from '../src/naming-fields.mjs';
import listsData from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const companies = { fields: ['company'], list: { id: 'companies', label: 'Companies', row_type: 'company', title_field: 'name', fields: [{ id: 'name', label: 'Name', kind: 'text' }] } };
const fresh = (named_by_field = []) => {
  const store = localStore(':memory:');
  let n = 0;
  const lists = makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` });
  return { store, lists, naming: makeNamingFields({ lists, eeaf: store.eeaf, rules: { ...listsData.naming, named_by_field } }) };
};

test('a field whose words name another list\'s rows becomes a link to them, and a field the rules say names a company links to companies', () => {
  const { store, lists, naming } = fresh([companies]);
  lists.save({ id: 'pillars', label: 'Pillars', fields: [{ id: 'name', label: 'Name', kind: 'text' }] });
  lists.putRows('pillars', { rows: [{ id: 'p1', values: { name: 'Build in public' } }, { id: 'p2', values: { name: 'Tutorials' } }, { id: 'p3', values: { name: 'Behind the scenes' } }] });
  lists.save({ id: 'formats', label: 'Formats', fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'serves', label: 'Serves', kind: 'tags' }, { id: 'tone', label: 'Tone', kind: 'text' }] });
  lists.putRows('formats', { rows: [
    { id: 'f1', values: { name: 'Reel', serves: ['Build in public', 'tutorials'], tone: 'warm' } },
    { id: 'f2', values: { name: 'Carousel', serves: ['Behind the scenes'], tone: 'Tutorials' } },
  ] });
  lists.save({ id: 'crm', label: 'CRM', fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'company', label: 'Company', kind: 'text' }] });
  lists.putRows('crm', { rows: [{ id: 'c1', values: { name: 'Ann', company: 'Acme' } }, { id: 'c2', values: { name: 'Bo', company: ' acme ' } }, { id: 'c3', values: { name: 'Cy', company: 'Globex' } }] });
  assert.ok(naming.nextAt(0) !== null, 'a change marks the lists');
  const found = naming.candidates().map(c => [c.list_id, c.field_id, c.links_to]).sort();
  assert.deepEqual(found, [['crm', 'company', 'companies'], ['formats', 'serves', 'pillars']]);
  while (naming.step(0)) { /* one field a step */ }
  assert.equal(naming.nextAt(0), null, 'nothing left: the mark is cleared');
  const formats = lists.read('formats');
  assert.deepEqual(formats.list.fields.find(f => f.id === 'serves'), { id: 'serves', label: 'Serves', kind: 'link', links_to: 'pillars' });
  assert.deepEqual(formats.rows.find(r => r.id === 'f1').values.serves, ['p1', 'p2']);
  assert.equal(formats.rows.find(r => r.id === 'f2').values.tone, 'Tutorials', 'a field whose words are not mostly names stays words');
  const madeCompanies = lists.read('companies');
  assert.deepEqual(madeCompanies.rows.map(r => r.values.name).sort(), ['Acme', 'Globex']);
  const crm = lists.read('crm');
  const acme = madeCompanies.rows.find(r => r.values.name === 'Acme').id;
  assert.deepEqual(crm.rows.find(r => r.id === 'c1').values.company, [acme]);
  assert.deepEqual(crm.rows.find(r => r.id === 'c2').values.company, [acme]);
  assert.deepEqual(crm.rows.find(r => r.id === 'c1').links.company, [{ id: acme, title: 'Acme' }]);
  // Participation read the other way: which people are at Acme.
  const acmeRecord = `record:${madeCompanies.list.row_type}:${acme}`;
  assert.deepEqual(store.eeaf.holdersOf(acmeRecord).holders.map(h => [h.id, h.role]).sort(), [['record:crm:c1', 'company'], ['record:crm:c2', 'company']]);
});

test('a field read by its words never moves, and nothing runs until a change marks the lists', () => {
  const { lists, naming } = fresh();
  assert.equal(naming.nextAt(0), null);
  lists.save({ id: 'pillars', label: 'Pillars', fields: [{ id: 'name', label: 'Name', kind: 'text' }] });
  lists.putRows('pillars', { rows: [{ id: 'p1', values: { name: 'One' } }, { id: 'p2', values: { name: 'Two' } }] });
  lists.save({ id: 'posts', label: 'Posts', fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'pillar', label: 'Pillar', kind: 'choice', choices: ['One', 'Two'] }],
    views: [{ id: 'ones', label: 'Ones', rules: { kind: 'group', combinator: 'and', rules: [{ field: 'pillar', operator: 'is', value: 'One' }] } }] });
  lists.putRows('posts', { rows: [{ id: 'x', values: { name: 'a', pillar: 'One' } }, { id: 'y', values: { name: 'b', pillar: 'Two' } }] });
  assert.deepEqual(naming.candidates(), []);
});

test('a field that says what it names moves whatever its words are, and a made row links the people its words name', () => {
  const { store, lists, naming } = fresh();
  lists.save({ id: 'crm', label: 'CRM', fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'company', label: 'Company', kind: 'text' }] });
  lists.putRows('crm', { rows: [
    { id: 'morgan-b', values: { name: 'Morgan Boyter' } },
    { id: 'morgan-l', values: { name: 'Morgan Laville', company: 'Sister - Morgan Boyter' } },
    { id: 'handy', values: { name: 'The Handyman', company: 'The Handyman' } },
    { id: 'dad', values: { name: 'Pat', company: 'Dad' } },
  ] });
  const relationships = { id: 'relationships', label: 'Relationships', row_type: 'relationship', title_field: 'name', fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'person', label: 'Person', kind: 'link', links_to: 'crm' }] };
  const crm = lists.find('crm');
  const { id: _id, ...definition } = crm;
  lists.save({ id: 'crm', ...definition, fields: crm.fields.map(field => field.id === 'company' ? { ...field, label: 'How you know them', names: { list: relationships } } : field) });
  while (naming.step(0)) { /* one field a step */ }
  const read = lists.read('crm');
  assert.deepEqual(read.list.fields.find(field => field.id === 'company'), { id: 'company', label: 'How you know them', kind: 'link', links_to: 'relationships' });
  const made = lists.read('relationships').rows;
  assert.deepEqual(made.map(row => row.values.name).sort(), ['Dad', 'Sister - Morgan Boyter', 'The Handyman']);
  assert.deepEqual(made.find(row => row.values.name === 'Sister - Morgan Boyter').values.person, ['morgan-b'], 'the person the words name is linked');
  assert.equal(made.find(row => row.values.name === 'The Handyman').values.person, undefined, 'never the row the words came from');
  assert.deepEqual(read.rows.find(row => row.id === 'morgan-l').links.company.map(link => link.title), ['Sister - Morgan Boyter']);
  // The words it held before stay in its history.
  assert.equal(store.eeaf.valuesAt('record:crm:morgan-l', ['company'])[0].value, 'Sister - Morgan Boyter');
});

// People kept in a list from a source (src/list-people.mjs over trillion-workshop's tools/person-list/do-work/merge-people.mjs): a missing
// list is made, an existing list's own fields are filled instead of near-duplicates, each person is one row across
// sources and syncs (matched by the source's own row, a phone number however it is written, or an email), nothing a
// person typed is lost, a repeated sync writes nothing, a source nobody designed for needs no change, and the route
// answers through the person's store with every refusal saying what to send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { fieldsFor, handleListPeopleRequest, keepPeopleInList } from '../src/list-people.mjs';
import { mergePeople } from '../../person-list/do-work/merge-people.mjs';

const MAC = { id: 'mac-contacts', label: 'Mac Contacts' };
const fresh = () => {
  const store = localStore(':memory:');
  const owners = { eeaf: store.eeaf, lists: makeLists({ eeaf: store.eeaf }) };
  let writes = 0;
  const write = store.eeaf.write.bind(store.eeaf);
  store.eeaf.write = (records, options) => { writes += records.length; return write(records, options); };
  return { owners, writes: () => writes };
};
const byTitle = (owners, list) => Object.fromEntries(owners.lists.read(list).rows.map(row => [row.title, row.values]));

test('a missing list is made with the fields a source fills, and each person lands once with the source on the row', () => {
  const { owners } = fresh();
  const kept = keepPeopleInList(owners, 'trillion-crm', {
    list_label: 'Trillion CRM', source: MAC,
    people: [
      { key: 'A1:ABPerson', name: 'Ada Stone', phones: ['+1 (555) 123-4567'], emails: ['Ada@Example.com'], organization: 'Stone Labs' },
      { key: 'B2:ABPerson', name: 'Bo Lind', phones: ['+45 12 34 56 78', '+45 87 65 43 21'] },
    ],
  });
  assert.deepEqual([kept.added, kept.updated, kept.unchanged], [2, 0, 0]);
  const { list } = owners.lists.read('trillion-crm');
  assert.equal(list.label, 'Trillion CRM');
  assert.equal(list.title_field, 'name');
  assert.deepEqual(list.fields.map(field => [field.id, field.kind]), [['name', 'text'], ['phone', 'phone'], ['email', 'email'], ['company', 'text'], ['job_title', 'text'], ['source', 'tags']]);
  const rows = byTitle(owners, 'trillion-crm');
  assert.equal(rows['Ada Stone'].company, 'Stone Labs');
  assert.deepEqual(rows['Ada Stone'].source, ['Mac Contacts']);
  assert.equal(rows['Bo Lind'].phone, '+45 12 34 56 78, +45 87 65 43 21');
});

test('an existing list keeps its label and its own fields are filled instead of near-duplicates', () => {
  const { owners } = fresh();
  owners.lists.save({ id: 'trillion-crm', label: 'Trillion CRM', fields: [{ id: 'full_name', label: 'Full name' }, { id: 'mobile', label: 'Mobile', kind: 'phone' }, { id: 'organisation', label: 'Organisation' }, { id: 'stage', label: 'Stage', kind: 'choice' }] });
  owners.lists.putRows('trillion-crm', { rows: [{ id: 'jc', values: { full_name: 'JC Freeman', stage: 'invited' } }] });
  keepPeopleInList(owners, 'trillion-crm', { source: MAC, people: [{ key: 'C3', name: 'Caro Vale', phones: ['555 222 3333'], organization: 'Vale Co' }] });
  const { list } = owners.lists.read('trillion-crm');
  assert.equal(list.label, 'Trillion CRM');
  assert.deepEqual(list.fields.map(field => field.id), ['full_name', 'mobile', 'organisation', 'stage', 'email', 'job_title', 'source']);
  const rows = byTitle(owners, 'trillion-crm');
  assert.equal(rows['Caro Vale'].mobile, '555 222 3333');
  assert.equal(rows['Caro Vale'].organisation, 'Vale Co');
  assert.equal(rows['JC Freeman'].stage, 'invited');
  assert.deepEqual(fieldsFor(list).filter(item => item.adding), []);
});

test('a list whose fields hold other kinds of values: a text field keeps the sources as words, a number or link field is never filled', () => {
  const { owners } = fresh();
  owners.lists.save({ id: 'crm', label: 'CRM', fields: [{ id: 'name', label: 'Name' }, { id: 'source', label: 'Source' }, { id: 'company', label: 'Company', kind: 'link', links_to: 'crm' }, { id: 'phone', label: 'Phone', kind: 'number' }] });
  keepPeopleInList(owners, 'crm', { source: MAC, people: [{ key: 'J1', name: 'Jo Rae', phones: ['555 777 8888'], organization: 'Rae Ltd' }] });
  keepPeopleInList(owners, 'crm', { source: { id: 'clinic-csv', label: 'Clinic export' }, people: [{ key: 'r1', name: 'Jo Rae', phones: ['+1 555 777 8888'] }] });
  const { list } = owners.lists.read('crm');
  assert.deepEqual(list.fields.map(field => [field.id, field.kind ?? 'text']), [['name', 'text'], ['source', 'text'], ['company', 'link'], ['phone', 'number'], ['phone_2', 'phone'], ['email', 'email'], ['company_2', 'text'], ['job_title', 'text']]);
  const row = byTitle(owners, 'crm')['Jo Rae'];
  assert.equal(row.source, 'Mac Contacts, Clinic export');
  assert.equal(row.phone_2, '555 777 8888');
  assert.equal(row.company_2, 'Rae Ltd');
});

test('a row someone made with only a name is the person when no other row or person has that name, and a source row made before folds into it', () => {
  const { owners } = fresh();
  owners.lists.save({ id: 'crm', label: 'CRM', fields: [{ id: 'name', label: 'Name' }, { id: 'email', label: 'Email', kind: 'email' }, { id: 'stage', label: 'Stage', kind: 'choice' }, { id: 'source', label: 'Where this came from' }, { id: 'phone', label: 'Phone', kind: 'phone' }] });
  owners.lists.putRows('crm', { rows: [
    { id: 'caro', values: { name: 'Caro', stage: 'invited', source: 'Met at the club' } },
    { id: 'sofi', values: { name: 'Sofi (Riley Brand)', email: 'sofi@example.com', stage: 'paid' } },
  ] });
  // An earlier sync that did not match by name made the source's own rows for both.
  owners.lists.putRows('crm', { rows: [
    { id: 'mac-contacts:K1', values: { name: 'Caro', phone: '555 111 2222', source: 'Mac Contacts' } },
    { id: 'mac-contacts:K2', values: { name: 'Sofi “Riley” Brand', phone: '555 333 4444', source: 'Mac Contacts' } },
  ] });
  const people = [{ key: 'K1', name: 'Caro', phones: ['555 111 2222'] }, { key: 'K2', name: 'Sofi “Riley” Brand', phones: ['555 333 4444'] }];
  const kept = keepPeopleInList(owners, 'crm', { source: MAC, people });
  assert.equal(kept.folded, 2);
  const rows = Object.fromEntries(owners.lists.read('crm').rows.map(row => [row.id, row.values]));
  assert.deepEqual(Object.keys(rows).sort(), ['caro', 'sofi']);
  assert.deepEqual([rows.caro.phone, rows.caro.stage, rows.caro.source], ['555 111 2222', 'invited', 'Met at the club, Mac Contacts']);
  assert.deepEqual([rows.sofi.phone, rows.sofi.email, rows.sofi.name], ['555 333 4444', 'sofi@example.com', 'Sofi (Riley Brand)']);
  // The next sync finds them by phone and writes nothing.
  const again = keepPeopleInList(owners, 'crm', { source: MAC, people });
  assert.deepEqual([again.added, again.updated, again.folded, again.unchanged], [0, 0, 0, 2]);
});

test('a name matches only when it is certain: never a name two rows or two people share, a row whose phone is someone else\'s, or a fold that would drop what was typed', () => {
  const { owners } = fresh();
  owners.lists.save({ id: 'crm', label: 'CRM', fields: [{ id: 'name', label: 'Name' }, { id: 'phone', label: 'Phone', kind: 'phone' }, { id: 'notes', label: 'Notes', kind: 'long-text' }] });
  owners.lists.putRows('crm', { rows: [
    { id: 'sam-a', values: { name: 'Sam' } }, { id: 'sam-b', values: { name: 'Sam' } },
    { id: 'lee', values: { name: 'Lee', phone: '555 999 8888' } },
    { id: 'kim', values: { name: 'Kim' } }, { id: 'kim-2', values: { name: 'Ana' } },
    { id: 'rue', values: { name: 'Rue', notes: 'from the gym' } },
    { id: 'mac-contacts:R1', values: { name: 'Rue', phone: '555 000 7777', notes: 'typed on the synced row' } },
  ] });
  const kept = keepPeopleInList(owners, 'crm', { source: MAC, people: [
    { key: 'S1', name: 'Sam', phones: ['555 101 0101'] },
    { key: 'L1', name: 'Lee', phones: ['555 222 1111'] },
    { key: 'A1', name: 'Ana', phones: ['555 303 0303'] }, { key: 'A2', name: 'Ana', phones: ['555 404 0404'] },
    { key: 'R1', name: 'Rue', phones: ['555 000 7777'] },
  ] });
  assert.equal(kept.folded, 0);
  const rows = Object.fromEntries(owners.lists.read('crm').rows.map(row => [row.id, row.values]));
  for (const id of ['mac-contacts:S1', 'mac-contacts:L1', 'mac-contacts:A1', 'mac-contacts:A2', 'mac-contacts:R1']) assert.ok(rows[id], id);
  assert.equal(rows.lee.phone, '555 999 8888');
  assert.equal(rows['kim-2'].phone, undefined);
  assert.equal(rows.rue.notes, 'from the gym');
});

test('the same person from a phone number written another way, an email, or a second source is one row, and nothing typed is lost', () => {
  const { owners } = fresh();
  owners.lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, { id: 'phone', label: 'Phone', kind: 'phone' }, { id: 'email', label: 'Email', kind: 'email' }, { id: 'company', label: 'Company' }, { id: 'notes', label: 'Notes', kind: 'long-text' }] });
  owners.lists.putRows('people', { rows: [{ id: 'typed', values: { name: 'Dee Lo (my name for her)', phone: '5551234567', company: '', notes: 'Met at the club' } }] });
  const kept = keepPeopleInList(owners, 'people', { source: MAC, people: [
    { key: 'D4', name: 'Dee Lo', phones: ['+1 (555) 123-4567', '+1 555 999 0000'], emails: ['dee@lo.com'], organization: 'Lo & Co' },
    { key: 'E5', name: 'Eve Park', emails: ['EVE@park.io'] },
  ] });
  assert.deepEqual([kept.added, kept.updated], [1, 1]);
  const csv = { id: 'clinic-csv', label: 'Clinic export' };
  const second = keepPeopleInList(owners, 'people', { source: csv, people: [{ key: 'row-9', name: 'Eve P.', emails: ['eve@PARK.io'], phones: ['07700 900123'] }] });
  assert.deepEqual([second.added, second.updated], [0, 1]);
  const rows = byTitle(owners, 'people');
  assert.equal(Object.keys(rows).length, 2);
  const dee = rows['Dee Lo (my name for her)'];
  assert.equal(dee.phone, '5551234567, +1 555 999 0000');
  assert.equal(dee.email, 'dee@lo.com');
  assert.equal(dee.company, 'Lo & Co');
  assert.equal(dee.notes, 'Met at the club');
  assert.deepEqual(rows['Eve Park'].source, ['Mac Contacts', 'Clinic export']);
  assert.equal(rows['Eve Park'].phone, '07700 900123');
});

test('a repeated sync writes nothing, and a changed contact updates only its own row', () => {
  const { owners, writes } = fresh();
  const people = [{ key: 'F6', name: 'Finn Moe', phones: ['555 444 1212'] }, { key: 'G7', name: 'Gus', emails: ['gus@example.com'] }];
  keepPeopleInList(owners, 'crm', { list_label: 'CRM', source: MAC, people });
  const before = writes();
  const again = keepPeopleInList(owners, 'crm', { source: MAC, people });
  assert.deepEqual([again.added, again.updated, again.unchanged], [0, 0, 2]);
  assert.equal(writes(), before);
  const renamed = keepPeopleInList(owners, 'crm', { source: MAC, people: [{ key: 'F6', name: 'Finn Moe-Berg', phones: ['555 444 1212'] }] });
  assert.deepEqual([renamed.added, renamed.updated], [0, 1]);
  assert.ok(byTitle(owners, 'crm')['Finn Moe-Berg']);
});

test('people in one batch who share a key become one row', () => {
  const merged = mergePeople({
    rows: [],
    fills: [{ from: 'name', field_id: 'name', merge: 'fill' }, { from: 'phones', field_id: 'phone', merge: 'keys', normalize: 'digits', suffix_digits: 7, join: ', ' }],
    source: MAC,
    people: [{ key: 'H8', name: 'Hal', phones: ['0045 11 22 33 44'] }, { key: 'H9', name: 'Hal (work card)', phones: ['+45 11223344'] }],
  });
  assert.deepEqual([merged.added, merged.updated, merged.writes.length], [1, 0, 1]);
  assert.equal(merged.writes[0].values.phone, '0045 11 22 33 44');
});

test('short numbers only match exactly, so two different people with the same last digits stay apart', () => {
  const fills = [{ from: 'phones', field_id: 'phone', merge: 'keys', normalize: 'digits', suffix_digits: 7, join: ', ' }];
  const merged = mergePeople({ rows: [{ id: 'x', values: { phone: '1234' } }], fills, source: MAC, people: [{ key: 'I1', phones: ['551234'] }] });
  assert.deepEqual([merged.added, merged.updated], [1, 0]);
});

test('the route answers through the store, and every refusal says what to send', async () => {
  const { owners } = fresh();
  const ask = (path, body) => handleListPeopleRequest(owners, new Request(`https://person${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'x-trillion-app': 'sync-contacts' } }));
  const ok = await ask('/lists/trillion-crm/people', { list_label: 'Trillion CRM', source: MAC, people: [{ key: 'S1', name: 'Sam', phones: ['555 000 1111'] }] });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).added, 1);
  const cases = [
    [{ source: MAC, people: [] }, /does not exist yet; send list_label/, '/lists/other/people'],
    [{ source: { id: 'Mac Contacts', label: 'x' }, people: [] }, /Name the source as \{ id, label \}/],
    [{ source: MAC, people: [{ name: 'No key' }] }, /Person 0 has no key/],
    [{ source: MAC, people: 'everyone' }, /Send people as a list of at most 500/],
    ['{not json', /JSON|Unexpected|Expected/],
  ];
  for (const [body, words, path = '/lists/trillion-crm/people'] of cases) {
    const refused = await ask(path, body);
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, words);
  }
});

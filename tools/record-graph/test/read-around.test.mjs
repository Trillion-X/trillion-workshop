// The model around one record from the rows handed in: the old orderedRelations and contactHistory (ported with
// test/activity-history.test.mjs), every relation of a record grouped by side and role, and its neighbours a bounded
// number of steps away. Every record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contactHistory, orderedRelations, readAround } from '../read-data/read-around.mjs';
import { MODEL } from '../read-data/graph-records.mjs';
import { activityRow, happenings, me, relationRow } from './graph-rows.mjs';

const ann = 'record:crm:ann', bo = 'record:crm:bo', cy = 'record:crm:cy';

test('a person\'s history is every activity they took part in, newest first, with when they were last in touch', async () => {
  const rows = happenings();
  const history = await contactHistory(rows, { id: ann });
  assert.deepEqual(history.activities.map(one => one.kind), ['meeting', 'call', 'email']);
  assert.equal(history.last_contact, '2026-05-03T15:00:00.000Z');
  assert.deepEqual(history.activities[1].as, ['caller'], 'each says the role this record took');
  assert.equal(history.count, 3);
  assert.equal(history.complete, true);
  assert.equal((await contactHistory(rows, { id: 'me' })).count, 4, 'me is the person whose store it is');
});

test('a pair\'s shared history, a kind, a role and a time window narrow it; an entity that took part has its own', async () => {
  const rows = happenings();
  const kinds = async input => (await contactHistory(rows, input)).activities.map(one => one.kind);
  assert.deepEqual(await kinds({ id: ann, with: bo }), ['meeting']);
  assert.deepEqual(await kinds({ id: ann, kinds: 'email,call' }), ['call', 'email']);
  assert.deepEqual(await kinds({ id: ann, kinds: ['email', 'call'] }), ['call', 'email']);
  assert.deepEqual(await kinds({ id: ann, role: 'caller' }), ['call']);
  assert.deepEqual(await kinds({ id: ann, since: '2026-04-01T00:00:00Z', until: '2026-04-30T00:00:00Z' }), ['call']);
  assert.equal((await contactHistory(rows, { id: ann, until: '2026-03-15T00:00:00Z' })).last_contact, '2026-03-01T10:00:00.000Z', 'last contact as of a time');
  assert.deepEqual(await kinds({ id: 'organisation:acme' }), ['meeting']);
  assert.deepEqual(await kinds({ id: 'me', with: cy }), ['message']);
  assert.equal((await contactHistory(rows, { id: 'record:crm:nobody' })).last_contact, null);
  assert.equal((await contactHistory(rows, { id: ann, limit: 1 })).activities.length, 1);
  await assert.rejects(contactHistory(rows, { id: ann, kinds: 'carrier-pigeon' }), /An activity is one of/);
  await assert.rejects(contactHistory(rows, { id: ann, role: 'boss' }), /A participant's role is one of/);
  await assert.rejects(contactHistory(rows, { id: ann, since: 'last week' }), /since is a date-time/);
  await assert.rejects(contactHistory(rows, {}), /Say whose history to read/);
});

test('naming kinds narrows the read, and a history past its read bound says it is not complete', async () => {
  const rows = happenings();
  assert.deepEqual((await contactHistory(rows, { id: ann, kinds: 'call' })).activities.map(one => one.kind), ['call']);
  const small = { ...MODEL, activities: { ...MODEL.activities, scan_most: 2 } };
  assert.equal((await contactHistory(rows, { id: 'me' }, { model: small })).complete, false);
  const fewKept = { ...MODEL, activities: { ...MODEL.activities, history_most: 2 } };
  const capped = await contactHistory(rows, { id: 'me' }, { model: fewKept });
  assert.deepEqual([capped.count, capped.complete], [2, false]);
});

test('the ordered read answers one end and role in that end\'s own order, and refuses a side that is not one', async () => {
  const rows = [relationRow('record:crm:pat', 'dad', me, { objectOrder: 'V' }), relationRow('record:crm:lee', 'dad', me, { objectOrder: 'W' })];
  const answer = await orderedRelations(rows, { id: 'me', side: 'object', role: 'dad' });
  assert.deepEqual(answer.relations.map(one => one.subject), ['record:crm:pat', 'record:crm:lee']);
  assert.deepEqual([answer.id, answer.side, answer.role, answer.complete], [me, 'object', 'dad', true]);
  await assert.rejects(orderedRelations(rows, { id: 'me', side: 'sideways', role: 'dad' }), /side is subject or object/);
  await assert.rejects(orderedRelations(rows, { id: 'me', side: 'object' }), /Say which record \(id\) and which role/);
  const small = { ...MODEL, relations: { ...MODEL.relations, side_most: 1 } };
  assert.equal((await orderedRelations(rows, { id: 'me', side: 'object', role: 'dad' }, { model: small })).complete, false);
});

test('around a record: every relation by side and role in order, its history, and nothing more unless hops is asked', async () => {
  const records = [
    relationRow(ann, 'member', 'group:alpha', { subjectOrder: 'V' }),
    relationRow(ann, 'member', 'group:beta', { subjectOrder: 'W' }),
    relationRow(ann, 'sister', bo),
    relationRow(cy, 'mentor', ann),
    relationRow(ann, 'member', 'group:gone', { subjectOrder: 'X', alive: false }),
    ...happenings(),
  ];
  const around = await readAround({ records, id: ann });
  assert.deepEqual(around.relations.map(group => [group.side, group.role, group.relations.map(one => one.subject === ann ? one.object : one.subject)]), [
    ['subject', 'member', ['group:alpha', 'group:beta']],
    ['subject', 'sister', [bo]],
    ['object', 'mentor', [cy]],
  ]);
  assert.deepEqual(around.history.activities.map(one => one.kind), ['meeting', 'call', 'email']);
  assert.equal(around.neighbours, undefined);
  assert.equal(around.complete, true);
  const narrowed = await readAround({ records, id: ann, side: 'subject', role: 'Member', ended: true, history: false });
  assert.deepEqual(narrowed.relations.map(group => group.relations.map(one => one.object)), [['group:alpha', 'group:beta', 'group:gone']]);
  assert.equal(narrowed.history, undefined);
  const calls = await readAround({ records, id: ann, history: { kinds: 'call' } });
  assert.deepEqual(calls.history.activities.map(one => one.kind), ['call']);
  await assert.rejects(readAround({ records }), /Say which record to read the graph around/);
  await assert.rejects(readAround({ records, id: ann, hops: 9 }), /hops is a whole number from 1 to 4/);
  await assert.rejects(readAround({ records, id: ann, side: 'up' }), /side is subject or object/);
  await assert.rejects(readAround({ id: ann }), /records is the rows you hold/);
});

test('neighbours: every record within hops steps, through relations and the activities it took part in, nearest first', async () => {
  const records = [
    relationRow(ann, 'member', 'group:alpha'),
    relationRow('record:crm:dee', 'member', 'group:alpha'),
    relationRow('record:crm:eve', 'sister', 'record:crm:dee'),
    activityRow('call-2', 'call', '2026-06-01T10:00:00Z', [{ record: ann, role: 'caller' }, { record: bo, role: 'recipient' }]),
  ];
  const around = input => readAround({ records, id: ann, history: false, ...input });
  const one = (await around({ hops: 1 })).neighbours;
  assert.deepEqual(one.records.map(record => [record.id.split(':')[0], record.distance]), [['activity', 1], ['group', 1]]);
  assert.equal(one.records[0].via.role, 'caller');
  const two = (await around({ hops: 2 })).neighbours;
  assert.deepEqual(two.records.filter(record => record.distance === 2).map(record => record.id), [bo, 'record:crm:dee']);
  assert.deepEqual(two.records.find(record => record.id === 'record:crm:dee').via, { from: 'group:alpha', to: 'record:crm:dee', by: two.records.find(record => record.id === 'record:crm:dee').via.by, kind: 'relation', role: 'member', side: 'object' });
  const three = (await around({ hops: 3 })).neighbours;
  assert.ok(three.records.some(record => record.id === 'record:crm:eve' && record.distance === 3));
  const relationsOnly = (await around({ hops: 2, activities: false })).neighbours;
  assert.ok(!relationsOnly.records.some(record => record.id === bo), 'activities left out of the walk');
  const limited = (await around({ hops: 3, limit: 2 })).neighbours;
  assert.deepEqual([limited.records.length, limited.complete], [2, false]);
});

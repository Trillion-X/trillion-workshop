// The model around one record over the records door: the old orderedRelations and contactHistory (ported with
// test/activity-history.test.mjs), every relation of a record grouped by side and role, and its neighbours a bounded
// number of steps away. Every record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { relate } from '../do-work/relate.mjs';
import { contactHistory, orderedRelations, readAround } from '../read-data/read-around.mjs';
import { MODEL } from '../read-data/graph-records.mjs';
import { freshDoor } from './graph-door.mjs';
import { seedActivities } from './fixtures.mjs';

const ann = 'record:crm:ann', bo = 'record:crm:bo', cy = 'record:crm:cy';
const me = MODEL.relations.self;

test('a person\'s history is every activity they took part in, newest first, with when they were last in touch', async t => {
  const { door } = await freshDoor(t);
  await seedActivities(door);
  const history = await contactHistory(door, { id: ann });
  assert.deepEqual(history.activities.map(one => one.kind), ['meeting', 'call', 'email']);
  assert.equal(history.last_contact, '2026-05-03T15:00:00.000Z');
  assert.deepEqual(history.activities[1].as, ['caller'], 'each says the role this record took');
  assert.equal(history.count, 3);
  assert.equal(history.complete, true);
  assert.equal((await contactHistory(door, { id: 'me' })).count, 4, 'me is the person whose store it is');
});

test('a pair\'s shared history, a kind, a role and a time window narrow it; an entity that took part has its own', async t => {
  const { door } = await freshDoor(t);
  await seedActivities(door);
  const kinds = async input => (await contactHistory(door, input)).activities.map(one => one.kind);
  assert.deepEqual(await kinds({ id: ann, with: bo }), ['meeting']);
  assert.deepEqual(await kinds({ id: ann, kinds: 'email,call' }), ['call', 'email']);
  assert.deepEqual(await kinds({ id: ann, kinds: ['email', 'call'] }), ['call', 'email']);
  assert.deepEqual(await kinds({ id: ann, role: 'caller' }), ['call']);
  assert.deepEqual(await kinds({ id: ann, since: '2026-04-01T00:00:00Z', until: '2026-04-30T00:00:00Z' }), ['call']);
  assert.equal((await contactHistory(door, { id: ann, until: '2026-03-15T00:00:00Z' })).last_contact, '2026-03-01T10:00:00.000Z', 'last contact as of a time');
  assert.deepEqual(await kinds({ id: 'organisation:acme' }), ['meeting']);
  assert.deepEqual(await kinds({ id: 'me', with: cy }), ['message']);
  assert.equal((await contactHistory(door, { id: 'record:crm:nobody' })).last_contact, null);
  assert.equal((await contactHistory(door, { id: ann, limit: 1 })).activities.length, 1);
  await assert.rejects(contactHistory(door, { id: ann, kinds: 'carrier-pigeon' }), /An activity is one of/);
  await assert.rejects(contactHistory(door, { id: ann, role: 'boss' }), /A participant's role is one of/);
  await assert.rejects(contactHistory(door, { id: ann, since: 'last week' }), /since is a date-time/);
  await assert.rejects(contactHistory(door, {}), /Say whose history to read/);
});

test('naming kinds narrows the read at the door, and a history past its read bound says it is not complete', async t => {
  const { door, fake } = await freshDoor(t);
  await seedActivities(door);
  await contactHistory(door, { id: ann, kinds: 'call' });
  assert.deepEqual(fake.calls.filter(call => call.method === 'records:list').at(-1).input.where, { kind: 'call' });
  const small = { ...MODEL, activities: { ...MODEL.activities, scan_most: 2 } };
  assert.equal((await contactHistory(door, { id: 'me' }, { model: small })).complete, false);
  const fewKept = { ...MODEL, activities: { ...MODEL.activities, history_most: 2 } };
  const capped = await contactHistory(door, { id: 'me' }, { model: fewKept });
  assert.deepEqual([capped.count, capped.complete], [2, false]);
});

test('the ordered read answers one end and role in that end\'s own order, and refuses a side that is not one', async t => {
  const { door } = await freshDoor(t);
  await relate(door, { relations: [{ subject: 'record:crm:pat', role: 'dad', object: 'me' }, { subject: 'record:crm:lee', role: 'dad', object: 'me' }] });
  const answer = await orderedRelations(door, { id: 'me', side: 'object', role: 'dad' });
  assert.deepEqual(answer.relations.map(one => one.subject), ['record:crm:pat', 'record:crm:lee']);
  assert.deepEqual([answer.id, answer.side, answer.role, answer.complete], [me, 'object', 'dad', true]);
  await assert.rejects(orderedRelations(door, { id: 'me', side: 'sideways', role: 'dad' }), /side is subject or object/);
  await assert.rejects(orderedRelations(door, { id: 'me', side: 'object' }), /Say which record \(id\) and which role/);
  const small = { ...MODEL, relations: { ...MODEL.relations, side_most: 1 } };
  assert.equal((await orderedRelations(door, { id: 'me', side: 'object', role: 'dad' }, { model: small })).complete, false);
});

test('around a record: every relation by side and role in order, its history, and nothing more unless hops is asked', async t => {
  const { door } = await freshDoor(t);
  await relate(door, { relations: [
    { subject: ann, role: 'member', object: 'group:alpha' },
    { subject: ann, role: 'member', object: 'group:beta' },
    { subject: ann, role: 'sister', object: bo },
    { subject: cy, role: 'mentor', object: ann },
    { subject: ann, role: 'member', object: 'group:gone', alive: false },
  ] });
  await seedActivities(door);
  const around = await readAround({ id: ann }, { door });
  assert.deepEqual(around.relations.map(group => [group.side, group.role, group.relations.map(one => one.subject === ann ? one.object : one.subject)]), [
    ['subject', 'member', ['group:alpha', 'group:beta']],
    ['subject', 'sister', [bo]],
    ['object', 'mentor', [cy]],
  ]);
  assert.deepEqual(around.history.activities.map(one => one.kind), ['meeting', 'call', 'email']);
  assert.equal(around.neighbours, undefined);
  assert.equal(around.complete, true);
  const narrowed = await readAround({ id: ann, side: 'subject', role: 'Member', ended: true, history: false }, { door });
  assert.deepEqual(narrowed.relations.map(group => group.relations.map(one => one.object)), [['group:alpha', 'group:beta', 'group:gone']]);
  assert.equal(narrowed.history, undefined);
  const calls = await readAround({ id: ann, history: { kinds: 'call' } }, { door });
  assert.deepEqual(calls.history.activities.map(one => one.kind), ['call']);
  await assert.rejects(readAround({}, { door }), /Say which record to read the graph around/);
  await assert.rejects(readAround({ id: ann, hops: 9 }, { door }), /hops is a whole number from 1 to 4/);
  await assert.rejects(readAround({ id: ann, side: 'up' }, { door }), /side is subject or object/);
});

test('neighbours: every record within hops steps, through relations and the activities it took part in, nearest first', async t => {
  const { door } = await freshDoor(t);
  await relate(door, { relations: [
    { subject: ann, role: 'member', object: 'group:alpha' },
    { subject: 'record:crm:dee', role: 'member', object: 'group:alpha' },
    { subject: 'record:crm:eve', role: 'sister', object: 'record:crm:dee' },
  ] });
  await relate(door, { activities: [{ kind: 'call', at: '2026-06-01T10:00:00Z', participants: [{ record: ann, role: 'caller' }, { record: bo, role: 'recipient' }] }] });
  const one = (await readAround({ id: ann, hops: 1, history: false }, { door })).neighbours;
  assert.deepEqual(one.records.map(record => [record.id.split(':')[0], record.distance]), [['activity', 1], ['group', 1]]);
  assert.equal(one.records[0].via.role, 'caller');
  const two = (await readAround({ id: ann, hops: 2, history: false }, { door })).neighbours;
  assert.deepEqual(two.records.filter(record => record.distance === 2).map(record => record.id), [bo, 'record:crm:dee']);
  assert.deepEqual(two.records.find(record => record.id === 'record:crm:dee').via, { from: 'group:alpha', to: 'record:crm:dee', by: two.records.find(record => record.id === 'record:crm:dee').via.by, kind: 'relation', role: 'member', side: 'object' });
  const three = (await readAround({ id: ann, hops: 3, history: false }, { door })).neighbours;
  assert.ok(three.records.some(record => record.id === 'record:crm:eve' && record.distance === 3));
  const relationsOnly = (await readAround({ id: ann, hops: 2, activities: false, history: false }, { door })).neighbours;
  assert.ok(!relationsOnly.records.some(record => record.id === bo), 'activities left out of the walk');
  const limited = (await readAround({ id: ann, hops: 3, limit: 2, history: false }, { door })).neighbours;
  assert.deepEqual([limited.records.length, limited.complete], [2, false]);
});

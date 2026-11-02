// relate, ported from Trillion src/record-model-tools.mjs with its tests (test/record-model.test.mjs "a relation is
// participation", test/relation-order-and-alive.test.mjs, test/activity-history.test.mjs), now over the records door:
// the same ids, values, order keys and refusals. Every record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { relate } from '../do-work/relate.mjs';
import { orderedRelations } from '../read-data/read-around.mjs';
import { MODEL, textHash } from '../read-data/graph-records.mjs';
import { freshDoor } from './graph-door.mjs';
import { seedActivities } from './fixtures.mjs';

const order = async (door, id, side, role, ended) => (await orderedRelations(door, { id, side, role, ended })).relations.map(one => side === 'subject' ? one.object : one.subject);
const ofKind = (fake, type) => [...fake.kept.values()].filter(record => record.type === type);

test('a relation is participation with its role as data: each end reads it under its role, and groups become entities', async t => {
  const { door, fake } = await freshDoor(t);
  const said = await relate(door, { relations: [
    { subject: 'record:crm:pat', role: 'Dad', object: 'me', said: 'Dad' },
    { subject: 'record:crm:ann', role: 'member', object: 'organisation:Example Club', said: 'Example Club' },
    { subject: 'record:crm:bo', role: 'member', object: 'organisation:Example Club', said: 'Club friend' },
    { subject: 'record:crm:lee', role: 'sister', object: 'record:crm:kim', said: 'Sister - Kim' },
  ] });
  assert.deepEqual(said.entities, ['organisation:example-club']);
  assert.deepEqual(fake.kept.get('organisation:example-club'), { id: 'organisation:example-club', type: 'organisation', value: { name: 'Example Club' } });
  // The same names make the same ids as the old relate: relation:<hash of [subject, role, object]>.
  assert.equal(said.relations[0].id, `relation:${textHash(JSON.stringify(['record:crm:pat', 'dad', MODEL.relations.self]))}`);
  // Your dad, read from you; who is in the club, read from it; whose sister Lee is, read from Kim.
  const dad = await orderedRelations(door, { id: 'me', side: 'object', role: 'dad' });
  assert.deepEqual(dad.relations.map(one => one.subject), ['record:crm:pat']);
  assert.equal((await orderedRelations(door, { id: 'organisation:example-club', side: 'object', role: 'member' })).relations.length, 2);
  assert.deepEqual((await orderedRelations(door, { id: 'record:crm:kim', side: 'object', role: 'sister' })).relations.map(one => one.said), ['Sister - Kim']);
  assert.deepEqual((await orderedRelations(door, { id: 'record:crm:pat', side: 'subject', role: 'dad' })).relations.map(one => one.object), [MODEL.relations.self]);
  // Saying it again changes nothing.
  const writes = fake.calls.filter(call => call.method === 'records:write').length;
  const again = await relate(door, { relations: [{ subject: 'record:crm:pat', role: 'dad', object: 'me' }] });
  assert.equal(again.relations[0].id, said.relations[0].id);
  assert.deepEqual(again.entities, []);
  assert.equal(fake.calls.filter(call => call.method === 'records:write').length, writes, 'nothing was written');
  await assert.rejects(relate(door, { relations: [{ subject: 'a/b', role: 'x', object: 'me' }] }), /A subject or object is a record id, me, or <entity kind>:<name>/);
  await assert.rejects(relate(door, { relations: [{ subject: 'me', role: '', object: 'record:crm:pat' }] }), /names its role/);
  await assert.rejects(relate(door, { entities: [{ kind: 'planet', name: 'Mars' }] }), /An entity is one of organisation, group, place/);
});

test('each end orders its own links: new ones go last, after places one, and the other end keeps its own order', async t => {
  const { door } = await freshDoor(t);
  await relate(door, { relations: [
    { subject: 'record:crm:ann', role: 'member', object: 'group:alpha' },
    { subject: 'record:crm:ann', role: 'member', object: 'group:beta' },
    { subject: 'record:crm:bo', role: 'member', object: 'group:alpha' },
  ] });
  await relate(door, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:gamma' }] });
  assert.deepEqual(await order(door, 'record:crm:ann', 'subject', 'member'), ['group:alpha', 'group:beta', 'group:gamma'], 'new links go last');
  assert.deepEqual(await order(door, 'group:alpha', 'object', 'member'), ['record:crm:ann', 'record:crm:bo']);
  // Ann moves gamma first on her side; alpha's own order of its members does not move.
  const gamma = (await orderedRelations(door, { id: 'record:crm:ann', side: 'subject', role: 'member' })).relations.at(-1).id;
  await relate(door, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:gamma', order: { subject: { after: null } } }] });
  assert.deepEqual(await order(door, 'record:crm:ann', 'subject', 'member'), ['group:gamma', 'group:alpha', 'group:beta']);
  const alphaAnn = (await orderedRelations(door, { id: 'group:alpha', side: 'object', role: 'member' })).relations[0].id;
  await relate(door, { relations: [{ subject: 'record:crm:bo', role: 'member', object: 'group:alpha', order: { object: { after: null } } }] });
  assert.deepEqual(await order(door, 'group:alpha', 'object', 'member'), ['record:crm:bo', 'record:crm:ann']);
  assert.deepEqual(await order(door, 'record:crm:ann', 'subject', 'member'), ['group:gamma', 'group:alpha', 'group:beta'], 'one end reordering leaves the other alone');
  // After a named relation lands between it and the next.
  await relate(door, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:beta', order: { subject: { after: gamma } } }] });
  assert.deepEqual(await order(door, 'record:crm:ann', 'subject', 'member'), ['group:gamma', 'group:beta', 'group:alpha']);
  await assert.rejects(relate(door, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:beta', order: { subject: { after: alphaAnn.replace(/.$/, 'z') } } }] }), /is not a relation of this subject/);
  await assert.rejects(relate(door, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:beta', order: { side: {} } }] }), /order is/);
  await assert.rejects(relate(door, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:beta', order: { subject: { before: null } } }] }), /order.subject is \{ after/);
});

test('several relations placed in one call see each other, on both ends', async t => {
  const { door } = await freshDoor(t);
  const first = await relate(door, { relations: [
    { subject: 'me', role: 'reads', object: 'record:book:one' },
    { subject: 'me', role: 'reads', object: 'record:book:two' },
  ] });
  await relate(door, { relations: [
    { subject: 'me', role: 'reads', object: 'record:book:three', order: { subject: { after: first.relations[0].id } } },
    { subject: 'me', role: 'reads', object: 'record:book:four', order: { subject: { after: null } } },
  ] });
  assert.deepEqual(await order(door, 'me', 'subject', 'reads'), ['record:book:four', 'record:book:one', 'record:book:three', 'record:book:two']);
});

test('ending a relation keeps its places; relating it again puts it back where it was; saying it again writes nothing', async t => {
  const { door, fake } = await freshDoor(t);
  await relate(door, { relations: ['one', 'two', 'three'].map(name => ({ subject: 'me', role: 'reads', object: `record:book:${name}` })) });
  const [, two] = (await orderedRelations(door, { id: 'me', side: 'subject', role: 'reads' })).relations;
  await relate(door, { relations: [{ subject: 'me', role: 'reads', object: 'record:book:two', alive: false }] });
  assert.deepEqual(await order(door, 'me', 'subject', 'reads'), ['record:book:one', 'record:book:three'], 'ended relations are left out');
  assert.deepEqual(await order(door, 'me', 'subject', 'reads', true), ['record:book:one', 'record:book:two', 'record:book:three']);
  assert.equal((await door.read('relation', two.id)).alive, false);
  assert.equal((await door.read('relation', two.id)).subject_order, two.subject_order, 'the ended relation keeps its place');
  await relate(door, { relations: [{ subject: 'me', role: 'reads', object: 'record:book:two' }] });
  assert.deepEqual(await order(door, 'me', 'subject', 'reads'), ['record:book:one', 'record:book:two', 'record:book:three']);
  const before = await door.read('relation', two.id);
  const writes = fake.calls.filter(call => call.method === 'records:write').length;
  const again = await relate(door, { relations: [{ subject: 'me', role: 'reads', object: 'record:book:two' }] });
  assert.deepEqual(await door.read('relation', two.id), before);
  assert.equal(again.relations[0].subject_order, two.subject_order);
  assert.equal(fake.calls.filter(call => call.method === 'records:write').length, writes);
  await assert.rejects(relate(door, { relations: [{ subject: 'me', role: 'reads', object: 'record:book:two', alive: 'no' }] }), /alive is true or false/);
});

const ann = 'record:crm:ann', bo = 'record:crm:bo';

test('an activity is a record named by what it is, with every record that took part under its own role', async t => {
  const { door, fake } = await freshDoor(t);
  const made = await seedActivities(door);
  assert.equal(made.activities.length, 4);
  assert.deepEqual(made.entities, ['organisation:acme'], 'an entity that took part is made once by its name');
  const meeting = made.activities.find(one => one.kind === 'meeting');
  assert.deepEqual(meeting.participants, [{ record: 'organisation:acme', role: 'participant' }, { record: ann, role: 'participant' },
    { record: bo, role: 'participant' }, { record: MODEL.relations.self, role: 'participant' }], 'participants sorted by record, then role; role participant when left out');
  assert.equal(meeting.at, '2026-05-03T15:00:00.000Z');
  assert.equal(meeting.id, `activity:${textHash(JSON.stringify(['meeting', '2026-05-03T15:00:00.000Z', null, meeting.participants]))}`);
  assert.deepEqual(fake.kept.get(meeting.id).value, (({ id, ...value }) => value)(meeting));
});

test('saying an activity again changes nothing, and a vague or empty one is refused with its words', async t => {
  const { door, fake } = await freshDoor(t);
  await seedActivities(door);
  const before = ofKind(fake, 'activity').length;
  await seedActivities(door);
  assert.equal(ofKind(fake, 'activity').length, before);
  const refuse = (activity, words) => assert.rejects(relate(door, { activities: [activity] }), words);
  await refuse({ kind: 'carrier-pigeon', at: '2026-01-01T00:00:00Z', participants: [{ record: ann }] }, /An activity is one of/);
  await refuse({ kind: 'call', at: 'yesterday', participants: [{ record: ann }] }, /as a date-time/);
  await refuse({ kind: 'call', at: '2026-01-01T00:00:00Z', participants: [] }, /between 1 and 50 records/);
  await refuse({ kind: 'call', at: '2026-01-01T00:00:00Z', participants: [{ record: ann, role: 'boss' }] }, /A participant's role is one of/);
  await refuse({ kind: 'call', at: '2026-01-01T00:00:00Z', participants: [{ record: ann }], summary: 'x'.repeat(2001) }, /summary is words of at most 2000/);
  assert.equal(ofKind(fake, 'activity').length, before, 'a refusal writes nothing');
});

test('a call over the relate bound is refused, and a large call is written in door-sized batches', async t => {
  const { door, fake } = await freshDoor(t);
  await assert.rejects(relate(door, { relations: Array.from({ length: 501 }, (_, at) => ({ subject: 'me', role: 'knows', object: `record:crm:p${at}` })) }), /at most 500 together/);
  await relate(door, { relations: Array.from({ length: 300 }, (_, at) => ({ subject: 'me', role: 'knows', object: `record:crm:p${String(at).padStart(3, '0')}` })) });
  const writes = fake.calls.filter(call => call.method === 'records:write');
  assert.ok(writes.length >= 2 && writes.every(call => call.input.records.length <= 256));
  assert.equal(ofKind(fake, 'relation').length, 300);
  const keys = (await orderedRelations(door, { id: 'me', side: 'subject', role: 'knows' })).relations.map(one => one.object);
  assert.deepEqual(keys, [...keys].sort(), 'three hundred in one call keep the order they were said in');
});

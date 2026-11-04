// A relation is one edge with an order key per side and an alive flag (src/record-model-tools.mjs invariant 3,
// src/record-model.json relation): each end orders its links of one role on its own, a new one goes last, order
// { side: { after } } places it, alive false ends it keeping its places, and the ordered read (read_model side + role,
// GET /records/model?id=&side=&role=) answers each end in its own order. Over the real record engine in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords } from '../src/record-engine.mjs';
import { relate, orderedRelations, handleModelRequest, modelTools } from '../src/record-model-tools.mjs';

const fresh = () => { const host = sqliteHost(':memory:'); return openRecords(host.sql, { transaction: host.transaction }); };
const order = (records, id, side, role, ended) => orderedRelations(records, { id, side, role, ended }).relations.map(one => side === 'subject' ? one.object : one.subject);

test('each end orders its own links: new ones go last, after places one, and the other end keeps its own order', () => {
  const records = fresh();
  relate(records, { relations: [
    { subject: 'record:crm:ann', role: 'member', object: 'group:alpha' },
    { subject: 'record:crm:ann', role: 'member', object: 'group:beta' },
    { subject: 'record:crm:bo', role: 'member', object: 'group:alpha' },
  ] });
  relate(records, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:gamma' }] });
  assert.deepEqual(order(records, 'record:crm:ann', 'subject', 'member'), ['group:alpha', 'group:beta', 'group:gamma'], 'new links go last');
  assert.deepEqual(order(records, 'group:alpha', 'object', 'member'), ['record:crm:ann', 'record:crm:bo']);
  // Ann moves gamma first on her side; alpha's own order of its members does not move.
  const gamma = orderedRelations(records, { id: 'record:crm:ann', side: 'subject', role: 'member' }).relations.at(-1).id;
  relate(records, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:gamma', order: { subject: { after: null } } }] });
  assert.deepEqual(order(records, 'record:crm:ann', 'subject', 'member'), ['group:gamma', 'group:alpha', 'group:beta']);
  const alphaAnn = orderedRelations(records, { id: 'group:alpha', side: 'object', role: 'member' }).relations[0].id;
  relate(records, { relations: [{ subject: 'record:crm:bo', role: 'member', object: 'group:alpha', order: { object: { after: null } } }] });
  assert.deepEqual(order(records, 'group:alpha', 'object', 'member'), ['record:crm:bo', 'record:crm:ann']);
  assert.deepEqual(order(records, 'record:crm:ann', 'subject', 'member'), ['group:gamma', 'group:alpha', 'group:beta'], 'one end reordering leaves the other alone');
  // After a named relation lands between it and the next.
  relate(records, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:beta', order: { subject: { after: gamma } } }] });
  assert.deepEqual(order(records, 'record:crm:ann', 'subject', 'member'), ['group:gamma', 'group:beta', 'group:alpha']);
  assert.throws(() => relate(records, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:beta', order: { subject: { after: alphaAnn.replace(/.$/, 'z') } } }] }), /is not a relation of this subject/);
  assert.throws(() => relate(records, { relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:beta', order: { side: {} } }] }), /order is/);
});

test('ending a relation keeps its places; relating it again puts it back where it was; saying it again writes nothing', () => {
  const records = fresh();
  relate(records, { relations: ['one', 'two', 'three'].map(name => ({ subject: 'me', role: 'reads', object: `record:book:${name}` })) });
  const [, two] = orderedRelations(records, { id: 'me', side: 'subject', role: 'reads' }).relations;
  relate(records, { relations: [{ subject: 'me', role: 'reads', object: 'record:book:two', alive: false }] });
  assert.deepEqual(order(records, 'me', 'subject', 'reads'), ['record:book:one', 'record:book:three'], 'ended relations are left out');
  assert.deepEqual(order(records, 'me', 'subject', 'reads', true), ['record:book:one', 'record:book:two', 'record:book:three']);
  assert.equal(records.read(two.id).alive, false);
  assert.equal(records.read(two.id).subject_order, two.subject_order, 'the ended relation keeps its place');
  relate(records, { relations: [{ subject: 'me', role: 'reads', object: 'record:book:two' }] });
  assert.deepEqual(order(records, 'me', 'subject', 'reads'), ['record:book:one', 'record:book:two', 'record:book:three']);
  const before = records.read(two.id);
  const again = relate(records, { relations: [{ subject: 'me', role: 'reads', object: 'record:book:two' }] });
  assert.deepEqual(records.read(two.id), before);
  assert.equal(again.relations[0].subject_order, two.subject_order);
  assert.throws(() => relate(records, { relations: [{ subject: 'me', role: 'reads', object: 'record:book:two', alive: 'no' }] }), /alive is true or false/);
});

test('the ordered read answers over GET /records/model and read_model; relate_records takes order and alive', async () => {
  const records = fresh();
  relate(records, { relations: [{ subject: 'record:crm:pat', role: 'dad', object: 'me' }, { subject: 'record:crm:lee', role: 'dad', object: 'me' }] });
  const answer = await handleModelRequest(records, new Request('https://store/records/model?id=me&side=object&role=dad')).json();
  assert.deepEqual(answer.relations.map(one => one.subject), ['record:crm:pat', 'record:crm:lee']);
  assert.equal(answer.complete, true);
  assert.equal((await handleModelRequest(records, new Request('https://store/records/model?id=me&side=sideways&role=dad'))).status, 400);
  const tools = modelTools(async (path, body) => ({ path, body }));
  assert.equal(await tools.find(tool => tool.name === 'read_model').run({ id: 'me', side: 'object', role: 'dad' }).then(one => one.path), '/records/model?id=me&side=object&role=dad');
  const relateTool = tools.find(tool => tool.name === 'relate_records').inputSchema.properties.relations.items.properties;
  assert.deepEqual(Object.keys(relateTool.order.properties), ['subject', 'object']);
  assert.equal(relateTool.alive.type, 'boolean');
});

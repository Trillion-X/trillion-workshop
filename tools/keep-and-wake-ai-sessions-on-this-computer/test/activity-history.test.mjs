// An activity (an email, a call, a meeting, an introduction) is a record that points at the people who took part, so a
// person's history, a pair's shared history and when they were last in touch are reads over one record kind (F-0721,
// src/record-model.json activities, src/record-model-tools.mjs relate / contactHistory). Over the real record engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords } from '../src/record-engine.mjs';
import { relate, contactHistory, handleModelRequest, modelTools } from '../src/record-model-tools.mjs';

const fresh = () => { const host = sqliteHost(':memory:'); return openRecords(host.sql, { transaction: host.transaction }); };
const ann = 'record:crm:ann', bo = 'record:crm:bo', cy = 'record:crm:cy';

function seed(records) {
  return relate(records, { activities: [
    { kind: 'email', at: '2026-03-01T10:00:00Z', summary: 'Sent the deck', direction: 'out', participants: [{ record: 'me', role: 'sender' }, { record: ann, role: 'recipient' }] },
    { kind: 'call', at: '2026-04-02T09:00:00Z', participants: [{ record: ann, role: 'caller' }, { record: 'me', role: 'recipient' }] },
    { kind: 'meeting', at: '2026-05-03T15:00:00Z', summary: 'Intro', participants: [{ record: ann }, { record: bo }, { record: 'me' }, { record: 'organisation:Acme' }] },
    { kind: 'message', at: '2026-05-10T08:00:00Z', participants: [{ record: cy, role: 'sender' }, { record: 'me', role: 'recipient' }] },
  ] });
}

test('a person\'s history is every activity they took part in, newest first, with when they were last in touch', () => {
  const records = fresh();
  const made = seed(records);
  assert.equal(made.activities.length, 4);
  const history = contactHistory(records, { id: ann });
  assert.deepEqual(history.activities.map(one => one.kind), ['meeting', 'call', 'email']);
  assert.equal(history.last_contact, '2026-05-03T15:00:00.000Z');
  assert.deepEqual(history.activities[1].as, ['caller'], 'each says the role this record took');
  assert.equal(history.count, 3);
  assert.equal(contactHistory(records, { id: 'me' }).count, 4, 'me is the person whose store it is');
});

test('a pair\'s shared history, a kind, a role and a time window narrow it; an entity that took part has its own', () => {
  const records = fresh();
  seed(records);
  assert.deepEqual(contactHistory(records, { id: ann, with: bo }).activities.map(one => one.kind), ['meeting']);
  assert.deepEqual(contactHistory(records, { id: ann, kinds: 'email,call' }).activities.map(one => one.kind), ['call', 'email']);
  assert.deepEqual(contactHistory(records, { id: ann, role: 'caller' }).activities.map(one => one.kind), ['call']);
  assert.deepEqual(contactHistory(records, { id: ann, since: '2026-04-01T00:00:00Z', until: '2026-04-30T00:00:00Z' }).activities.map(one => one.kind), ['call']);
  assert.equal(contactHistory(records, { id: ann, until: '2026-03-15T00:00:00Z' }).last_contact, '2026-03-01T00:00:00.000Z'.replace('00:00:00', '10:00:00'), 'last contact as of a time');
  assert.deepEqual(contactHistory(records, { id: 'organisation:acme' }).activities.map(one => one.kind), ['meeting']);
  assert.equal(contactHistory(records, { id: 'record:crm:nobody' }).last_contact, null);
});

test('saying an activity again changes nothing, and a vague or empty one is refused with its words', () => {
  const records = fresh();
  seed(records);
  const before = records.model().kinds.find(kind => kind.type === 'activity').count;
  seed(records);
  assert.equal(records.model().kinds.find(kind => kind.type === 'activity').count, before);
  const refuse = activity => assert.throws(() => relate(records, { activities: [activity] }));
  refuse({ kind: 'carrier-pigeon', at: '2026-01-01T00:00:00Z', participants: [{ record: ann }] });
  refuse({ kind: 'call', at: 'yesterday', participants: [{ record: ann }] });
  refuse({ kind: 'call', at: '2026-01-01T00:00:00Z', participants: [] });
  refuse({ kind: 'call', at: '2026-01-01T00:00:00Z', participants: [{ record: ann, role: 'boss' }] });
});

test('the history answers over GET /records/model and read_model, and relate_records takes activities', async () => {
  const records = fresh();
  seed(records);
  const answer = await handleModelRequest(records, new Request(`https://store/records/model?history=${encodeURIComponent(ann)}&kinds=meeting,call`)).json();
  assert.deepEqual(answer.activities.map(one => one.kind), ['meeting', 'call']);
  const tools = modelTools(async () => ({}));
  assert.ok(tools.find(tool => tool.name === 'read_model').inputSchema.properties.history);
  assert.ok(tools.find(tool => tool.name === 'relate_records').inputSchema.properties.activities);
});

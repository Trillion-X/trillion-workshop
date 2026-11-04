// The three rows run as the container runs them (test-helpers/run-a-row.mjs `answerOf`): each row's argv, its packed
// files laid on this repository, and the fake records door with exactly the row's rights. Every record is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import MODEL from '../read-data/record-graph.json' with { type: 'json' };

const relateRow = rowOf(rows, 'tool:relate-records');
const aroundRow = rowOf(rows, 'tool:read-the-graph-around-a-record');
const connectRow = rowOf(rows, 'tool:find-how-records-connect');
const at = (selector, value) => selector.slice(2).split(/[.[\]]+/).filter(Boolean).reduce((found, key) => found?.[key], value);

test('relate-records keeps relations, entities and activities through its own rights, and the read rows read them back', async () => {
  const kept = await answerOf(relateRow, {
    relations: [{ subject: 'record:crm:ann', role: 'member', object: 'group:Example Choir', said: 'sings with the choir' }, { subject: 'record:crm:bo', role: 'member', object: 'group:Example Choir' }],
    activities: [{ kind: 'meeting', at: '2026-06-01T18:00:00Z', summary: 'Rehearsal', participants: [{ record: 'record:crm:ann', role: 'attendee' }, { record: 'me', role: 'organiser' }] }],
  });
  assert.equal(kept.status, 0, kept.error);
  assert.deepEqual(kept.result.entities, ['group:example-choir']);
  assert.deepEqual(kept.kept.map(record => record.type).sort(), ['activity', 'group', 'relation', 'relation']);
  const records = kept.kept;
  const around = await answerOf(aroundRow, { id: 'record:crm:ann', hops: 2 }, { records });
  assert.equal(around.status, 0, around.error);
  assert.deepEqual(around.result.relations.map(group => [group.side, group.role, group.relations.map(one => one.object)]), [['subject', 'member', ['group:example-choir']]]);
  assert.deepEqual(around.result.history.activities.map(one => [one.kind, one.as]), [['meeting', ['attendee']]]);
  assert.ok(around.result.neighbours.records.some(record => record.id === 'record:crm:bo' && record.distance === 2));
  const connect = await answerOf(connectRow, { from: 'record:crm:bo', to: 'me' }, { records });
  assert.equal(connect.status, 0, connect.error);
  assert.deepEqual(connect.result.paths.map(path => path.length), [4]);
  const shared = await answerOf(connectRow, { of: ['record:crm:ann', 'record:crm:bo'] }, { records });
  assert.deepEqual(shared.result.hubs.map(hub => hub.id), ['group:example-choir']);
});

test('the read rows may not write, and the relate row reaches only relations, activities and entity kinds', async () => {
  for (const row of [aroundRow, connectRow]) {
    assert.ok(row.invoke.records.rights.every(right => !right.operations.includes('records:write')), `${row.id} only reads`);
  }
  assert.deepEqual(relateRow.invoke.records.rights.map(right => right.kind).sort(), ['activity', ...MODEL.relations.entity_kinds, 'relation'].sort());
  const refused = await answerOf(relateRow, { relations: [{ subject: 'a/b', role: 'x', object: 'me' }] });
  assert.equal(refused.status, 1);
  assert.match(refused.error, /A subject or object is a record id, me, or <entity kind>:<name>/);
  assert.deepEqual(refused.kept, [], 'a refusal writes nothing');
});

test('each row\'s verify sample answers what it says, over an empty store', async () => {
  for (const row of [aroundRow, connectRow]) {
    for (const check of row.verify) {
      const answer = await answerOf(row, check.input);
      assert.equal(answer.status, 0, answer.error);
      assert.match(String(at(check.output_selector, answer.result)), new RegExp(check.contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
});

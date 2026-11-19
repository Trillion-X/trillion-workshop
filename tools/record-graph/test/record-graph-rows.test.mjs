// The read rows run as the container runs them (test-helpers/run-a-row.mjs `answerOf`), over made-up records: the relations,
// entities and activities the store keeps for relate (tools/record-graph's relation and activity model), handed in as
// `records`. No records door is held by any row. Every record is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { activityRow, me, relationRow } from './graph-rows.mjs';

const aroundRow = rowOf(rows, 'tool:read-the-graph-around-a-record');
const connectRow = rowOf(rows, 'tool:find-how-records-connect');
const at = (selector, value) => selector.slice(2).split(/[.[\]]+/).filter(Boolean).reduce((found, key) => found?.[key], value);
const ann = 'record:crm:ann', bo = 'record:crm:bo';
const records = [
  relationRow(ann, 'member', 'group:example-choir'),
  relationRow(bo, 'member', 'group:example-choir'),
  { id: 'group:example-choir', type: 'group', value: { name: 'Example Choir' } },
  activityRow('rehearsal', 'meeting', '2026-06-01T18:00:00Z', [{ record: ann, role: 'attendee' }, { record: me, role: 'organiser' }], { summary: 'Rehearsal' }),
];

test('the read rows work on the relations and activities the store keeps, given as records', async () => {
  const around = await answerOf(aroundRow, { records, id: ann, hops: 2 });
  assert.equal(around.status, 0, around.error);
  assert.deepEqual(around.result.relations.map(group => [group.side, group.role, group.relations.map(one => one.object)]), [['subject', 'member', ['group:example-choir']]]);
  assert.deepEqual(around.result.history.activities.map(one => [one.kind, one.as]), [['meeting', ['attendee']]]);
  assert.ok(around.result.neighbours.records.some(record => record.id === bo && record.distance === 2));
  const connect = await answerOf(connectRow, { records, from: bo, to: 'me' });
  assert.equal(connect.status, 0, connect.error);
  assert.deepEqual(connect.result.paths.map(path => path.length), [4]);
  const shared = await answerOf(connectRow, { records, of: [ann, bo] });
  assert.deepEqual(shared.result.hubs.map(hub => hub.id), ['group:example-choir']);
});

test('the read rows hold no records door and take the rows as input', async () => {
  for (const row of [aroundRow, connectRow]) {
    assert.equal(row.invoke.records, undefined, `${row.id} holds no records door`);
    assert.ok(row.input_schema.required.includes('records'), `${row.id} takes the rows as input`);
  }
});

test('each row\'s verify sample answers what it says, over no rows', async () => {
  for (const row of [aroundRow, connectRow]) {
    for (const check of row.verify) {
      const answer = await answerOf(row, check.input);
      assert.equal(answer.status, 0, answer.error);
      assert.match(String(at(check.output_selector, answer.result)), new RegExp(check.contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
});

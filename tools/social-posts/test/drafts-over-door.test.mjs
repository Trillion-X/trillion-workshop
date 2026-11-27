// The two computations over records handed in, run as the container runs them (use-a-snippet and read-a-thread-summary),
// and the five rows that only kept records being gone from what-this-tool-does-and-how-to-run-it.json. Everything here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const row = id => rowOf(rows, `tool:${id}`);
const snippetRecord = { id: 'snippet:2026-10-01T09:00:00.000Z:a1b2c3d4e5', type: 'snippet', value: { snippet_id: 'snippet:2026-10-01T09:00:00.000Z:a1b2c3d4e5', title: 'Thanks', text: 'Thanks {name}, see you {when}!', tags: ['replies'], set_at: '2026-10-01T09:00:00.000Z', uses: 0 } };
const summaryRecord = { id: 'thread-summary:Email:Email:t1', type: 'thread-summary', value: { summary_id: 'thread-summary:Email:Email:t1', app: 'Email', conversation_id: 'Email:t1', summary: 'They ask for the Friday deck; I said yes.', through_message_id: 'message:2', through_at: '2026-10-19T10:05:00Z', set_at: '2026-10-19T10:06:00.000Z' } };

test('a use fills the handed-in snippet and keeps nothing', async () => {
  const used = await answerOf(row('use-a-snippet'), { snippet_id: snippetRecord.id, values: { name: 'Ana' }, records: [snippetRecord] });
  assert.equal(used.status, 0, used.error);
  assert.equal(used.result.text, 'Thanks Ana, see you {when}!');
  assert.deepEqual(used.result.left_blank, ['when']);
  assert.deepEqual(used.kept, [], 'a use stores nothing');
});

test('a read says whether the handed-in summary is stale against the message times handed in', async () => {
  const times = ['2026-10-19T10:00:00Z', '2026-10-19T10:05:00Z', '2026-10-19T11:00:00Z'];
  const stale = await answerOf(row('read-a-thread-summary'), { app: 'Email', conversation_id: 'Email:t1', message_times: times, records: [summaryRecord] });
  assert.equal(stale.status, 0, stale.error);
  assert.deepEqual([stale.result.stale, stale.result.newer_messages], [true, 1]);
  assert.match(stale.result.said, /1 newer message/);
  assert.deepEqual(stale.kept, [], 'a read stores nothing');
});

test('the five rows that only kept snippets and summaries are retired; their work is the recipes', () => {
  for (const id of ['save-a-snippet', 'find-snippets', 'remove-a-snippet', 'keep-a-thread-summary', 'remove-a-thread-summary']) {
    assert.equal(rows.records.some(record => record.payload.id === `tool:${id}`), false, `tool:${id} is retired`);
  }
  const text = JSON.stringify(rows.records.filter(record => /snippet|thread-summar/.test(record.payload.id)));
  assert.doesNotMatch(text, /records:(read|write|list)/, 'the snippet and summary rows name no records door method');
});

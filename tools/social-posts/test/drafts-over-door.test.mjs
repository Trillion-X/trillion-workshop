// The snippet and thread-summary rows (read-data/drafts-over-door.mjs over the moved snippets.mjs and
// thread-summaries.mjs) run as the container runs them, against the fake records door with exactly each row's rights.
// Everything here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = id => rowOf(rows, `tool:${id}`);

test('the snippet rows keep snippets as the person\'s own snippet records: save, find, use with blanks, change, refuse stale, remove', async () => {
  const saved = await runRow(row('save-a-snippet'), { title: 'Say no kindly', text: 'Hi {name}, thank you for {thing}.', tags: ['Replies'] });
  assert.equal(saved.status, 0, saved.error);
  const made = saved.result.snippet;
  assert.deepEqual(made.blanks, ['name', 'thing']);
  assert.deepEqual(made.tags, ['replies']);
  assert.deepEqual(saved.kept.map(record => [record.type, record.id]), [['snippet', made.snippet_id]]);
  let records = saved.kept;

  const found = await runRow(row('find-snippets'), { query: 'kindly' }, { records });
  assert.deepEqual(found.result.snippets.map(snippet => snippet.snippet_id), [made.snippet_id]);
  assert.deepEqual((await runRow(row('find-snippets'), { tag: 'elsewhere' }, { records })).result.snippets, []);
  assert.deepEqual(found.kept, records, 'finding changes nothing');

  const used = await runRow(row('use-a-snippet'), { snippet_id: made.snippet_id, values: { name: 'Ana' } }, { records });
  assert.equal(used.result.text, 'Hi Ana, thank you for {thing}.');
  assert.deepEqual(used.result.left_blank, ['thing']);
  assert.match(used.result.said, /Left blank: thing/);
  const counted = used.kept.find(record => record.id === made.snippet_id).value;
  assert.equal(counted.uses, 1);
  assert.equal(counted.text, made.text, 'a use never rewrites the words');
  records = used.kept;

  const changed = await runRow(row('save-a-snippet'), { snippet_id: made.snippet_id, title: 'Decline kindly', expected_set_at: made.set_at }, { records });
  assert.equal(changed.result.snippet.title, 'Decline kindly');
  assert.equal(changed.result.snippet.text, made.text);
  const stale = await runRow(row('save-a-snippet'), { snippet_id: made.snippet_id, text: 'x', expected_set_at: 'long ago' }, { records: changed.kept });
  assert.match(stale.error, /saved again at/);
  assert.deepEqual(stale.kept, changed.kept, 'a stale save changes nothing');
  assert.match((await runRow(row('save-a-snippet'), { title: '', text: 'x' })).error, /needs a title/);

  const removed = await runRow(row('remove-a-snippet'), { snippet_id: made.snippet_id }, { records: changed.kept });
  assert.match(removed.result.said, /Removed the snippet "Decline kindly"/);
  assert.equal(removed.kept.length, 0);
  assert.match((await runRow(row('use-a-snippet'), { snippet_id: made.snippet_id }, { records: removed.kept })).error, /There is no snippet/);
});

test('the thread-summary rows cover through the latest message handed in and count the newer message times', async () => {
  const thread = { app: 'Email', conversation_id: 'Email:t1' };
  assert.match((await runRow(row('keep-a-thread-summary'), { ...thread, summary: 'x', latest: null })).error, /no messages to summarize/);
  const none = await runRow(row('read-a-thread-summary'), { ...thread, message_times: [] });
  assert.equal(none.result.summary, null);
  assert.match(none.result.said, /No summary is kept/);

  const kept = await runRow(row('keep-a-thread-summary'), { ...thread, summary: 'They ask for the Friday deck; I said yes.', latest: { id: 'message:2', at: '2026-10-19T10:05:00Z' } });
  assert.equal(kept.status, 0, kept.error);
  assert.equal(kept.result.summary.through_message_id, 'message:2');
  assert.deepEqual(kept.kept.map(record => [record.type, record.id]), [['thread-summary', 'thread-summary:Email:Email:t1']]);

  const times = ['2026-10-19T10:00:00Z', '2026-10-19T10:05:00Z'];
  const fresh = await runRow(row('read-a-thread-summary'), { ...thread, message_times: times }, { records: kept.kept });
  assert.deepEqual([fresh.result.stale, fresh.result.newer_messages], [false, 0]);
  const stale = await runRow(row('read-a-thread-summary'), { ...thread, message_times: [...times, '2026-10-19T11:00:00Z'] }, { records: kept.kept });
  assert.deepEqual([stale.result.stale, stale.result.newer_messages], [true, 1]);
  assert.match(stale.result.said, /1 newer message/);
  assert.match((await runRow(row('keep-a-thread-summary'), { ...thread, summary: '  ', latest: { id: 'message:3', at: '2026-10-19T11:00:00Z' } }, { records: kept.kept })).error, /needs its words/);

  const again = await runRow(row('keep-a-thread-summary'), { ...thread, summary: 'Updated.', latest: { id: 'message:3', at: '2026-10-19T11:00:00Z' } }, { records: kept.kept });
  assert.equal(again.result.summary.through_message_id, 'message:3');
  assert.equal(again.kept.length, 1, 'one summary per conversation');

  const removed = await runRow(row('remove-a-thread-summary'), thread, { records: again.kept });
  assert.equal(removed.result.removed, true);
  assert.equal(removed.kept.length, 0);
  assert.match((await runRow(row('remove-a-thread-summary'), thread, { records: removed.kept })).error, /No summary is kept/);
});

test('a write is refused whole when the record changed after it was read', async () => {
  const { passesOverDoor } = await import('../read-data/drafts-over-door.mjs');
  const held = new Map([['snippet:a', { id: 'snippet:a', type: 'snippet', value: { n: 1 } }]]);
  const sent = [];
  const door = {
    read: async (type, id) => structuredClone(held.get(id)?.value ?? null),
    async *list({ type }) { for (const record of held.values()) if (record.type === type) yield structuredClone(record); },
    write: async (records, { key }) => { sent.push({ records, key }); },
  };
  const answer = await passesOverDoor(door, 'snippet', eeaf => {
    const value = eeaf.read('snippet:a');
    if (value) eeaf.write([{ id: 'snippet:a', type: 'snippet', value: { n: value.n + 1 } }]);
    return value;
  });
  assert.deepEqual(answer, { n: 1 });
  assert.deepEqual(sent[0].records, [{ id: 'snippet:a', type: 'snippet', value: { n: 2 }, expected: { type: 'snippet', value: { n: 1 } } }]);
  assert.match(sent[0].key, /^snippet:[0-9a-f]{64}$/);
});

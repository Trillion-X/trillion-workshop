// A summary an AI keeps of one conversation (read-data/thread-summaries.mjs, moved from trillion test/thread-summaries.test.mjs): it covers through the newest message, and reading
// says whether the thread has moved on since. Trillion's second test (the person store's ends of a thread read the real
// messages owner) runs trillion's own src/person-store.mjs wiring and messages owner, which stay there; it is not moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { posts } from './drafts-for-tests.mjs';

test('a summary covers through the newest message, goes stale when the thread moves on, and is removed alone', () => {
  const thread = [];
  const ends = {
    latest: () => thread.at(-1) ?? null,
    newer: ({ after }) => thread.filter(message => Date.parse(message.at) > Date.parse(after)).length,
  };
  const { owner } = posts({ threadEnds: ends });
  const { summaries } = owner;
  assert.throws(() => summaries.save({ conversation_id: 'Email:t1', summary: 'x' }), /no messages to summarize/);
  thread.push({ id: 'message:1', at: '2026-10-19T10:00:00Z' }, { id: 'message:2', at: '2026-10-19T10:05:00Z' });
  assert.match(summaries.read({ conversation_id: 'Email:t1' }).said, /No summary is kept/);
  const saved = summaries.save({ app: 'Email', conversation_id: 'Email:t1', summary: 'Sam asks for the Friday deck; I said yes.' });
  assert.equal(saved.summary.through_message_id, 'message:2');
  const fresh = summaries.read({ app: 'Email', conversation_id: 'Email:t1' });
  assert.deepEqual([fresh.stale, fresh.newer_messages], [false, 0]);
  thread.push({ id: 'message:3', at: '2026-10-19T11:00:00Z' });
  const stale = summaries.read({ app: 'Email', conversation_id: 'Email:t1' });
  console.log('SUMMARY READBACK:', JSON.stringify({ stale: stale.stale, newer: stale.newer_messages, said: stale.said, summary: stale.summary.summary }));
  assert.deepEqual([stale.stale, stale.newer_messages], [true, 1]);
  assert.throws(() => summaries.save({ conversation_id: 'Email:t1', summary: '  ' }), /needs its words/);
  assert.equal(summaries.save({ app: 'Email', conversation_id: 'Email:t1', summary: 'Updated.' }).summary.through_message_id, 'message:3');
  assert.equal(summaries.remove({ app: 'Email', conversation_id: 'Email:t1' }).removed, true);
  assert.equal(summaries.read({ app: 'Email', conversation_id: 'Email:t1' }).summary, null);
});

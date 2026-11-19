// Reading a conversation's summary (read-data/thread-summaries.mjs): the record and the message times are handed in, and
// reading says whether the thread has moved on since. Keeping and removing a summary are the store's job and are proven by
// test/keep-recipes-proof.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeThreadSummaries } from '../read-data/thread-summaries.mjs';

const summary = { summary_id: 'thread-summary:Email:Email:t1', app: 'Email', conversation_id: 'Email:t1', summary: 'Sam asks for the Friday deck; I said yes.', through_message_id: 'message:2', through_at: '2026-10-19T10:05:00Z', set_at: '2026-10-19T10:06:00.000Z' };
const eeaf = { read: id => (id === summary.summary_id ? structuredClone(summary) : null) };
const newerThan = times => ({ after }) => times.filter(time => Date.parse(time) > Date.parse(after)).length;

test('a summary is fresh when no newer message came, and stale with the count when one did', () => {
  const fresh = makeThreadSummaries({ eeaf, newer: newerThan(['2026-10-19T10:00:00Z', '2026-10-19T10:05:00Z']) }).read({ app: 'Email', conversation_id: 'Email:t1' });
  assert.deepEqual([fresh.stale, fresh.newer_messages], [false, 0]);
  const stale = makeThreadSummaries({ eeaf, newer: newerThan(['2026-10-19T10:00:00Z', '2026-10-19T10:05:00Z', '2026-10-19T11:00:00Z']) }).read({ app: 'Email', conversation_id: 'Email:t1' });
  assert.deepEqual([stale.stale, stale.newer_messages], [true, 1]);
  assert.match(stale.said, /1 newer message/);
});

test('a conversation with no summary says none is kept, and one with no name is refused', () => {
  const none = makeThreadSummaries({ eeaf: { read: () => null }, newer: () => 0 }).read({ app: 'Email', conversation_id: 'Email:t9' });
  assert.equal(none.summary, null);
  assert.match(none.said, /No summary is kept/);
  assert.throws(() => makeThreadSummaries({ eeaf, newer: () => 0 }).read({ app: 'Email' }), /Name the conversation/);
});

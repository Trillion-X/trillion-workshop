// test/claimed-time.test.mjs
// A time someone else gives is checked once where it arrives (src/claimed-time.mjs): any past time, never one that
// has not happened yet; a message stamped on arrival never sorts before the newest one kept (a high-water mark); and
// who recorded a message is the sign-in the service names, never the batch's own claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { messages } from '../src/messages.mjs';
import { recordSent } from '../src/sent.mjs';
import { AHEAD_SECONDS, claimedTimeProblem } from '../src/claimed-time.mjs';

const NOW = '2026-10-05T07:00:00.000Z';
const at = seconds => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

test('a past time is kept exactly; a time ahead of the clock by more than the allowance is refused', () => {
  const now = new Date(NOW);
  assert.deepEqual(claimedTimeProblem('2019-01-01T00:00:00Z', { now }), { at: '2019-01-01T00:00:00.000Z' });
  assert.deepEqual(claimedTimeProblem(at(AHEAD_SECONDS), { now }), { at: at(AHEAD_SECONDS) }, 'a clock a little fast is allowed');
  assert.match(claimedTimeProblem(at(AHEAD_SECONDS + 1), { now }).problem, /has not happened yet/);
  assert.match(claimedTimeProblem('next tuesday', { now }).problem, /must be a date and time/);
});

test('a message dated in the future is refused and nothing in its batch is kept', () => {
  const store = localStore(':memory:');
  const kept = messages(store.eeaf, { now: () => new Date(NOW) });
  assert.throws(() => kept.record({ messages: [
    { conversation_id: 'c', app: 'Muse', speaker: 'person', at: at(-60), text: 'fine' },
    { conversation_id: 'c', app: 'Muse', speaker: 'person', at: '2027-01-01T00:00:00Z', text: 'from a Mac set a year ahead' },
  ] }), /messages\[1\]\.at is 2027-01-01T00:00:00\.000Z, later than now/);
  assert.equal(kept.read({}).messages.length, 0);
  assert.throws(() => kept.correctAuthoredAt({ message_id: 'message:x', authored_at: '2027-01-01T00:00:00Z', evidence: 'transcript' }), /later than now/);
});

test('a message stamped on arrival is placed after the newest kept, even one dated a little ahead', () => {
  const store = localStore(':memory:');
  const kept = messages(store.eeaf, { now: () => new Date(NOW) });
  kept.record({ messages: [{ conversation_id: 'c', app: 'Mac', speaker: 'person', at: at(120), text: 'my clock is two minutes fast' }] });
  kept.record({ messages: [{ conversation_id: 'c', app: 'Muse', speaker: 'ai', text: 'answered just now' }] });
  const newest = kept.read({}).messages;
  assert.equal(newest[0].text, 'answered just now', 'the reply reads after the message it answers');
  assert.equal(newest[0].at, at(120.001));
});

test('who recorded a message is the sign-in the service names, never the batch', () => {
  const store = localStore(':memory:');
  const kept = messages(store.eeaf, { now: () => new Date(NOW) });
  kept.record({ messages: [{ conversation_id: 'c', app: 'Claimed', speaker: 'person', at: at(-1), text: 'hi', recorded_by: 'key:forged', recorded_app: 'Forged' }] }, { app: 'ChatGPT', reader: 'app:ChatGPT' });
  const [message] = kept.read({}).messages;
  assert.equal(message.recorded_by, 'app:ChatGPT');
  assert.equal(message.recorded_app, 'ChatGPT');
  assert.equal(message.app, 'Claimed', 'the conversation\'s own app name is still the caller\'s words');
});

test('something sent cannot be dated after now', () => {
  const store = localStore(':memory:');
  assert.throws(() => recordSent(store.eeaf, { kind: 'email', to: 'a@example.com', body_markdown: 'Hello', sent_at: '2099-01-01T00:00:00Z' }), /sent_at is 2099/);
  assert.ok(recordSent(store.eeaf, { kind: 'email', to: 'a@example.com', body_markdown: 'Hello', sent_at: '2026-01-01T00:00:00Z' }).id);
});

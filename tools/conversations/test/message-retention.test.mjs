// A conversation's retention policy (src/message-retention.mjs): messages older than N days are erased through the erasure
// owner (here the record store's own erase, the one PersonStore.eraseRecord wraps), a page at a time, oldest first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { messages } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';
import { makeMessageRetention, messageRetentionActions, RetentionError } from '../from-old-trillion/src/message-retention.mjs';
import settings from '../from-old-trillion/src/message-retention.json' with { type: 'json' };

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-19T12:00:00Z');
const at = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();

function world() {
  const store = localStore(':memory:');
  const kept = messages(store.eeaf, { now: () => new Date(NOW) });
  const facts = new Map();
  const erased = [];
  const retention = makeMessageRetention({
    eeaf: store.eeaf, now: () => NOW,
    values: { list: prefix => [...facts].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value), put: (key, value) => facts.set(key, value) },
    erase: async (id, how) => { erased.push([id, how.app]); return store.eeaf.erase(id, { actor: { by: 'erasure', app: how.app } }); },
  });
  const say = (conversation, daysAgo, text) => kept.record({ messages: [{ conversation_id: conversation, app: 'Claude', speaker: 'person', at: at(daysAgo), text }] });
  const texts = conversation => kept.read({ conversation_id: conversation, limit: 100 }).messages.map(message => message.text);
  return { store, kept, retention, erased, say, texts, facts };
}

test('messages older than the policy are erased through the erasure owner, oldest first, and newer ones stay', async () => {
  const { retention, say, texts, erased } = world();
  say('chat-a', 40, 'forty days ago'); say('chat-a', 31, 'thirty-one days ago'); say('chat-a', 29, 'twenty-nine days ago'); say('chat-a', 1, 'yesterday');
  say('chat-b', 90, 'other conversation, no policy');
  assert.equal(retention.nextAt(), null, 'no policy, nothing to sweep');
  retention.set({ conversation_id: 'chat-a', older_than_days: 30 });
  assert.equal(retention.nextAt(), NOW, 'a new policy is swept at once');
  const swept = await retention.sweep();
  assert.deepEqual(swept.swept, [{ conversation_id: 'chat-a', erased: 2, more: false }]);
  assert.deepEqual(texts('chat-a'), ['yesterday', 'twenty-nine days ago']);
  assert.deepEqual(texts('chat-b'), ['other conversation, no policy']);
  assert.equal(erased.length, 2);
  assert.ok(erased.every(([, app]) => app === settings.app), 'each erasure goes through the erasure owner under the retention app');
  assert.equal(retention.nextAt(), NOW + settings.every_minutes * 60_000, 'a short page waits for the next interval');
});

test('a policy is set, read, changed and cleared; a clear stops the sweep and erases nothing more', async () => {
  const { retention, say, texts } = world();
  say('chat-a', 100, 'old');
  assert.deepEqual(retention.read(), { policies: [] });
  retention.set({ conversation_id: 'chat-a', older_than_days: 365 });
  retention.set({ conversation_id: 'chat-a', older_than_days: 60 });
  assert.equal(retention.read({ conversation_id: 'chat-a' }).policy.older_than_days, 60, 'setting again changes it');
  assert.equal(retention.clear({ conversation_id: 'chat-a' }).cleared, true);
  assert.equal(retention.clear({ conversation_id: 'chat-a' }).cleared, false);
  assert.deepEqual(retention.read(), { policies: [] });
  assert.equal(retention.nextAt(), null);
  assert.deepEqual((await retention.sweep()).swept, []);
  assert.deepEqual(texts('chat-a'), ['old']);
});

test('a sweep is a page; more due keeps the next sweep immediate; bad input is refused in words', async () => {
  const { retention, say, texts } = world();
  for (let index = 0; index < settings.page + 3; index += 1) say('chat-a', 50 + index, `m${index}`);
  retention.set({ conversation_id: 'chat-a', older_than_days: 30 });
  const first = await retention.sweep();
  assert.equal(first.swept[0].erased, settings.page);
  assert.equal(first.swept[0].more, true);
  assert.equal(retention.nextAt(), NOW, 'still due, so again at once');
  assert.equal((await retention.sweep()).swept[0].erased, 3);
  assert.deepEqual(texts('chat-a'), []);
  for (const bad of [{ older_than_days: 30 }, { conversation_id: 'x', older_than_days: 0 }, { conversation_id: 'x', older_than_days: 1.5 }, { conversation_id: 'x', older_than_days: settings.max_days + 1 }]) {
    assert.throws(() => retention.set(bad), RetentionError);
  }
});

test('the account actions reach the same owner and refuse a host that cannot erase', async () => {
  const { retention } = world();
  const actions = messageRetentionActions({ eraseRecord: () => {}, store: { eeaf: {} }, messageRetention: () => retention });
  assert.match((await actions['set-message-retention']({ conversation_id: 'chat-a', older_than_days: 7 })).said, /older than 7 days will be erased/);
  assert.equal((await actions['read-message-retention']({})).policies.length, 1);
  assert.equal((await actions['clear-message-retention']({ conversation_id: 'chat-a' })).cleared, true);
  assert.equal((await actions['erase-old-messages']({})).swept.length, 0);
  await assert.rejects(messageRetentionActions({ store: null })['read-message-retention']({}), /cannot erase messages from here/);
});

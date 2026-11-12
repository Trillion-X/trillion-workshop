// tools/reply-by-keyword-rule: the decide and send rows against a fake records door and a fake Meta answer. No network;
// the held token is a stand-in read from a function, never a real value.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideTheReplies } from '../do-work/decide-the-replies.mjs';
import { sendAnInstagramReply } from '../do-work/send-an-instagram-reply.mjs';
import { segment, prefixOf } from '../../pull-from-connected-accounts/read-data/snapshot.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const ACCOUNT = 'account-one';
const SOURCE = 'instagram-messages';

function fakeDoor(records) {
  const written = [];
  return {
    written,
    async *list({ type, prefix }) {
      for (const [id, record] of records) {
        if (record.type !== type) continue;
        if (prefix !== undefined && !id.startsWith(prefix)) continue;
        yield { id, value: record.value };
      }
    },
    async readRecord(type, id) {
      const found = records.get(id);
      return found && found.type === type ? found : null;
    },
    async write(writes) {
      written.push(...writes);
      for (const write of writes) records.set(write.id, { type: write.type, value: write.value });
      return { ok: true };
    },
  };
}

function seeded({ selfId = 'me', lastInboundMinutesAgo = 5, sent = [] } = {}) {
  const records = new Map();
  const put = (id, type, value) => records.set(id, { type, value });
  put(`${prefixOf(SOURCE, ACCOUNT)}state`, 'account-snapshot-part', { kind: 'state', self_id: selfId, cursor: null, pulled_at: iso(NOW) });
  put(`${prefixOf(SOURCE, ACCOUNT)}thread:${segment('thread-1')}`, 'account-snapshot-part', {
    kind: 'thread', seq: 1,
    thread: {
      id: 'thread-1', title: 'thread-1',
      messages: [
        { id: 'msg-1', from: { id: 'them' }, created_time: iso(NOW - lastInboundMinutesAgo * 60000), message: 'what is the price' },
      ],
    },
  });
  put('reply-rule:prices', 'reply-rule', {
    id: 'rule:prices', enabled: true, words: ['price'], mode: 'any', reply: 'Hi, the price list is here.',
  });
  for (const key of sent) put(`instagram-reply:${segment(key)}`, 'instagram-reply', { key, state: 'sent' });
  return records;
}

test('the decide row chooses a reply for the latest inbound message and skips a key already sent', async () => {
  const door = fakeDoor(seeded());
  const out = await decideTheReplies({ account_id: ACCOUNT, now: iso(NOW) }, { door });
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].action, 'send');
  assert.equal(out.decisions[0].key, 'msg-1:rule:prices');
  assert.equal(out.decisions[0].reply_text, 'Hi, the price list is here.');
  const again = await decideTheReplies({ account_id: ACCOUNT, now: iso(NOW) }, { door: fakeDoor(seeded({ sent: ['msg-1:rule:prices'] })) });
  assert.equal(again.decisions[0].reason, 'already-sent');
});

test('the decide row refuses an account with no pulled state', async () => {
  const records = new Map();
  await assert.rejects(decideTheReplies({ account_id: ACCOUNT, now: iso(NOW) }, { door: fakeDoor(records) }), /pull its messages first/);
});

test('the send row refuses a reply whose window closed before it is sent, and sends nothing', async () => {
  const door = fakeDoor(seeded());
  let posted = false;
  const decision = {
    action: 'send', kind: 'dm', key: 'msg-1:rule:prices', message_id: 'msg-1', recipient_id: 'them',
    reply_text: 'hello', last_inbound_at: iso(NOW - 25 * 3600000),
  };
  const out = await sendAnInstagramReply({ account_id: ACCOUNT, decision }, { door }, {
    nowMs: NOW, read: () => 'stand-in-token', send: async () => { posted = true; return { ok: true }; },
  });
  assert.equal(out.status, 'refused');
  assert.equal(out.reason, 'window-closed');
  assert.equal(posted, false);
  assert.equal(door.written.length, 0);
});

test('the send row posts once inside the window, keeps a record, and never sends the same key twice', async () => {
  const records = seeded();
  const door = fakeDoor(records);
  const calls = [];
  const decision = {
    action: 'send', kind: 'dm', key: 'msg-1:rule:prices', message_id: 'msg-1', recipient_id: 'them',
    reply_text: 'Hi, the price list is here.', last_inbound_at: iso(NOW - 5 * 60000),
  };
  const deps = {
    nowMs: NOW,
    read: fd => { assert.equal(fd, 4); return 'stand-in-token'; },
    send: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ recipient_id: 'them', message_id: 'mid-1' }) };
    },
  };
  const out = await sendAnInstagramReply({ account_id: ACCOUNT, decision }, { door }, deps);
  assert.equal(out.status, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.instagram.com/v21.0/me/messages');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer stand-in-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient: { id: 'them' }, message: { text: 'Hi, the price list is here.' } });
  const kept = records.get(`instagram-reply:${segment('msg-1:rule:prices')}`).value;
  assert.equal(kept.state, 'sent');
  assert.equal(kept.message_id, 'mid-1');
  assert.doesNotMatch(JSON.stringify(records), /stand-in-token/);
  const again = await sendAnInstagramReply({ account_id: ACCOUNT, decision }, { door }, deps);
  assert.equal(again.status, 'already-sent');
  assert.equal(calls.length, 1);
});

test('a private reply goes to the comment id, and an unknown outcome is kept, never retried', async () => {
  const records = seeded();
  const door = fakeDoor(records);
  const decision = {
    action: 'send', kind: 'private-reply', key: 'c-1:rule:prices', message_id: 'c-1', recipient: { comment_id: 'c-1' },
    reply_text: 'Here it is.', created_time: iso(NOW - 3600000),
  };
  const sent = [];
  const out = await sendAnInstagramReply({ account_id: ACCOUNT, decision }, { door }, {
    nowMs: NOW, read: () => 'stand-in-token',
    send: async (url, init) => { sent.push(JSON.parse(init.body)); throw new Error('connection reset'); },
  });
  assert.equal(out.status, 'not-known');
  assert.deepEqual(sent[0], { recipient: { comment_id: 'c-1' }, message: { text: 'Here it is.' } });
  assert.equal(records.get(`instagram-reply:${segment('c-1:rule:prices')}`).value.state, 'not-known');
  const retry = await sendAnInstagramReply({ account_id: ACCOUNT, decision }, { door }, { nowMs: NOW, read: () => 'x', send: async () => { throw new Error('should not send'); } });
  assert.equal(retry.status, 'already-sent');
});

// tools/reply-by-keyword-rule: the decide and send rows against a fake records door and a fake Meta answer. No network;
// the held token is a stand-in read from a function, never a real value.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideTheReplies } from '../do-work/decide-the-replies.mjs';
import { sendAReply } from '../do-work/send-a-reply.mjs';
import { segment, prefixOf } from '../../pull-from-connected-accounts/read-data/snapshot.mjs';

const COMMENTS = 'instagram-comments';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const ACCOUNT = 'account-one';
const IG = 'reply-place:instagram';
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

function seeded({ selfId = 'me', lastInboundMinutesAgo = 5, sent = [], comments = null } = {}) {
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
  if (comments) {
    put(`${prefixOf(COMMENTS, ACCOUNT)}state`, 'account-snapshot-part', { kind: 'state', self_id: selfId, cursor: null, pulled_at: iso(NOW) });
    put(`${prefixOf(COMMENTS, ACCOUNT)}thread:${segment('media-1')}`, 'account-snapshot-part', {
      kind: 'thread', seq: 1,
      thread: { id: 'media-1', title: 'media-1', source: { id: 'media-1', caption: 'Rye bread' }, messages: comments },
    });
  }
  put('reply-rule:prices', 'reply-rule', {
    id: 'rule:prices', enabled: 'on', words: ['price'], mode: 'any', reply: 'Hi, the price list is here.',
  });
  for (const key of sent) put(`reply-kept:${segment(IG)}:${segment(key)}`, 'reply-kept', { key, place: IG, state: 'sent' });
  return records;
}

test('the decide row chooses a reply for the latest inbound message and skips a key already sent', async () => {
  const door = fakeDoor(seeded());
  const out = await decideTheReplies({ place: IG, account: ACCOUNT, now: iso(NOW) }, { door });
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].action, 'send');
  assert.equal(out.decisions[0].key, 'msg-1:rule:prices');
  assert.equal(out.decisions[0].reply_text, 'Hi, the price list is here.');
  const again = await decideTheReplies({ place: IG, account: ACCOUNT, now: iso(NOW) }, { door: fakeDoor(seeded({ sent: ['msg-1:rule:prices'] })) });
  assert.equal(again.decisions[0].reason, 'already-sent');
});

test('the decide row refuses an account with no pulled state', async () => {
  const records = new Map();
  await assert.rejects(decideTheReplies({ place: IG, account: ACCOUNT, now: iso(NOW) }, { door: fakeDoor(records) }), /pull it first/);
});

test('the send row refuses a reply whose window closed before it is sent, and sends nothing', async () => {
  const door = fakeDoor(seeded());
  let posted = false;
  const decision = {
    place: IG, action: 'send', kind: 'dm', key: 'msg-1:rule:prices', message_id: 'msg-1', recipient: { id: 'them' },
    reply_text: 'hello', created_time: iso(NOW - 25 * 3600000),
  };
  const out = await sendAReply({ account_id: ACCOUNT, decision }, { door }, {
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
    place: IG, action: 'send', kind: 'dm', key: 'msg-1:rule:prices', message_id: 'msg-1', recipient: { id: 'them' },
    reply_text: 'Hi, the price list is here.', created_time: iso(NOW - 5 * 60000),
  };
  const deps = {
    nowMs: NOW,
    read: fd => { assert.equal(fd, 4); return 'stand-in-token'; },
    send: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ recipient_id: 'them', message_id: 'mid-1' }) };
    },
  };
  const out = await sendAReply({ account_id: ACCOUNT, decision }, { door }, deps);
  assert.equal(out.status, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.instagram.com/v21.0/me/messages');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer stand-in-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient: { id: 'them' }, message: { text: 'Hi, the price list is here.' } });
  const kept = records.get(`reply-kept:${segment(IG)}:${segment('msg-1:rule:prices')}`).value;
  assert.equal(kept.state, 'sent');
  assert.equal(kept.message_id, 'mid-1');
  assert.doesNotMatch(JSON.stringify(records), /stand-in-token/);
  const again = await sendAReply({ account_id: ACCOUNT, decision }, { door }, deps);
  assert.equal(again.status, 'already-sent');
  assert.equal(calls.length, 1);
});

test('a private reply goes to the comment id, and an unknown outcome is kept, never retried', async () => {
  const records = seeded();
  const door = fakeDoor(records);
  const decision = {
    place: IG, action: 'send', kind: 'private-reply', key: 'c-1:rule:prices', message_id: 'c-1', recipient: { comment_id: 'c-1' },
    reply_text: 'Here it is.', created_time: iso(NOW - 3600000),
  };
  const sent = [];
  const out = await sendAReply({ account_id: ACCOUNT, decision }, { door }, {
    nowMs: NOW, read: () => 'stand-in-token',
    send: async (url, init) => { sent.push(JSON.parse(init.body)); throw new Error('connection reset'); },
  });
  assert.equal(out.status, 'not-known');
  assert.deepEqual(sent[0], { recipient: { comment_id: 'c-1' }, message: { text: 'Here it is.' } });
  assert.equal(records.get(`reply-kept:${segment(IG)}:${segment('c-1:rule:prices')}`).value.state, 'not-known');
  const retry = await sendAReply({ account_id: ACCOUNT, decision }, { door }, { nowMs: NOW, read: () => 'x', send: async () => { throw new Error('should not send'); } });
  assert.equal(retry.status, 'already-sent');
});

test('the decide row reads the pulled comments: a comment is answered by a private reply, the person\'s own comment is left alone', async () => {
  const comments = [
    { id: 'c-1', from: { id: 'them' }, username: 'ben', text: 'price please?', timestamp: iso(NOW - 2 * 3600000) },
    { id: 'c-2', from: { id: 'me' }, username: 'rolling_pin', text: 'price list below', timestamp: iso(NOW - 3600000) },
  ];
  const out = await decideTheReplies({ place: IG, account: ACCOUNT, now: iso(NOW) }, { door: fakeDoor(seeded({ comments })) });
  assert.deepEqual(out.not_pulled, []);
  const c1 = out.decisions.find(d => d.message_id === 'c-1');
  assert.equal(c1.action, 'send');
  assert.equal(c1.kind, 'private-reply');
  assert.deepEqual(c1.recipient, { comment_id: 'c-1' });
  assert.equal(out.decisions.find(d => d.message_id === 'c-2').reason, 'comment-is-ours');
});

test('a comment source never pulled is named under not_pulled, and the direct messages are still decided', async () => {
  const out = await decideTheReplies({ place: IG, account: ACCOUNT, now: iso(NOW) }, { door: fakeDoor(seeded()) });
  assert.deepEqual(out.not_pulled, [COMMENTS]);
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].kind, 'dm');
});

// A place no code has heard of: one row, handed to the decide and send rows, is decided and sent with no other change.
const MADE_UP = {
  id: 'reply-place:made-up', label: 'Madeup', connection_vendor: 'made-up', send_tool: 'tool:send-a-reply-on-made-up',
  self_id: { plain: 'own_handle' },
  send: { hosts: ['api.made-up.example'], token_descriptor: 4, headers: { 'X-Key': '{token}' }, timeout_ms: 1000 },
  channels: [{
    id: 'remark', pull: { handed_in: { tool: 'tool:read-made-up-remarks', items_path: 'remarks' } }, which: 'each',
    fields: { message_id: 'key', from_id: 'who', created_time: 'when', text: 'body', thread_id: 'key' },
    own_reason: 'remark-is-ours', recipient: {}, window_ms: null,
    request: { method: 'PUT', url: 'https://api.made-up.example/answer/{message_id}', body: { say: '{reply_text}' }, id_path: 'reply.id', error_path: 'why' },
  }],
};

test('an unknown place is one more row: decided from handed-in items and sent as its row says, once', async () => {
  const records = new Map([
    ['reply-rule:prices', { type: 'reply-rule', value: { id: 'rule:prices', enabled: 'on', words: ['price'], mode: 'any', reply: 'It is below.' } }],
    ['connection:service_connection%3Amade-up%3Aone', { type: 'connection', value: { vendor: 'made-up', plain: { own_handle: 'me' } } }],
  ]);
  const door = fakeDoor(records);
  door.read = async (type, id) => (records.get(id)?.type === type ? records.get(id).value : null);
  const pulled = { remark: [{ remarks: [
    { key: 'k1', who: 'v1', when: iso(NOW - 900 * 86400000), body: 'price?' },
    { key: 'k2', who: 'me', when: iso(NOW), body: 'price below' },
  ] }] };
  const out = await decideTheReplies({ place: MADE_UP.id, account_id: 'service_connection:made-up:one', pulled, now: iso(NOW) }, { door }, { places: [MADE_UP] });
  assert.deepEqual(out.not_pulled, []);
  assert.deepEqual(out.decisions.map(d => [d.message_id, d.action, d.reason ?? d.key]), [['k1', 'send', 'k1:rule:prices'], ['k2', 'skip', 'remark-is-ours']]);
  const calls = [];
  const deps = {
    nowMs: NOW, places: [MADE_UP], read: fd => { assert.equal(fd, 4); return 'stand-in-token'; },
    send: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ reply: { id: 'r-1' } }) }; },
  };
  const sent = await sendAReply({ account_id: 'service_connection:made-up:one', decision: out.decisions[0] }, { door }, deps);
  assert.equal(sent.status, 'sent');
  assert.equal(calls[0].url, 'https://api.made-up.example/answer/k1');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['X-Key'], 'stand-in-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { say: 'It is below.' });
  assert.doesNotMatch(JSON.stringify([...records]), /stand-in-token/);
  assert.equal((await sendAReply({ account_id: 'service_connection:made-up:one', decision: out.decisions[0] }, { door }, deps)).status, 'already-sent');
  assert.equal(calls.length, 1);
});

test('a place row whose hosts do not hold the request address sends nothing', async () => {
  const door = fakeDoor(new Map());
  const wrong = { ...MADE_UP, send: { ...MADE_UP.send, hosts: ['other.example'] } };
  const decision = { place: MADE_UP.id, action: 'send', kind: 'remark', key: 'k1:r', message_id: 'k1', recipient: {}, reply_text: 'x', created_time: iso(NOW) };
  let posted = false;
  const out = await sendAReply({ account_id: 'a', decision }, { door }, { nowMs: NOW, places: [wrong], read: () => 't', send: async () => { posted = true; } });
  assert.equal(out.reason, 'host-not-allowed');
  assert.equal(posted, false);
  assert.equal(door.written.length, 0);
});

test('the shipped YouTube row answers a handed-in comment thread by its id and skips the channel\'s own', async () => {
  const records = new Map([
    ['reply-rule:prices', { type: 'reply-rule', value: { id: 'rule:prices', enabled: 'on', words: ['price'], mode: 'any', reply: 'The list is linked below.' } }],
    ['connection:service_connection%3Ayoutube%3Aone', { type: 'connection', value: { vendor: 'youtube', plain: { youtube_channel_id: 'UCme' } } }],
  ]);
  const door = fakeDoor(records);
  door.read = async (type, id) => (records.get(id)?.type === type ? records.get(id).value : null);
  const thread = (id, by, text) => ({ id, snippet: { totalReplyCount: 0, topLevelComment: { snippet: { textDisplay: text, likeCount: 1, publishedAt: iso(NOW - 3600000), authorChannelId: { value: by } } } } });
  const pulled = { comment: [{ items: [thread('Ugx1', 'UCfan', 'what is the price'), thread('Ugx2', 'UCme', 'price below')] }] };
  const out = await decideTheReplies({ place: 'reply-place:youtube', account_id: 'service_connection:youtube:one', pulled, now: iso(NOW) }, { door });
  assert.equal(out.decisions[0].action, 'send');
  assert.equal(out.decisions[1].reason, 'comment-is-ours');
  const calls = [];
  const sent = await sendAReply({ account_id: 'service_connection:youtube:one', decision: out.decisions[0] }, { door }, {
    nowMs: NOW, read: () => 'stand-in-token',
    send: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 'Ugx1.reply' }) }; },
  });
  assert.equal(sent.status, 'sent');
  assert.equal(calls[0].url, 'https://www.googleapis.com/youtube/v3/comments?part=snippet');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer stand-in-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { snippet: { parentId: 'Ugx1', textOriginal: 'The list is linked below.' } });
});

test('a channel with nothing handed in is named under not_pulled, never decided', async () => {
  const records = new Map([['connection:a', { type: 'connection', value: { plain: { youtube_channel_id: 'UCme' } } }]]);
  const door = fakeDoor(records);
  door.read = async (type, id) => (records.get(id)?.type === type ? records.get(id).value : null);
  const out = await decideTheReplies({ place: 'reply-place:youtube', account_id: 'a', now: iso(NOW) }, { door });
  assert.deepEqual(out.not_pulled, ['tool:read-youtube-comments']);
  assert.deepEqual(out.decisions, []);
});

test('no file of the code names a place: the places are only in reply-places.json', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const here = new URL('../', import.meta.url);
  const named = /instagram|youtube|graph\.|googleapis|meta\b|messenger/i;
  for (const folder of ['do-work', 'read-data']) {
    for (const file of readdirSync(new URL(`${folder}/`, here)).filter(name => name.endsWith('.mjs'))) {
      const text = readFileSync(new URL(`${folder}/${file}`, here), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
      assert.doesNotMatch(text, named, `${folder}/${file} names a place`);
    }
  }
});

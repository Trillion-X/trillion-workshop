// tools/reply-by-keyword-rule: the decide and send rows with no records door and a fake place answer. No network; the
// held token is a stand-in read from a function, never a real value. Rules, pulled items and kept rows arrive in the
// request; every answer holds its whole result and nothing is kept.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideTheReplies } from '../do-work/decide-the-replies.mjs';
import { sendAReply } from '../do-work/send-a-reply.mjs';
import { segment } from '../../pull-from-connected-accounts/read-data/snapshot.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const NOW = Date.parse('2026-11-12T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const IG = 'reply-place:instagram';
const ACCOUNT = 'account-one';

const RULE = { id: 'reply-rule:prices', type: 'reply-rule', value: { id: 'rule:prices', enabled: 'on', words: ['price'], mode: 'any', reply: 'Hi, the price list is here.' } };
const thread = (lastInboundMinutesAgo = 5) => ({ id: 'thread-1', title: 'thread-1', messages: [{ id: 'msg-1', from: { id: 'them' }, created_time: iso(NOW - lastInboundMinutesAgo * 60000), message: 'what is the price' }] });
const keptRow = (key, place = IG) => ({ id: `reply-kept:${segment(place)}:${segment(key)}`, type: 'reply-kept', value: { key, place, state: 'sent' } });
const ask = (extra = {}) => ({ place: IG, now: iso(NOW), self_id: 'me', rules: [RULE], pulled: { dm: [thread()] }, ...extra });

test('the decide row chooses a reply for the latest inbound message and skips a key already kept', () => {
  const out = decideTheReplies(ask(), {});
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].action, 'send');
  assert.equal(out.decisions[0].key, 'msg-1:rule:prices');
  assert.equal(out.decisions[0].reply_text, 'Hi, the price list is here.');
  const again = decideTheReplies(ask({ kept: [keptRow('msg-1:rule:prices')] }), {});
  assert.equal(again.decisions[0].reason, 'already-sent');
});

test('the decide row refuses a request without the person\'s own id', () => {
  assert.throws(() => decideTheReplies(ask({ self_id: undefined }), {}), /give self_id/);
});

test('the decide row run as its row runs it holds no records door and answers the whole decision', async () => {
  const row = rowOf(rows, 'tool:decide-the-replies');
  assert.equal(row.invoke.records, undefined);
  const answer = await answerOf(row, ask(), {});
  assert.equal(answer.status, 0, answer.error);
  assert.equal(answer.result.decisions[0].key, 'msg-1:rule:prices');
  assert.deepEqual(answer.calls ?? [], []);
});

test('the send rows hold no records door and name the row to keep in their answer', () => {
  for (const id of ['tool:send-a-reply-on-instagram', 'tool:send-a-reply-on-youtube']) {
    const row = rowOf(rows, id);
    assert.equal(row.invoke.records, undefined, `${id} holds no records door`);
    assert.ok(row.output_schema.properties.keep, `${id} answers the row to keep`);
  }
});

test('the send row refuses a reply whose window closed before it is sent, and sends nothing', async () => {
  let posted = false;
  const decision = {
    place: IG, action: 'send', kind: 'dm', key: 'msg-1:rule:prices', message_id: 'msg-1', recipient: { id: 'them' },
    reply_text: 'hello', created_time: iso(NOW - 25 * 3600000),
  };
  const out = await sendAReply({ account_id: ACCOUNT, decision }, {}, {
    nowMs: NOW, read: () => 'stand-in-token', send: async () => { posted = true; return { ok: true }; },
  });
  assert.equal(out.status, 'refused');
  assert.equal(out.reason, 'window-closed');
  assert.equal(out.keep, undefined);
  assert.equal(posted, false);
});

test('the send row posts once inside the window, answers the row to keep, and never sends a key already kept', async () => {
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
  const out = await sendAReply({ account_id: ACCOUNT, decision }, {}, deps);
  assert.equal(out.status, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.instagram.com/v21.0/me/messages');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer stand-in-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient: { id: 'them' }, message: { text: 'Hi, the price list is here.' } });
  assert.equal(out.keep.id, `reply-kept:${segment(IG)}:${segment('msg-1:rule:prices')}`);
  assert.equal(out.keep.type, 'reply-kept');
  assert.equal(out.keep.value.state, 'sent');
  assert.equal(out.keep.value.message_id, 'mid-1');
  assert.doesNotMatch(JSON.stringify(out), /stand-in-token/);
  const again = await sendAReply({ account_id: ACCOUNT, decision, kept: [out.keep] }, {}, deps);
  assert.equal(again.status, 'already-sent');
  assert.equal(calls.length, 1);
});

test('a private reply goes to the comment id, and an unknown outcome is answered as not-known, never retried', async () => {
  const decision = {
    place: IG, action: 'send', kind: 'private-reply', key: 'c-1:rule:prices', message_id: 'c-1', recipient: { comment_id: 'c-1' },
    reply_text: 'Here it is.', created_time: iso(NOW - 3600000),
  };
  const sent = [];
  const out = await sendAReply({ account_id: ACCOUNT, decision }, {}, {
    nowMs: NOW, read: () => 'stand-in-token',
    send: async (url, init) => { sent.push(JSON.parse(init.body)); throw new Error('connection reset'); },
  });
  assert.equal(out.status, 'not-known');
  assert.deepEqual(sent[0], { recipient: { comment_id: 'c-1' }, message: { text: 'Here it is.' } });
  assert.equal(out.keep.value.state, 'not-known');
  const retry = await sendAReply({ account_id: ACCOUNT, decision, kept: [out.keep] }, {}, { nowMs: NOW, read: () => 'x', send: async () => { throw new Error('should not send'); } });
  assert.equal(retry.status, 'already-sent');
});

test('a failed answer is answered as a failed row to keep, with the place\'s own words', async () => {
  const decision = { place: IG, action: 'send', kind: 'dm', key: 'm:r', message_id: 'm', recipient: { id: 'them' }, reply_text: 'x', created_time: iso(NOW - 60000) };
  const out = await sendAReply({ account_id: ACCOUNT, decision }, {}, {
    nowMs: NOW, read: () => 't', send: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad recipient' } }) }),
  });
  assert.deepEqual([out.status, out.said, out.keep.value.state, out.keep.value.message], ['failed', 'bad recipient', 'failed', 'bad recipient']);
});

test('the decide row reads the pulled comments: a comment is answered by a private reply, the person\'s own comment is left alone', () => {
  const comments = [
    { id: 'c-1', from: { id: 'them' }, username: 'ben', text: 'price please?', timestamp: iso(NOW - 2 * 3600000) },
    { id: 'c-2', from: { id: 'me' }, username: 'rolling_pin', text: 'price list below', timestamp: iso(NOW - 3600000) },
  ];
  const out = decideTheReplies(ask({ pulled: { dm: [thread()], 'private-reply': [{ id: 'media-1', messages: comments }] } }), {});
  assert.deepEqual(out.not_pulled, []);
  const c1 = out.decisions.find(d => d.message_id === 'c-1');
  assert.equal(c1.action, 'send');
  assert.equal(c1.kind, 'private-reply');
  assert.deepEqual(c1.recipient, { comment_id: 'c-1' });
  assert.equal(out.decisions.find(d => d.message_id === 'c-2').reason, 'comment-is-ours');
});

test('a comment source never handed in is named under not_pulled, and the direct messages are still decided', () => {
  const out = decideTheReplies(ask(), {});
  assert.deepEqual(out.not_pulled, ['instagram-comments']);
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
  const rule = { id: 'reply-rule:prices', type: 'reply-rule', value: { id: 'rule:prices', enabled: 'on', words: ['price'], mode: 'any', reply: 'It is below.' } };
  const pulled = { remark: [{ remarks: [
    { key: 'k1', who: 'v1', when: iso(NOW - 900 * 86400000), body: 'price?' },
    { key: 'k2', who: 'me', when: iso(NOW), body: 'price below' },
  ] }] };
  const out = decideTheReplies({ place: MADE_UP.id, self_id: 'me', rules: [rule], pulled, now: iso(NOW) }, {}, { places: [MADE_UP] });
  assert.deepEqual(out.not_pulled, []);
  assert.deepEqual(out.decisions.map(d => [d.message_id, d.action, d.reason ?? d.key]), [['k1', 'send', 'k1:rule:prices'], ['k2', 'skip', 'remark-is-ours']]);
  const calls = [];
  const deps = {
    nowMs: NOW, places: [MADE_UP], read: fd => { assert.equal(fd, 4); return 'stand-in-token'; },
    send: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ reply: { id: 'r-1' } }) }; },
  };
  const sent = await sendAReply({ account_id: 'service_connection:made-up:one', decision: out.decisions[0] }, {}, deps);
  assert.equal(sent.status, 'sent');
  assert.equal(calls[0].url, 'https://api.made-up.example/answer/k1');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['X-Key'], 'stand-in-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { say: 'It is below.' });
  assert.doesNotMatch(JSON.stringify(sent), /stand-in-token/);
  assert.equal((await sendAReply({ account_id: 'service_connection:made-up:one', decision: out.decisions[0], kept: [sent.keep] }, {}, deps)).status, 'already-sent');
  assert.equal(calls.length, 1);
});

test('a place row whose hosts do not hold the request address sends nothing', async () => {
  const wrong = { ...MADE_UP, send: { ...MADE_UP.send, hosts: ['other.example'] } };
  const decision = { place: MADE_UP.id, action: 'send', kind: 'remark', key: 'k1:r', message_id: 'k1', recipient: {}, reply_text: 'x', created_time: iso(NOW) };
  let posted = false;
  const out = await sendAReply({ account_id: 'a', decision }, {}, { nowMs: NOW, places: [wrong], read: () => 't', send: async () => { posted = true; } });
  assert.equal(out.reason, 'host-not-allowed');
  assert.equal(posted, false);
  assert.equal(out.keep, undefined);
});

test('the shipped YouTube row answers a handed-in comment thread by its id and skips the channel\'s own', async () => {
  const rule = { id: 'reply-rule:prices', type: 'reply-rule', value: { id: 'rule:prices', enabled: 'on', words: ['price'], mode: 'any', reply: 'The list is linked below.' } };
  const youtubeThread = (id, by, text) => ({ id, snippet: { totalReplyCount: 0, topLevelComment: { snippet: { textDisplay: text, likeCount: 1, publishedAt: iso(NOW - 3600000), authorChannelId: { value: by } } } } });
  const pulled = { comment: [{ items: [youtubeThread('Ugx1', 'UCfan', 'what is the price'), youtubeThread('Ugx2', 'UCme', 'price below')] }] };
  const out = decideTheReplies({ place: 'reply-place:youtube', self_id: 'UCme', rules: [rule], pulled, now: iso(NOW) }, {});
  assert.equal(out.decisions[0].action, 'send');
  assert.equal(out.decisions[1].reason, 'comment-is-ours');
  const calls = [];
  const sent = await sendAReply({ account_id: 'service_connection:youtube:one', decision: out.decisions[0] }, {}, {
    nowMs: NOW, read: () => 'stand-in-token',
    send: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 'Ugx1.reply' }) }; },
  });
  assert.equal(sent.status, 'sent');
  assert.equal(calls[0].url, 'https://www.googleapis.com/youtube/v3/comments?part=snippet');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer stand-in-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { snippet: { parentId: 'Ugx1', textOriginal: 'The list is linked below.' } });
});

test('a channel with nothing handed in is named under not_pulled, never decided', () => {
  const out = decideTheReplies({ place: 'reply-place:youtube', self_id: 'UCme', rules: [RULE], now: iso(NOW) }, {});
  assert.deepEqual(out.not_pulled, ['tool:read-youtube-comments']);
  assert.deepEqual(out.decisions, []);
});

test('no file of the code names a place: the places are only in reply-places.json', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const here = new URL('../', import.meta.url);
  const named = /instagram|youtube|graph\.|googleapis|(?<!import\.)meta\b|messenger/i; // import.meta is JavaScript, not the company
  for (const folder of ['do-work', 'read-data']) {
    for (const file of readdirSync(new URL(`${folder}/`, here)).filter(name => name.endsWith('.mjs'))) {
      const text = readFileSync(new URL(`${folder}/${file}`, here), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
      assert.doesNotMatch(text, named, `${folder}/${file} names a place`);
    }
  }
});

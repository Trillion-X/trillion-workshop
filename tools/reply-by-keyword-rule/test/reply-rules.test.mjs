// tools/reply-by-keyword-rule: the rules, the two Meta windows and the choice of replies, with made-up values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSend, chooseReplies, fill, itemsOf, normalise, pick, ruleMatches, windowOpen } from '../read-data/reply-rules.mjs';
import places from '../read-data/reply-places.json' with { type: 'json' };

const NOW = Date.parse('2026-11-12T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const iso = ms => new Date(ms).toISOString();
const rule = (over = {}) => ({ id: 'rule:prices', enabled: 'on', words: ['price'], mode: 'any', reply: 'Hi {name}, the price list is here.', ...over });
const place = places.places.find(row => row.id === 'reply-place:instagram');
const message = (id, from, minutesAgo, text) => ({ id, from: { id: from }, created_time: iso(NOW - minutesAgo * 60 * 1000), message: text });

test('normalise lowers case, drops accents, punctuation and symbols', () => {
  assert.equal(normalise('Émoji! Hello,  WORLD 🎉'), 'emoji hello world');
});

test('a rule matches whole words only, any or all of them', () => {
  assert.equal(ruleMatches(rule(), "What's the PRICE?"), true);
  assert.equal(ruleMatches(rule(), 'pricey stuff'), false);
  assert.equal(ruleMatches(rule({ words: ['price', 'shoes'], mode: 'all' }), 'price of shoes'), true);
  assert.equal(ruleMatches(rule({ words: ['price', 'shoes'], mode: 'all' }), 'price only'), false);
});

test('a window is the place row\'s own number, counted from the item, and null means the place sets none', () => {
  const day = place.channels.find(channel => channel.id === 'dm').window_ms;
  const week = place.channels.find(channel => channel.id === 'private-reply').window_ms;
  assert.equal(day, 24 * HOUR);
  assert.equal(week, 7 * 24 * HOUR);
  assert.equal(windowOpen(day, NOW - (day - 1), NOW), true);
  assert.equal(windowOpen(day, NOW - day, NOW), false);
  assert.equal(windowOpen(null, NOW - 1000 * 24 * HOUR, NOW), true);
});

test('a dotted path reads into an object, and a template fills whole values and words', () => {
  assert.equal(pick({ a: { b: 'x' } }, 'a.b'), 'x');
  assert.equal(pick({ a: null }, 'a.b'), undefined);
  assert.deepEqual(fill({ to: '{recipient}', say: 'hi {name}!' }, { recipient: { id: 'p' }, name: 'Ana' }), { to: { id: 'p' }, say: 'hi Ana!' });
  assert.throws(() => fill('{missing}', {}), /no value for \{missing\}/);
});

test('a reply goes to the latest message of a thread, only when the person wrote it last', () => {
  const threads = [
    { id: 'thread:a', messages: [message('m1', 'them', 30, 'hello'), message('m2', 'them', 5, 'what is the price')] },
    { id: 'thread:b', messages: [message('m3', 'them', 9, 'price?'), message('m4', 'me', 2, 'sent by us')] },
  ];
  const out = chooseReplies({ place, rules: [rule()], pulled: { dm: threads }, selfId: 'me', nowMs: NOW, sentKeys: new Set() });
  const a = out.find(d => d.thread_id === 'thread:a');
  assert.equal(a.action, 'send');
  assert.equal(a.key, 'm2:rule:prices');
  assert.deepEqual(a.recipient, { id: 'them' });
  assert.equal(a.kind, 'dm');
  assert.equal(a.reply_text, 'Hi {name}, the price list is here.');
  const b = out.find(d => d.thread_id === 'thread:b');
  assert.equal(b.action, 'skip');
  assert.equal(b.reason, 'latest-message-is-ours');
});

test('a reply is skipped when its window is closed, its key was already sent, or no enabled rule matches', () => {
  const old = { id: 'thread:old', messages: [message('m5', 'them', 25 * 60, 'price')] };
  const sent = { id: 'thread:sent', messages: [message('m6', 'them', 1, 'price')] };
  const none = { id: 'thread:none', messages: [message('m7', 'them', 1, 'hello there')] };
  const out = chooseReplies({
    place, rules: [rule(), rule({ id: 'rule:off', enabled: 'off', words: ['hello'] })],
    pulled: { dm: [old, sent, none] }, selfId: 'me', nowMs: NOW, sentKeys: new Set(['m6:rule:prices']),
  });
  assert.equal(out.find(d => d.thread_id === 'thread:old').reason, 'window-closed');
  assert.equal(out.find(d => d.thread_id === 'thread:sent').reason, 'already-sent');
  assert.equal(out.find(d => d.thread_id === 'thread:none').reason, 'no-rule-matches');
});

test('the first enabled rule in order decides the reply', () => {
  const threads = [{ id: 'thread:c', messages: [message('m8', 'them', 1, 'price of shoes')] }];
  const out = chooseReplies({
    place, rules: [rule({ id: 'rule:first', words: ['shoes'] }), rule({ id: 'rule:second', words: ['price'] })],
    pulled: { dm: threads }, selfId: 'me', nowMs: NOW, sentKeys: new Set(),
  });
  assert.equal(out[0].rule_id, 'rule:first');
});

test('a comment gets a private reply inside 7 days, and only the comment id is its recipient', () => {
  const comments = [
    { id: 'c1', from: { id: 'them' }, timestamp: iso(NOW - 2 * HOUR), text: 'price please' },
    { id: 'c2', from: { id: 'them' }, timestamp: iso(NOW - 8 * 24 * HOUR), text: 'price please' },
  ];
  const out = chooseReplies({ place, rules: [rule()], pulled: { 'private-reply': [{ id: 'media:1', messages: comments }] }, selfId: 'me', nowMs: NOW, sentKeys: new Set() });
  const c1 = out.find(d => d.message_id === 'c1');
  assert.equal(c1.action, 'send');
  assert.equal(c1.kind, 'private-reply');
  assert.deepEqual(c1.recipient, { comment_id: 'c1' });
  assert.equal(out.find(d => d.message_id === 'c2').reason, 'window-closed');
});

test('checkSend refuses a reply whose window has closed by the time it is sent, and one with no time', () => {
  const decision = { action: 'send', created_time: iso(NOW - 25 * HOUR), window_ms: 24 * HOUR };
  assert.deepEqual(checkSend(decision, NOW), { ok: false, reason: 'window-closed' });
  assert.deepEqual(checkSend({ ...decision, created_time: iso(NOW - HOUR) }, NOW), { ok: true });
  assert.deepEqual(checkSend({ ...decision, window_ms: null, created_time: iso(NOW - 900 * 24 * HOUR) }, NOW), { ok: true });
  assert.deepEqual(checkSend({ ...decision, created_time: undefined }, NOW), { ok: false, reason: 'unknown-time' });
});

test('a place the code has never heard of is read from its row alone: items, own words, window, recipient', () => {
  const made = {
    id: 'reply-place:made-up', channels: [{
      id: 'remark', pull: { handed_in: { tool: 'tool:made-up', items_path: 'data.remarks' } }, which: 'each',
      fields: { message_id: 'key', from_id: 'who.ref', created_time: 'when', text: 'body', thread_id: 'key' },
      own_reason: 'remark-is-ours', recipient: { to: '{from_id}' }, window_ms: 2 * HOUR,
    }],
  };
  const answers = [{ data: { remarks: [
    { key: 'r1', who: { ref: 'v1' }, when: iso(NOW - HOUR), body: 'what is the price' },
    { key: 'r2', who: { ref: 'me' }, when: iso(NOW - HOUR), body: 'price below' },
    { key: 'r3', who: { ref: 'v2' }, when: iso(NOW - 3 * HOUR), body: 'price?' },
  ] } }];
  assert.equal(itemsOf(made.channels[0], answers).length, 3);
  const out = chooseReplies({ place: made, rules: [rule()], pulled: { remark: answers }, selfId: 'me', nowMs: NOW, sentKeys: new Set() });
  assert.deepEqual(out.map(d => [d.message_id, d.action, d.reason ?? d.key]), [['r1', 'send', 'r1:rule:prices'], ['r2', 'skip', 'remark-is-ours'], ['r3', 'skip', 'window-closed']]);
  assert.deepEqual(out[0].recipient, { to: 'v1' });
  assert.equal(out[0].place, 'reply-place:made-up');
});

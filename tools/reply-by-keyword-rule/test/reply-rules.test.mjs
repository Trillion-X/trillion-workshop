// tools/reply-by-keyword-rule: the rules, the two Meta windows and the choice of replies, with made-up values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRIVATE_REPLY_MS, WINDOW_MS, checkSend, chooseReplies, dmWindowOpen, normalise, privateReplyOpen, ruleMatches,
} from '../read-data/reply-rules.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const iso = ms => new Date(ms).toISOString();
const rule = (over = {}) => ({ id: 'rule:prices', enabled: true, words: ['price'], mode: 'any', reply: 'Hi {name}, the price list is here.', ...over });
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

test('a direct message may be answered only inside 24 hours of the last one from the person', () => {
  assert.equal(WINDOW_MS, 24 * HOUR);
  assert.equal(dmWindowOpen(NOW - (24 * HOUR - 1), NOW), true);
  assert.equal(dmWindowOpen(NOW - 24 * HOUR, NOW), false);
});

test('a private reply to a comment may be sent inside 7 days of the comment', () => {
  assert.equal(PRIVATE_REPLY_MS, 7 * 24 * HOUR);
  assert.equal(privateReplyOpen(NOW - (7 * 24 * HOUR - 1), NOW), true);
  assert.equal(privateReplyOpen(NOW - 7 * 24 * HOUR, NOW), false);
});

test('a reply goes to the latest message of a thread, only when the person wrote it last', () => {
  const threads = [
    { id: 'thread:a', messages: [message('m1', 'them', 30, 'hello'), message('m2', 'them', 5, 'what is the price')] },
    { id: 'thread:b', messages: [message('m3', 'them', 9, 'price?'), message('m4', 'me', 2, 'sent by us')] },
  ];
  const out = chooseReplies({ rules: [rule()], threads, comments: [], selfId: 'me', nowMs: NOW, sentKeys: new Set() });
  const a = out.find(d => d.thread_id === 'thread:a');
  assert.equal(a.action, 'send');
  assert.equal(a.key, 'm2:rule:prices');
  assert.equal(a.recipient_id, 'them');
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
    rules: [rule(), rule({ id: 'rule:off', enabled: false, words: ['hello'] })],
    threads: [old, sent, none], comments: [], selfId: 'me', nowMs: NOW, sentKeys: new Set(['m6:rule:prices']),
  });
  assert.equal(out.find(d => d.thread_id === 'thread:old').reason, 'window-closed');
  assert.equal(out.find(d => d.thread_id === 'thread:sent').reason, 'already-sent');
  assert.equal(out.find(d => d.thread_id === 'thread:none').reason, 'no-rule-matches');
});

test('the first enabled rule in order decides the reply', () => {
  const threads = [{ id: 'thread:c', messages: [message('m8', 'them', 1, 'price of shoes')] }];
  const out = chooseReplies({
    rules: [rule({ id: 'rule:first', words: ['shoes'] }), rule({ id: 'rule:second', words: ['price'] })],
    threads, comments: [], selfId: 'me', nowMs: NOW, sentKeys: new Set(),
  });
  assert.equal(out[0].rule_id, 'rule:first');
});

test('a comment gets a private reply inside 7 days, and only the comment id is its recipient', () => {
  const comments = [
    { id: 'c1', media_id: 'media:1', from: { id: 'them' }, created_time: iso(NOW - 2 * HOUR), text: 'price please' },
    { id: 'c2', media_id: 'media:1', from: { id: 'them' }, created_time: iso(NOW - 8 * 24 * HOUR), text: 'price please' },
  ];
  const out = chooseReplies({ rules: [rule()], threads: [], comments, selfId: 'me', nowMs: NOW, sentKeys: new Set() });
  const c1 = out.find(d => d.message_id === 'c1');
  assert.equal(c1.action, 'send');
  assert.equal(c1.kind, 'private-reply');
  assert.deepEqual(c1.recipient, { comment_id: 'c1' });
  assert.equal(out.find(d => d.message_id === 'c2').reason, 'window-closed');
});

test('checkSend refuses a reply whose window has closed by the time it is sent', () => {
  const decision = { action: 'send', kind: 'dm', last_inbound_at: iso(NOW - 25 * HOUR) };
  assert.deepEqual(checkSend(decision, NOW), { ok: false, reason: 'window-closed' });
  assert.deepEqual(checkSend({ ...decision, last_inbound_at: iso(NOW - HOUR) }, NOW), { ok: true });
  assert.deepEqual(checkSend({ action: 'send', kind: 'private-reply', created_time: iso(NOW - 8 * 24 * HOUR) }, NOW), { ok: false, reason: 'window-closed' });
});

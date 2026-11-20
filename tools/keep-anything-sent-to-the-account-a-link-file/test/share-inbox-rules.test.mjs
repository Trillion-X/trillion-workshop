// The share inbox's decisions: what a store's answer means for a kept share, when it resumes, what it keeps and what the
// person reads. No storage here; every name and number is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { notNowStatus, tooBig, shareToKeep, resumeAtOf, outcomeOfAnswer, gaveUp, statusWords, rules } from '../read-data/share-inbox-rules.mjs';

const NOW = Date.parse('2026-11-20T11:00:00Z');

test('a store that is down, busy or out of use for now is "not now"; a plain refusal is not', () => {
  for (const status of [500, 503, 408, 429]) assert.equal(notNowStatus(status), true, String(status));
  for (const status of [200, 202, 400, 404]) assert.equal(notNowStatus(status), false, String(status));
});

test('a share with no list of items, or a to that is not a list, is not kept; a missing request key is made', () => {
  assert.equal(shareToKeep('{"items":[]}'), null);
  assert.equal(shareToKeep('{"items":[1],"to":"x"}'), null);
  assert.equal(shareToKeep('not json'), null);
  const kept = shareToKeep('{"items":[{"title":"made-up"}]}', () => 'rk_made-up-1');
  assert.equal(kept.key, 'rk_made-up-1');
  assert.equal(JSON.parse(kept.body).request_key, 'rk_made-up-1');
  assert.equal(shareToKeep('{"items":[1],"request_key":"device-7"}').key, 'device-7');
});

test('a request over max_bytes is too big, counting its files; a smaller one is not', () => {
  assert.equal(tooBig('x'.repeat(rules.max_bytes + 1)), true);
  assert.equal(tooBig('x'.repeat(10), [{ base64: 'y'.repeat(rules.max_bytes) }]), true);
  assert.equal(tooBig('x'.repeat(10)), false);
});

test('a resume time is the one the answer names, clamped to resume_wait_at_most_seconds; none later is null', () => {
  const later = new Date(NOW + 60_000).toISOString();
  assert.equal(resumeAtOf({ retry_at: later }, NOW), NOW + 60_000);
  assert.equal(resumeAtOf({ retry_at: new Date(NOW + 10 * 86_400_000).toISOString() }, NOW), NOW + rules.resume_wait_at_most_seconds * 1000);
  assert.equal(resumeAtOf({ retry_after: '120' }, NOW), NOW + 120_000);
  assert.equal(resumeAtOf({ retry_at: new Date(NOW - 1000).toISOString() }, NOW), null);
  assert.equal(resumeAtOf({}, NOW), null);
});

test('a store that took the share (2xx, not queued) delivers it; a queued answer keeps it waiting', () => {
  assert.deepEqual(outcomeOfAnswer({ status: 200, ok: true, body: { id: 'made-up' } }, NOW), { outcome: 'delivered' });
  assert.deepEqual(outcomeOfAnswer({ status: 202, ok: true, body: { queued: true } }, NOW), { outcome: 'later', resumeAt: null });
});

test('a not-now answer keeps the share waiting, with its resume time when it names one', () => {
  const retry = new Date(NOW + 30_000).toISOString();
  assert.deepEqual(outcomeOfAnswer({ status: 429, ok: false, body: { retry_at: retry } }, NOW), { outcome: 'later', resumeAt: NOW + 30_000 });
  assert.deepEqual(outcomeOfAnswer({ status: 503, ok: false, body: null }, NOW), { outcome: 'later', resumeAt: null });
});

test('a refusal for good keeps the receiver\'s own words exactly, and a refusal with no words gets the stable reason', () => {
  const words = '  Made-up reason with spaces  ';
  assert.deepEqual(outcomeOfAnswer({ status: 400, ok: false, body: { error: words } }, NOW),
    { outcome: 'refused', status: 400, reason_code: 'receiver_refused', reason: words });
  assert.deepEqual(outcomeOfAnswer({ status: 422, ok: false, body: {} }, NOW),
    { outcome: 'refused', status: 422, reason_code: 'receiver_refused_without_reason', reason: rules.no_reason });
});

test('a share that has tried too often gives up, and the list words say could not deliver with the reason', () => {
  assert.equal(gaveUp(rules.give_up_after_tries - 1), false);
  assert.equal(gaveUp(rules.give_up_after_tries), true);
  assert.equal(statusWords({}), rules.waiting_status);
  assert.equal(statusWords({ refused: { reason: 'Made-up reason' } }), 'could not deliver: Made-up reason');
});

// Opt-in recording rules: open by default, block wins, unknown facts are pending, grants, the notice step, consent events (read-data/recording-rules.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { consentLog, evaluate, grantBook, mayStart, noticeStep, recheck } from '../read-data/recording-rules.mjs';

const rules = [
  { id: 'no-legal', effect: 'block', when: { space: 'legal' }, says: 'the legal space never records' },
  { id: 'notice-first', effect: 'require', when: { space: ['sales', 'support'] }, facts: ['notice_given'] },
  { id: 'host-ok', effect: 'require', when: { kind: 'external' }, facts: ['host_allows'] },
];

test('with no rules everything is allowed, and a rule only restricts what it names', () => {
  assert.deepEqual(evaluate([], { space: 'legal' }), { state: 'allowed', by: [], why: '' });
  assert.equal(evaluate(rules, { space: 'design' }).state, 'allowed');
});

test('block wins, a false required fact blocks, an unknown one is pending, and the refusals are distinct', () => {
  assert.equal(evaluate(rules, { space: 'legal', notice_given: true }).state, 'blocked');
  assert.match(evaluate(rules, { space: 'legal' }).why, /legal space never records/);
  assert.equal(evaluate(rules, { space: 'sales', notice_given: false }).state, 'blocked');
  const pending = evaluate(rules, { space: 'sales' });
  assert.deepEqual([pending.state, pending.by], ['pending', ['notice-first']]);
  assert.equal(evaluate(rules, { space: 'sales', notice_given: true }).state, 'allowed');
  assert.deepEqual(mayStart({ rules, facts: { space: 'sales' } }).code, 'pending');
  assert.deepEqual(mayStart({ rules, facts: { space: 'legal' } }).code, 'refused');
  assert.deepEqual(mayStart({ rules, facts: {}, running: true }).code, 'busy');
  assert.equal(mayStart({ rules, facts: { space: 'design' } }).ok, true);
});

test('mid-session: consent withdrawn stops a recording, an unknown fact does not', () => {
  assert.deepEqual(recheck({ rules, facts: { space: 'sales', notice_given: true } }), { keep: true });
  assert.equal(recheck({ rules, facts: { space: 'sales' } }).keep, true);
  assert.equal(recheck({ rules, facts: { space: 'sales', notice_given: false } }).keep, false);
});

test('request and grant: once is spent by its first use, persistent stays, revoke removes', () => {
  const book = grantBook();
  book.request('ben', 1);
  assert.deepEqual(book.pending(), ['ben']);
  book.grant('ben', { scope: 'once', by: 'ana' });
  assert.deepEqual(book.pending(), []);
  assert.equal(book.use('ben'), true);
  assert.equal(book.use('ben'), false);
  book.grant('cho', { scope: 'persistent', by: 'ana' });
  assert.equal(book.use('cho') && book.use('cho'), true);
  assert.equal(book.revoke('cho'), true);
  assert.equal(book.use('cho'), false);
});

test('the notice has one sender, never types into a field in use, falls back to the camera picture, and can stop', () => {
  const rule = { fallback: 'frame', stop_after_seconds: 30 };
  const base = { senders: ['b-device', 'a-device'], me: 'a-device', sent: false, frame_available: true, waited_seconds: 0 };
  assert.equal(noticeStep(rule, { ...base, field_empty: true }).do, 'type');
  assert.equal(noticeStep(rule, { ...base, field_empty: false }).do, 'frame');
  assert.equal(noticeStep(rule, { ...base, me: 'b-device', field_empty: true }).do, 'wait', 'not the chosen sender');
  assert.equal(noticeStep({ stop_after_seconds: 30 }, { ...base, field_empty: false, frame_available: false, waited_seconds: 31 }).do, 'stop');
  assert.equal(noticeStep({ stop_after_seconds: 30 }, { ...base, field_empty: false, frame_available: false, waited_seconds: 5 }).do, 'wait');
  assert.equal(noticeStep(rule, { ...base, sent: true }).do, 'none');
});

test('consent events are per meeting and person, the latest choice decides, and only that person\'s words are removed', () => {
  const log = consentLog();
  log.record('m1', 'ben', 'continue', 1); log.record('m1', 'cho', 'leave', 2); log.record('m1', 'ben', 'decline', 3); log.record('m1', 'cho', 'continue', 4);
  assert.deepEqual(log.excluded('m1'), ['ben']);
  const turns = [{ person: 'ana', text: 'hi' }, { person: 'ben', text: 'secret' }, { person: 'cho', text: 'ok' }];
  assert.deepEqual(log.keep('m1', turns).map(turn => turn.person), ['ana', 'cho']);
  assert.deepEqual(log.keep('m2', turns).length, 3, 'another meeting is untouched');
  console.log('REAL readback of the consent events:', JSON.stringify(log.events().map(row => `${row.person}:${row.choice}`)));
});

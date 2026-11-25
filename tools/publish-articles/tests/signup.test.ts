import test from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, planConfirmFrom, planSignupFrom, type SignupInput } from '../do-work/signup.ts';

const input: SignupInput = {
  database: 'd', email: ' Reader@Example.com ', source_path: '/articles', consent_text: 'Send me the articles.', confirm_origin: 'https://example.com',
  confirm: { subject: 'Confirm', body: 'Open this link.' }, tags: ['b', 'a', 'a'], now: '2026-01-01T00:00:00.000Z', random_token: 'tok', id: 'sub-1',
};

test('a new address gets one insert and one confirmation message holding the token, which is never stored', () => {
  const plan = planSignupFrom(input, undefined);
  assert.equal(plan.action, 'send_confirmation');
  if (plan.action !== 'send_confirmation') return;
  assert.match(plan.statements[0].sql, /^INSERT INTO subscribers/);
  assert.equal(plan.statements[0].params[1], 'reader@example.com');
  assert.equal(plan.statements[0].params[2], digestOf('sub-1', 'tok'));
  assert.ok(!plan.statements[0].params.includes('tok'));
  assert.equal(plan.statements[0].params[5], '["a","b"]');
  assert.equal(plan.message.to, 'reader@example.com');
  assert.match(plan.message.text, /https:\/\/example.com\/subscribe\/confirm\?s=sub-1&t=tok$/);
});

test('a confirmed address is sent nothing; a bad address or an odd state is refused', () => {
  assert.equal(planSignupFrom(input, { id: 'x', status: 'confirmed' }).action, 'already_confirmed');
  assert.equal(planSignupFrom({ ...input, email: 'nope' }, undefined).action, 'refused');
  assert.equal(planSignupFrom(input, { id: 'x', status: 'bounced' }).action, 'refused');
});

test('an unsubscribed or pending address starts again on its own id with an update', () => {
  const plan = planSignupFrom(input, { id: 'old', status: 'unsubscribed' });
  assert.equal(plan.action, 'send_confirmation');
  if (plan.action !== 'send_confirmation') return;
  assert.match(plan.statements[0].sql, /^UPDATE subscribers/);
  assert.equal(plan.statements[0].params[5], 'old');
  assert.match(plan.message.text, /s=old&t=tok/);
});

test('an http origin is refused', () => {
  assert.throws(() => planSignupFrom({ ...input, confirm_origin: 'http://example.com' }, undefined), TypeError);
});

test('the link confirms once, while fresh, with the right token', () => {
  const row = { id: 'sub-1', status: 'pending', confirm_digest: digestOf('sub-1', 'tok'), confirm_sent_at: '2026-01-01T00:00:00.000Z' };
  const ok = planConfirmFrom({ id: 'sub-1', token: 'tok', now: '2026-01-02T00:00:00.000Z' }, row);
  assert.equal(ok.action, 'confirm');
  assert.match(ok.statements[0].sql, /status = 'confirmed'/);
  assert.equal(planConfirmFrom({ id: 'sub-1', token: 'wrong', now: '2026-01-02T00:00:00.000Z' }, row).action, 'invalid');
  assert.equal(planConfirmFrom({ id: 'sub-1', token: 'tok', now: '2026-01-04T00:00:00.000Z' }, row).action, 'invalid', 'older than 48 hours');
  assert.equal(planConfirmFrom({ id: 'sub-1', token: 'tok' }, { ...row, status: 'confirmed' }).action, 'already_confirmed');
  assert.equal(planConfirmFrom({ id: 'sub-1', token: 'tok' }, undefined).action, 'invalid');
});

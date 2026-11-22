// The Meta signing rule (signing-rules.json, "meta-x-hub-signature-256"): Meta signs the raw body with the app secret and
// sends sha256=<hex> in X-Hub-Signature-256. Made-up secret and body. A call altered after signing, signed with another
// secret, sent without the sha256= prefix, or without the header is refused; the same call signed correctly is verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { checkSignature, signingRuleNamed } from '../do-work/mechanisms/signed-service-calls.mjs';

const RULE_NAME = 'meta-x-hub-signature-256';
const APP_SECRET = 'made-up-meta-app-secret';
const body = JSON.stringify({ object: 'instagram', entry: [{ id: '17841400000000000', time: 1795050000, changes: [{ field: 'comments', value: { id: 'comment-1', text: 'PRICE' } }] }] });
const signedWith = (secret, payload = body) => ({ 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}` });
const check = (headers, payload = body) => checkSignature({ verify: signingRuleNamed(RULE_NAME), headers, body: payload, secret: APP_SECRET });

test('the Meta rule is a named row that signs the raw body with sha256 in hex', () => {
  assert.deepEqual(signingRuleNamed(RULE_NAME), {
    parts: { sig: { header: 'x-hub-signature-256', match: 'sha256=([0-9a-fA-F]+)' } },
    signed: '{body}', signature: 'sig', hash: 'sha256', encoding: 'hex',
  });
});

test('a call signed over its raw body with the app secret is verified', () => {
  assert.deepEqual(check(signedWith(APP_SECRET)), { ok: true });
});

test('a call whose body was altered after signing is refused', () => {
  assert.equal(check(signedWith(APP_SECRET), body.replace('PRICE', 'SPAM')).reason, 'signature-mismatch');
});

test('a call signed with another secret is refused', () => {
  assert.equal(check(signedWith('someone-else-app-secret')).reason, 'signature-mismatch');
});

test('a call whose signature has no sha256= prefix is refused', () => {
  const bare = createHmac('sha256', APP_SECRET).update(body).digest('hex');
  assert.equal(check({ 'x-hub-signature-256': bare }).reason, 'no-signature');
});

test('a call without the signature header is refused', () => {
  assert.equal(check({}).reason, 'no-signature');
});

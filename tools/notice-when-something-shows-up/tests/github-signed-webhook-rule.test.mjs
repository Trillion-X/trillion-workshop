// The GitHub signing rule (signing-rules.json, "github-x-hub-signature-256"): GitHub signs the raw body with the webhook's
// secret and sends sha256=<hex> in X-Hub-Signature-256. The vector is GitHub's own, copied from
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries (read Nov 28 2026): secret
// "It's a Secret to Everybody", payload "Hello, World!", signature 757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSignature, signingRuleNamed } from '../do-work/mechanisms/signed-service-calls.mjs';

const RULE_NAME = 'github-x-hub-signature-256';
const SECRET = "It's a Secret to Everybody";
const PAYLOAD = 'Hello, World!';
const SIGNATURE = '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
const check = (headers, body = PAYLOAD, secret = SECRET) => checkSignature({ verify: signingRuleNamed(RULE_NAME), headers, body, secret });

test('the GitHub rule is a named row that signs the raw body with sha256 in hex', () => {
  assert.deepEqual(signingRuleNamed(RULE_NAME), {
    parts: { sig: { header: 'x-hub-signature-256', match: '^sha256=([0-9a-fA-F]{64})$' } },
    signed: '{body}', signature: 'sig', hash: 'sha256', encoding: 'hex',
  });
});

test("GitHub's documented vector is verified", () => {
  assert.deepEqual(check({ 'x-hub-signature-256': `sha256=${SIGNATURE}` }), { ok: true });
});

test('one flipped byte of the body is refused', () => {
  assert.equal(check({ 'x-hub-signature-256': `sha256=${SIGNATURE}` }, 'Hello, World?').reason, 'signature-mismatch');
});

test('one flipped digit of the signature is refused', () => {
  const flipped = `${SIGNATURE.slice(0, -1)}${SIGNATURE.endsWith('7') ? '8' : '7'}`;
  assert.equal(check({ 'x-hub-signature-256': `sha256=${flipped}` }).reason, 'signature-mismatch');
});

test('another secret is refused', () => {
  assert.equal(check({ 'x-hub-signature-256': `sha256=${SIGNATURE}` }, PAYLOAD, "It's a Secret to Somebody").reason, 'signature-mismatch');
});

test('a signature without the sha256= prefix, the old sha1 header, or no header is refused', () => {
  assert.equal(check({ 'x-hub-signature-256': SIGNATURE }).reason, 'no-signature');
  assert.equal(check({ 'x-hub-signature': 'sha1=01dc10d0c83e72ed246219cdd91669667fe2ca59' }).reason, 'no-signature');
  assert.equal(check({}).reason, 'no-signature');
});

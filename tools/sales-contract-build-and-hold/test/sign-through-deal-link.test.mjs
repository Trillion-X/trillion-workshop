import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSignName, signerOf, signSection } from '../read-data/sign-through-deal-link.mjs';

test('a buyer who has signed sees the signatures on the link', () => {
  assert.deepEqual(signSection({ signedByYou: true, signatures: [{ name: 'Ana' }], proven: true }), { kind: 'signed', signatures: [{ name: 'Ana' }] });
});

test('signatures made by others show even before this buyer proves their address', () => {
  assert.deepEqual(signSection({ signedByYou: false, signatures: [{ name: 'Ben' }], proven: false }), { kind: 'signed', signatures: [{ name: 'Ben' }] });
});

test('a proven buyer with no signature yet gets the signing form with the name field', () => {
  assert.deepEqual(signSection({ signedByYou: false, signatures: [], proven: true }), {
    kind: 'form',
    field: { name: 'name', required: true, min_length: 2, max_length: 200 },
  });
});

test('an unproven buyer with no signature gets no signing section', () => {
  assert.deepEqual(signSection({ signedByYou: false, signatures: [], proven: false }), { kind: 'none' });
});

test('the signer is the buyer when the link delivers on signing, else nobody', () => {
  assert.equal(signerOf({ deliversOnSign: true, buyer: 'buyer_1' }), 'buyer_1');
  assert.equal(signerOf({ deliversOnSign: false, buyer: 'buyer_1' }), null);
});

test('a typed name needs at least 2 and at most 200 characters', () => {
  assert.deepEqual(checkSignName('Ana'), { ok: true });
  assert.deepEqual(checkSignName(''), { ok: false, problem: 'required', message: 'Give your name to sign.' });
  assert.deepEqual(checkSignName(undefined), { ok: false, problem: 'required', message: 'Give your name to sign.' });
  assert.deepEqual(checkSignName('A'), { ok: false, problem: 'too_short', message: 'Your name needs at least 2 characters.' });
  assert.equal(checkSignName('A'.repeat(200)).ok, true);
  assert.deepEqual(checkSignName('A'.repeat(201)), { ok: false, problem: 'too_long', message: 'Your name can be at most 200 characters.' });
});

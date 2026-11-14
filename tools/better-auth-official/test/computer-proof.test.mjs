// tools/better-auth-official/test/computer-proof.test.mjs
//
// computer-proof.mjs checks a Trillion computer's proof and its account's computers row byte for byte as trillion-rust
// src/account/computers.rs does. The fixtures (test-fixtures/computer-proof.json) were signed outside this module: Ed25519 from
// fixed seeds by Python's cryptography package over its own implementation of computers.rs's byte layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addressOf, enrolledAccount, keyDigest, readProof } from '../computer-proof.mjs';

const fixture = JSON.parse(readFileSync(new URL('../test-fixtures/computer-proof.json', import.meta.url), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')).computer_proof;
const now = fixture.at + 1000;

test('blake3 is the standard one: the empty text\'s hash', () => {
  assert.equal(keyDigest(''), 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
});

test('a key-check proof signed by a computer for a key is read: the computer, the key\'s digest, the time', () => {
  assert.deepEqual(readProof(settings, 'key-check', fixture.proof, now), { computer: fixture.computer, part: keyDigest(fixture.key), at: fixture.at });
});

test('a proof of another use, outside the window, with a changed signature or another text is refused', () => {
  assert.equal(readProof(settings, 'key-check', fixture.proof_of_another_use, now), null);
  assert.equal(readProof(settings, 'key-check', fixture.proof, fixture.at + settings.window_ms + 1), null);
  assert.equal(readProof(settings, 'key-check', fixture.proof.replace(/.$/, c => (c === '0' ? '1' : '0')), now), null);
  assert.equal(readProof(settings, 'session', fixture.proof, now), null, 'a use the settings do not name');
  assert.equal(readProof(settings, 'key-check', `trc_${fixture.proof.slice(4)}`, now), null);
  assert.notEqual(readProof(settings, 'key-check', fixture.proof_for_another_key, now)?.part, keyDigest(fixture.key), 'a proof binds one key');
});

test('the account\'s own row, signed by the key its address names, enrolls the computers it lists and no other', () => {
  assert.equal(addressOf(settings, fixture.kept.account_key), fixture.kept.row.account);
  assert.equal(enrolledAccount(settings, fixture.kept, fixture.computer), fixture.kept.row.account);
  assert.equal(enrolledAccount(settings, fixture.kept, fixture.stranger), null);
  assert.equal(enrolledAccount(settings, { ...fixture.kept, row: { ...fixture.kept.row, revision: 4 } }, fixture.computer), null, 'a changed row');
  assert.equal(enrolledAccount(settings, { ...fixture.kept, account_key: fixture.stranger }, fixture.computer), null, 'a key the address does not name');
  assert.equal(enrolledAccount(settings, { ...fixture.kept, row: { ...fixture.kept.row, pursuit: 'p' } }, fixture.computer), null, 'a pursuit\'s row');
});

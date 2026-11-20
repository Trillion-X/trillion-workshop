// Setting up the ways in besides passkeys: new backup codes are unbiased, grouped for reading and shown once; an
// authenticator setup waits for its first right code, turns on with that code's step, ends when its wait passes, and
// refuses past its tries; adding a way in needs a fresh sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHENTICATOR, authenticatorRemovedWords, authenticatorSetupEnds, authenticatorSetupWords, backupRemovedWords,
  backupRevealWords, BACKUP_CODES, finishAuthenticatorSetup, formatBackupCode, isFreshSignIn, newBackupCodes,
  normalBackupCode, signInAgainWords,
} from '../read-data/verify-every-port-sign-in-authenticator-setup.mjs';

const MINUTE = 60_000;
// A deterministic byte source for the tests: it cycles 0..255, so the rejection of biased bytes is exercised.
const cycling = () => {
  let next = 0;
  return bytes => Uint8Array.from(bytes, () => { const value = next; next = (next + 1) % 256; return value; });
};

test('new backup codes are the set size, twelve characters of the alphabet, and read in groups', () => {
  const codes = newBackupCodes(cycling());
  assert.equal(codes.length, BACKUP_CODES.count);
  for (const { code, shown } of codes) {
    assert.equal(code.length, BACKUP_CODES.groups * BACKUP_CODES.group_length);
    assert.ok([...code].every(char => BACKUP_CODES.alphabet.includes(char)), 'every character is from the alphabet');
    assert.match(shown, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.equal(normalBackupCode(shown), code, 'the form the person types reads back to the kept form');
  }
});

test('bytes that would bias a character are skipped, never used', () => {
  const alphabet = BACKUP_CODES.alphabet;
  const below = Math.floor(256 / alphabet.length) * alphabet.length;
  const biased = alphabet.length === 1 ? 0 : below;
  let served = 0;
  // First request: a biased byte, then bytes that map to the second character; every later request gives the second too.
  const codes = newBackupCodes(bytes => {
    served += 1;
    return Uint8Array.from(bytes, (_, index) => (served === 1 && index === 0 ? biased : 1));
  });
  assert.ok(biased >= below && biased < 256);
  assert.ok(![...codes[0].code].includes(alphabet[biased % alphabet.length]), 'the biased byte made no character');
  assert.ok([...codes[0].code].every(char => char === alphabet[1]));
});

test('a typed code is kept in its one form: lower case, no spaces or dashes', () => {
  assert.equal(normalBackupCode(' ABCD-efgh jkmn '), 'abcdefghjkmn');
  assert.equal(normalBackupCode(undefined), '');
  assert.equal(formatBackupCode('abcdefghjkmn'), 'abcd-efgh-jkmn');
});

test('the backup code words say how many there are and that each works once', () => {
  const reveal = backupRevealWords();
  assert.equal(reveal.label, 'Your 10 backup codes. Copy them now: they are shown only this once.');
  assert.equal(reveal.note, 'Keep these somewhere safe, away from this device. Each works once.');
  assert.equal(backupRemovedWords(), 'Your backup codes are removed.');
});

test('a way in is added or changed only by a sign-in made within the fresh window, never by a phone sign-in', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const fresh = { method: 'passkey', created_at: new Date(now - 9 * MINUTE).toISOString() };
  assert.equal(isFreshSignIn(fresh, now), true);
  assert.equal(isFreshSignIn({ method: 'passkey', created_at: new Date(now - 11 * MINUTE).toISOString() }, now), false);
  assert.equal(isFreshSignIn({ method: 'phone', created_at: new Date(now).toISOString() }, now), false);
  assert.equal(isFreshSignIn(undefined, now), false, 'no sign-in is never fresh');
  assert.equal(signInAgainWords(), 'For your safety, sign in again first. Opening sign-in…');
});

test('the first right code turns the setup on with its step; a wrong code says so; a passed setup ends', () => {
  const now = 1_000_000;
  const ends = authenticatorSetupEnds(now);
  assert.equal(ends, now + 15 * MINUTE);
  const on = finishAuthenticatorSetup({ ends, now, code: '123456', checkStep: code => (code === '123456' ? 42 : null) });
  assert.deepEqual(on, { outcome: 'on', step: 42 });
  assert.equal(authenticatorSetupWords(on), 'Your authenticator app is on. It shows a new code for the service every 30 seconds.');
  const wrong = finishAuthenticatorSetup({ ends, now, code: '000000', checkStep: () => null });
  assert.deepEqual(wrong, { outcome: 'wrong' });
  assert.equal(authenticatorSetupWords(wrong), 'That code is not right. Type the newest code your authenticator app shows for the service.');
  const late = finishAuthenticatorSetup({ ends, now: ends, code: '123456', checkStep: () => 1 });
  assert.deepEqual(late, { outcome: 'ended' }, 'at the end time the setup has ended');
  assert.equal(authenticatorSetupWords(late), 'This setup ended. Open it again from Account & security.');
});

test('a setup past its tries waits, and the words say how many minutes', () => {
  const now = 5;
  const answer = finishAuthenticatorSetup({ ends: now + MINUTE, now, waitMinutes: 15, code: '123456', checkStep: () => 1 });
  assert.deepEqual(answer, { outcome: 'wait', wait_minutes: 15 }, 'a wait is answered before the code is checked');
  assert.equal(authenticatorSetupWords(answer), 'Too many tries. Wait 15 minutes, then try again.');
  assert.equal(AUTHENTICATOR.tries_per_setup, 5);
});

test('removing the authenticator app says its codes stop signing in', () => {
  assert.equal(authenticatorRemovedWords(), 'Your authenticator app is removed. Its codes no longer sign in.');
});

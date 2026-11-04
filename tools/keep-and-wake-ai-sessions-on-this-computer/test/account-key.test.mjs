// The shared account-key reader (harness/account-key.mjs): held, absent and unreadable are different answers, against
// the file home and a Keychain that answers as macOS does. The run against a real throwaway Keychain sits in
// Trillion-X/trillion-apps beside scripts/macos-keychain-state.mjs, which makes that Keychain without touching the
// person's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAccountKey, accountKeyOrNull, requireAccountKey } from '../harness/account-key.mjs';

const SECRET = 'nm_fictional_test_key_0001';

test('on another system the key file is read only when no one but its owner can read it', t => {
  const root = mkdtempSync(join(tmpdir(), 'trillion-account-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'key');
  assert.deepEqual(readAccountKey({ platform: 'linux', file }), { state: 'absent' });
  writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });
  assert.deepEqual(readAccountKey({ platform: 'linux', file }), { state: 'held', key: SECRET });
  chmodSync(file, 0o644);
  assert.deepEqual(readAccountKey({ platform: 'linux', file }), { state: 'unreadable', reason: 'key file is readable by others' });
  chmodSync(file, 0o600);
  writeFileSync(file, '\n', { mode: 0o600 });
  assert.deepEqual(readAccountKey({ platform: 'linux', file }), { state: 'absent' });
});

test('a Keychain that says no such item is absent; one that is refused or silent is unreadable, and its words are not passed on', () => {
  const absent = readAccountKey({ platform: 'darwin', exec: () => { throw Object.assign(new Error('not found'), { status: 44 }); } });
  assert.deepEqual(absent, { state: 'absent' });
  const refused = readAccountKey({ platform: 'darwin', exec: () => { throw Object.assign(new Error('user canceled the secret nm_leak'), { status: 128 }); } });
  assert.deepEqual(refused, { state: 'unreadable', reason: 'keychain refused' });
  const silent = readAccountKey({ platform: 'darwin', exec: () => { throw Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }); } });
  assert.deepEqual(silent, { state: 'unreadable', reason: 'keychain did not answer' });
  assert.equal(accountKeyOrNull({ platform: 'darwin', exec: () => { throw new Error('x'); } }), null);
});

test('the key is asked for by item name, never put in an argument', () => {
  let seen;
  readAccountKey({ platform: 'darwin', item: 'some-item', exec: (program, args) => { seen = [program, args]; return `${SECRET}\n`; } });
  assert.deepEqual(seen, ['/usr/bin/security', ['find-generic-password', '-s', 'some-item', '-w']]);
});

test('a caller that needs the key gets it, or an error that says whether none is kept or it could not be read', () => {
  assert.equal(requireAccountKey({ platform: 'darwin', exec: () => `${SECRET}\n` }), SECRET);
  assert.throws(() => requireAccountKey({ platform: 'darwin', exec: () => { throw Object.assign(new Error('x'), { status: 44 }); } }), { code: 'account_key_absent' });
  assert.throws(() => requireAccountKey({ platform: 'darwin', exec: () => { throw Object.assign(new Error('x'), { status: 128 }); } }), { code: 'account_key_unreadable' });
});

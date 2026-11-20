// The account key a unit's sealed credential holds (harness/wake-sessions.mjs keyFromCredential): read from the
// credentials folder systemd makes, with the trailing newline removed, and refused without a folder or name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { keyFromCredential } from '../harness/wake-sessions.mjs';

test('the account key is read from the credential file, without its trailing newline', () => {
  const folder = mkdtempSync(join(tmpdir(), 'wake-cred-'));
  try {
    writeFileSync(join(folder, 'account-key'), 'key-value-for-test\n');
    assert.equal(keyFromCredential('account-key', folder), 'key-value-for-test');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('no credential folder or name is refused, and a missing credential is an error', () => {
  assert.throws(() => keyFromCredential('account-key', undefined), /No credential folder or name/);
  assert.throws(() => keyFromCredential('', '/tmp'), /No credential folder or name/);
  const folder = mkdtempSync(join(tmpdir(), 'wake-cred-'));
  try { assert.throws(() => keyFromCredential('absent', folder), /ENOENT/); }
  finally { rmSync(folder, { recursive: true, force: true }); }
});

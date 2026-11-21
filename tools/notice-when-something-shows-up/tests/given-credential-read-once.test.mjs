// A credential descriptor is read once and its text kept, so every waiter of one switch that shares the run's
// credential_name gets the key: the engine mounts it as a pipe, which answers only its first read. A temp file opened
// once stands in for the pipe (a second readFileSync of the same descriptor reads from where the first stopped: nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGivenCredential } from '../do-work/mechanisms/given-credential.mjs';

test('two waiters sharing one descriptor both read the same credential', () => {
  const folder = mkdtempSync(join(tmpdir(), 'given-credential-'));
  try {
    writeFileSync(join(folder, 'held'), 'made-up-token\n');
    const fd = openSync(join(folder, 'held'), 'r');
    try {
      assert.equal(readGivenCredential({ credentialFd: fd }, 4), 'made-up-token');
      assert.equal(readGivenCredential({ credentialFd: fd }, 4), 'made-up-token', 'the second waiter gets the key too');
      assert.equal(readGivenCredential({ credentialMounted: true }, fd), 'made-up-token', 'the fallback descriptor is the same kept read');
    } finally { closeSync(fd); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a waiter with no credential mounted is still refused before any read', () => {
  assert.throws(() => readGivenCredential({ credentialMounted: false }, 4), /no credential named/);
});

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/trillion.json' with { type: 'json' };
import { findLocalDoor, main, stateOf } from '../do-work/trillion.mjs';

// The real thing: this computer's own engine and the issuer it names, with only the browser stubbed. It runs where the Trillion
// app is installed (a computer with no local door has nothing here to ask).
const localMcp = findLocalDoor();
// The engine must be answering: one that is not running is said (login does not fall back to another Trillion), not reached.
const answering = localMcp !== null && await fetch(new URL(settings.protected_resource_path, localMcp)).then(answer => answer.ok).catch(() => false);

test('bare trillion login reaches the browser step against this computer\'s engine and its real issuer', { skip: !answering && 'this computer\'s Trillion is not answering' }, async () => {
  let opened = null;
  const open = async url => { opened = new URL(url); throw new Error('browser stubbed'); };
  const memory = { where: 'memory', read: () => null, write: () => {}, forget: () => {} };
  const started = Date.now();
  await assert.rejects(main(['login'], { store: { read: () => null, where: 'no key' }, grants: memory, state: stateOf({ home: mkdtempSync(join(tmpdir(), 'trillion-login-live-')) }), open, env: {}, localDoor: () => localMcp }), /Trillion could not open your browser/);
  assert.ok(opened, 'the authorize page was reached');
  assert.equal(opened.protocol, 'https:');
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(opened.searchParams.get('scope'), settings.scope);
  assert.ok(Date.now() - started < 10_000, 'discovery is one local read and one public read');
});

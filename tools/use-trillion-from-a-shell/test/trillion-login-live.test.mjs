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

test('bare trillion login reaches the browser step against this computer\'s engine and its real issuer', { skip: localMcp === null && 'no Trillion app on this computer' }, async () => {
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

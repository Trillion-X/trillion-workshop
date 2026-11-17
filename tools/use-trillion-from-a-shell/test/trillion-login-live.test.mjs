import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/trillion.json' with { type: 'json' };
import { findDeclaredOrigin, main, stateOf } from '../do-work/trillion.mjs';

// The real thing: the sign-in site's own engine and the issuer it names, with only the browser stubbed. It skips where that engine does not
// answer (a computer with no network): one that is not answering is said, never replaced by another.
const site = findDeclaredOrigin();
const answering = site !== null && await fetch(new URL(settings.protected_resource_path, `${site}/mcp`)).then(answer => answer.ok).catch(() => false);

test('bare trillion login reaches the browser step against the sign-in site\'s engine and its real issuer', { skip: !answering && 'the sign-in site is not declared or not answering' }, async () => {
  let opened = null;
  const open = async url => { opened = new URL(url); throw new Error('browser stubbed'); };
  const memory = { where: 'memory', read: () => null, write: () => {}, forget: () => {} };
  const started = Date.now();
  await assert.rejects(main(['login'], { store: { read: () => null, where: 'no key' }, grants: memory, state: stateOf({ home: mkdtempSync(join(tmpdir(), 'trillion-login-live-')) }), open, env: {}, agentSocket: () => null, localDoor: () => null, declaredOrigin: () => site }), /Trillion could not open your browser/);
  assert.ok(opened, 'the authorize page was reached');
  assert.equal(opened.protocol, 'https:');
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(opened.searchParams.get('scope'), settings.scope);
  assert.ok(Date.now() - started < 10_000, 'discovery is two public reads');
});

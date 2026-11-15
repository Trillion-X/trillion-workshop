import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browserWithPasskeyDevice, createAccount } from 'trillion-workshop/test-helpers/passkey-account.mjs';

test('app proofs can load the exported account fixture and its packed local dependencies', () => {
  assert.equal(typeof browserWithPasskeyDevice, 'function');
  assert.equal(typeof createAccount, 'function');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = new Set(manifest.files);
  for (const file of ['passkey-account.mjs', 'chromium.mjs', 'customer-signup-observation.mjs', 'sign-in-methods.json']) {
    assert.ok(declared.has(`test-helpers/${file}`), `${file} must travel with the account fixture`);
    assert.ok(readFileSync(new URL(`../test-helpers/${file}`, import.meta.url)).length > 0);
  }
  assert.ok(manifest.dependencies.playwright, 'the installed fixture needs Playwright at runtime');
});

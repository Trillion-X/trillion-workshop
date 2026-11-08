import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import SIGN_IN_METHODS from 'trillion-workshop/test-helpers/sign-in-methods.json' with { type: 'json' };

test('installed consumers receive all sign-in work words and long-wait steps through the public DATA export', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('test-helpers/sign-in-methods.json'), 'the exported DATA travels in the package');
  const work = Object.entries(SIGN_IN_METHODS.work).filter(([name]) => !name.startsWith('_'));
  assert.ok(work.length > 0, 'the sign-in DATA contains real work');
  for (const [name, words] of work) {
    assert.ok(words.pending?.endsWith('…') && words.done && !words.done.endsWith('…'), name);
  }
  assert.ok(SIGN_IN_METHODS.still_working.steps.length > 0);
  assert.ok(SIGN_IN_METHODS.still_working.again);
});

test('the page script and account proof read the same sign-in DATA owner', () => {
  for (const relative of ['../tools/sign-in-with-a-passkey/passkey.mjs', '../test-helpers/passkey-account.mjs']) {
    const owner = new URL(relative, import.meta.url);
    const source = readFileSync(owner, 'utf8');
    const imported = /import\s+\w+\s+from\s+['"]([^'"]+sign-in-methods\.json)['"]/.exec(source)?.[1];
    assert.ok(imported, `${relative} reads the sign-in DATA`);
    assert.equal(new URL(imported, owner).href, import.meta.resolve('trillion-workshop/test-helpers/sign-in-methods.json'));
  }
  for (const key of ['passkey_sign_in', 'passkey_create', 'code_finish', 'code_send', 'sign_up_finish', 'password_set', 'password_sign_in']) {
    assert.ok(SIGN_IN_METHODS.work[key], `${key} used by the page script has work words`);
  }
});

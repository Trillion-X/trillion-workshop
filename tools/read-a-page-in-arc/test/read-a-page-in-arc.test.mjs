// test/read-a-page-in-arc.test.mjs: opens example.com in the real Arc browser, reads it and checks the tab was closed.
// The check on the address is done without Arc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPageInArc } from '../read-a-page-in-arc.mjs';

const run = promisify(execFile);

test('refuses an address that is not http or https, without touching Arc', async () => {
  let called = false;
  const answer = await readPageInArc({ url: 'file:///etc/hosts' }, { exec: async () => { called = true; return { stdout: '' }; } });
  assert.equal(called, false);
  assert.match(answer.error, /http or https/);
});

test('reads example.com in Arc and closes its tab', async () => {
  const answer = await readPageInArc({ url: 'https://example.com/' });
  assert.equal(answer.error, undefined, answer.error);
  assert.equal(answer.title, 'Example Domain');
  assert.match(answer.text, /documentation/);
  assert.ok(answer.text.length <= 20000);
  const { stdout } = await run('osascript', ['-e', 'tell application "Arc" to return URL of (active tab of front window)']);
  assert.doesNotMatch(stdout, /^https:\/\/example\.com\/?$/);
});

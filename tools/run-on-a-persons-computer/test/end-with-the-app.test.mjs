// A program the app starts ends once the app is gone (computer/end-with-the-app.mjs), and only then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { endWithTheApp } from '../end-with-the-app.mjs';

test('a child ends when its parent changes, and a program started by launchd never does', async () => {
  let parent = 4242;
  let ended = 0;
  const timer = endWithTheApp({ every_seconds: 0.01, parentOf: () => parent, end: () => { ended += 1; } });
  await new Promise(done => setTimeout(done, 40));
  assert.equal(ended, 0, 'the app is still there');
  parent = 1;
  await new Promise(done => setTimeout(done, 40));
  assert.ok(ended >= 1, 'the app is gone: the program ends');
  clearInterval(timer);
  assert.equal(endWithTheApp({ parentOf: () => 1, end: () => { ended += 100; } }), null, 'started by launchd: nothing to watch');
});

// tools/better-auth-official/test/stop-without-dropping.test.mjs
//
// A stop never drops a call: /readyz answers 503 from the signal on, a call that arrives during the hold is answered, and a call
// already running when the listener closes finishes before the process ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { readiness, stopWithoutDropping } from '../stop-without-dropping.mjs';

test('a stop answers 503 on /readyz, serves the hold, and finishes the call it holds before it ends', async () => {
  const server = createServer((request, response) => {
    if (readiness(request, response)) return;
    setTimeout(() => response.end('done'), 600);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const at = path => `http://127.0.0.1:${server.address().port}${path}`;
  assert.equal((await fetch(at('/readyz'))).status, 200);
  const signal = new EventEmitter();
  let exited = null, after = false;
  const ended = new Promise(done => stopWithoutDropping([server], { hold_ms: 300, grace_ms: 5000 }, async () => { after = true; }, { on: signal, exit: code => { exited = code; done(); } }));
  const slow = fetch(at('/slow'));
  await new Promise(done => setTimeout(done, 50));
  signal.emit('SIGTERM');
  assert.equal((await fetch(at('/readyz'))).status, 503, 'the front door stops sending work at once');
  assert.equal(await (await fetch(at('/in-the-hold'))).text(), 'done', 'a call that arrives during the hold is answered');
  assert.equal(await (await slow).text(), 'done', 'the call it held finishes');
  await ended;
  assert.equal(exited, 0);
  assert.ok(after, 'the store closes only after every call');
});

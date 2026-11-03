// The page side of a resumable live stream (src/workspace/store-changes.ts): it remembers the last numbered change it
// heard, names it when the socket reconnects, reads everything again on `reset`, and drops a message that is no frame.
import test from 'node:test';
import assert from 'node:assert/strict';

const sockets = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  constructor(url) { super(); this.url = url; sockets.push(this); }
  close(code = 1006) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
  hear(frame) { this.dispatchEvent(Object.assign(new Event('message'), { data: typeof frame === 'string' ? frame : JSON.stringify(frame) })); }
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('a reconnect names the last numbered change heard; reset reads every screen again; a non-frame is dropped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  Object.assign(globalThis, { window: globalThis, WebSocket: FakeSocket, location: { protocol: 'https:', host: 'app.example' } });
  delete globalThis.BroadcastChannel;
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, querySelectorAll: () => [] };
  globalThis.addEventListener = () => {};
  // Each close is counted with its code (src/interactions.mjs liveClosed).
  const counted = [];
  globalThis.trillionCounting = { liveClosed: (code, ms) => counted.push({ code, measured: Number.isFinite(ms) }) };
  const { onStoreChange } = await import('../src/workspace/store-changes.ts?resume');
  const reads = { messages: 0, other: 0 };
  onStoreChange(() => { reads.messages += 1; }, ['/work/api/messages']);
  onStoreChange(() => { reads.other += 1; }, ['/work/api/other']);
  await turn();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://app.example/work/live', 'a first connection names nothing');

  sockets[0].hear({ revision: 4, epoch: 'e1', seq: 2 });
  await turn(); t.mock.timers.tick(3000); await turn();
  reads.messages = 0; reads.other = 0;
  sockets[0].hear({ changed: ['/work/api/messages'], epoch: 'e1', seq: 3 });
  await turn(); t.mock.timers.tick(3000); await turn();
  assert.deepEqual(reads, { messages: 1, other: 0 }, 'a narrow change reads only the screen drawn from it');

  sockets[0].hear('this is not a frame');
  sockets[0].hear('[1,2]');
  await turn(); t.mock.timers.tick(3000); await turn();
  assert.deepEqual(reads, { messages: 1, other: 0 }, 'a message that is no frame reads nothing');

  sockets[0].close();
  t.mock.timers.tick(2000);
  await turn();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, 'wss://app.example/work/live?epoch=e1&after=3', 'the reconnect says where it left off');

  sockets[1].hear({ revision: 4, epoch: 'e1', seq: 5 });
  sockets[1].hear({ reset: true, epoch: 'e2', seq: 0 });
  await turn(); t.mock.timers.tick(3000); await turn();
  assert.deepEqual(reads, { messages: 2, other: 1 }, 'reset reads every screen again');
  sockets[1].close();
  t.mock.timers.tick(5000);
  await turn();
  assert.equal(sockets[2].url, 'wss://app.example/work/live?epoch=e2&after=0', 'and the new life is the one it names next');
  sockets[2].close(1013);
  assert.deepEqual(counted, [{ code: 1006, measured: true }, { code: 1006, measured: true }, { code: 1013, measured: true }], 'every close is counted with its code');
});

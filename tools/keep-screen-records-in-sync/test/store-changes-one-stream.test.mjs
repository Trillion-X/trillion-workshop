// Two tabs of one browser share one live stream (src/workspace/store-changes.ts): the tab holding the stream lock owns the
// socket and hands every frame to the other tab; when it leaves, the other takes over.
import test from 'node:test';
import assert from 'node:assert/strict';

const sockets = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  constructor(url) { super(); this.url = url; sockets.push(this); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  hear(frame) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) })); }
}
// An exclusive lock queue, as navigator.locks gives a browser's tabs.
const held = new Map();
const locks = {
  async request(name, { signal } = {}, callback) {
    const queue = held.get(name) ?? Promise.resolve();
    let release;
    const mine = new Promise(resolve => { release = resolve; });
    held.set(name, queue.then(() => mine));
    await new Promise((resolve, reject) => { queue.then(resolve); signal?.addEventListener('abort', () => { release(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
    try { return await callback(); } finally { release(); }
  },
};

// A browser's BroadcastChannel: a message posted on one channel reaches the other channels of the same name, not itself.
const channels = new Set();
class FakeChannel extends EventTarget {
  constructor(name) { super(); this.name = name; channels.add(this); }
  close() { channels.delete(this); }
  postMessage(data) { for (const other of channels) if (other !== this && other.name === this.name) queueMicrotask(() => other.dispatchEvent(Object.assign(new Event('message'), { data }))); }
}

test('one socket for two tabs, every frame reaches both, and the second tab takes over when the first leaves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  Object.assign(globalThis, { window: globalThis, BroadcastChannel: FakeChannel, WebSocket: FakeSocket, location: { protocol: 'https:', host: 'app.example' } });
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true });
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, querySelectorAll: () => [] };
  globalThis.addEventListener = () => {};
  const one = await import('../src/workspace/store-changes.ts?tab=one');
  const two = await import('../src/workspace/store-changes.ts?tab=two');
  const reads = { one: 0, two: 0 };
  const stopOne = one.onStoreChange(() => { reads.one += 1; });
  const stopTwo = two.onStoreChange(() => { reads.two += 1; });
  await new Promise(resolve => setImmediate(resolve));
  console.log('STREAM READBACK sockets opened with two tabs listening:', sockets.length);
  assert.equal(sockets.length, 1, 'two tabs, one socket');

  sockets[0].hear({ revision: 7 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, { one: 1, two: 1 }, 'a frame the socket hears reaches both tabs');

  stopOne();
  // The tab that takes over opens its socket on the page's connect timer (store-changes.ts invariant 3), so the mocked clock
  // moves on before the takeover is checked; old trillion's copy of this test failed here for want of it.
  for (let step = 0; step < 20; step += 1) { await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(1000); }
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  console.log('STREAM READBACK sockets after the first tab left:', sockets.length);
  assert.equal(sockets.length, 2, 'the second tab opened the stream when the first left');
  sockets[1].hear({ revision: 8 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.two, 2);
  stopTwo();
});

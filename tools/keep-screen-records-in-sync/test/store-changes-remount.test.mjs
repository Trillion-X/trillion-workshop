// A screen that remounts keeps the page's one live socket (src/workspace/store-changes.ts): its listener leaves and comes
// back in the same moment, and closing the socket when the last listener left made every remount close the socket with
// 1000 and open another, so the account's book saw a socket end every few seconds (2026-10-20).
import test from 'node:test';
import assert from 'node:assert/strict';

const sockets = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  closedWith = null;
  constructor(url) { super(); this.url = url; sockets.push(this); }
  close(code = 1006) { this.readyState = 3; this.closedWith = code; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('a listener that leaves and comes back keeps the socket; the socket closes only when no listener came back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  Object.assign(globalThis, { window: globalThis, WebSocket: FakeSocket, location: { protocol: 'https:', host: 'app.example' } });
  delete globalThis.BroadcastChannel;
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, querySelectorAll: () => [] };
  globalThis.addEventListener = () => {};
  const { onStoreChange } = await import('../src/workspace/store-changes.ts?remount');
  let stop = onStoreChange(() => {}, ['/work/api/messages']);
  await turn();
  assert.equal(sockets.length, 1);
  // The screen remounts: its listener stops and a new one starts in the same turn.
  stop();
  stop = onStoreChange(() => {}, ['/work/api/messages']);
  await turn(); t.mock.timers.tick(5000); await turn();
  assert.equal(sockets.length, 1, 'no second socket for a remount');
  assert.equal(sockets[0].closedWith, null, 'the socket stayed open');
  // The last screen goes away for good: the socket closes once nobody came back.
  stop();
  await turn(); t.mock.timers.tick(5000); await turn();
  assert.equal(sockets[0].closedWith, 1000);
  assert.equal(sockets.length, 1);
});

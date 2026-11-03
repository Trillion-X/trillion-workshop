// Two tabs of one browser share one live socket (src/workspace/store-changes.ts, src/live-protocol.mjs earlySocketScript):
// the tab that leads the stream lock owns it; a follower opens no early socket of its own, which it could never use (each
// one was given up after 15 s, a full subscribe admission on the account's book for nothing, 2026-10-20); and when the
// leader goes away, the follower takes the stream over.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { earlySocketScript } from '../src/live-protocol.mjs';

const sockets = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  closedWith = null;
  constructor(url) { super(); this.url = url; sockets.push(this); }
  close(code = 1006) { this.readyState = 3; this.closedWith = code; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
}
// Web Locks as a browser keeps them: one holder per name, the next waiter takes over when the holder's callback ends.
function fakeLocks() {
  const holders = new Map(), queues = new Map();
  const pump = name => {
    if (holders.get(name)) return;
    const next = (queues.get(name) ?? []).shift();
    if (!next) return;
    holders.set(name, next);
    Promise.resolve(next.run({ name })).then(() => { holders.delete(name); next.done(); pump(name); });
  };
  return {
    query: async () => ({ held: [...holders.keys()].map(name => ({ name })), pending: [] }),
    request(name, options, run) {
      return new Promise(done => {
        const entry = { run, done };
        (queues.get(name) ?? queues.set(name, []).get(name)).push(entry);
        options?.signal?.addEventListener('abort', () => { const queue = queues.get(name) ?? []; const at = queue.indexOf(entry); if (at >= 0) { queue.splice(at, 1); done(); } });
        pump(name);
      });
    },
  };
}
class FakeChannel extends EventTarget {
  static open = new Set();
  constructor(name) { super(); this.name = name; FakeChannel.open.add(this); }
  postMessage(data) { for (const other of FakeChannel.open) if (other !== this && other.name === this.name) other.dispatchEvent(Object.assign(new Event('message'), { data })); }
  close() { FakeChannel.open.delete(this); }
}
const turn = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve)); };

test('a follower tab opens no early socket and takes the stream over when the leader goes away', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const locks = fakeLocks();
  Object.assign(globalThis, { window: globalThis, WebSocket: FakeSocket, BroadcastChannel: FakeChannel, location: { protocol: 'https:', host: 'app.example' } });
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true });
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, querySelectorAll: () => [] };
  globalThis.addEventListener = () => {};
  const runEarly = () => vm.runInNewContext(earlySocketScript(), { window: globalThis, WebSocket: FakeSocket, navigator: { locks }, location: globalThis.location, setTimeout: () => {} });

  // The leader's page: its early socket opens, and its app takes it when it leads the stream lock.
  runEarly(); await turn();
  assert.equal(sockets.length, 1, 'the first tab opens its early socket');
  const leader = await import('../src/workspace/store-changes.ts?leader');
  const stopLeader = leader.onStoreChange(() => {}, ['/work/api/messages']);
  await turn();
  assert.equal(sockets.length, 1, 'the leader took its early socket');

  // The follower's page: the stream lock is held, so its early script opens nothing, and its app waits on the channel.
  runEarly(); await turn();
  assert.equal(sockets.length, 1, 'the follower opened no early socket');
  const follower = await import('../src/workspace/store-changes.ts?follower');
  follower.onStoreChange(() => {}, ['/work/api/messages']);
  await turn();
  assert.equal(sockets.length, 1, 'the follower listens on the channel, with no socket of its own');

  // The leader goes away: once its grace ends it lets the lock go, and the follower opens the stream.
  stopLeader();
  t.mock.timers.tick(5000); await turn();
  assert.equal(sockets[0].closedWith, 1000, 'the leader closed its socket');
  assert.equal(sockets.length, 2, 'the follower took the stream over');
  assert.equal(sockets[1].url, 'wss://app.example/work/live');
});

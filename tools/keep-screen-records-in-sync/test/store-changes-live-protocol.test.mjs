// The page's end of the live protocol (src/workspace/store-changes.ts): a socket taken over from the early script
// replays what it heard, a hello instruction steers the page, requests are acknowledged and fail on close, a numbered
// hole asks once, a dirty notice reads its kind, ops frames reach the one handler registry, and a silent socket is closed.
import assert from 'node:assert/strict';
import test from 'node:test';
// The page's own module, imported as it is (Node strips its types): `copy` names a separate instance, as the bundle did.
const importSource = (_code, { copy } = {}) => import(`../src/workspace/store-changes.ts${copy ? '?copy' : ''}`);
const code = null;

function page() {
  const sockets = [], events = [], timers = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1; sent = []; listeners = {};
    constructor() { sockets.push(this); }
    addEventListener(type, f) { (this.listeners[type] ??= []).push(f); }
    send(text) { this.sent.push(text); }
    close(code) { this.closedWith = code; this.readyState = 3; (this.listeners.close ?? []).forEach(f => f({})); }
    say(frame) { (this.listeners.message ?? []).forEach(f => f({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })); }
  }
  const win = { addEventListener: () => {}, dispatchEvent: event => events.push(event), clearTimeout: id => clearTimeout(id),
    setTimeout: (f, ms) => { timers.push({ ms }); return setTimeout(f, ms); },
    location: { reload: () => { win.reloaded = true; } } };
  Object.assign(globalThis, { window: win, document: { visibilityState: 'visible', addEventListener: () => {}, querySelectorAll: () => [] }, WebSocket: FakeSocket,
    location: { protocol: 'https:', host: 'h.test' }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } });
  // No Web Locks here: a tab with none keeps its own socket (the leader election is store-changes-one-stream.test.mjs).
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  return { sockets, events, timers, win };
}
const until = async (condition, ms = 12000) => { for (let waited = 0; !condition() && waited < ms; waited += 50) await new Promise(resolve => setTimeout(resolve, 50)); };
const flush = () => new Promise(resolve => setTimeout(resolve, 5));

test('the page speaks the live protocol over one socket', async t => {
  const env = page();
  t.after(() => { for (const key of ['window', 'document', 'WebSocket', 'location', 'CustomEvent']) delete globalThis[key]; });
  // A socket the early script opened, which already heard a frame.
  const early = new WebSocket('x'); env.sockets.length = 0;
  const heardEarly = [];
  const handle = { socket: early, take(consume) { heardEarly.forEach(consume); handle.consume = consume; } };
  env.win.trillionEarlySocket = handle;
  heardEarly.push(JSON.stringify({ revision: 5, hello: { epoch: 'E1' } }));
  const { onStoreChange, onLiveEvent, keepFresh, liveFreshness, watchWindow } = await importSource(code);
  let reloads = 0;
  const stops = [onStoreChange(() => { reloads += 1; })];
  assert.equal(env.sockets.length, 0, 'the early socket is taken over, not a second one opened');
  await until(() => reloads >= 1);
  const baseline = reloads;
  const say = frame => handle.consume(JSON.stringify(frame));
  // ops frames reach the one typed registry.
  const batches = [];
  onLiveEvent('supplemental', batch => { batches.push(batch.length); });
  assert.throws(() => onLiveEvent('supplemental', () => {}), /already a handler/);
  assert.throws(() => onLiveEvent('ops', () => {}), /already a handler/, 'ops belong to the window owner');
  say({ supplemental: { name: 'spaces', bundle: {} } });
  say({ supplemental: { name: 'spaces', bundle: {} } });
  await flush();
  assert.deepEqual(batches, [2], 'two same-type frames in one turn are one batch');
  await new Promise(resolve => setTimeout(resolve, 3300));
  assert.equal(reloads, baseline, 'a frame with no revision and no read reloads nothing');
  // A numbered hole asks once with the last number held.
  const narrow = [];
  stops.push(onStoreChange(() => { narrow.push('messages'); }, ['/work/api/messages']));
  say({ revision: 5, counters: { messages: '01a0' } });
  say({ revision: 5, counters: { messages: '01a5' } });
  const request = JSON.parse(early.sent.at(-1));
  assert.deepEqual([request.type, request.scope, request.after], ['catch_up', 'messages', '01a0']);
  say({ reply_to: request.id, epoch: 'E1', scope: 'messages', through: '01a5', items: ['message:1'], read: 'messages' });
  await until(() => narrow.length >= 1);
  assert.ok(narrow.length >= 1, 'a catch-up that found messages reads only the screens listening for messages');
  // A watched window asks, then follows ops.
  const watching = watchWindow('messages', 3);
  const asked = JSON.parse(early.sent.at(-1));
  assert.deepEqual([asked.type, asked.list, asked.from, asked.to], ['window', 'messages', 0, 3]);
  say({ reply_to: asked.id, epoch: 'E1', list: 'messages', from: 0, rows: [{ id: 'a' }, { id: 'b' }], total: 2, read: 'messages' });
  await flush();
  assert.deepEqual(watching.rows(), [{ id: 'a' }, { id: 'b' }]);
  const before = narrow.length;
  say({ ops: { list: 'messages', read: 'messages', ops: [{ op: 'insert', index: 0, row: { id: 'z' }, total: 3 }] } });
  await until(() => narrow.length > before);
  assert.deepEqual(watching.rows(), [{ id: 'z' }, { id: 'a' }, { id: 'b' }]);
  assert.ok(narrow.length > before, 'a change in the window reads the screens drawing it');
  watching.stop();
  // A dirty notice reads its kind again only when its version moved.
  const reads = [];
  stops.push(onStoreChange(() => { reads.push('people'); }, ['people']));
  say({ dirty: { kind: 'people', version: 'v1' } });
  await new Promise(resolve => setTimeout(resolve, 3100));
  await until(() => reads.length >= 1);
  assert.equal(reads.length >= 1, true, 'a dirty notice with a new version reads its kind');
  const afterFirst = reads.length;
  say({ dirty: { kind: 'people', version: 'v1' } });
  await new Promise(resolve => setTimeout(resolve, 3100));
  assert.equal(reads.length, afterFirst, 'the same version reads nothing');
  // Subscribing is acknowledged by reply_to and makes ids fresh.
  const pending = keepFresh(['a', 'b']);
  const subscribe = JSON.parse(early.sent.at(-1));
  assert.deepEqual(subscribe.ids, ['a', 'b']);
  say({ reply_to: subscribe.id, epoch: 'E1', acked: ['a', 'b'] });
  assert.equal(await pending, 2);
  assert.equal(liveFreshness.isFresh('a'), true);
  // A new store epoch means the subscription is gone.
  say({ revision: 6, hello: { epoch: 'E2' } });
  assert.equal(liveFreshness.isFresh('a'), false);
  // A request still waiting when the socket closes fails with the named error.
  const lost = keepFresh(['c']);
  early.close(1006);
  await assert.rejects(lost, error => error.name === 'LiveSocketClosed');
  for (const stop of stops) stop();
});

test('a hello instruction is announced and kept for the listener that starts later', async t => {
  const env = page();
  t.after(() => { for (const key of ['window', 'document', 'WebSocket', 'location', 'CustomEvent']) delete globalThis[key]; });
  const { onStoreChange } = await importSource(code, { copy: true });
  onStoreChange(() => {});
  const opened = env.sockets[0];
  opened.say({ revision: 1, hello: { epoch: 'E', instruction: { code: 'reload', said: 'Update' } } });
  assert.equal(env.events[0].type, 'trillion-live-instruction');
  assert.deepEqual(env.events[0].detail, { action: 'reload', said: 'Update' });
  assert.deepEqual(env.win.trillionPendingInstruction, { action: 'reload', said: 'Update' });
});

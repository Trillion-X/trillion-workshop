import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { importSource } from 'trillion-workshop/test-helpers/import-source-for-tests.mjs';

const root = new URL('..', import.meta.url).pathname;
const bundle = await build({ absWorkingDir: root, entryPoints: ['tools/workspace-screens/web/src/workspace/live-room.ts'], bundle: true,
  write: false, platform: 'node', format: 'esm', logLevel: 'silent', loader: { '.json': 'json' } });
const liveRoom = await importSource(bundle.outputFiles[0].text, 'live-room-carrier');
const notKept = JSON.parse(readFileSync(new URL('../tools/workspace-screens/web/src/workspace/live-room.json', import.meta.url))).words.not_kept;
const reconnectAfter = JSON.parse(readFileSync(new URL('../tools/workspace-screens/web/src/workspace/live-room.json', import.meta.url))).reconnect_after_ms;

function binding() {
  const connections = [];
  const identity = {};
  const carrier = {
    identity,
    connect(path, handlers) {
      const sent = [];
      const connection = { path, handlers, sent, closeCalls: 0,
        send(data) { sent.push(JSON.parse(data)); }, close() { this.closeCalls += 1; } };
      connections.push(connection);
      return connection;
    },
  };
  return { carrier, connections };
}
const board = (connection, records = []) => connection.handlers.message(JSON.stringify({ type: 'board', records }));

test('rooms share only when both path and opaque carrier identity match', () => {
  const a = binding(), b = binding();
  const first = liveRoom.openLiveRoom('/room/x', a.carrier);
  const same = liveRoom.openLiveRoom('/room/x', a.carrier);
  const other = liveRoom.openLiveRoom('/room/x', b.carrier);
  assert.equal(first.room, same.room);
  assert.notEqual(first.room, other.room);
  assert.equal(a.connections.length, 1);
  assert.equal(b.connections.length, 1);
  first.release(); same.release(); other.release();
});

test('a supplied binding carries whole-room state, base values and merged answers', async () => {
  const host = binding();
  const { room, release } = liveRoom.openLiveRoom('/room/records', { carrier: host.carrier });
  const connection = host.connections[0];
  board(connection, [{ address: 'doc', value: { text: 'base' } }]);
  await room.opened();
  const pending = room.change([{ address: 'doc', value: { text: 'mine' } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(connection.sent[0].changes, [{ address: 'doc', base: { text: 'base' }, value: { text: 'mine' } }]);
  connection.handlers.message(JSON.stringify({ type: 'changed', request: connection.sent[0].request,
    records: [{ address: 'doc', value: { text: 'mine + theirs' } }] }));
  assert.equal(await pending, true);
  assert.deepEqual(room.known.get('doc'), { text: 'mine + theirs' });
  release();
});

test('a dropped binding rejects pending work and reconnects without replaying it', async () => {
  const host = binding();
  const { room, release } = liveRoom.openLiveRoom('/room/drop', host.carrier);
  const initial = host.connections[0];
  board(initial);
  await room.opened();
  const pending = room.change([{ address: 'doc', value: 'uncertain' }]);
  await new Promise(resolve => setImmediate(resolve));
  initial.handlers.close(false);
  await assert.rejects(pending, { message: notKept });
  await new Promise(resolve => setTimeout(resolve, reconnectAfter * 2 + 100));
  assert.equal(host.connections.length, 2);
  assert.equal(host.connections[1].sent.length, 0, 'a fresh carrier never replays a possibly accepted write');
  board(host.connections[1]);
  release();
});

test('an ended carrier fails closed and does not reconnect', async () => {
  const host = binding();
  const { room, release } = liveRoom.openLiveRoom('/room/ended', host.carrier);
  const initial = host.connections[0];
  board(initial);
  await room.opened();
  initial.handlers.message(JSON.stringify({ type: 'auth-ended' }));
  await assert.rejects(room.opened(), { status: 403 });
  await assert.rejects(room.change([{ address: 'doc', value: 1 }]), { message: notKept });
  initial.handlers.close(false);
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(host.connections.length, 1);
  release();
});


test('an in-process supplied carrier can paint its current room synchronously', async () => {
  const carrier = { identity: {}, connect(path, handlers) {
    handlers.message(JSON.stringify({ type: 'board', records: [{ address: 'same', value: 'current' }] }));
    return { send() {}, close() {} };
  } };
  const { room, release } = liveRoom.openLiveRoom('/sync', carrier);
  await room.opened();
  assert.equal(room.known.get('same'), 'current');
  release();
});

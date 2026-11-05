import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { whatsapp } from '../computer/connections/whatsapp.mjs';
import { incomingItems, readIncomingItems } from '../computer/connections/incoming-items.mjs';
import { READERS, readNewItems } from '../computer/read-new-items.mjs';

const connectionRow = JSON.parse(readFileSync(new URL(import.meta.resolve('../../run-on-a-persons-computer/carry-connections.json')))).connections.find(row => row.vendor === 'whatsapp');
const sourceRow = JSON.parse(readFileSync(new URL(import.meta.resolve('../computer/computer-sources.json')))).sources.find(row => row.id === 'whatsapp');
const turn = () => new Promise(resolve => setImmediate(resolve));
const message = (id, extra = {}) => ({ key: { id, remoteJid: 'group@g.us', participant: 'sender@s.whatsapp.net' }, messageTimestamp: 1_791_360_000, pushName: 'Sender', message: { conversation: `Original words ${id}` }, ...extra });

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-whatsapp-incoming-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'session'));
  writeFileSync(join(folder, 'session', 'creds.json'), JSON.stringify({ registered: true }));
  let clock = Date.parse('2026-10-07T20:00:00Z');
  const sockets = [], connections = [];
  function create(self = '15550000001:4@s.whatsapp.net') {
    const instance = whatsapp({ ...connectionRow, keep: 2, open_within_ms: 20, reconnect_after_ms: 5 }, {
      folder, now: () => clock,
      load: async () => ({
        fetchLatestBaileysVersion: async () => ({ version: 'fixture' }),
        useMultiFileAuthState: async () => ({ state: { creds: { registered: true } }, saveCreds() {} }),
        default() {
          const events = new Map();
          const socket = { user: { id: self }, ev: { on: (name, handler) => events.set(name, handler) }, end() {} };
          sockets.push({ socket, events });
          return socket;
        },
      }),
    });
    connections.push(instance);
    return instance;
  }
  async function start(instance) { const result = instance.start(); await turn(); sockets.at(-1).events.get('connection.update')({ connection: 'open' }); assert.equal((await result).carried, true); }
  const emit = (items, type = 'notify') => sockets.at(-1).events.get('messages.upsert')({ messages: items, type });
  const file = join(folder, connectionRow.incoming.file);
  const carrier = { ...sourceRow.read, store: file };
  const stateFile = join(folder, 'reader.json');
  function reader(account, options = {}) { return readNewItems({ carriers: [carrier], stateFile, now: () => new Date(clock), readers: READERS, keep: async () => { throw new Error('text needs no files'); }, account, turnedAway: { ask_again_minutes: 1 }, ...options }); }
  t.after(() => connections.forEach(instance => instance.stop()));
  return { create, start, emit, reader, file, folder, sockets, advance: ms => { clock += ms; } };
}

test('incoming WhatsApp text reaches the existing door once, with source/sender/time intact and never as owner instructions', async t => {
  const f = fixture(t), connection = f.create();
  await f.start(connection);
  const item = message('original');
  f.emit([item, message('own', { key: { id: 'own', fromMe: true, remoteJid: 'friend@s.whatsapp.net' } })]);
  f.emit([message('history')], 'append');
  f.sockets.at(-1).events.get('messaging-history.set')({ messages: [message('older-history')] });
  await turn();
  const received = [];
  const reader = f.reader(async (route, { body }) => { assert.equal(route, '/inbound'); received.push(body); return { status: 200, body: { arrival_id: 'arrival:original' } }; });
  await reader.tick(); // capture preceded the first reader tick; it must not be lost
  await reader.tick();
  f.emit([item]); await turn(); await reader.tick();
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    route: 'WhatsApp', source_id: JSON.stringify(['15550000001@s.whatsapp.net', 'group@g.us', 'sender@s.whatsapp.net', 'original']),
    source_ref: 'original', conversation_id: JSON.stringify(['15550000001@s.whatsapp.net', 'group@g.us']), from: 'sender@s.whatsapp.net', from_person: false,
    title: 'WhatsApp from Sender', text: 'Original words original', at: new Date(item.messageTimestamp * 1000).toISOString(),
  });
  assert.equal(reader.status()[0].arrived, true);
  assert.deepEqual(readIncomingItems(f.file), []);
  const found = await reader.search('original words');
  assert.equal(found.items.length, 1, 'a receipt does not erase the source from the existing search consumer');
  assert.equal(found.items[0].source_id, received[0].source_id);
});

for (const firstStatus of [400, 503, null]) test(`pending incoming text survives ${firstStatus ?? 'offline'}, recent eviction and both process restarts`, async t => {
  const f = fixture(t), connection = f.create();
  await f.start(connection);
  f.emit([message('first'), message('second'), message('third'), message('fourth')]); await turn();
  assert.equal((await connection.read({ limit: 10 })).messages.length, 2, 'bounded recent view really evicted pending text');
  let refused = true;
  const delivered = [], attempts = [];
  const account = async (_route, { body }) => {
    attempts.push(body.source_ref);
    if (refused) return firstStatus === null ? null : { status: firstStatus, body: { error: 'temporary refusal' } };
    delivered.push(body.source_ref); return { status: 200, body: { arrival_id: `arrival:${body.source_ref}` } };
  };
  await f.reader(account).tick();
  assert.equal(readIncomingItems(f.file).length, 4);
  // A crash/restart does not explicitly stop the connection; the next instance marks it offline until open.
  const restarted = f.create();
  await f.start(restarted);
  f.advance(3_600_000); refused = false;
  const reader = f.reader(account);
  await reader.tick(); await reader.tick();
  assert.deepEqual(delivered.sort(), ['first', 'fourth', 'second', 'third']);
  assert.deepEqual(readIncomingItems(f.file), []);
  assert.ok(attempts.length > delivered.length);
});

test('lost acknowledgement resends the same door identity; its persisted receipt prevents replay after restart', async t => {
  const f = fixture(t), connection = f.create(); await f.start(connection);
  f.emit([message('lost-reply')]); await turn();
  const kept = new Map(), attempts = [];
  let loseReply = true;
  const account = async (_route, { body }) => {
    attempts.push(body.source_id);
    if (!kept.has(body.source_id)) kept.set(body.source_id, body);
    if (loseReply) { loseReply = false; return null; }
    return { status: 200, body: { arrival_id: 'arrival:one', repeated: true } };
  };
  await f.reader(account).tick();
  f.advance(120_000);
  await f.reader(account).tick();
  f.emit([message('lost-reply')]); await turn(); await f.reader(account).tick();
  assert.equal(kept.size, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.deepEqual(readIncomingItems(f.file), []);
});

test('provider offline append messages after the durable capture boundary arrive after reconnect, older history stays out', async t => {
  const f = fixture(t), connection = f.create(); await f.start(connection);
  const started = Date.parse(incomingItems(f.file).state().started_at);
  f.sockets.at(-1).events.get('connection.update')({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
  f.advance(7_200_000);
  const back = f.create(); await f.start(back);
  assert.equal(Date.parse(incomingItems(f.file).state().started_at), started);
  f.emit([
    message('missed-offline', { messageTimestamp: (started + 60_000) / 1000 }),
    message('old-history', { messageTimestamp: (started - 60_000) / 1000 }),
  ], 'append');
  await turn();
  const delivered = [];
  // Use the real child-process reader here, not an injected reader implementation.
  await f.reader(async (_route, { body }) => { delivered.push(body.source_ref); return { status: 200, body: { message_id: `message:${body.source_id}` } }; }, { readers: undefined }).tick();
  assert.deepEqual(delivered, ['missed-offline']);
});

test('an offline message from the capture boundary second is kept at provider timestamp precision', async t => {
  const f = fixture(t); f.advance(500);
  const connection = f.create(); await f.start(connection);
  const boundary = Date.parse(incomingItems(f.file).state().started_at);
  assert.equal(boundary % 1000, 500);
  f.emit([message('same-second', { messageTimestamp: Math.floor(boundary / 1000) })], 'append');
  await turn();
  const delivered = [];
  await f.reader(async (_route, { body }) => { delivered.push(body.source_ref); return { status: 200, body: { message_id: 'message:same-second' } }; }).tick();
  assert.deepEqual(delivered, ['same-second']);
});

test('stop during delivery gates the next item, survives restart and only explicit connect resumes', async t => {
  const f = fixture(t), connection = f.create(); await f.start(connection);
  f.emit([message('first'), message('second')]); await turn();
  const received = [];
  await f.reader(async (_route, { body }) => { received.push(body.source_ref); connection.pause(); return { status: 200, body: { arrival_id: 'arrival:first' } }; }).tick();
  assert.deepEqual(received, ['first']);
  f.emit([message('after-stop')]);
  assert.throws(() => readIncomingItems(f.file), /stopped/);
  const stopped = f.create();
  assert.equal((await stopped.start()).carried, false);
  assert.equal(f.sockets.length, 1, 'automatic renewal never resumes an explicit stop');
  const resumed = stopped.connect(); await turn(); f.sockets.at(-1).events.get('connection.update')({ connection: 'open' });
  assert.equal((await resumed).state, 'connected');
  await f.reader(async (_route, { body }) => { received.push(body.source_ref); return { status: 200, body: { message_id: `message:${body.source_id}` } }; }).tick();
  assert.deepEqual(received, ['first', 'second']);
});

test('account change and logout cannot deliver another account pending words or collect stale socket events', async t => {
  const f = fixture(t), first = f.create(); await f.start(first); f.emit([message('private')]); await turn();
  const second = f.create('15550000002@s.whatsapp.net'); await f.start(second);
  f.emit([message('same-id')]); await turn();
  const delivered = [];
  const account = async (_route, { body }) => { delivered.push(body); return { status: 200, body: { message_id: `message:${body.source_id}` } }; };
  await f.reader(account).tick();
  assert.equal(delivered.length, 1); assert.equal(delivered[0].source_ref, 'same-id');
  f.sockets.at(-1).events.get('connection.update')({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  f.emit([message('after-logout')]);
  assert.throws(() => readIncomingItems(f.file), /logged out/);
  const back = f.create(); await f.start(back); await f.reader(account).tick();
  assert.equal(delivered.length, 2); assert.equal(delivered[1].source_ref, 'private');
  assert.notEqual(delivered[0].source_id, delivered[1].source_id);
});

test('a stop cancels an already-scheduled reconnect and late callbacks cannot re-enable it', async t => {
  const f = fixture(t), connection = f.create(); await f.start(connection);
  const events = f.sockets.at(-1).events;
  events.get('connection.update')({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  connection.pause();
  events.get('connection.update')({ connection: 'open' });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.sockets.length, 1);
  assert.equal(connection.carried(), false);
  assert.equal(incomingItems(f.file).state().status, 'stopped');
});

test('HTTP 200 without a kept-message or arrival receipt never acknowledges incoming words', async t => {
  const f = fixture(t), connection = f.create(); await f.start(connection);
  f.emit([message('no-receipt')]); await turn();
  await f.reader(async () => ({ status: 200, body: { error: 'not actually kept' } })).tick();
  assert.equal(readIncomingItems(f.file).length, 1);
  f.advance(120_000);
  await f.reader(async () => ({ status: 200, body: { message_id: 'message:kept' } })).tick();
  assert.deepEqual(readIncomingItems(f.file), []);
});

test('constructing an unused duplicate carrier cannot disable the live owner before the carrier lock is held', async t => {
  const f = fixture(t), live = f.create(); await f.start(live);
  f.emit([message('before-duplicate')]); await turn();
  const duplicate = f.create(); // carry-connections loads modules before checking carrier.lock
  assert.equal(incomingItems(f.file).state().status, 'active');
  f.emit([message('after-duplicate')]); await turn();
  assert.equal(readIncomingItems(f.file).length, 2);
  assert.equal(f.sockets.length, 1);
  const restart = duplicate.start();
  assert.throws(() => readIncomingItems(f.file), /offline/, 'the owning start marks liveness unknown until its new socket opens');
  await turn(); f.sockets.at(-1).events.get('connection.update')({ connection: 'open' });
  assert.equal((await restart).carried, true);
});

test('owning startup with no linked session disables stale active liveness without admitting pending words', async t => {
  const f = fixture(t), connection = f.create(); await f.start(connection);
  f.emit([message('pending-before-unlink')]); await turn();
  writeFileSync(join(f.folder, 'session', 'creds.json'), JSON.stringify({ registered: false }));
  const restart = f.create();
  assert.equal(incomingItems(f.file).state().status, 'active', 'construction still has no lifecycle authority');
  assert.equal((await restart.start()).carried, false);
  assert.throws(() => readIncomingItems(f.file), /offline/);
  assert.equal(f.sockets.length, 1, 'no automatic pairing or socket is started');
});

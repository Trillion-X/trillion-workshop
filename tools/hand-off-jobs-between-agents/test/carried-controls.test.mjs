import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCarrier } from '../../run-on-a-persons-computer/carry-connections.mjs';
import { whatsapp } from '../../bring-in-new-items-from-this-computer/computer/connections/whatsapp.mjs';
import { incomingItems, readIncomingItems } from '../../bring-in-new-items-from-this-computer/computer/connections/incoming-items.mjs';
import { carriedTools, carriedAnnotations, handleCarriedRequest, isCarriedPath, makeCarriedConnections } from '../../shared-code/src/carried-connections.mjs';

const settings = JSON.parse(readFileSync(new URL('../../run-on-a-persons-computer/carry-connections.json', import.meta.url)));
const row = settings.connections.find(item => item.vendor === 'whatsapp');

async function world(t, { linked = true } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-carried-controls-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'session'));
  const setLinked = value => writeFileSync(join(folder, 'session', 'creds.json'), JSON.stringify({ registered: value }));
  setLinked(linked);
  const sockets = [], modules = [], jobs = new Map(), cache = new Map();
  let card = null, ready = true, carrier, owner, count = 0;
  function makeModule() {
    const module = whatsapp({ ...row, open_within_ms: 100 }, {
      folder,
      load: async () => ({
        fetchLatestBaileysVersion: async () => ({ version: 'fixture' }),
        useMultiFileAuthState: async () => ({ state: { creds: { registered: linked } }, saveCreds() {} }),
        default() {
          const events = new Map();
          const socket = { user: { id: '15550000001@s.whatsapp.net' }, ev: { on: (event, handler) => events.set(event, handler) }, end() {} };
          sockets.push({ socket, events });
          setImmediate(() => events.get('connection.update')?.({ connection: 'open' }));
          return socket;
        },
      }),
    });
    modules.push(module);
    return module;
  }
  async function startCarrier(module = makeModule()) {
    carrier = makeCarrier({ settings, connections: new Map([['whatsapp', { row, module }]]), computer: 'Test Mac',
      call: async (path, input) => { if (path === '/agents/publish') card = input; return {}; },
      kept: { get: id => cache.get(id), put: (id, value) => cache.set(id, value) },
    });
    await carrier.publish();
    return module;
  }
  const agents = {
    find: () => ({ agents: card ? [{ ...card, ready_now: ready }] : [] }),
    handOff(input) {
      const earlier = [...jobs.values()].find(job => job.request_key === input.request_key);
      if (earlier) return { handoff: earlier };
      const handoff = { ...input, handoff_id: `control-${++count}`, handed_at: new Date().toISOString(), state: 'open' };
      jobs.set(handoff.handoff_id, handoff);
      setImmediate(async () => {
        handoff.result = await carrier.run(handoff);
        handoff.state = 'finished';
        owner.finished(handoff);
      });
      return { handoff };
    },
    read: ({ handoff_id }) => ({ handoff: jobs.get(handoff_id) }),
  };
  owner = makeCarriedConnections({ agents, services: async () => [{ vendor: 'whatsapp', name: 'WhatsApp' }], sleep: () => new Promise(() => {}) });
  const tools = carriedTools(async (path, input) => {
    assert.equal(isCarriedPath(path), true);
    const reply = await handleCarriedRequest(owner, new Request(`https://test.invalid${path}`, { method: 'POST', body: JSON.stringify(input) }));
    const value = await reply.json();
    if (!reply.ok) throw new Error(value.error);
    return value;
  });
  const call = (verb, key) => tools.find(tool => tool.name === `${verb}_carried_service`).run({ service: 'whatsapp', request_key: key });
  const module = await startCarrier();
  t.after(() => modules.forEach(item => item.stop()));
  return { module, call, owner, jobs, sockets, setLinked, makeModule, startCarrier, get carrier() { return carrier; }, file: join(folder, row.incoming.file), setReady: value => { ready = value; } };
}

test('public pause and resume tools reach the native owner and persist intent across a carrier restart', async t => {
  const w = await world(t);
  const before = w.sockets.length;
  w.sockets.at(-1).events.get('messages.upsert')({ type: 'notify', messages: [{ key: { id: 'pending', remoteJid: 'friend@s.whatsapp.net' }, messageTimestamp: 1_791_360_000, message: { conversation: 'kept while paused' } }] });
  const paused = await w.call('pause', 'pause-once');
  assert.equal(paused.state, 'finished'); assert.equal(paused.result.state, 'paused');
  assert.equal(incomingItems(w.file).state().status, 'stopped');
  assert.throws(() => readIncomingItems(w.file), /stopped/);
  const duplicate = await w.call('pause', 'pause-once');
  assert.equal(duplicate.handoff_id, paused.handoff_id); assert.equal(w.jobs.size, 1);
  await w.startCarrier();
  assert.equal(w.sockets.length, before, 'normal startup does not override the public pause');
  const resumed = await w.call('resume', 'resume-once');
  assert.equal(resumed.result.state, 'connected');
  assert.equal(w.sockets.length, before + 1);
  assert.equal(readIncomingItems(w.file)[0].source_ref, 'pending');
  assert.equal(carriedAnnotations.pause_carried_service.readOnlyHint, false);
  assert.equal(carriedAnnotations.resume_carried_service.idempotentHint, true);
});

test('normal socket cleanup remains restartable and cleanup never clears an explicit pause', async t => {
  const w = await world(t);
  w.module.stop();
  assert.equal(incomingItems(w.file).state().status, 'offline');
  const restarted = await w.startCarrier();
  assert.equal(restarted.carried(), true);
  await w.call('pause', 'durable-pause');
  restarted.stop();
  assert.equal(incomingItems(w.file).state().status, 'stopped');
  const paused = await w.startCarrier();
  assert.equal(paused.carried(), false);
});

test('away, unknown and stale control requests are refused without changing native intent', async t => {
  const w = await world(t), before = w.jobs.size;
  w.setReady(false);
  await assert.rejects(w.call('pause', 'away'), /last seen/);
  assert.equal(w.jobs.size, before); assert.equal(w.module.carried(), true);
  w.setReady(true);
  await assert.rejects(w.owner.ask('pause', { service: 'unavailable', request_key: 'unknown' }), /not a service/);
  await assert.rejects(w.owner.ask('pause', { service: 'whatsapp' }), /request_key/);
  const old = new Date(Date.now() - (settings.stale_after_minutes + 1) * 60_000).toISOString();
  assert.match((await w.carrier.run({ handoff_id: 'stale', handed_at: old, input: { connection: 'whatsapp', verb: 'pause' } })).error, /waited more/);
  assert.match((await w.carrier.run({ handoff_id: 'cleanup', handed_at: new Date().toISOString(), input: { connection: 'whatsapp', verb: 'stop' } })).error, /cannot do stop/);
  assert.equal(w.module.carried(), true);
});

test('public resume refuses an unlinked session without pairing, then works after the session is restored', async t => {
  const w = await world(t, { linked: false });
  assert.equal(w.sockets.length, 0);
  assert.equal((await w.call('pause', 'unlinked-pause')).result.state, 'paused');
  const refused = await w.call('resume', 'unlinked-resume');
  assert.equal(refused.result.state, 'needs_connection');
  assert.match(refused.result.error, /not linked/);
  assert.equal(w.sockets.length, 0);
  assert.equal(incomingItems(w.file).state().status, 'stopped');
  w.setLinked(true);
  assert.equal((await w.call('resume', 'restored-resume')).result.state, 'connected');
  assert.equal(w.sockets.length, 1);
});

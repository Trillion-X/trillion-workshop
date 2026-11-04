import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { READERS, readNewItems } from '../../bring-in-new-items-from-this-computer/computer/read-new-items.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCarrier } from '../../run-on-a-persons-computer/carry-connections.mjs';
import { whatsapp } from '../../bring-in-new-items-from-this-computer/computer/connections/whatsapp.mjs';
import { incomingItems, readIncomingItems, acknowledgeIncomingItem } from '../../bring-in-new-items-from-this-computer/computer/connections/incoming-items.mjs';
import { carriedTools, carriedAnnotations, handleCarriedRequest, isCarriedPath, makeCarriedConnections } from '../src/carried-connections.mjs';

const settings = JSON.parse(readFileSync(new URL('../../run-on-a-persons-computer/carry-connections.json', import.meta.url)));
const row = settings.connections.find(item => item.vendor === 'whatsapp');

async function world(t, { linked = true, saveCreds = () => {}, setKeys = () => {}, query = request => { request.attrs.id = 'query-1'; return { tag: 'iq', attrs: { id: 'query-1', type: 'result' } }; } } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-carried-controls-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'session'));
  const setLinked = value => writeFileSync(join(folder, 'session', 'creds.json'), JSON.stringify({ registered: value }));
  setLinked(linked);
  const sockets = [], modules = [], jobs = new Map(), cache = new Map(), queries = [];
  let self = '15550000001@s.whatsapp.net';
  let card = null, ready = true, carrier, owner, count = 0;
  function makeModule() {
    const module = whatsapp({ ...row, open_within_ms: 100 }, {
      folder,
      load: async () => ({
        fetchLatestBaileysVersion: async () => ({ version: 'fixture' }),
        useMultiFileAuthState: async () => { mkdirSync(join(folder, 'session'), { recursive: true }); setLinked(linked); return { state: { creds: { registered: linked }, keys: { get: async () => ({}), set: data => setKeys(folder, data) } }, saveCreds: () => saveCreds(folder) }; },
        default({ auth }) {
          const events = new Map();
          const socket = { auth, user: { id: self }, query: async request => { queries.push(request); return query(request); }, ev: { on: (event, handler) => events.set(event, handler) }, end() {} };
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
  const call = (name, input = {}) => tools.find(tool => tool.name === name).run({ service: 'whatsapp', ...input });
  const module = await startCarrier();
  t.after(() => modules.forEach(item => item.stop()));
  return { module, call, owner, jobs, sockets, folder, queries, setSelf: value => { self = value; }, setLinked, makeModule, startCarrier, get carrier() { return carrier; }, file: join(folder, row.incoming.file), setReady: value => { ready = value; } };
}

const A = '15550000001@s.whatsapp.net', B = '15550000002@s.whatsapp.net';
const turn = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => { for (let step = 0; step < 20 && !predicate(); step += 1) await turn(); assert.ok(predicate(), 'fixture operation reached the intended await boundary'); };
const emit = (w, id) => w.sockets.at(-1).events.get('messages.upsert')({ type: 'notify', messages: [{ key: { id, remoteJid: 'friend@s.whatsapp.net' }, messageTimestamp: 1_791_360_000, message: { conversation: `private words ${id}` } }] });
const act = async (w, name, input = {}) => (await w.call(name, { request_key: `${name}-${w.jobs.size}`, ...input })).result;
const source = JSON.parse(readFileSync(new URL('../../bring-in-new-items-from-this-computer/computer/computer-sources.json', import.meta.url))).sources.find(item => item.id === 'whatsapp');
function reader(w, account) {
  return readNewItems({ carriers: [{ ...source.read, store: w.file }], stateFile: join(w.folder, 'reader.json'), now: () => new Date('2026-10-08T20:00:00Z'), readers: READERS, account, keep: async () => { throw Error('text has no files'); } });
}

test('a late successful revoke of A cannot close or archive a newly connected B', async t => {
  let finish;
  const w = await world(t, { query: request => new Promise(resolve => { request.attrs.id = 'old-revoke'; finish = () => resolve({ tag: 'iq', attrs: { id: 'old-revoke', type: 'result' } }); }) });
  const revoking = act(w, 'revoke_carried_service', { account: A }); await until(() => Boolean(finish));
  assert.equal(incomingItems(w.file).state().status, 'revoking');
  await act(w, 'disconnect_carried_service', { account: A });
  w.setSelf(B); await act(w, 'connect_carried_service', { phone: '15550000002' });
  assert.equal((await act(w, 'read_carried_service_state')).account, B);
  finish(); await revoking;
  const after = await act(w, 'read_carried_service_state');
  assert.equal(after.account, B); assert.equal(after.state, 'connected'); assert.equal(after.remote_revoked, false);
  assert.equal(existsSync(join(w.folder, 'session')), true);
  assert.equal(readdirSync(w.folder).filter(name => name.startsWith('session-detached-')).length, 1);
});

test('a late failed revoke of A cannot pause a newly connected B', async t => {
  let fail;
  const w = await world(t, { query: () => new Promise((_resolve, reject) => { fail = () => reject(Error('old provider request failed')); }) });
  const revoking = act(w, 'revoke_carried_service', { account: A }); await until(() => Boolean(fail));
  await act(w, 'disconnect_carried_service', { account: A });
  w.setSelf(B); await act(w, 'connect_carried_service', { phone: '15550000002' });
  fail(); await revoking;
  const after = await act(w, 'read_carried_service_state');
  assert.equal(after.account, B); assert.equal(after.state, 'connected');
});

test('pause remains immediate while revocation waits, and its late result does not archive the paused session', async t => {
  let finish;
  const w = await world(t, { query: request => new Promise(resolve => { request.attrs.id = 'pause-race'; finish = () => resolve({ tag: 'iq', attrs: { id: 'pause-race', type: 'result' } }); }) });
  const revoking = act(w, 'revoke_carried_service', { account: A }); await until(() => Boolean(finish));
  const paused = await act(w, 'pause_carried_service');
  assert.equal(paused.state, 'paused'); assert.equal(incomingItems(w.file).state().status, 'stopped');
  assert.equal(existsSync(join(w.folder, 'session')), true);
  finish(); const outcome = await revoking;
  assert.equal(outcome.remote_revoked, true); assert.equal(outcome.superseded, true); assert.equal(outcome.current_connection_changed, false);
  assert.equal(incomingItems(w.file).state().status, 'stopped'); assert.equal(existsSync(join(w.folder, 'session')), true);
  assert.equal(readdirSync(w.folder).filter(name => name.startsWith('session-detached-')).length, 0);
});

test('disconnect drains a Baileys signal-key write as well as creds.update before rebind', async t => {
  let finish, entered = false;
  const w = await world(t, { setKeys: async (folder, data) => {
    entered = true; await new Promise(resolve => { finish = resolve; });
    writeFileSync(join(folder, 'session', 'signal-key.json'), JSON.stringify(data));
  } });
  const writing = w.sockets[0].socket.auth.keys.set({ old_account_key: 'synthetic fixture only' });
  await turn(); assert.equal(entered, true);
  let detached = false;
  const disconnect = act(w, 'disconnect_carried_service', { account: A }).then(result => { detached = true; return result; });
  await until(() => incomingItems(w.file).state()?.status === 'disconnected'); await turn(); assert.equal(detached, false, 'all already-running auth writes must finish before the active path is archived');
  finish(); await writing; await disconnect;
  const archived = readdirSync(w.folder).find(name => name.startsWith('session-detached-'));
  assert.equal(existsSync(join(w.folder, archived, 'signal-key.json')), true);
  w.setSelf(B); await act(w, 'connect_carried_service', { phone: '15550000002' });
  assert.equal(existsSync(join(w.folder, 'session', 'signal-key.json')), false);
  await w.sockets[0].socket.auth.keys.set({ late_old_account_key: 'synthetic fixture only' });
  assert.equal(existsSync(join(w.folder, 'session', 'signal-key.json')), false, 'a retired socket cannot write into the replacement account session');
});


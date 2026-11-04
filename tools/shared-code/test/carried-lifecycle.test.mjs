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

async function world(t, { linked = true, saveCreds = () => {}, query = request => { request.attrs.id = 'query-1'; return { tag: 'iq', attrs: { id: 'query-1', type: 'result' } }; } } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-carried-controls-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'session'));
  const setLinked = value => writeFileSync(join(folder, 'session', 'creds.json'), JSON.stringify({ registered: value }));
  setLinked(linked);
  const sockets = [], modules = [], jobs = new Map(), cache = new Map(), queries = [];
  let self = '15553635791@s.whatsapp.net';
  let card = null, ready = true, carrier, owner, count = 0;
  function makeModule() {
    const module = whatsapp({ ...row, open_within_ms: 100 }, {
      folder,
      load: async () => ({
        fetchLatestBaileysVersion: async () => ({ version: 'fixture' }),
        useMultiFileAuthState: async () => { mkdirSync(join(folder, 'session'), { recursive: true }); setLinked(linked); return { state: { creds: { registered: linked } }, saveCreds: () => saveCreds(folder) }; },
        default() {
          const events = new Map();
          const socket = { user: { id: self }, query: async request => { queries.push(request); return query(request); }, ev: { on: (event, handler) => events.set(event, handler) }, end() {} };
          sockets.push({ socket, events });
          // Open after handlers attach, before a busy timer phase can expire the fake connection.
          queueMicrotask(() => events.get('connection.update')?.({ connection: 'open' }));
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

const A = '15553635791@s.whatsapp.net', B = '15551165833@s.whatsapp.net';
const turn = () => new Promise(resolve => setImmediate(resolve));
const emit = (w, id) => w.sockets.at(-1).events.get('messages.upsert')({ type: 'notify', messages: [{ key: { id, remoteJid: '15552092925@s.whatsapp.net' }, messageTimestamp: 1_791_360_000, message: { conversation: `private words ${id}` } }] });
const act = async (w, name, input = {}) => (await w.call(name, { request_key: `${name}-${w.jobs.size}`, ...input })).result;
const source = JSON.parse(readFileSync(new URL('../../bring-in-new-items-from-this-computer/computer/computer-sources.json', import.meta.url))).sources.find(item => item.id === 'whatsapp');
function reader(w, account) {
  return readNewItems({ carriers: [{ ...source.read, store: w.file }], stateFile: join(w.folder, 'reader.json'), now: () => new Date('2026-10-08T20:00:00Z'), readers: READERS, account, keep: async () => { throw Error('text has no files'); } });
}

test('public state, local disconnect and restart preserve account-scoped pending evidence without claiming remote revocation', async t => {
  const w = await world(t); emit(w, 'old-pending');
  const state = await act(w, 'read_carried_service_state');
  assert.equal(state.account, A); assert.equal(state.incoming.pending, 1); assert.deepEqual(state.incoming_accounts, [A]);
  const disconnected = await act(w, 'disconnect_carried_service', { account: A });
  assert.equal(disconnected.local_disconnected, true); assert.equal(disconnected.remote_revoked, false);
  assert.equal(disconnected.pending_preserved, true); assert.equal(w.queries.length, 0);
  assert.equal(existsSync(join(w.folder, 'session')), false);
  assert.equal(readdirSync(w.folder).filter(name => name.startsWith('session-detached-')).length, 1);
  assert.throws(() => readIncomingItems(w.file), /disconnected/);
  await w.startCarrier();
  assert.equal(w.sockets.length, 1, 'restart never opens a detached account');
  assert.equal((await act(w, 'resume_carried_service')).state, 'needs_connection');
  assert.equal((await act(w, 'connect_carried_service')).state, 'needs_phone');
  assert.equal(w.sockets.length, 1, 'resume and connect without a phone do not pair');
  assert.equal((await act(w, 'read_carried_service_state')).incoming.pending, 1);
});

test('a replacement account requires explicit connect and cannot receive the former account pending items', async t => {
  const w = await world(t); emit(w, 'old-pending');
  const old = readIncomingItems(w.file)[0];
  await act(w, 'disconnect_carried_service', { account: A });
  w.setSelf(B);
  assert.equal((await act(w, 'connect_carried_service', { phone: '15550000002' })).state, 'connected');
  emit(w, 'new-pending');
  assert.deepEqual(readIncomingItems(w.file).map(item => item.account), [B]);
  const received = []; await reader(w, async (_path, { body }) => { received.push(body); return { status: 200, body: { arrival_id: 'arrival:new' } }; }).tick();
  assert.deepEqual(received.map(item => item.source_ref), ['new-pending']);
  const former = await act(w, 'read_carried_incoming_copies', { account: A });
  assert.equal(former.items[0].source_id, old.source_id); assert.equal(former.items[0].pending, true);
  assert.equal('text' in former.items[0], false);
  assert.equal(incomingItems(w.file).summary(A).pending, 1);
});

test('account mismatch, missing scope, stale helper and away presence refuse destructive actions', async t => {
  const w = await world(t); emit(w, 'pending');
  for (const name of ['disconnect_carried_service', 'revoke_carried_service']) {
    assert.match((await act(w, name, { account: B })).error, /exact currently bound account/);
    await assert.rejects(w.call(name, { request_key: name }), /account is needed/);
  }
  assert.equal(w.queries.length, 0); assert.equal(w.module.carried(), true);
  const count = w.jobs.size; w.setReady(false);
  await assert.rejects(w.call('disconnect_carried_service', { account: A, request_key: 'away' }), /last seen/);
  assert.equal(w.jobs.size, count); w.setReady(true);
  const answer = await w.carrier.run({ handoff_id: 'stale-delete', handed_at: '2020-01-01T00:00:00Z', input: { connection: 'whatsapp', verb: 'disconnect', account: A } });
  assert.match(answer.error, /waited more/); assert.equal(w.module.carried(), true);
});

test('only a matching provider result confirms revocation; pause and restart retain that fact', async t => {
  const w = await world(t); emit(w, 'pending');
  const answer = await act(w, 'revoke_carried_service', { account: A });
  assert.equal(answer.state, 'revoked'); assert.equal(answer.remote_revoked, true); assert.equal(answer.local_disconnected, true);
  assert.equal(w.queries[0].content[0].tag, 'remove-companion-device');
  assert.equal(w.queries[0].content[0].attrs.jid, A); assert.equal(w.queries[0].content[0].attrs.reason, 'user_initiated');
  await act(w, 'pause_carried_service'); await w.startCarrier();
  const state = await act(w, 'read_carried_service_state');
  assert.equal(state.remote_revoked, true); assert.equal(state.state, 'revoked'); assert.equal(state.incoming.pending, 1);
  assert.equal((await act(w, 'resume_carried_service')).state, 'needs_connection');
  assert.equal((await act(w, 'revoke_carried_service', { account: A })).remote_revoked, true);
  assert.equal(w.queries.length, 1, 'verified revoke is idempotent without another provider request');
});

for (const outcome of ['timeout', 'error', 'mismatch', 'refusal']) test(`provider ${outcome} cannot be reported as remote revocation`, async t => {
  const w = await world(t, { query(request) {
    request.attrs.id = 'expected';
    if (outcome === 'timeout') return undefined;
    if (outcome === 'error') throw Error('provider unavailable');
    return { tag: 'iq', attrs: { id: outcome === 'mismatch' ? 'wrong' : 'expected', type: outcome === 'refusal' ? 'error' : 'result' } };
  } }); emit(w, 'pending');
  const result = await act(w, 'revoke_carried_service', { account: A });
  assert.equal(result.remote_revoked, false); assert.equal(result.state, 'revocation_unconfirmed');
  assert.equal(incomingItems(w.file).state().status, 'stopped'); assert.equal(existsSync(join(w.folder, 'session')), true);
  assert.equal(incomingItems(w.file).summary(A).pending, 1);
  await w.startCarrier(); assert.equal(w.sockets.length, 1, 'unconfirmed revoke stays paused through restart');
  assert.equal((await act(w, 'resume_carried_service')).state, 'connected', 'retained linked session remains explicitly recoverable');
});

test('disconnect drains an in-flight credential save and ignores late old-socket writes', async t => {
  let finishSave, entered = false, saves = 0;
  const w = await world(t, { saveCreds: async folder => {
    entered = true; saves += 1; await new Promise(resolve => { finishSave = resolve; });
    writeFileSync(join(folder, 'session', 'fixture-write.json'), '{}');
  } });
  const event = w.sockets[0].events.get('creds.update'); event(); await turn(); assert.equal(entered, true);
  let finished = false;
  const disconnect = act(w, 'disconnect_carried_service', { account: A }).then(result => { finished = true; return result; });
  await turn(); assert.equal(finished, false); assert.equal(existsSync(join(w.folder, 'session')), true);
  finishSave(); assert.equal((await disconnect).local_disconnected, true); assert.equal(existsSync(join(w.folder, 'session')), false);
  event(); await turn(); assert.equal(saves, 1); assert.equal(existsSync(join(w.folder, 'session')), false);
  // A provider's unrelated late write must not turn a detached intent into an implicit resume either.
  mkdirSync(join(w.folder, 'session')); w.setLinked(true);
  assert.equal((await act(w, 'resume_carried_service')).state, 'needs_connection');
  assert.equal(w.sockets.length, 1);
  w.setSelf(B); assert.equal((await act(w, 'connect_carried_service', { phone: '15550000002' })).state, 'connected');
  assert.equal(readdirSync(w.folder).filter(name => name.startsWith('session-detached-')).length, 2);
});

test('public copy listing is bounded and erasure defaults to preserving every unacknowledged item atomically', async t => {
  const w = await world(t); emit(w, 'a'); emit(w, 'b'); emit(w, 'c');
  const items = readIncomingItems(w.file); acknowledgeIncomingItem(w.file, items[0]);
  const page = await act(w, 'read_carried_incoming_copies', { account: A, limit: 2 });
  assert.equal(page.items.length, 2); assert.ok(page.next_after); assert.equal('text' in page.items[0], false);
  const next = await act(w, 'read_carried_incoming_copies', { account: A, limit: 2, after: page.next_after });
  assert.equal(next.items.length, 1); assert.equal(next.next_after, null);
  const ids = items.slice(0, 2).map(item => item.source_id);
  const refused = await act(w, 'erase_carried_incoming_copy', { account: A, source_ids: ids });
  assert.match(refused.error, /include_pending: true/);
  assert.equal(incomingItems(w.file).summary(A).delivered, 1); assert.equal(incomingItems(w.file).summary(A).pending, 2);
  assert.match((await act(w, 'erase_carried_incoming_copy', { account: B, source_ids: ids, include_pending: true })).error, /different account/);
  assert.match((await act(w, 'erase_carried_incoming_copy', { account: A, source_ids: [...ids, 'unknown'], include_pending: true })).error, /not found/);
  assert.equal(incomingItems(w.file).summary(A).erased, 0);
  await assert.rejects(w.call('erase_carried_incoming_copy', { account: A, source_ids: ids, request_key: 'bad-boolean', include_pending: 'true' }), /must be true or false/);
  await assert.rejects(w.call('erase_carried_incoming_copy', { account: A, source_ids: [], request_key: 'empty' }), /exact source IDs/);
});

test('authorized exact-copy erase removes journal payload, preserves shared receipt, and tombstones replay after restart', async t => {
  const w = await world(t); emit(w, 'received');
  const item = readIncomingItems(w.file)[0], receipts = new Map();
  await reader(w, async (_path, { body }) => { receipts.set(body.source_id, body); return { status: 200, body: { arrival_id: 'receipt:one' } }; }).tick();
  const result = await act(w, 'erase_carried_incoming_copy', { account: A, source_ids: [item.source_id] });
  assert.equal(result.erased, 1); assert.equal(result.pending_erased, 0); assert.equal(result.shared_history_changed, false);
  assert.equal(receipts.get(item.source_id).text, item.text);
  const db = new DatabaseSync(w.file);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM incoming_items').get().n, 0);
  const tombstone = db.prepare('SELECT * FROM incoming_erased').get(); db.close();
  assert.match(tombstone.source_hash, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(tombstone).includes(item.source_id), false);
  w.module.stop(); await w.startCarrier(); emit(w, 'received'); await turn();
  assert.deepEqual(readIncomingItems(w.file), []);
  assert.equal((await act(w, 'erase_carried_incoming_copy', { account: A, source_ids: [item.source_id] })).already_erased, 1);
  assert.equal((await reader(w, async () => { throw Error('erased replay must never send'); }).search('private words')).items.length, 0);
  assert.equal(receipts.size, 1);
});

test('explicit pending erase skips an already-read later item and cannot recreate it on replay or acknowledgement', async t => {
  const w = await world(t); emit(w, 'a-first'); emit(w, 'b-erase');
  const items = readIncomingItems(w.file), erased = items[1], sent = [];
  await reader(w, async (_path, { body }) => {
    sent.push(body.source_ref);
    if (sent.length === 1) {
      const answer = await act(w, 'erase_carried_incoming_copy', { account: A, source_ids: [erased.source_id], include_pending: true });
      assert.equal(answer.pending_erased, 1);
    }
    return { status: 200, body: { arrival_id: 'receipt:first' } };
  }).tick();
  assert.deepEqual(sent, ['a-first']);
  acknowledgeIncomingItem(w.file, erased); emit(w, 'b-erase'); await turn();
  assert.deepEqual(readIncomingItems(w.file), []); assert.equal(incomingItems(w.file).summary(A).erased, 1);
});

test('existing journal migrates tombstones without resetting capture boundary or acknowledgements', async t => {
  const w = await world(t); emit(w, 'old-schema'); const item = readIncomingItems(w.file)[0]; acknowledgeIncomingItem(w.file, item);
  const boundary = incomingItems(w.file).state().started_at;
  const db = new DatabaseSync(w.file); db.exec('DROP TABLE incoming_erased'); db.close();
  assert.equal(readIncomingItems(w.file, { includeDelivered: true }).length, 1);
  assert.equal((await act(w, 'erase_carried_incoming_copy', { account: A, source_ids: [item.source_id] })).erased, 1);
  assert.equal(incomingItems(w.file).state().started_at, boundary); assert.equal(incomingItems(w.file).put(item), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCarrier } from '../../run-on-a-persons-computer/carry-connections.mjs';
import { whatsapp } from '../../bring-in-new-items-from-this-computer/computer/connections/whatsapp.mjs';
import { quoteBlock } from '../../shared-code/src/quoted-words.mjs';
import { carriedTools, carriedAnnotations, handleCarriedRequest, isCarriedPath, makeCarriedConnections } from '../../shared-code/src/carried-connections.mjs';

const settings = JSON.parse(readFileSync(new URL('../../run-on-a-persons-computer/carry-connections.json', import.meta.url)));
const row = settings.connections.find(item => item.vendor === 'whatsapp');

async function world(t, { legacy = [], keep = row.keep, keepFile = null, download = async () => { throw Error('media unavailable'); }, linked = true, saveCreds = () => {}, setKeys = () => {}, query = request => { request.attrs.id = 'query-1'; return { tag: 'iq', attrs: { id: 'query-1', type: 'result' } }; } } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-carried-controls-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'session'));
  const setLinked = value => writeFileSync(join(folder, 'session', 'creds.json'), JSON.stringify({ registered: value }));
  setLinked(linked);
  writeFileSync(join(folder, 'recent.json'), JSON.stringify(legacy));
  const sockets = [], modules = [], jobs = new Map(), cache = new Map(), queries = [];
  let self = '15550000001@s.whatsapp.net';
  let card = null, ready = true, carrier, owner, count = 0;
  function makeModule() {
    const module = whatsapp({ ...row, keep, open_within_ms: 100 }, {
      folder, keepFile,
      load: async () => ({
        downloadMediaMessage: item => download(item),
        fetchLatestBaileysVersion: async () => ({ version: 'fixture' }),
        useMultiFileAuthState: async () => { mkdirSync(join(folder, 'session'), { recursive: true }); setLinked(linked); return { state: { creds: { registered: linked }, keys: { get: async () => ({}), set: data => setKeys(folder, data) } }, saveCreds: () => saveCreds(folder) }; },
        default({ auth }) {
          const events = new Map();
          const socket = { auth, user: { id: self }, query: async request => { queries.push(request); return query(request); }, ev: { on: (event, handler) => events.set(event, handler) }, end() {} };
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

const A = '15550000001@s.whatsapp.net', B = '15550000002@s.whatsapp.net';
const turn = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => { for (let step = 0; step < 20 && !predicate(); step += 1) await turn(); assert.ok(predicate(), 'fixture operation reached the intended await boundary'); };
const emit = (w, id) => w.sockets.at(-1).events.get('messages.upsert')({ type: 'notify', messages: [{ key: { id, remoteJid: 'friend@s.whatsapp.net' }, messageTimestamp: 1_791_360_000, message: { conversation: `private words ${id}` } }] });
const act = async (w, name, input = {}) => (await w.call(name, { request_key: `${name}-${w.jobs.size}`, ...input })).result;
const cached = w => JSON.parse(readFileSync(join(w.folder, 'recent.json')));
const item = (id, text, at = 1_791_360_000) => ({ key: { id, remoteJid: 'friend@s.whatsapp.net' }, messageTimestamp: at, message: { conversation: text } });
const voice = (id, at = 1_791_360_000) => ({ key: { id, remoteJid: 'friend@s.whatsapp.net' }, messageTimestamp: at, message: { audioMessage: { ptt: true, seconds: 3, mimetype: 'audio/ogg' } } });
const upsert = (w, messages, index = w.sockets.length - 1) => w.sockets[index].events.get('messages.upsert')({ type: 'notify', messages });
const read = w => act(w, 'read_recent_messages', { limit: 50 });
// A tool answer puts other people's words in the quoted block the AI reads (src/quoted-words.json); the cache keeps them as typed.
const said = text => quoteBlock(text, { source: 'whatsapp' }).quoted;
const rebind = async (w, from, to) => {
  await act(w, 'disconnect_carried_service', { account: from });
  w.setSelf(to);
  await act(w, 'connect_carried_service', { phone: to.split('@')[0] });
};

test('public reads isolate A -> B -> A, preserving equal-ID captures and retained account history through restart', async t => {
  const w = await world(t);
  upsert(w, [item('shared-id', 'A private text')]);
  assert.equal((await read(w)).messages[0].text, said('A private text'));
  await rebind(w, A, B);
  const before = await read(w);
  assert.deepEqual(before.messages, [], 'B cannot read A cached messages');
  assert.equal(before.account, B); assert.equal(before.history_complete, false); assert.equal(before.cache_status, 'recent_only');
  upsert(w, [item('shared-id', 'B private text')]);
  assert.deepEqual((await read(w)).messages.map(row => row.text), [said('B private text')]);
  assert.deepEqual(cached(w).map(row => [row.account, row.text]), [[A, 'A private text'], [B, 'B private text']]);
  w.module.stop();
  await w.startCarrier();
  assert.deepEqual((await read(w)).messages.map(row => row.text), [said('B private text')]);
  await rebind(w, B, A);
  const again = await read(w);
  assert.equal(again.account, A); assert.deepEqual(again.messages.map(row => row.text), [said('A private text')]);
  assert.equal(cached(w).length, 2);
});

test('unknown legacy entries stay unchanged and omitted with explicit incomplete coverage; retention is per account', async t => {
  const legacy = [
    { id: 'unknown-1', from: 'friend', chat: 'friend', at: '2026-01-01T00:00:00.000Z', text: 'unknown account' },
    { id: 'unknown-2', account: null, from: 'friend', chat: 'friend', at: '2026-01-02T00:00:00.000Z', text: 'also unknown' },
  ];
  const w = await world(t, { legacy, keep: 1 });
  const initial = await read(w);
  assert.deepEqual(initial.messages, []); assert.equal(initial.account, A);
  assert.equal(initial.omitted_legacy_count, 2); assert.equal(initial.history_complete, false); assert.equal(initial.cache_status, 'legacy_unattributed');
  upsert(w, [item('a1', 'earlier A'), item('a2', 'retained A', 1_791_360_001)]);
  await rebind(w, A, B);
  upsert(w, [item('b1', 'earlier B'), item('b2', 'retained B', 1_791_360_002)]);
  const current = await read(w);
  assert.equal(current.omitted_legacy_count, 2); assert.deepEqual(current.messages.map(row => row.text), [said('retained B')]);
  assert.deepEqual(cached(w).filter(row => !row.account), legacy, 'never guess or erase legacy account ownership');
  assert.deepEqual(cached(w).filter(row => row.account).map(row => [row.account, row.text]), [[A, 'retained A'], [B, 'retained B']]);
});

test('a delayed old socket download and later callback cannot update the replacement account cache', async t => {
  let release, saves = 0;
  const w = await world(t, {
    download: () => new Promise(resolve => { release = () => resolve(Buffer.from('A original audio')); }),
    keepFile: async file => { saves += 1; return { id: '1f:A', name: file.name }; },
  });
  upsert(w, [voice('late-A')]); await until(() => Boolean(release));
  await rebind(w, A, B);
  release(); await turn();
  upsert(w, [item('stale-callback', 'must remain absent')], 0);
  const result = await read(w);
  assert.deepEqual(result.messages, []); assert.equal(result.account, B);
  assert.equal(saves, 0, 'stale downloaded media must not start an upload');
  assert.deepEqual(cached(w), []);
});

test('same provider voice ID and timestamp use account-specific cache filenames and never fall back to A audio for B', async t => {
  const audioCache = new Map(), uploads = [], fallback = [];
  let downloads = 0;
  const keepFile = async file => { audioCache.set(file.name, file.bytes); uploads.push(file); return { id: `1f:${uploads.length}`, name: file.name }; };
  keepFile.readCached = async name => { fallback.push(name); return audioCache.get(name) ?? null; };
  const w = await world(t, { keepFile, download: async () => { if (++downloads === 1) return Buffer.from('A audio'); throw Error('B audio unavailable'); } });
  upsert(w, [voice('same-voice')]); await until(() => cached(w).length === 1);
  const aName = cached(w)[0].audio.file_name;
  await rebind(w, A, B);
  upsert(w, [voice('same-voice')]); await until(() => cached(w).some(row => row.account === B));
  const result = await read(w);
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].account, B);
  assert.equal(result.messages[0].audio.file_identity, undefined);
  assert.notEqual(result.messages[0].audio.file_name, aName);
  assert.ok(fallback.length > 0); assert.equal(fallback.includes(aName), false);
  assert.equal(uploads.length, 1);
  assert.equal(cached(w).find(row => row.account === A).audio.file_identity, '1f:1');
});

test('public retry started on A refuses its stale cache result after rebind and reports the changed connection', async t => {
  let retry = false, release, saves = 0;
  const keepFile = async () => { saves += 1; throw Error('first upload pending'); };
  keepFile.readCached = async () => retry ? new Promise(resolve => { release = () => resolve(Buffer.from('A retry audio')); }) : null;
  const w = await world(t, { keepFile, download: async () => Buffer.from('A audio') });
  upsert(w, [voice('retry-A')]); await until(() => cached(w).length === 1);
  assert.equal(saves, 1);
  retry = true;
  const reading = read(w); await until(() => Boolean(release));
  await rebind(w, A, B);
  release(); const outcome = await reading;
  assert.deepEqual(outcome.messages, []); assert.equal(outcome.account, null); assert.equal(outcome.cache_status, 'connection_changed'); assert.equal(outcome.history_complete, false);
  assert.equal(saves, 1, 'no stale upload may begin after an awaited cache read');
  assert.equal(cached(w)[0].account, A); assert.equal(cached(w)[0].audio.file_identity, undefined);
  assert.deepEqual((await read(w)).messages, []);
});

test('an old pending import does not suppress the same message ID on a newly opened socket for the same account', async t => {
  let release, downloads = 0;
  const w = await world(t, {
    download: () => ++downloads === 1 ? new Promise(resolve => { release = () => resolve(Buffer.from('old attempt')); }) : Buffer.from('new attempt'),
    keepFile: async file => ({ id: '1f:new-session', name: file.name }),
  });
  upsert(w, [voice('same-account-reconnect')]); await until(() => Boolean(release));
  await act(w, 'pause_carried_service');
  await act(w, 'resume_carried_service');
  upsert(w, [voice('same-account-reconnect')]);
  await until(() => cached(w).length === 1);
  assert.equal(cached(w)[0].account, A); assert.equal(cached(w)[0].audio.file_identity, '1f:new-session');
  release(); await turn();
  assert.equal(cached(w).length, 1); assert.equal((await read(w)).messages[0].audio.file_identity, '1f:new-session');
});

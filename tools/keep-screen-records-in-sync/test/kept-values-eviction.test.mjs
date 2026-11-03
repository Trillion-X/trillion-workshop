// A kept-values store (the answers and the unsent writes this computer keeps in IndexedDB) stays bounded (F-0092):
// values idle or old, and the least recently used past the cap, are swept; a value written unsynced is never swept;
// a value read is marked used; a value an earlier version wrote still reads and starts aging at the sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const KEY = Buffer.alloc(32, 7).toString('base64url');

function fakeIndexedDB() {
  const databases = new Map();
  const deleteRequested = [];
  const opened = [];
  const connect = (name) => {
    const database = databases.get(name);
    const connection = {
      objectStoreNames: { contains: () => database.created },
      createObjectStore() { database.created = true; },
      onversionchange: null,
      closed: false,
      close() { this.closed = true; },
      transaction() {
        const transaction = {};
        const queue = (fn) => queueMicrotask(fn);
        const answer = (request, result) => queue(() => { request.result = result; request.onsuccess?.(); });
        const rows = database.rows;
        transaction.objectStore = () => ({
          get(key) { const request = {}; answer(request, rows.get(key)); return request; },
          put(value, key) { const request = {}; rows.set(key, value); answer(request, key); return request; },
          delete(key) { const request = {}; rows.delete(key); answer(request, undefined); return request; },
          openCursor() {
            const request = {};
            const keys = [...rows.keys()];
            let at = -1;
            const step = () => {
              at += 1;
              while (at < keys.length && !rows.has(keys[at])) at += 1;
              if (at >= keys.length) { request.result = null; request.onsuccess?.(); return; }
              const key = keys[at];
              request.result = {
                key, value: rows.get(key),
                update(value) { rows.set(key, value); },
                delete() { rows.delete(key); },
                continue() { queue(step); },
              };
              request.onsuccess?.();
            };
            queue(step);
            return request;
          },
        });
        setTimeout(() => transaction.oncomplete?.(), 0);
        return transaction;
      },
    };
    opened.push(connection);
    return connection;
  };
  return {
    databases, deleteRequested, opened,
    open(name) {
      if (!databases.has(name)) databases.set(name, { rows: new Map(), created: false });
      const database = databases.get(name);
      const request = {};
      queueMicrotask(() => {
        request.result = connect(name);
        if (!database.created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase(name) {
      const request = {};
      deleteRequested.push(name);
      queueMicrotask(() => { databases.delete(name); request.onsuccess?.(); });
      return request;
    },
  };
}

let copy = 0;
// Each load is a separate instance of the part (as each bundle was) whose kept-values.json carries the test's limits.
const limits = new Map();
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    const asked = context.parentURL && new URL(context.parentURL).searchParams.get('copy');
    return asked && /kept-values\.json$/.test(resolved.url) ? { ...resolved, url: `${resolved.url}?copy=${asked}` } : resolved;
  },
  load(url, context, next) {
    const loaded = next(url, context);
    const asked = /kept-values\.json\?copy=/.test(url) ? new URL(url).searchParams.get('copy') : null;
    return asked ? { ...loaded, source: JSON.stringify({ ...JSON.parse(String(loaded.source)), ...limits.get(asked) }) } : loaded;
  },
});
async function load(overrides = {}) {
  copy += 1;
  limits.set(String(copy), overrides);
  return import(`../parts/ui/show/request/kept-values.ts?copy=${copy}`);
}

function browser() {
  const indexedDB = fakeIndexedDB();
  const storage = new Map();
  const listeners = [];
  globalThis.indexedDB = indexedDB;
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)); }, removeItem: key => { storage.delete(key); } };
  globalThis.window = { addEventListener: (type, handler) => { if (type === 'storage') listeners.push(handler); } };
  return { indexedDB, storage, listeners };
}
test.afterEach(() => { delete globalThis.indexedDB; delete globalThis.localStorage; delete globalThis.window; });

const DAY = 86_400_000;
const rowOf = (indexedDB, name, key) => indexedDB.databases.get(name).rows.get(key);

test('The sweep drops idle and old values and the least recently used past the cap, and never an unsynced one', async () => {
  const { indexedDB } = browser();
  const { createKeptValues } = await load({ entries_most: 3, sweep_after_ms: 3_600_000 });
  const store = createKeptValues('account-d');
  await store.write('/idle', 1);
  await store.write('/old', 2);
  await store.write('/unsent', { waiting: true }, { unsynced: true });
  await store.write('/a', 'a');
  await store.write('/b', 'b');
  await store.write('/c', 'c');
  const rows = indexedDB.databases.get('account-d').rows;
  const now = Date.now();
  rows.set('/idle', { ...rows.get('/idle'), at: now - 31 * DAY });
  rows.set('/old', { ...rows.get('/old'), at: now - DAY, since: now - 91 * DAY });
  rows.set('/unsent', { ...rows.get('/unsent'), at: now - 400 * DAY, since: now - 400 * DAY });
  rows.set('/a', { ...rows.get('/a'), at: now - 3 * DAY });
  rows.set('/b', { ...rows.get('/b'), at: now - 2 * DAY });
  rows.set('/legacy', JSON.stringify({ from: 'an earlier version' }));
  const dropped = await store.sweep();
  assert.deepEqual([...rows.keys()].sort(), ['/b', '/c', '/legacy', '/unsent'].sort(), 'idle and old gone, then the oldest of the rest past three, the unsent one kept');
  assert.equal(dropped, 3);
  assert.deepEqual(await store.read('/legacy'), { from: 'an earlier version' }, 'a value an earlier version wrote still reads');
  assert.equal(typeof rows.get('/legacy').at, 'number', 'and starts aging from the sweep');
  assert.deepEqual(await store.read('/unsent'), { waiting: true });
  assert.equal(rows.get('/unsent').unsynced, true);
});

test('A read marks a value used once a day, so a value people open is not swept as idle', async () => {
  const { indexedDB } = browser();
  const { createKeptValues } = await load({ sweep_after_ms: 3_600_000 });
  const store = createKeptValues('account-e');
  await store.write('/seen', 1);
  const rows = indexedDB.databases.get('account-e').rows;
  const longAgo = Date.now() - 29 * DAY;
  rows.set('/seen', { ...rows.get('/seen'), at: longAgo, since: longAgo });
  assert.equal(await store.read('/seen'), 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(rows.get('/seen').at > longAgo + 28 * DAY, 'its use is marked');
  assert.equal(rows.get('/seen').since, longAgo, 'when it was first written is not');
  assert.equal(await store.sweep(), 0);
});


test('A kept value carries its row layout and role: another role or layout reads as nothing kept, and the sweep drops the other layout but never an unsent one (F-0734)', async () => {
  const { indexedDB } = browser();
  const { createKeptValues } = await load({ sweep_after_ms: 3_600_000 });
  const store = createKeptValues('account-f');
  await store.write('/space', { items: 3 }, { role: 'member' });
  await store.write('/old-layout', 'x');
  await store.write('/old-unsent', 'y', { unsynced: true });
  await store.write('/legacy-role', 'z');
  const rows = indexedDB.databases.get('account-f').rows;
  assert.equal(rows.get('/space').schema, 1);
  assert.equal(rows.get('/space').role, 'member');
  assert.deepEqual(await store.read('/space', { role: 'member' }), { items: 3 });
  assert.equal(await store.read('/space', { role: 'guest' }), null, 'a changed role does not paint what the old role saw');
  assert.deepEqual(await store.read('/space'), { items: 3 }, 'a read that names no role reads it');
  rows.set('/old-layout', { ...rows.get('/old-layout'), schema: 0 });
  rows.set('/old-unsent', { ...rows.get('/old-unsent'), schema: 0 });
  rows.set('/earlier-build', JSON.stringify('written before layouts were marked'));
  assert.equal(await store.read('/old-layout'), null, 'another layout reads as nothing kept');
  assert.equal(await store.read('/earlier-build', { role: 'guest' }), 'written before layouts were marked', 'a row with no marks still reads');
  assert.equal(await store.sweep(), 1);
  assert.equal(rows.has('/old-layout'), false);
  assert.equal(rows.has('/old-unsent'), true, 'the only copy of an unsent write is never dropped');
});

// src/kept-reads.mjs
//
// PURPOSE
//   A read the Worker makes on nearly every request (the browser session a cookie names, the personal key an AI's call
//   carries, when a sign-in last noted its use) is kept for a few minutes where reading it again costs nothing: in this
//   Worker's own memory, then in the edge cache of the place it runs. A KV read is billed past its monthly allowance and
//   these were nearly all of it (2026-10-04: 2.16 million reads of the account's records, about 25 a second).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a value whose taking-back is decided elsewhere on every request is kept: a session or key is still checked by
//      the person's store each time (src/person-store.mjs acceptsBrowserSession, authorizeSignIn, which refuse a sign-in
//      ended since), so a kept copy can never let an ended sign-in back in. A value a request is authorized by alone is
//      never kept here. A screen's answer is kept under the store revision it was read at and the person it is for,
//      so any change the person could see is a new name.
//   2. Nothing missing is kept: a session made a moment ago is read the moment it is first asked for.
//   3. A copy lives at most `seconds`, in memory and at the edge alike, and the place that changes or ends a value
//      replaces or forgets it there (other places' copies run out on their own, invariant 1).
//   4. A large value (a screen's whole answer) is kept only at the edge (`inMemory: false`), so this Worker's memory
//      holds small records alone.
//   5. The edge copy's address is internal (`/.trillion-internal/kept-reads/...`, no route serves it) and names only the
//      key's own name, never a secret: callers pass names made from hashes.
//   6. A value read from one namespace is never answered for another: `nameIn(store, name)` gives each store its own
//      names for shared settings read the same way everywhere.

const IN_MEMORY_MAX = 5000;
// Each store a value is read from gets its own names, so two namespaces (a test's, another environment's) never share a copy.
const storeIds = new WeakMap();
let nextStoreId = 0;
/** `name` as kept for values read from `store` (a KV namespace or any object standing for one). */
export function nameIn(store, name) {
  if (!store || typeof store !== 'object') return name;
  if (!storeIds.has(store)) storeIds.set(store, ++nextStoreId);
  return `${storeIds.get(store)}:${name}`;
}
const memory = new Map();
// Only unfinished source reads share a promise. A keep/forget made while the
// source is still waiting detaches it, so its later result is not kept again.
const reading = new Map();
const readingKey = (origin, seconds, inMemory) => JSON.stringify([origin, seconds, inMemory]);
const detachReading = name => reading.delete(name);

const edgeCache = async () => {
  if (!globalThis.caches) return null;
  try { return await globalThis.caches.open('trillion-kept-reads'); } catch { return globalThis.caches.default ?? null; }
};
const edgeKey = (origin, name) => new Request(`${origin}/.trillion-internal/kept-reads/${encodeURIComponent(name)}`);

/** The kept value of `name`, else `read()`'s (kept for `seconds` when it is not missing). */
export async function keptRead({ origin, name, seconds, read, inMemory = true, now = Date.now() }) {
  const held = inMemory ? memory.get(name) : null;
  if (held && held.until > now) return held.value;
  memory.delete(name);
  const cache = origin ? await edgeCache() : null;
  if (cache) {
    const hit = await cache.match(edgeKey(origin, name)).catch(() => null);
    if (hit) {
      const value = await hit.json().catch(() => null);
      if (value !== null) { if (inMemory) remember(name, value, seconds, now); return value; }
    }
  }
  const key = readingKey(origin, seconds, inMemory);
  let variants = reading.get(name);
  const pending = variants?.get(key);
  if (pending) return pending.promise;
  if (!variants) { variants = new Map(); reading.set(name, variants); }
  const entry = {};
  const current = () => reading.get(name) === variants && variants.get(key) === entry;
  entry.promise = Promise.resolve().then(read).then(async value => {
    // The public keep/forget path may have replaced this read while it waited.
    // Existing callers still get their read; subsequent callers read the new value.
    if (current() && value !== null && value !== undefined) {
      await keepValue({ origin, name, value, seconds, inMemory, now });
    }
    return value;
  }).finally(() => {
    if (current()) { variants.delete(key); if (!variants.size) reading.delete(name); }
  });
  variants.set(key, entry);
  return entry.promise;
}

function remember(name, value, seconds, now) {
  if (memory.size >= IN_MEMORY_MAX) memory.delete(memory.keys().next().value);
  memory.set(name, { value, until: now + seconds * 1000 });
}

/** Keeps `value` as `name`'s current value, in memory and at this place's edge (invariant 3). */
export async function keep(options) {
  detachReading(options.name);
  return keepValue(options);
}
async function keepValue({ origin, name, value, seconds, inMemory = true, now = Date.now() }) {
  if (inMemory) remember(name, value, seconds, now);
  const cache = origin ? await edgeCache() : null;
  await cache?.put(edgeKey(origin, name), new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${seconds}` } })).catch(() => {});
}

/** Forgets `name` here and at this place's edge. */
export async function forget({ origin, name }) {
  detachReading(name);
  memory.delete(name);
  const cache = origin ? await edgeCache() : null;
  await cache?.delete(edgeKey(origin, name)).catch(() => {});
}

/** Whether `name` was noted in this Worker within `seconds` (and notes it now when it was not): for a write made at
 *  most once in a while, such as when a sign-in was last used, so the read before it is skipped too. */
export function notedWithin(name, seconds, now = Date.now()) {
  const held = memory.get(`noted:${name}`);
  if (held && held.until > now) return true;
  remember(`noted:${name}`, true, seconds, now);
  return false;
}

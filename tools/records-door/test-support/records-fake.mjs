// tools/records-door/test-support/records-fake.mjs
//
// A small in-memory stand-in for the records a tool reaches through the door, for tests only: read, readMany, write,
// ids, scan over declared field indexes, a transaction that rolls back, forgetCached, indexReady, typeOf, and readAt
// over the versions each write kept. It keeps current values in a Map and, per id, the versions written (with the
// moment from `now`, default Date.now): no log rows, no erasure, no pages, no files. It is not a store. The engine
// (Trillion-X/trillion-rust src/storage/record_store) is the one store; what a tool proves on this fake is its own logic
// over the answers the door gives (paging, interval probes, counts), never the store's durability, history or erasure.
//
// The read shapes follow the door's record answers that old trillion's record engine gave tools (tag
// old-trillion-before-worker-retire, parts/record-log/do-work/record-log-store.mjs `ids`, `scan` :2733, `readMany`):
// - `ids(type, { prefix, before, limit })`: ids of one type, newest id first (descending), those below `before`.
// - `scan(type, name, { equal, from, after, after_id, idFrom, limit })`: entries `{ id, values }` of a declared index in
//   (values, id) order; `equal` fixes the leading fields, `from` starts the next field at a value, `after` (with
//   `after_id`) continues past one entry, `idFrom` starts the id when every field is fixed.
// - `readAt(id, at)`: the record as saved at `at` (an ISO time or ms), `{ type, value, complete, kept_from }`, the shape
//   of the engine's record_at (trillion-rust src/storage/record_store/history.rs, #149) and of old record-time.mjs
//   readAt; value and type are null when it did not exist then. Every version is kept, so complete is always true.
//   Until the door answers records:read { id, at }, this is how a tool's history reads are proven.
// - An index declares `{ type, name, paths, where: [{ path, not: [...] }] }`, as old src/record-indexes.json did.

const at = (value, path) => path.reduce((here, field) => (here !== null && typeof here === 'object' ? here[field] : undefined), value);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const one = compare(JSON.stringify(a[i]), JSON.stringify(b[i]));
    if (one) return one;
  }
  return 0;
};

export function recordsFake({ indexes = [], records = [], now = () => Date.now() } = {}) {
  let held = new Map(records.map(record => [record.id, { type: record.type, value: structuredClone(record.value) }]));
  // Per id, every version written, oldest first: { at (ms), type, value } (value null for a removal).
  let versions = new Map(records.map(record => [record.id, [{ at: -Infinity, type: record.type, value: structuredClone(record.value) }]]));
  let changes = 0;
  const writes = [];
  const indexOf = (type, name) => {
    const index = indexes.find(row => row.type === type && row.name === name);
    if (!index) throw new Error(`${type} declares no index ${name}`);
    return index;
  };
  const entries = index => [...held]
    .filter(([, record]) => record.type === index.type)
    .filter(([, record]) => (index.where ?? []).every(rule => !(rule.not ?? []).includes(at(record.value, rule.path))))
    .map(([id, record]) => ({ id, values: index.paths.map(path => at(record.value, path)) }))
    .filter(entry => entry.values.every(value => value !== undefined && value !== null))
    .sort((a, b) => order(a.values, b.values) || compare(a.id, b.id));
  const api = {
    read: id => structuredClone(held.get(id)?.value ?? null),
    readMany: ids => new Map(ids.map(id => [id, structuredClone(held.get(id)?.value ?? null)])),
    write(rows, options = {}) {
      if (!Array.isArray(rows) || !rows.length) throw new TypeError('A write names its records.');
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id) throw new TypeError('A record needs an id.');
        const at = now();
        const kept = versions.get(row.id) ?? [];
        if (row.value === null || row.value === undefined) {
          kept.push({ at, type: null, value: null });
          held.delete(row.id);
        } else {
          const type = row.type ?? held.get(row.id)?.type;
          kept.push({ at, type, value: structuredClone(row.value) });
          held.set(row.id, { type, value: structuredClone(row.value) });
        }
        versions.set(row.id, kept);
      }
      changes += 1;
      writes.push({ ids: rows.map(row => row.id), actor: options.actor ?? null });
    },
    ids(type, { prefix = '', before, limit = 1000 } = {}) {
      return [...held].filter(([id, record]) => record.type === type && id.startsWith(prefix) && (before === undefined || id < before))
        .map(([id]) => id).sort().reverse().slice(0, limit);
    },
    scan(type, name, { equal = [], from, after, after_id, idFrom, limit = 1000 } = {}) {
      const index = indexOf(type, name);
      const fixed = entry => equal.every((value, i) => JSON.stringify(entry.values[i]) === JSON.stringify(value));
      const next = equal.length;
      return entries(index).filter(fixed).filter(entry => {
        if (from !== undefined && compare(JSON.stringify(entry.values[next]), JSON.stringify(from)) < 0) return false;
        if (after !== undefined) {
          const side = compare(JSON.stringify(entry.values[next]), JSON.stringify(after));
          if (side < 0 || (side === 0 && (after_id === undefined || entry.id <= after_id))) return false;
        }
        if (idFrom !== undefined && entry.id < idFrom) return false;
        return true;
      }).slice(0, limit);
    },
    typeOf: id => held.get(id)?.type ?? null,
    /** The record as saved at `at` (an ISO time or ms): the newest version written at or before it. */
    readAt(id, at) {
      const ms = typeof at === 'number' ? at : Date.parse(at);
      if (!Number.isFinite(ms)) throw new Error(`${at} is neither a time nor a log row id.`);
      const then = (versions.get(id) ?? []).filter(version => version.at <= ms).at(-1);
      return { type: then?.type ?? null, value: then?.value == null ? null : structuredClone(then.value), complete: true, kept_from: null };
    },
    indexReady: () => true,
    forgetCached() {},
    /** Run `change`; when it throws, every write it made is taken back. */
    transaction(change) {
      const before = new Map([...held].map(([id, record]) => [id, structuredClone(record)]));
      const keptBefore = new Map([...versions].map(([id, kept]) => [id, kept.slice()]));
      const counted = changes;
      try { return change(); }
      catch (error) { held = before; versions = keptBefore; changes = counted; throw error; }
    },
    /** How many writes have been made (a stand-in for "the log moved", never a log). */
    changes: () => changes,
    writes: () => writes.slice(),
  };
  return api;
}

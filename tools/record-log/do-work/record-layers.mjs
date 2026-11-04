// parts/record-log/do-work/record-layers.mjs
//
// A LAYER: CHANGES KEPT ASIDE OVER A RECORD STORE, READ AS IF MADE, THEN MERGED IN ONE WRITE OR DROPPED FOR NOTHING.
//
// Purpose
//   A draft of many changes (an AI's proposal, a person trying something, a batch prepared before it is approved) is
//   written into a layer instead of the store. Reading through the layer answers each record as the layer would make it
//   and every other record as the store holds it. Merging writes the whole layer into the store as ONE change, each field
//   only where the store still holds what the layer saw when it first touched that record (the store's applyChanges);
//   fields the store changed since are left as the store has them and answered as conflicts, and stay in the layer
//   (merging it again, once the conflict was seen, writes the layer's value over the store's). Dropping a layer drops its
//   table, which writes no row.
//
// Non-negotiable invariants
//   1. A layer never changes the store until it is merged; its own table is its only writing, one row per write.
//   2. What a layer saw is fixed the first time it touches a record (that record's stored value then, or none), so a
//      merge can tell a field the store changed since from one the layer changed.
//   3. Layer names are DATA chosen by the caller: letters, digits, dash and underscore; nothing here names a product.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const TABLE = name => `record_layer_${name.replace(/-/g, '_')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The layers kept in a database: their names. */
export function recordLayers(sql) {
  return sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'record_layer_*'").toArray().map(row => row.name.slice('record_layer_'.length));
}

/**
 * One layer over `store` (a record-log store) in the same database.
 *   sql          the database (the store's)
 *   transaction  (fn) -> result
 */
export function recordLayer(store, sql, name, { transaction = fn => fn() } = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name ?? '')) throw new Error('A layer is named with letters, digits, dash and underscore.');
  const table = TABLE(name);
  const all = (query, ...params) => sql.exec(query, ...params).toArray();
  // Each record the layer touched: { saw: { type, value } | null (the store then), now: { type, value } | null }.
  let touched = new Map();
  const open = () => {
    touched = new Map();
    const exists = all("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", table).length > 0;
    if (!exists) return;
    for (const row of all(`SELECT records FROM ${table} ORDER BY rowid`)) {
      for (const { id, saw, now } of JSON.parse(row.records)) touched.set(id, { saw: touched.has(id) ? touched.get(id).saw : saw, now });
    }
  };
  open();
  const viewOf = id => (touched.has(id) ? touched.get(id).now : store.storedRecord(id));

  return {
    name,
    /** Writes records into the layer (value null removes): [{ id, type, value }]. One row in the layer's table. */
    write(records) {
      const rows = [];
      transaction(() => {
        sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (records TEXT NOT NULL)`);
        for (const { id, type, value } of records) {
          const saw = touched.has(id) ? touched.get(id).saw : store.storedRecord(id);
          if (value === null) { rows.push({ id, saw, now: null }); continue; }
          const stored = store.storedForm(type, value);
          for (const shared of stored.shared) if (!store.storedRecord(shared.id) && !touched.has(shared.id)) rows.push({ id: shared.id, saw: null, now: { type: shared.type, value: shared.value } });
          rows.push({ id, saw, now: { type, value: stored.value } });
        }
        if (rows.length) sql.exec(`INSERT INTO ${table} (records) VALUES (?)`, JSON.stringify(rows));
      });
      for (const row of rows) touched.set(row.id, { saw: touched.has(row.id) ? touched.get(row.id).saw : row.saw, now: row.now });
    },
    /** One record as the layer would make it, or as the store holds it if the layer never touched it. */
    read(id) { const found = viewOf(id); return found ? store.resolved(found.value) : null; },
    typeOf(id) { return viewOf(id)?.type ?? null; },
    /** What merging would change: [{ id, before, after }] against the store as it is now (stored values, links kept). */
    diff() {
      const out = [];
      for (const [id, { now }] of touched) {
        const held = store.storedRecord(id);
        if (!same(held, now)) out.push({ id, before: held, after: now });
      }
      return out;
    },
    /**
     * Writes the layer into the store as one change. A field the store changed since the layer first touched its record
     * is left as the store has it and answered as a conflict; those records stay in the layer, everything else leaves
     * it, and an empty layer's table is dropped. Answers { transaction_id, applied, conflicts }.
     */
    merge(context = {}) {
      const envelopes = [];
      for (const [id, { saw, now }] of touched) {
        if (same(saw, now)) continue;
        if (!saw || !now || saw.type !== now.type) {
          envelopes.push(now ? { id, type: now.type, value: now.value, prior: saw } : { id, remove: true, prior: saw });
          continue;
        }
        const set = {};
        const unset = [];
        const was = {};
        const added = [];
        for (const field of new Set([...Object.keys(saw.value), ...Object.keys(now.value)])) {
          if (same(saw.value[field], now.value[field])) continue;
          if (now.value[field] === undefined) unset.push(field); else set[field] = now.value[field];
          if (saw.value[field] !== undefined) was[field] = saw.value[field]; else added.push(field);
        }
        envelopes.push({ id, type: now.type, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}), was, ...(added.length ? { added } : {}) });
      }
      const result = store.applyChanges([{ id: name, envelopes }], { ...context, actor: { ...(context.actor ?? {}), layer: name } });
      // Each conflicted record stays with what it now sees: the store as it is, plus only the layer's conflicted
      // fields (a whole-record conflict keeps the layer's whole record), so merging again changes nothing else.
      const stuck = new Map();
      for (const conflict of result.conflicts) {
        if (!stuck.has(conflict.id)) stuck.set(conflict.id, new Set());
        stuck.get(conflict.id).add(conflict.field);
      }
      const staysAs = (id, now) => {
        const held = store.storedRecord(id);
        const fields = stuck.get(id);
        if (fields.has(null) || !held || !now || held.type !== now.type) return { id, saw: held, now };
        const value = { ...held.value };
        for (const field of fields) { if (now.value[field] === undefined) delete value[field]; else value[field] = now.value[field]; }
        return { id, saw: held, now: { type: now.type, value } };
      };
      transaction(() => {
        sql.exec(`DROP TABLE IF EXISTS ${table}`);
        const kept = [...touched].filter(([id]) => stuck.has(id)).map(([id, { now }]) => staysAs(id, now));
        if (kept.length) {
          sql.exec(`CREATE TABLE ${table} (records TEXT NOT NULL)`);
          sql.exec(`INSERT INTO ${table} (records) VALUES (?)`, JSON.stringify(kept));
        }
      });
      open();
      return result;
    },
    /** Drops the layer: its table goes, which writes no row. */
    discard() { sql.exec(`DROP TABLE IF EXISTS ${table}`); touched = new Map(); },
    /** How many records the layer holds changes for. */
    get size() { return touched.size; },
  };
}

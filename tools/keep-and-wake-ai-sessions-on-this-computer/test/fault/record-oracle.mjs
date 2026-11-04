// test/fault/record-oracle.mjs
//
// Purpose
//   The reference model a record store is judged against while faults fire: a plain map of what every record must
//   read as. A write the store acknowledged is definite; a write that failed is possibly durable (its statement may
//   have failed after its own transaction committed), so the oracle takes whichever of the two states the store
//   answers right after the failure and holds the store to that from then on, across every reset. A store that answers
//   a value it later loses on a reset fails here; so does one that answers anything but the before or after state.
//
// Non-negotiable invariants
//   1. Acknowledged = durable: a write whose event committed reads back after any number of resets.
//   2. All or nothing: a failed write reads back as wholly before or wholly after, never a mix of its records.
//   3. The oracle names no record kind: records are { id, type, value } and indexes are the store's own declarations.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import assert from 'node:assert/strict';

const canonical = value => JSON.stringify(value, (_, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);

/** ids: every id a run can write (so a record the store holds and the model does not is caught too). */
export function recordOracle(ids) {
  const model = new Map();
  const apply = records => { for (const { id, type, value } of records) { if (value === null) model.delete(id); else model.set(id, { type, value }); } };
  return {
    model,
    /** A write the store acknowledged. */
    acknowledged: apply,
    /** A write that failed: settle it by what the store answers now, all of its records the same way. */
    possibly(records, readOne) {
      const after = records.every(({ id, value }) => same(readOne(id), value));
      const before = records.every(({ id }) => same(readOne(id), model.get(id)?.value));
      assert.ok(after || before, `a failed write reads back as neither before nor after: ${records.map(r => r.id).join(', ')}`);
      if (after && !before) apply(records);
      return after && !before ? 'after' : 'before';
    },
    /** Every id reads as the model says, and each type lists exactly the model's ids of it. */
    check(store, label) {
      for (const id of ids) {
        const want = model.get(id);
        const got = store.read(id);
        assert.ok(same(got, want?.value), `${label}: ${id} reads ${canonical(got)}, the model holds ${canonical(want?.value ?? null)}`);
        if (want) assert.equal(store.typeOf(id), want.type, `${label}: ${id} type`);
      }
      const types = new Set([...model.values()].map(item => item.type));
      for (const type of types) {
        const want = [...model].filter(([, item]) => item.type === type).map(([id]) => id).sort();
        assert.deepEqual([...store.ids(type)].sort(), want, `${label}: the ids of ${type}`);
      }
    },
    /** A digest of the model, to compare two runs. */
    digest: () => canonical([...model].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

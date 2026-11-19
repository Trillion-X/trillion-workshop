// tools/notifications/read-data/given-rows.mjs
//
// The person's own rows this run reads are the ones its caller gives in `stored.records` ([{ id, type, value }]): the
// caller reads them from the person's own store and hands them in, and the run reads nothing else. What the run keeps
// comes back in its answer as `keep` ([{ id, type, value }], value null removes) for the caller to keep where the
// person keeps them. The run writes nothing itself and names no store.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The input without `stored`, and the given rows (an empty list when none were given).
export function splitGiven(raw) {
  const { stored, ...input } = object(raw) ? raw : {};
  const records = object(stored) && Array.isArray(stored.records) ? stored.records.filter(object) : [];
  return { input, records };
}

// The given row of one type with this id, or null.
export const recordOf = (records, type, id) => records.find(row => row.type === type && row.id === id) ?? null;

// The value of the given row of one type with this id, or null when it is not given.
export const valueOf = (records, type, id) => recordOf(records, type, id)?.value ?? null;

// The given rows of one type, whose ids start with the prefix when one is named.
export const rowsOf = (records, type, prefix = '') => records.filter(row => row.type === type && typeof row.id === 'string' && row.id.startsWith(prefix));

// One row to keep: value null removes the row.
export const keepRow = (type, id, value) => ({ id, type, value });

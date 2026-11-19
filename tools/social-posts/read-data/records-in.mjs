// tools/social-posts/read-data/records-in.mjs
//
// The records a tool reads, handed in by the caller, and the rows it would keep, handed back. The run reads no store and
// keeps nothing: the person's AI reads the records the ask needs (the post, the person's connection records) from a
// store and gives them as `records` ([{ id, type, value }]); whatever the run would have written comes back as `keep`
// ([{ id, type, value }], the whole row), for the caller to store.
//
//   recordsIn(input) -> { records, kept }   the records handed in (malformed ones dropped), and the rows to keep
//   recordAt(records, type, id)             the whole record { id, type, value }, or null
//   valueAt(records, type, id)              the value of that record, or null
//   recordsOfType(records, type)            the records of that kind handed in, greatest id first
//   keepRows(kept, rows)                    takes each { id, type, value } into `kept`; nothing is stored
//   withKept(answer, kept)                  the answer with `keep` when there is something to store
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function recordsIn(input) {
  const records = (Array.isArray(input?.records) ? input.records : []).filter(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string' && object(record.value));
  return { records, kept: [] };
}

export const recordAt = (records, type, id) => records.find(record => record.type === type && record.id === id) ?? null;
export const valueAt = (records, type, id) => recordAt(records, type, id)?.value ?? null;
export const recordsOfType = (records, type) => records.filter(record => record.type === type).sort((a, b) => (a.id < b.id ? 1 : -1));
export const keepRows = (kept, rows) => { for (const { id, type, value } of rows) kept.push({ id, type, value }); };
export const withKept = (answer, kept) => (kept.length ? { ...answer, keep: kept } : answer);

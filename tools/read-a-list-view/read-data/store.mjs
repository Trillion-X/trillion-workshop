// tools/read-a-list-view/read-data/store.mjs
//
// Purpose: the records a list read or refresh works over, read from the rows the caller hands in (`stored`) with plain
// filters. This reader reaches no store: the caller reads its records from wherever the person keeps them and passes
// them in. A refresh answers the records to write as `keep` rows, each with the value it expected, so the store refuses
// a write whose record has moved (the same contract as tool:change-my-groups, 1ba06d179e).
//
// Non-Negotiable Invariants:
//   1. `stored.records` is required: a read or refresh handed no records is refused, never read as an empty store.
//   2. A record is { id, type, value }; a record id is held once. A value of null is no record.
//   3. Records of one type are listed greatest id first, the order a store lists them in, so a page's `after` cursor
//      (the last id shown) is the same across calls.
//
//   storeOf(stored) → { record(type, id) → value | null, recordsOf(type, prefix) → [{ id, type, value }] }
const say = (code, words) => Object.assign(new Error(words), { code });

export function storeOf(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !Array.isArray(stored.records)) {
    throw say('bad_input', 'stored.records must hold the records this list reads, each { id, type, value }.');
  }
  const held = new Map();
  for (const record of stored.records) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id || typeof record.type !== 'string' ||
        !record.type || !Object.hasOwn(record, 'value')) {
      throw say('bad_input', 'Each stored record is { id, type, value }.');
    }
    const key = `${record.type}\u0000${record.id}`;
    if (held.has(key)) throw say('bad_input', `stored holds the record ${record.id} of ${record.type} twice.`);
    held.set(key, record.value ?? null);
  }
  const byOrder = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  return {
    record(type, id) {
      return held.get(`${type}\u0000${id}`) ?? null;
    },
    recordsOf(type, prefix = `${type}:`) {
      const found = [];
      for (const [key, value] of held) {
        const at = key.indexOf('\u0000');
        if (key.slice(0, at) !== type || value === null) continue;
        const id = key.slice(at + 1);
        if (id.startsWith(prefix)) found.push({ id, type, value });
      }
      return found.sort(byOrder);
    },
  };
}

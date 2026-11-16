// tools/record-graph/read-data/rows-as-list.mjs
//
// The rows a read tool works on arrive in its request (`records`: the person's rows, each { id, type, value }, read by
// their AI from their store). This gives them the one shape every bounded read in graph-records.mjs, graph-walk.mjs and
// tools/read-glance-feeds already uses, `list({ type, prefix?, where?, limit?, fields? })`: the rows of one type whose id
// starts with `prefix` and whose top-level value fields equal `where`, in the order given. Nothing is read from or kept
// in any store, and no records door is opened. Stands alone, so a row that imports it packs only this file.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** { list } over the supplied rows; refuses rows that are not { id, type, value } before any walk starts. */
export function rowsAsList(records) {
  if (!Array.isArray(records) || records.some(row => !object(row) || typeof row.id !== 'string' || typeof row.type !== 'string')) {
    throw new Error('records is the rows you hold, each { id, type, value }.');
  }
  return {
    async *list({ type, prefix, where } = {}) {
      for (const row of records) {
        if (row.type !== type || !object(row.value)) continue;
        if (prefix !== undefined && !row.id.startsWith(prefix)) continue;
        if (where && !Object.entries(where).every(([field, wanted]) => row.value[field] === wanted)) continue;
        yield row;
      }
    },
  };
}

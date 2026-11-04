// The generation of a store's tables, per SQL handle. A module that remembers "this table exists" (or what it held) keeps the
// generation it was made in beside that memory and makes its tables again when the generation has moved on. deleteEverything
// drops every table of the store and calls dropTables for each handle it uses, so no memory from before the drop is read again.
const generations = new WeakMap();

/** The generation this handle's tables are in: 0 until they are first dropped. */
export const tableGeneration = sql => generations.get(sql) ?? 0;

/** Moves each handle to a new generation: every memory made before this call is stale from now on. */
export function dropTables(...handles) {
  for (const sql of handles) generations.set(sql, tableGeneration(sql) + 1);
}

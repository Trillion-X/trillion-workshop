// tools/records-door/do-work/write-keep-list.mjs
//
// The one writer of a tool's keep list, beside the export runner (run-an-export.mjs): a row that declares keep_into gets each
// record its function returns as `keep` written into the table the row names, in one transaction. The runner names no table. A record is written only if the value it was read with (`expected`) is still the value the
// database holds; one record that moved refuses the whole list and nothing is written (the caller reads again and answers again).
//
// The client is a pg client (or any object with query(text, values) → { rows }). The connection is held by the engine and
// handed to the run's process on its own descriptor (the row's invoke.credential_mounts), as approve-a-post does
// (tools/social-posts/do-work/approve-a-post-in-database.mjs): it is never in the request, argv, a file or the environment.
// The table name comes from the row's keep_into data, checked as a plain identifier before it is written into the statements.
export const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class KeepRefused extends Error {}

const canonical = value => JSON.stringify(value, (key, item) => (item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);

/** Write `keep` (rows { id, type, value, expected }) into `table` in one transaction; refuse the whole list if any `expected` moved. */
export async function writeKeepList(keep, client, { table } = {}) {
  if (!Array.isArray(keep)) throw new KeepRefused('The keep list is missing.');
  if (typeof table !== 'string' || !TABLE_NAME.test(table)) throw new KeepRefused('keep_into names no plain table.');
  const create = `CREATE TABLE IF NOT EXISTS ${table} (id text NOT NULL, type text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (id, type))`;
  await client.query(create, []);
  await client.query('BEGIN', []);
  try {
    for (const item of keep) {
      const { rows } = await client.query(`SELECT value FROM ${table} WHERE id = $1 AND type = $2 FOR UPDATE`, [item.id, item.type]);
      if (!same(rows[0]?.value, item.expected)) throw new KeepRefused(`${item.type} ${item.id} changed since it was read: nothing was written.`);
    }
    for (const item of keep) {
      if (item.value === null) await client.query(`DELETE FROM ${table} WHERE id = $1 AND type = $2`, [item.id, item.type]);
      else await client.query(
        `INSERT INTO ${table} (id, type, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id, type) DO UPDATE SET value = EXCLUDED.value`,
        [item.id, item.type, JSON.stringify(item.value)]);
    }
    await client.query('COMMIT', []);
    return { written: keep.length };
  } catch (error) {
    await client.query('ROLLBACK', []);
    throw error;
  }
}

// tools/keep-a-postgres-database-on-a-computer/do-work/carry-rows-to-new-database.mjs
//
// Carries what was written to an old database after it was copied into its new one (scripts/copy-a-database.sh), so a move
// under a new name drops nothing while the old one's writers move over. For each named table: the columns the old one has and
// the new one lacks are added (same type), then every row of the old table is written into the new one by primary key (a key
// the new one lacks is added; a key it has takes the old row's values), and each sequence the old one moved past is set
// forward. All in one transaction on the new database; the old one is only read.
//   deletes_too: a key the old table no longer has is taken out of the new one too (its writer removed it). Only while the
//                old one is still the one written and the new one is not yet.
//   keep_new:    a key both have keeps the new database's row (once the new one is written too).
//
// usage: OLD_CONNECTION=postgresql://... NEW_CONNECTION=postgresql://... node carry-rows-to-new-database.mjs [--deletes-too | --keep-new] TABLE...
// The connection strings come in the environment only. Prints counts only, never a row value.
import { pathToFileURL } from 'node:url';
import { openConnection } from './compare-two-databases.mjs';

const columnsOf = (db, table) => db.query(`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type from pg_attribute a
  where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`, [`public."${table}"`]);

/** Carries the named tables from `from` into `to` (each answers `query(sql, params)` with rows); answers what each table got. */
export async function carryRows(from, to, tables, { deletes_too = false, keep_new = false } = {}) {
  if (deletes_too && keep_new) throw new Error('deletes_too and keep_new do not go together');
  const report = [];
  await to.query('BEGIN');
  try {
    for (const table of tables) {
      const [had, has] = [await columnsOf(from, table), await columnsOf(to, table)];
      const added = had.filter(c => !has.some(h => h.name === c.name));
      for (const c of added) await to.query(`alter table public."${table}" add column "${c.name}" ${c.type}`);
      const keyColumns = (await from.query(`select a.attname as name from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`, [`public."${table}"`])).map(r => r.name);
      if (!keyColumns.length) throw new Error(`${table} has no primary key; nothing carried`);
      const keys = keyColumns.map(name => `"${name}"`), key = keys.join(', ');
      const names = had.map(c => `"${c.name}"`);
      const [{ rows }] = await from.query(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text as rows from public."${table}" x`);
      const [{ n: before }] = await to.query(`select count(*)::int as n from public."${table}"`);
      let taken_out = 0;
      if (deletes_too) {
        const gone = await to.query(`delete from public."${table}" t where (${keys.map(k => `t.${k}`).join(', ')}) not in (select ${key} from jsonb_populate_recordset(null::public."${table}", $1::jsonb)) returning 1`, [rows]);
        taken_out = gone.length;
      }
      const others = names.filter(n => !keys.includes(n));
      const onConflict = others.length && !keep_new
        // Rows compared as text, so a json column (which has no = operator) compares too.
        ? `update set ${others.map(n => `${n} = excluded.${n}`).join(', ')} where (public."${table}".*)::text is distinct from (excluded.*)::text`
        : 'nothing';
      const written = await to.query(`insert into public."${table}" (${names.join(', ')}) select ${names.join(', ')} from jsonb_populate_recordset(null::public."${table}", $1::jsonb)
        on conflict (${key}) do ${onConflict} returning 1`, [rows]);
      const [{ n: after }] = await to.query(`select count(*)::int as n from public."${table}"`);
      report.push({ table, columns_added: added.map(c => c.name), rows_written: written.length, taken_out, rows_before: before, rows_after: after });
    }
    // A sequence never goes back: each one the old database moved past is set to the old value.
    for (const { name, value } of await from.query(`select sequencename as name, last_value::text as value from pg_sequences where schemaname = 'public' and last_value is not null`)) {
      const [now] = await to.query(`select last_value::text as value from pg_sequences where schemaname = 'public' and sequencename = $1`, [name]);
      if (now && BigInt(value) > BigInt(now.value ?? 0)) { await to.query(`select setval($1, $2::bigint, true)`, [`public."${name}"`, value]); report.push({ sequence: name, from: now.value, to: value }); }
    }
    await to.query('COMMIT');
  } catch (error) { await to.query('ROLLBACK'); throw error; }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { OLD_CONNECTION, NEW_CONNECTION } = process.env;
  if (!OLD_CONNECTION || !NEW_CONNECTION) throw new Error('Give OLD_CONNECTION and NEW_CONNECTION in the environment.');
  const args = process.argv.slice(2);
  const tables = args.filter(a => !a.startsWith('--'));
  if (!tables.length) throw new Error('Name the tables to carry.');
  const [from, to] = [await openConnection(OLD_CONNECTION), await openConnection(NEW_CONNECTION)];
  try {
    for (const line of await carryRows(from, to, tables, { deletes_too: args.includes('--deletes-too'), keep_new: args.includes('--keep-new') })) console.log(JSON.stringify(line));
  } finally { await from.end(); await to.end(); }
}

import { realpathSync } from 'node:fs';
// tools/copy-rows-between-databases/do-work/copy-rows.mjs
//
// The container tool `tool:copy-rows-between-databases` (tool-rows.json): copies named rows of one table from one Postgres-wire
// database to another, inside this one process, and answers only counts and each key's version, a few KB however big the rows are.
// A row's body is read from the source and written to the destination here; it is never in the request, the answer or the run's record.
//
// Both connection strings are held values the engine hands this one process on private pipes: the source's on descriptor 3 and the
// destination's on descriptor 4 (the row's invoke.credential_mounts). Neither is ever in the request, argv, a file or the environment,
// and no answer or error holds one. This file reads no vault and names no vendor, table or host.
//
// A row is found by its key column and carried whole as JSON: the destination fills its own table's columns from the names in it
// (jsonb_populate_record), so a column only the source has is left behind. A row's version is the md5 of its whole row as JSON, read by
// each database itself; the same row is the same version in both. All the keys are written in one transaction on the destination.
//   on_conflict "do_nothing"          a key the destination already has is kept as it is.
//   on_conflict "update_when_newer"   a key the destination has is replaced when its version_column is smaller than the source's;
//                                     equal or larger is kept. The key column must be unique in the destination.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const SOURCE_DESCRIPTOR = 3;
const DESTINATION_DESCRIPTOR = 4;
const MOST_KEYS = 1000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFLICTS = ['do_nothing', 'update_when_newer'];

const held = descriptor => {
  try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; }
};

const quoted = (name, what) => {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`${what} must be a plain name of letters, digits and underscores.`);
  return `"${name}"`;
};

// The request: { table, key_column, keys, on_conflict?, version_column? }. Anything else is refused with its reason.
export function shapeOf(input) {
  const asked = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const { table, key_column: keyColumn, keys, on_conflict: onConflict = 'do_nothing', version_column: versionColumn } = asked;
  if (typeof table !== 'string' || table.split('.').length > 2) throw new Error('table must be a table name, or schema.table.');
  const tableText = table.split('.').map(part => quoted(part, 'table')).join('.');
  const key = quoted(keyColumn, 'key_column');
  if (!Array.isArray(keys) || keys.some(each => typeof each !== 'string')) throw new Error('keys must be a list of the key values, each as text.');
  if (keys.length > MOST_KEYS) throw new Error(`keys holds ${keys.length} keys; at most ${MOST_KEYS} go in one call.`);
  if (!CONFLICTS.includes(onConflict)) throw new Error(`on_conflict must be one of ${CONFLICTS.join(', ')}.`);
  if (onConflict === 'update_when_newer' && versionColumn === undefined) throw new Error('on_conflict update_when_newer needs version_column: the column whose larger value is newer.');
  if (onConflict === 'do_nothing' && versionColumn !== undefined) throw new Error('version_column is for on_conflict update_when_newer.');
  return { tableText, key, keys: [...new Set(keys)], onConflict, version: versionColumn === undefined ? undefined : quoted(versionColumn, 'version_column') };
}

const versionOf = async (client, shape, key) => {
  const { rows } = await client.query(`SELECT md5(to_jsonb(t)::text) AS version FROM ${shape.tableText} t WHERE t.${shape.key}::text = $1`, [key]);
  return rows.length ? rows[0].version : null;
};

// Copies the keys; the answer is { copied, updated, kept, missing, keys: [{ key, result, source_version, destination_version }] }.
export async function copyRows({ source, destination, input, connect = connectTo }) {
  if (typeof source !== 'string' || source === '') throw new Error('No source connection was handed to this run. Hold it under the name source_credential_name gives.');
  if (typeof destination !== 'string' || destination === '') throw new Error('No destination connection was handed to this run. Hold it under the name destination_credential_name gives.');
  const shape = shapeOf(input);
  const from = await connect(source);
  let to;
  try {
    to = await connect(destination);
    const update = shape.onConflict === 'update_when_newer';
    let setList = '';
    if (update) {
      const { rows } = await to.query("SELECT a.attname AS name FROM pg_attribute a WHERE a.attrelid = $1::text::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum", [shape.tableText]);
      setList = rows.map(({ name }) => `${quoted(name, 'column')} = EXCLUDED.${quoted(name, 'column')}`).join(', ');
    }
    const write = `INSERT INTO ${shape.tableText} SELECT * FROM jsonb_populate_record(NULL::${shape.tableText}, $1::jsonb) ON CONFLICT (${shape.key}) ` +
      (update ? `DO UPDATE SET ${setList} WHERE ${shape.tableText}.${shape.version} < EXCLUDED.${shape.version}` : 'DO NOTHING');
    const answered = [];
    await to.query('BEGIN');
    try {
      for (const key of shape.keys) {
        const { rows } = await from.query(`SELECT to_jsonb(t) AS body, md5(to_jsonb(t)::text) AS version FROM ${shape.tableText} t WHERE t.${shape.key}::text = $1`, [key]);
        if (!rows.length) { answered.push({ key, result: 'missing', source_version: null, destination_version: await versionOf(to, shape, key) }); continue; }
        const before = update ? await versionOf(to, shape, key) : null;
        const wrote = await to.query(write, [JSON.stringify(rows[0].body)]);
        // A competing insert can win after a read. A write that affected no rows never owns the row it found.
        const result = wrote.rowCount !== 1 ? 'kept' : before === null ? 'copied' : 'updated';
        answered.push({ key, result, source_version: rows[0].version, destination_version: await versionOf(to, shape, key) });
      }
      await to.query('COMMIT');
    } catch (error) {
      await to.query('ROLLBACK').catch(() => {});
      throw error;
    }
    const count = result => answered.filter(each => each.result === result).length;
    return { copied: count('copied'), updated: count('updated'), kept: count('kept'), missing: count('missing'), keys: answered };
  } finally {
    await from.end().catch(() => {});
    await to?.end().catch(() => {});
  }
}

async function connectTo(connection) {
  // A run the engine sandboxes reaches its databases by address through the run's own proxy (through-the-run-proxy.mjs).
  const { default: pg } = await import('pg');
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  return client;
}

// The text of a failure with each connection string and its secret parts taken out.
export function sayWithout(error, ...connections) {
  let said = String(error?.message ?? error);
  // Each whole string first, then each password: taking a password out first would break the other string's text.
  const passwords = [];
  for (const connection of connections) {
    try { passwords.push(decodeURIComponent(new URL(connection).password)); } catch { /* not a URL: only the whole text is removed */ }
  }
  for (const part of [...connections, ...passwords]) if (part) said = said.split(part).join('[held]');
  return said;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const source = held(SOURCE_DESCRIPTOR), destination = held(DESTINATION_DESCRIPTOR);
  try {
    console.log(JSON.stringify(await copyRows({ source, destination, input: JSON.parse(readFileSync(0, 'utf8')) })));
  } catch (error) {
    console.error(sayWithout(error, source, destination));
    process.exitCode = 1;
  }
}

import { realpathSync } from 'node:fs';
// tools/keep-journey-steps-from-kept-rows/do-work/keep-steps.mjs
//
// The container tool `tool:keep-journey-steps-from-kept-rows` (tool-rows.json): reads the kept rows that stand for a visitor's
// steps (read-data/journey-kept-rows.json: bookings, site-form leads and site visits from the statements table, sales from
// payment_events) and keeps each one in
// the pursuit's journey_steps table through keepStep (do-work/journey.mjs). A row is read from the newest kept step of its kind
// (or from `since` when given), and a step with a ref already kept is left as it is, so running it again adds nothing.
//
// The connection string is a held value on descriptor 3 (the row's credential_mounts), as show-where-each-phrase-came-from holds
// it; the database is reached through the run's proxy (through-the-run-proxy.mjs). Every email is made into its key in JavaScript
// and never written raw. The mapping's SQL is DATA written by the pursuit's owner; the one input value (since) is a bound parameter.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emailKey, keepStep, purgeProofRows, visitStep } from '../../traffic-attribution/do-work/journey.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';
import settings from '../read-data/journey-kept-rows.json' with { type: 'json' };

const OVERLAP_MINUTES = Number(settings.cutoff_overlap_minutes);
if (!Number.isInteger(OVERLAP_MINUTES) || OVERLAP_MINUTES < 0) throw new TypeError('journey-kept-rows.json cutoff_overlap_minutes must be a whole number of minutes.');

// The kit's tables and views (traffic-attribution's journey-steps.sql). Applied to a pursuit's database once per version, before
// any step is kept, so a schema change in the kit reaches a live database within one run. The version is the BLAKE3 of the bytes.
const SCHEMA_SQL = readFileSync(new URL('../../traffic-attribution/read-data/journey-steps.sql', import.meta.url), 'utf8');
const SCHEMA_VERSION = makeHashCodeHexFromBytes(new TextEncoder().encode(SCHEMA_SQL));
// Every object the file declares: tables, views and indexes (each a row of pg_class).
const DECLARED = [...SCHEMA_SQL.matchAll(/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|OR REPLACE VIEW)\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gim)].map(match => match[1]);
// The columns the kit's tables declare, as [table, column]: each CREATE TABLE's column list and each ADD COLUMN IF NOT EXISTS.
const CONSTRAINT_WORD = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i;
const DECLARED_COLUMNS = [
  ...[...SCHEMA_SQL.matchAll(/^CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*) \(\n([\s\S]*?)\n\);/gim)].flatMap(([, table, body]) => body.split('\n')
    .map(line => line.trim().match(/^([a-z_][a-z0-9_]*)\s/i)?.[1])
    .filter(column => column && !CONSTRAINT_WORD.test(column))
    .map(column => [table, column])),
  ...[...SCHEMA_SQL.matchAll(/^ALTER TABLE ([a-z_][a-z0-9_]*) ADD COLUMN IF NOT EXISTS ([a-z_][a-z0-9_]*)/gim)].map(([, table, column]) => [table, column]),
];
const DECLARED_TABLES = [...new Set(DECLARED_COLUMNS.map(([table]) => table))];

const CONNECTION_DESCRIPTOR = 3;
const STATEMENT_TIMEOUT_MS = 20000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * The SELECT that reads one mapping's rows: its fields as f_<name>, its where, and only rows whose cutoff_column (the time the
 * source row itself was kept, an insert time) is newer than the cutoff. The cutoff is `since` when given, else the newest step
 * of this kind's own insert time less the overlap (cutoff_overlap_minutes), so a row whose transaction committed late is still read;
 * `at` is the event time, for display. A row read again is not kept twice. A ref in journey_excluded_refs is never read.
 */
export function readSql(mapping, { byRef = false } = {}) {
  const fields = Object.entries(mapping.fields).map(([name, expression]) => `(${expression}) AS f_${name}`);
  const sourced = Object.entries(mapping.source ?? {}).map(([name, expression]) => `(${expression}) AS s_${name}`);
  // byRef: the rows named by $1 (a list of refs), whatever their cutoff, so a source fixed long after it was kept is read again.
  const scope = byRef
    ? `(${mapping.fields.ref}) = ANY($1::text[])`
    : `(${mapping.cutoff_column}) > COALESCE($1::timestamptz, (SELECT max(at) - make_interval(mins => ${OVERLAP_MINUTES}) FROM journey_steps WHERE step = $2), '-infinity'::timestamptz)`;
  return `SELECT ${[...fields, ...sourced].join(', ')} FROM ${mapping.table} WHERE (${mapping.where}) AND ${scope} `
    + `AND NOT EXISTS (SELECT 1 FROM journey_excluded_refs x WHERE x.ref = (${mapping.fields.ref})) `
    + `ORDER BY ${mapping.fields.at}, ${mapping.fields.ref}`;
}

/**
 * The journey step one read row stands for. The raw email is turned into its key here and no further. A mapping whose fields
 * name a url (the address a page was seen at, and its referrer) is a visit: the journey kit's own visit step for that address
 * (its kept parameters, touch and join), with the row's ref, or null when the address keeps no source (a direct visit, a check).
 */
export function stepOf(mapping, row) {
  const visitor = text(row.f_visitor) || null;
  if (mapping.fields.url) {
    const visit = visitStep({ url: text(row.f_url), refererHeader: text(row.f_referrer) || undefined, visitor });
    return visit && { ...visit, ref: text(row.f_ref) || null };
  }
  const source = Object.fromEntries(Object.keys(mapping.source ?? {}).map(name => [name, row[`s_${name}`] ?? null]).filter(([, value]) => value !== null));
  // A step joins by its visitor when it has one (joined_by_visitor), else by the touch it followed (joined_by_touch).
  const touch = text(row.f_touch_id) || null;
  return {
    visitor,
    touch_id: touch,
    step: mapping.step,
    ref: text(row.f_ref) || null,
    joined_by: visitor && mapping.joined_by_visitor ? mapping.joined_by_visitor : touch && mapping.joined_by_touch ? mapping.joined_by_touch : mapping.joined_by,
    email_key: emailKey(row.f_email),
    offer_id: text(row.f_offer_id) || null,
    value_cents: row.f_value_cents ?? null,
    source: Object.keys(source).length ? source : null,
  };
}

/** The columns a table has in this database, read once per table through `cache`; none when the table is absent. */
async function columnsOf(query, table, cache) {
  if (!cache.has(table)) {
    const { rows } = await query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [table]);
    cache.set(table, new Set(rows.map(row => row.column_name)));
  }
  return cache.get(table);
}

/**
 * Whether a shape fits this database: each of its requires_columns is a column of the mapped table, or, written "table.column",
 * of the table it names (a mapping that reads offers needs offers' own columns too).
 */
async function fits(query, mapping, cache) {
  for (const name of mapping.requires_columns ?? []) {
    const [table, column] = name.includes('.') ? name.split('.') : [mapping.table, name];
    if (!(await columnsOf(query, table, cache)).has(column)) return false;
  }
  return true;
}

/**
 * Keeps every mapped row as its journey step. `query(sql, params)` resolves to { rows, rowCount } (pg or PGlite). Answers each
 * mapping's count of rows read and of steps newly kept; a mapping with no ref in its fields is refused before any read.
 * Mappings that name the same table and step are shapes of that table: the first whose requires_columns the table has is read,
 * and the answer names it. A table that fits none of its shapes is reported with its columns, not an error.
 */
export async function keepStepsFromRows({ query, since = null, refs = null, mappings = settings.mappings }) {
  for (const mapping of mappings) {
    if (!text(mapping.fields?.ref)) throw new TypeError(`${mapping.id} names no ref, so its steps could not be kept once.`);
    if (!text(mapping.cutoff_column)) throw new TypeError(`${mapping.id} names no cutoff_column (the time its rows were kept), so its rows could not be read once each.`);
  }
  const shapes = new Map();
  for (const mapping of mappings) {
    const key = JSON.stringify([mapping.table, mapping.step]);
    shapes.set(key, [...(shapes.get(key) ?? []), mapping]);
  }
  const answer = [];
  const cache = new Map();
  for (const alternatives of shapes.values()) {
    const { table, step } = alternatives[0];
    // A pursuit with no such table (a site that takes no bookings, say) has nothing to keep for these mappings: it is reported, not an error.
    if ((await columnsOf(query, table, cache)).size === 0) {
      for (const mapping of alternatives) answer.push({ id: mapping.id, step, skipped: `no ${table} here` });
      continue;
    }
    let mapping = null;
    for (const candidate of alternatives) {
      if (await fits(query, candidate, cache)) {
        mapping = candidate;
        break;
      }
    }
    if (!mapping) {
      answer.push({ table, step, skipped: `no mapping fits ${table}`, columns: [...(await columnsOf(query, table, cache))].sort() });
      continue;
    }
    const { rows } = refs ? await query(readSql(mapping, { byRef: true }), [refs]) : await query(readSql(mapping), [since, mapping.step]);
    let kept = 0;
    for (const row of rows) {
      // A visit whose address keeps no source is no step.
      if (stepOf(mapping, row) === null) continue;
      const result = await keepStep(query, stepOf(mapping, row));
      if (result.kept) kept += 1;
    }
    answer.push({ id: mapping.id, step, read: rows.length, kept });
  }
  return { mappings: answer };
}

async function connectTo(connection, proxy) {
  // pg loads here, not at import, so the checks above run where pg is not installed (the tests).
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}), statement_timeout: STATEMENT_TIMEOUT_MS });
  await client.connect();
  return client;
}

/** Whether the database has applied this version of the kit's schema. */
async function schemaApplied(query) {
  const present = (await query("SELECT to_regclass('journey_kit_schema') IS NOT NULL AS present", [])).rows[0].present;
  if (!present) return false;
  return (await query('SELECT 1 AS applied FROM journey_kit_schema WHERE version = $1', [SCHEMA_VERSION])).rows.length > 0;
}

/**
 * The privileges each kit view holds now, as GRANT statements (the owner's own entry is not one). A view is dropped and created
 * again by the schema file, which takes its grants with it, so applySchema restores these after the file's views exist.
 */
async function viewGrants(query) {
  const { rows } = await query(
    `SELECT c.relname, a.privilege_type, a.is_grantable,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee
     FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relkind = 'v' AND c.relname = ANY($1::text[]) AND pg_table_is_visible(c.oid) AND a.grantee <> c.relowner
     ORDER BY c.relname, a.privilege_type, grantee`,
    [DECLARED],
  );
  return rows.map(row => `GRANT ${row.privilege_type} ON ${row.relname} TO ${row.grantee}${row.is_grantable ? ' WITH GRANT OPTION' : ''};`);
}

/**
 * Applies the kit's schema in one transaction, with the version row written in it, so a failed apply leaves the database as it
 * was. The views' grants are read first and restored inside the same transaction. Plain text (no parameters) so the whole file
 * runs as one simple query. The version is hex, so it is written inline.
 */
async function applySchema(client, query) {
  const grants = await viewGrants(query);
  try {
    await client.query(`BEGIN;\n${SCHEMA_SQL}\n${grants.join('\n')}\nINSERT INTO journey_kit_schema (version) VALUES ('${SCHEMA_VERSION}') ON CONFLICT DO NOTHING;\nCOMMIT;`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** What the kit declares that the database lacks, read from pg_class (no writes). */
async function schemaReport(query) {
  const present = new Set((await query('SELECT relname FROM pg_class WHERE relname = ANY($1::text[])', [DECLARED])).rows.map(row => row.relname));
  const columns = new Set((await query('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])', [DECLARED_TABLES])).rows.map(row => `${row.table_name}.${row.column_name}`));
  const missing = [
    ...DECLARED.filter(name => !present.has(name)),
    ...DECLARED_COLUMNS.map(([table, column]) => `${table}.${column}`).filter(name => !columns.has(name)),
  ];
  return { declared: DECLARED.length, missing, version: SCHEMA_VERSION, applied: await schemaApplied(query) };
}

/**
 * The tool's answer for one input through the connection on descriptor 3. mode "keep" (the default) applies the kit's schema when
 * this database has not got this version, then keeps the steps: { schema, mappings }. mode "check" writes nothing and answers what
 * the kit declares that the database lacks: { declared, missing, version, applied }. Keep mode also removes the proof rows that are
 * old enough (purgeProofRows), and answers what it removed as proof.
 */
export async function runKeepSteps({ input, connection, proxy = process.env.HTTPS_PROXY ?? '', connect = connectTo }) {
  if (!plain(input)) throw new Error('The input is one object, with since or refs (optional), or mode "check".');
  const mode = input.mode === undefined ? 'keep' : input.mode;
  if (mode !== 'keep' && mode !== 'check') throw new Error('mode must be "keep" or "check".');
  const since = input.since === undefined ? null : text(input.since);
  if (since !== null && !ISO_TIME.test(since)) throw new Error('since must be an ISO time, like 2026-11-21T00:00:00Z.');
  const refs = input.refs === undefined ? null : input.refs;
  if (refs !== null && (!Array.isArray(refs) || refs.length === 0 || refs.length > 500 || !refs.every(ref => typeof ref === 'string' && ref.trim()))) throw new Error('refs must be a list of 1 to 500 ref strings.');
  if (refs !== null && since !== null) throw new Error('give refs or since, not both.');
  if (!connection) throw new Error('The database connection is not held for this run.');
  const client = await connect(connection, proxy);
  const names = new Map();
  // Each distinct statement text gets one named prepared statement on this connection.
  const query = (sql, params) => {
    if (!names.has(sql)) names.set(sql, `keep_steps_${names.size}`);
    return client.query({ name: names.get(sql), text: sql, values: params });
  };
  try {
    if (mode === 'check') return { mode, ...(await schemaReport(query)) };
    let schema = 'current';
    if (!(await schemaApplied(query))) {
      await applySchema(client, query);
      schema = 'applied';
    }
    const kept = await keepStepsFromRows({ query, since, refs: refs?.map(ref => ref.trim()) ?? null });
    return { schema, ...kept, proof: await purgeProofRows(query) };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const connection = (() => { try { return readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim(); } catch { return ''; } })();
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(`${JSON.stringify(await runKeepSteps({ input, connection }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

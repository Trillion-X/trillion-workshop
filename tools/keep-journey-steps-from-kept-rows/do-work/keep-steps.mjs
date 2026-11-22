// tools/keep-journey-steps-from-kept-rows/do-work/keep-steps.mjs
//
// The container tool `tool:keep-journey-steps-from-kept-rows` (tool-rows.json): reads the kept rows that stand for a visitor's
// steps (read-data/journey-kept-rows.json: bookings from the statements table, sales from payment_events) and keeps each one in
// the pursuit's journey_steps table through keepStep (do-work/journey.mjs). A row is read from the newest kept step of its kind
// (or from `since` when given), and a step with a ref already kept is left as it is, so running it again adds nothing.
//
// The connection string is a held value on descriptor 3 (the row's credential_mounts), as show-where-each-phrase-came-from holds
// it; the database is reached through the run's proxy (through-the-run-proxy.mjs). Every email is made into its key in JavaScript
// and never written raw. The mapping's SQL is DATA written by the pursuit's owner; the one input value (since) is a bound parameter.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emailKey, keepStep } from '../../traffic-attribution/do-work/journey.mjs';
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

/** The journey step one read row stands for. The raw email is turned into its key here and no further. */
export function stepOf(mapping, row) {
  const visitor = text(row.f_visitor) || null;
  const source = Object.fromEntries(Object.keys(mapping.source ?? {}).map(name => [name, row[`s_${name}`] ?? null]).filter(([, value]) => value !== null));
  return {
    visitor,
    step: mapping.step,
    ref: text(row.f_ref) || null,
    joined_by: visitor && mapping.joined_by_visitor ? mapping.joined_by_visitor : mapping.joined_by,
    email_key: emailKey(row.f_email),
    offer_id: text(row.f_offer_id) || null,
    value_cents: row.f_value_cents ?? null,
    source: Object.keys(source).length ? source : null,
  };
}

/**
 * Keeps every mapped row as its journey step. `query(sql, params)` resolves to { rows, rowCount } (pg or PGlite). Answers each
 * mapping's count of rows read and of steps newly kept; a mapping with no ref in its fields is refused before any read.
 */
export async function keepStepsFromRows({ query, since = null, refs = null, mappings = settings.mappings }) {
  const answer = [];
  for (const mapping of mappings) {
    if (!text(mapping.fields?.ref)) throw new TypeError(`${mapping.id} names no ref, so its steps could not be kept once.`);
    if (!text(mapping.cutoff_column)) throw new TypeError(`${mapping.id} names no cutoff_column (the time its rows were kept), so its rows could not be read once each.`);
    // A pursuit with no such table (a site that takes no bookings, say) has nothing to keep for this mapping: it is reported, not an error.
    const present = (await query('SELECT to_regclass($1::text) IS NOT NULL AS present', [mapping.table])).rows[0].present;
    if (!present) {
      answer.push({ id: mapping.id, step: mapping.step, skipped: `no ${mapping.table} here` });
      continue;
    }
    const { rows } = refs ? await query(readSql(mapping, { byRef: true }), [refs]) : await query(readSql(mapping), [since, mapping.step]);
    let kept = 0;
    for (const row of rows) {
      const result = await keepStep(query, stepOf(mapping, row));
      if (result.kept) kept += 1;
    }
    answer.push({ id: mapping.id, step: mapping.step, read: rows.length, kept });
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
 * Applies the kit's schema in one transaction, with the version row written in it, so a failed apply leaves the database as it
 * was. Plain text (no parameters) so the whole file runs as one simple query. The version is hex, so it is written inline.
 */
async function applySchema(client) {
  try {
    await client.query(`BEGIN;\n${SCHEMA_SQL}\nINSERT INTO journey_kit_schema (version) VALUES ('${SCHEMA_VERSION}') ON CONFLICT DO NOTHING;\nCOMMIT;`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** What the kit declares that the database lacks, read from pg_class (no writes). */
async function schemaReport(query) {
  const present = new Set((await query('SELECT relname FROM pg_class WHERE relname = ANY($1::text[])', [DECLARED])).rows.map(row => row.relname));
  return { declared: DECLARED.length, missing: DECLARED.filter(name => !present.has(name)), version: SCHEMA_VERSION, applied: await schemaApplied(query) };
}

/**
 * The tool's answer for one input through the connection on descriptor 3. mode "keep" (the default) applies the kit's schema when
 * this database has not got this version, then keeps the steps: { schema, mappings }. mode "check" writes nothing and answers what
 * the kit declares that the database lacks: { declared, missing, version, applied }.
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
      await applySchema(client);
      schema = 'applied';
    }
    return { schema, ...(await keepStepsFromRows({ query, since, refs: refs?.map(ref => ref.trim()) ?? null })) };
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connection = (() => { try { return readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim(); } catch { return ''; } })();
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(`${JSON.stringify(await runKeepSteps({ input, connection }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

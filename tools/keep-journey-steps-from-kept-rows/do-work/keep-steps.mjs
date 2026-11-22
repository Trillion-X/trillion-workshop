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
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';
import settings from '../read-data/journey-kept-rows.json' with { type: 'json' };

const CONNECTION_DESCRIPTOR = 3;
const STATEMENT_TIMEOUT_MS = 20000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');

/** The SELECT that reads one mapping's rows: its fields as f_<name>, its where, and only rows newer than the cutoff. */
export function readSql(mapping) {
  const fields = Object.entries(mapping.fields).map(([name, expression]) => `(${expression}) AS f_${name}`);
  const sourced = Object.entries(mapping.source ?? {}).map(([name, expression]) => `(${expression}) AS s_${name}`);
  return `SELECT ${[...fields, ...sourced].join(', ')} FROM ${mapping.table} WHERE (${mapping.where}) AND (${mapping.fields.at}) > `
    + 'COALESCE($1::timestamptz, (SELECT max(at) FROM journey_steps WHERE step = $2), \'-infinity\'::timestamptz) '
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
export async function keepStepsFromRows({ query, since = null, mappings = settings.mappings }) {
  const answer = [];
  for (const mapping of mappings) {
    if (!text(mapping.fields?.ref)) throw new TypeError(`${mapping.id} names no ref, so its steps could not be kept once.`);
    const { rows } = await query(readSql(mapping), [since, mapping.step]);
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

/** The tool's answer for one input { since? }, through the connection on descriptor 3. */
export async function runKeepSteps({ input, connection, proxy = process.env.HTTPS_PROXY ?? '', connect = connectTo }) {
  if (!plain(input)) throw new Error('The input is one object, with since (optional) as an ISO time.');
  const since = input.since === undefined ? null : text(input.since);
  if (since !== null && !ISO_TIME.test(since)) throw new Error('since must be an ISO time, like 2026-11-21T00:00:00Z.');
  if (!connection) throw new Error('The database connection is not held for this run.');
  const client = await connect(connection, proxy);
  const names = new Map();
  // Each distinct statement text gets one named prepared statement on this connection.
  const query = (sql, params) => {
    if (!names.has(sql)) names.set(sql, `keep_steps_${names.size}`);
    return client.query({ name: names.get(sql), text: sql, values: params });
  };
  try {
    return await keepStepsFromRows({ query, since });
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

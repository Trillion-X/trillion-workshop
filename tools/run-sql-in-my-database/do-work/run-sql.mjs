// tools/run-sql-in-my-database/do-work/run-sql.mjs
//
// The container tool `tool:run-sql-in-my-database` (tool-rows.json): one SQL statement, as written, in the person's own
// Postgres-wire database, answered as { columns, rows, row_count } or the database's own error text. Either the caller's
// `sql` (with `params`), or the shape the step-outputs runner hands for a `row:<list>` output ({ list, id, value }),
// which is an upsert into the table named `list`, made when it is missing as (id text primary key, value jsonb,
// updated_at timestamptz).
//
// The connection string is a held value the engine hands this one process on a private pipe, descriptor 3 (the row's
// invoke.credential_mounts); it is never in the request, argv, a file or the environment, and no answer or error holds it.
// This file reads no vault and names no vendor or host: any server that speaks the Postgres wire protocol answers it.
// One statement per call is the protocol's rule, not ours: every statement goes through the extended query protocol (a named
// prepared statement), which the server refuses when the text holds more than one command. What a login may do is that
// login's rule in the database (a SELECT-only role cannot write); nothing here checks it, wraps it or adds a flag.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const CONNECTION_DESCRIPTOR = 3;

const heldConnection = () => {
  let held = '';
  try { held = readFileSync(CONNECTION_DESCRIPTOR, 'utf8'); } catch { held = ''; }
  return held.trim();
};

// One statement through the extended protocol; the answer is the columns, the rows and the rows' count.
let sent = 0;
const runOne = async (client, text, values = []) => {
  const result = await client.query({ name: `statement_${sent += 1}`, text, values });
  return { columns: result.fields.map(field => field.name), rows: result.rows, row_count: result.rowCount ?? result.rows.length };
};

const upsertText = list => `INSERT INTO ${pg.Client.prototype.escapeIdentifier(list)} (id, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
const createText = list => `CREATE TABLE IF NOT EXISTS ${pg.Client.prototype.escapeIdentifier(list)} (id text PRIMARY KEY, value jsonb, updated_at timestamptz)`;

// The request's two shapes: { sql, params? } and { list, id, value }. Anything else is refused with its reason.
export function shapeOf(input) {
  const asked = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const hasSql = Object.hasOwn(asked, 'sql');
  const hasRow = Object.hasOwn(asked, 'list') || Object.hasOwn(asked, 'id') || Object.hasOwn(asked, 'value');
  if (hasSql && hasRow) throw new Error('Give either sql (with params) or list, id and value, not both.');
  if (hasSql) {
    if (typeof asked.sql !== 'string' || asked.sql.trim() === '') throw new Error('sql must be a statement as text.');
    if (asked.params !== undefined && !Array.isArray(asked.params)) throw new Error('params must be a list of values.');
    return { kind: 'sql', sql: asked.sql, params: asked.params ?? [] };
  }
  if (hasRow) {
    if (typeof asked.list !== 'string' || asked.list === '' || typeof asked.id !== 'string' || asked.id === '' || asked.value === undefined) throw new Error('A row needs list and id as text and a value.');
    return { kind: 'row', list: asked.list, id: asked.id, value: asked.value };
  }
  throw new Error('Give sql (with params) or list, id and value.');
}

// Runs the request as the connection's login. `connect` makes a connected client (a test hands its own); the client is
// always closed. A server error is the server's own text; the connection string is removed from any text first.
export async function runSql({ connection, input, connect = connectTo }) {
  if (typeof connection !== 'string' || connection === '') throw new Error('No database connection was handed to this run. Hold the connection string under the name the cart line gives.');
  const shape = shapeOf(input);
  const timeout = input.statement_timeout_ms;
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) throw new Error('statement_timeout_ms must be a whole number of milliseconds above zero.');
  const client = await connect(connection, timeout);
  try {
    if (shape.kind === 'sql') return await runOne(client, shape.sql, shape.params);
    await runOne(client, createText(shape.list));
    return await runOne(client, upsertText(shape.list), [shape.id, JSON.stringify(shape.value)]);
  } finally {
    await client.end().catch(() => {});
  }
}

async function connectTo(connection, statementTimeout) {
  const client = new pg.Client({ connectionString: connection, ...(statementTimeout ? { statement_timeout: statementTimeout } : {}) });
  await client.connect();
  return client;
}

// The text of a failure with the connection string and its secret parts taken out.
export function sayWithout(error, connection) {
  let said = String(error?.message ?? error);
  const parts = [connection];
  try { const url = new URL(connection); parts.push(decodeURIComponent(url.password)); } catch { /* not a URL: only the whole text is removed */ }
  for (const part of parts) if (part) said = said.split(part).join('[held]');
  return said;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connection = heldConnection();
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(await runSql({ connection, input })));
  } catch (error) {
    console.error(sayWithout(error, connection));
    process.exitCode = 1;
  }
}

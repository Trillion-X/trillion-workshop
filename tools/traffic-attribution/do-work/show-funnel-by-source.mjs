// tools/traffic-attribution/do-work/show-funnel-by-source.mjs
//
// The container tool `tool:show-funnel-by-source` (its descriptor is the offer in part.json): one read of the person's
// funnel_by_source view (journey-steps.sql), answered as { columns, rows, row_count }. Shown as a parts screen at /funnel-by-source.
//
// The connection string is a held value the engine hands this one process on descriptor 3 (the offer's invoke.credential_mounts);
// it is never in the request, argv, a file or the environment, and no answer or error holds it. The statement is fixed text and
// takes no input from the request. The database is reached through the run's proxy (through-the-run-proxy.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;
const STATEMENT_TIMEOUT_MS = 10000;
const ROW_LIMIT = 500;
export const FUNNEL_SQL = 'SELECT utm_source AS source, utm_medium AS medium, utm_campaign AS campaign, visitors, clicks, visits, leads, bookings, checkouts, sales, revenue_cents FROM funnel_by_source ORDER BY visitors DESC NULLS LAST LIMIT ' + ROW_LIMIT;

const held = () => {
  try { return readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim(); } catch { return ''; }
};

async function connectTo(connection, proxy) {
  // pg loads here, not at import, so the function's checks run where pg is not installed (the tests).
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}), statement_timeout: STATEMENT_TIMEOUT_MS });
  await client.connect();
  return client;
}

// The one statement: { columns, rows, row_count }. No connection is opened when none is held.
export async function funnelBySource({ connection = held(), proxy = process.env.HTTPS_PROXY ?? '', connect = connectTo } = {}) {
  if (!connection) throw new Error('The database connection is not held for this run.');
  const client = await connect(connection, proxy);
  try {
    const result = await client.query({ text: FUNNEL_SQL });
    return { columns: result.fields.map(field => field.name), rows: result.rows, row_count: result.rows.length };
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  funnelBySource()
    .then(answer => process.stdout.write(JSON.stringify(answer)))
    .catch(error => { process.stderr.write(`show-funnel-by-source: ${error.message}\n`); process.exitCode = 1; });
}

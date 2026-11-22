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
// The people counts (funnel_by_source, one count per person per step) and the visit steps of each source (visit_steps_by_source, every
// visit whether or not a person is kept). A source present in only one of the two still shows, its other count at 0. The join reads a
// missing UTM field as '' (a tracked link never carries an empty one), so it can use a hash join.
export const FUNNEL_SQL = `SELECT COALESCE(f.utm_source, v.utm_source) AS source, COALESCE(f.utm_medium, v.utm_medium) AS medium, COALESCE(f.utm_campaign, v.utm_campaign) AS campaign, COALESCE(f.visitors, 0) AS visitors, COALESCE(f.clicks, 0) AS clicks, COALESCE(f.visits, 0) AS visits, COALESCE(f.leads, 0) AS leads, COALESCE(f.bookings, 0) AS bookings, COALESCE(f.checkouts, 0) AS checkouts, COALESCE(f.sales, 0) AS sales, COALESCE(f.revenue_cents, 0) AS revenue_cents, '$' || to_char(COALESCE(f.revenue_cents, 0) / 100.0, 'FM999,999,990.00') AS revenue_text, COALESCE(v.visit_steps, 0) AS visit_steps FROM funnel_by_source f FULL JOIN visit_steps_by_source v ON COALESCE(v.utm_source, '') = COALESCE(f.utm_source, '') AND COALESCE(v.utm_medium, '') = COALESCE(f.utm_medium, '') AND COALESCE(v.utm_campaign, '') = COALESCE(f.utm_campaign, '') ORDER BY visitors DESC, visit_steps DESC LIMIT ${ROW_LIMIT}`;

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

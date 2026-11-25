/**
 * notice-when-something-shows-up/do-work/mechanisms/postgres-connection.mjs
 *
 * How the noticer opens a Postgres connection: the one place that knows the run's proxy. A run the engine sandboxes reaches
 * the database only through the run's own proxy, which the engine names in HTTPS_PROXY: a direct connect is refused (EPERM).
 * The tunnel is run-sql-in-my-database's, laid beside this tool by the row. The row-changes leaf reads its watched database
 * this way (and says clientOptions on as its own, for due-time.mjs and source-rows.mjs), and the place store
 * (../kept-places.mjs) reads the database places_in names this way, without loading the row-changes leaf and what it loads.
 */

/** The pg client options for `connection`: through the run's proxy when the engine names one. */
export async function clientOptions(connection, proxy = process.env.HTTPS_PROXY) {
  if (!proxy) return { connectionString: connection };
  const { throughProxy } = await import("../../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs");
  return { connectionString: connection, stream: throughProxy(proxy) };
}

/** A connected pg client for `connection`. */
export async function connectWithPg(connection) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(await clientOptions(connection));
  await client.connect();
  return client;
}

// The sign-in store: one Postgres database that every Better Auth process of the sign-in shares (users, passkeys, the one-time
// challenge and email-code rows in `verification`, sessions, grants, the `jwks` keys), so any process behind the sign-in name can finish
// what another started. Better Auth reaches it through its own documented Kysely PostgreSQL adapter (a pg Pool as `database`,
// https://www.better-auth.com/docs/adapters/postgresql). settings.json `store.env` names the environment variable that carries the
// connection string, which the engine or the unit hands the process under the credential settings.json `store.credential` names;
// this tool never reads a vault.

import pg from 'pg';
import { getMigrations } from 'better-auth/db/migration';

// Takes one number out of every process that migrates, so processes starting together make the tables one at a time.
const MIGRATION_LOCK = 7_104_081_977;

export function storePool({ store }, env = process.env) {
  const connectionString = env[store.env];
  if (!connectionString) throw new Error(`${store.env} is empty: the sign-in store's connection (credential ${store.credential}) must be in the environment`);
  return new pg.Pool({ connectionString, max: store.pool_size });
}

// Creates or updates Better Auth's tables for the options the process runs, holding a database-wide advisory lock so a second
// process that starts at the same moment waits and then finds the tables made.
export async function migrateStore(auth, pool) {
  const held = await pool.connect();
  try {
    await held.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await (await getMigrations(auth.options)).runMigrations();
  } finally {
    await held.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    held.release();
  }
}

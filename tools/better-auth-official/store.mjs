// The sign-in store: one database that every Better Auth process of the sign-in shares (users, passkeys, the one-time challenge
// and email-code rows in `verification`, sessions, grants, the `jwks` keys), so any process behind the sign-in name can finish what
// another started. This tool names no database: settings.json `store` names the driver Better Auth is handed as its `database`
// (`module`, its `export` and the constructor's `arguments`, each "{connection}" in them the connection string), and Better Auth
// picks its own adapter for it (a pg Pool, a MySQL pool, better-sqlite3, node:sqlite's DatabaseSync or a Kysely dialect:
// https://www.better-auth.com/docs/concepts/database). Another store is a settings change. `store.env` names the environment variable
// that carries the connection string, which the engine or the unit hands the process under the credential `store.credential`
// names; this tool never reads a vault.

import { CompiledQuery } from 'kysely';
import { createKyselyAdapter } from '@better-auth/kysely-adapter';
import { getMigrations } from 'better-auth/db/migration';

const filled = (value, connection) => typeof value === 'string' ? value.replaceAll('{connection}', connection)
  : Array.isArray(value) ? value.map(item => filled(item, connection))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item, connection)]))
  : value;

/** The driver the store's settings name, made with the connection string from the environment. */
export async function storeDriver({ store }, env = process.env) {
  const connection = env[store.env];
  if (!connection) throw new Error(`${store.env} is empty: the sign-in store's connection (credential ${store.credential}) must be in the environment`);
  const made = (await import(store.module))[store.export];
  if (typeof made !== 'function') throw new Error(`settings store: ${store.module} exports no ${store.export}`);
  return new made(...filled(store.arguments ?? [], connection));
}

/** Ends the store's driver by the method the settings name (`store.close`). */
export const closeStore = async ({ store }, driver) => driver[store.close]?.();

// Creates or updates Better Auth's tables for the options the process runs. When the settings name `migration_lock` (`take` and
// `give`, the store's own statements), it is held on one connection around the migration, so a second process that starts at the
// same moment waits and then finds the tables made. A store that is one process's own file needs none.
export async function migrateStore(auth, { store }) {
  const migrate = async () => (await getMigrations(auth.options)).runMigrations();
  if (!store.migration_lock) return migrate();
  // Better Auth's own Kysely over the same driver: it holds no connection of its own, so it is never destroyed (that would end the driver).
  const { kysely } = await createKyselyAdapter(auth.options);
  await kysely.connection().execute(async held => {
    await held.executeQuery(CompiledQuery.raw(store.migration_lock.take));
    try { await migrate(); } finally { await held.executeQuery(CompiledQuery.raw(store.migration_lock.give)).catch(() => {}); }
  });
}

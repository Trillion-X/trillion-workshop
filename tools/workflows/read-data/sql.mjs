// tools/workflows/read-data/sql.mjs
//
// How a workflows tool reaches the person's own Postgres: a `sql` function, `sql(text, values?) -> Promise<row[]>`, one
// statement per call, rows as objects (jsonb columns arrive parsed). The tool is handed it by do-work/run-with-sql.mjs,
// which connects with the held connection string on descriptor 3; tests hand it one over a real server. Nothing here names
// a vendor, a host or a secret.
//
//   sqlOver(client)              the `sql` function over one connected pg client (each statement a named one, so the server refuses two commands in one text)
//   sayWithout(error, connection) a failure's text with the connection string and its password taken out
//   applySqlFiles(sql, files)    makes the tables: each file of sql/ is one statement, `create ... if not exists`, run in name order
//   identifier(name)             a table or column name from DATA, quoted so it can only ever be one name
//
// The files run inside one transaction under an advisory lock, so two firings that start together make each table once.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SQL_FOLDER = new URL('../sql/', import.meta.url);
const LOCK = 7_203_558_113; // one made-up number every workflows tool takes; the lock is held to the end of the transaction

export function identifier(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('A table or column name must be text.');
  return `"${name.replaceAll('"', '""')}"`;
}

// The statements of a folder of .sql files, in name order, each file one statement.
export function sqlFiles(folder = SQL_FOLDER) {
  const base = folder instanceof URL ? folder.pathname : folder;
  return readdirSync(base).filter(name => name.endsWith('.sql')).sort().map(name => ({ name, text: readFileSync(join(base, name), 'utf8').trim() }));
}

export async function applySqlFiles(sql, files = sqlFiles()) {
  await sql('begin');
  try {
    await sql('select pg_advisory_xact_lock($1)', [LOCK]);
    for (const file of files) await sql(file.text);
    await sql('commit');
  } catch (error) {
    await sql('rollback').catch(() => {});
    throw error;
  }
}

// The text of a failure with the connection string and its password taken out.
export function sayWithout(error, connection) {
  let said = String(error?.message ?? error);
  const parts = [connection];
  try { parts.push(decodeURIComponent(new URL(connection).password)); } catch { /* not a URL: only the whole text is removed */ }
  for (const part of parts) if (part) said = said.split(part).join('[held]');
  return said;
}

// A `sql` function over one connected client.
export function sqlOver(client) {
  let sent = 0;
  return async (statement, values = []) => (await client.query({ name: `statement_${sent += 1}`, text: statement, values })).rows;
}

// tools/run-sql-in-my-database/do-work/serve-a-read.ts
//
// The one main of every tool that answers a fixed read of a pursuit's database. A tool's file hands `serveARead` its reader
// (input, rows) and this runs it the way tool:read-my-newest-decisions does: the database label comes from the input, the
// engine mounts that database's held connection on descriptor 3 (and, under a declared use, the use ticket on descriptor 5),
// and every statement of the read shares one read-only transaction, claimed once under the use. The reader holds no login and
// no client: `rows(sql, params)` answers the rows' objects. Nothing here names a table, a column or a tool.
import { readFileSync } from 'node:fs';
import { sayWithout, withSqlRead } from './run-sql.mjs';

export type Rows = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
export type Reader<Input, Answer> = (input: Input, rows: Rows) => Promise<Answer>;
type Use = { purpose: string; surface: string };
type Given = { database?: unknown; use?: Use };

const STATEMENT_TIMEOUT_MS = 9000;
const RUN_CEILING_MS = 12000;

export async function readInDatabase<Input extends Given, Answer>(input: Input, reader: Reader<Input, Answer>, { connection, ticket = '', read = withSqlRead }: { connection: string; ticket?: string; read?: typeof withSqlRead }): Promise<Answer> {
  if (typeof input.database !== 'string' || input.database === '') throw new Error('Give database: the name of the pursuit database to read.');
  return read({ connection, ticket, use: input.use, statement_timeout_ms: STATEMENT_TIMEOUT_MS, ceilingMs: RUN_CEILING_MS },
    async (query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => reader(input, async (sql, params) => (await query(sql, params)).rows));
}

// The tool's row names its reader in argv: node <file> <reader name>.
export async function serveARead(readers: Record<string, Reader<any, unknown>>): Promise<void> {
  let connection = '', ticket = '';
  try {
    const reader = readers[process.argv[2] ?? ''];
    if (!reader) throw new Error(`No reader named ${process.argv[2]}; this file has: ${Object.keys(readers).join(', ')}.`);
    const input = JSON.parse(readFileSync(0, 'utf8')) as Given;
    connection = readFileSync(3, 'utf8').trim();
    // An unmounted descriptor may be Node's own queue: descriptor 5 is read only when the input makes the engine mount a ticket.
    if (input.use !== undefined && input.use !== null && typeof input.database === 'string') ticket = readFileSync(5, 'utf8').trim();
    console.log(JSON.stringify(await readInDatabase(input, reader, { connection, ticket })));
  } catch (error) {
    console.error(sayWithout(error, connection, ticket));
    process.exitCode = 1;
  }
}

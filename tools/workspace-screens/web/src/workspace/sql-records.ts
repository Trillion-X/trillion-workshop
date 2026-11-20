// src/workspace/sql-records.ts
//
// PURPOSE
//   The workspace's saved records as rows of one table in the person's own database, read and written in SQL. It is a
//   transport for remoteRecordsSource (records-source.ts): `read` answers the values held under labels, `write` confirms
//   one batch with each write's expectation checked by the database itself. The statement runner is given: the page's
//   runs one statement through the SQL tool with the person's own rights (account-workspace.ts), a test runs it on a real
//   server. The table is the workspace's own: made on its first write, never assumed by a read.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A value is kept as the JSON text it was written as, with the identity of that value (records-source.ts identityOf, the one records.ts identityOfValue gives), so a read
//      answers the same bytes and the same identity a write expected; the database reorders nothing.
//   2. A write's expectation is checked in the same statement that changes the row: an expected identity that no longer
//      holds changes nothing and is answered as a conflict with the value now held.
//   3. After a failed write the next one waits (retry.first_ms, doubled per failure up to retry.most_ms) before its first
//      statement, and a written batch ends the wait: a refusal puts the old value back and a screen writes again, so an
//      unreachable database is asked at a measured pace, never in a loop.
//   4. No table is a refusal for a read: nothing has been saved yet, so nothing is held. Once a read has found no table,
//      later reads answer nothing held without asking until this page makes the table or asks fresh (each statement is
//      a tool run, and a first open reads many labels).

import { identityOf, type RecordsConflict, type RecordsRead, type RecordsWriteBody, type RecordsWriteReply } from './records-source.ts';

export type RunStatement = (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;

const NO_TABLE = /relation .* does not exist|42P01/;

export type Retry = { first_ms: number; most_ms: number };

export function sqlRecordsTransport(run: RunStatement, table: string, retry: Retry) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error(`"${table}" is not a plain table name.`);
  let made: Promise<unknown> | null = null, noTable = false, failures = 0;
  const pace = () => failures ? new Promise(done => setTimeout(done, Math.min(retry.most_ms, retry.first_ms * 2 ** (failures - 1)))) : null;
  const make = () => made ??= run(`create table if not exists ${table} (label text primary key, value text not null, identity text not null, changed_at timestamptz not null default now())`, [])
    .then(done => { noTable = false; return done; }, error => { made = null; throw error; });
  const held = async (labels: readonly string[], fresh = false) => {
    if (!labels.length || (noTable && !fresh)) return new Map<string, unknown>();
    const rows = await run(`select label, value from ${table} where label = any($1::text[])`, [labels]).catch(error => {
      if (NO_TABLE.test(String(error?.message ?? error))) return (noTable = true, []);
      throw error;
    });
    return new Map(rows.map(row => [String(row.label), JSON.parse(String(row.value))]));
  };
  const writeOne = (label: string, payload: unknown, expected: string | null | undefined) => {
    const value = JSON.stringify(payload), identity = identityOf(payload);
    if (expected === undefined) return run(`insert into ${table} (label, value, identity) values ($1, $2, $3) on conflict (label) do update set value = excluded.value, identity = excluded.identity, changed_at = now() returning label`, [label, value, identity]);
    if (expected === null) return run(`insert into ${table} (label, value, identity) values ($1, $2, $3) on conflict (label) do nothing returning label`, [label, value, identity]);
    return run(`update ${table} set value = $2, identity = $3, changed_at = now() where label = $1 and identity = $4 returning label`, [label, value, identity, expected]);
  };
  return {
    async read(labels: readonly string[], options?: { fresh?: boolean }): Promise<RecordsRead> {
      return { records: Object.fromEntries(await held(labels, options?.fresh)) };
    },
    async write(body: RecordsWriteBody): Promise<RecordsWriteReply> {
      await pace();
      try {
        const reply = await writeBatch(body);
        failures = 0;
        return reply;
      } catch (error) {
        failures += 1;
        throw error;
      }
    },
  };
  async function writeBatch(body: RecordsWriteBody): Promise<RecordsWriteReply> {
    await make();
    const conflicts: RecordsConflict[] = [];
    let written = 0;
    for (const entry of body.writes) {
      if ((await writeOne(entry.address_label, entry.payload, entry.expected_identity)).length) { written += 1; continue; }
      const now = await held([entry.address_label], true);
      conflicts.push({ address: entry.address_label, current: now.has(entry.address_label) ? { found: true, value: now.get(entry.address_label) } : { found: false } });
    }
    return conflicts.length ? { written, conflicts } : { written };
  }
}

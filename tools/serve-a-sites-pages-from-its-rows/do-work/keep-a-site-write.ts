// tools/serve-a-sites-pages-from-its-rows/do-work/keep-a-site-write.ts
//
// PURPOSE
//   tool:keep-a-site-write: one of a site's named writes (read-data/site-writes.json: a lead, a visit, a price view, a welcome
//   stop) with the values a site's action row gives, as one fixed statement. The input is { database, use, write, values } on
//   standard input; the engine mounts the database's writer login on descriptor 3 (the row's credential item binds the use with
//   held_suffix -writer-connection) and the use ticket on descriptor 5. The answer is { write, row_count, rows }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The caller names a write and gives values; the statement is the write's own, from site-writes.json. No SQL is taken from the
//      input, and a value goes into the statement only as a parameter.
//   2. A value the write does not take, a required value not given, a text past its most, or a list past its count is refused
//      before anything is sent.
//   3. A json value (a tool's answer the row hands on, such as a course stop's keep) goes in as its JSON text, so the statement
//      reads it with $n::jsonb; it is refused past `most` bytes of that text.
//   4. The statement runs in one transaction that claims the use first (run-sql.mjs withSqlWrite), as the writer login, whose
//      grants (role recipe may-write-named-columns-under-a-use) are the only rights it has.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sayWithout, withSqlWrite } from '../../run-sql-in-my-database/do-work/run-sql.mjs';

type Value = { name: string; type: 'text' | 'texts' | 'json'; most: number; required?: boolean };
type Write = { sql: string; values: Value[] };
type Asked = { database?: unknown; use?: unknown; write?: unknown; values?: unknown };
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; row_count: number }>;

const WRITES: Record<string, Write> = JSON.parse(readFileSync(new URL('../read-data/site-writes.json', import.meta.url), 'utf8')).writes;

/** The named write and its parameters, in order, from the values given; refused in words when the request is not one it takes. */
export function statementOf(asked: Asked, writes: Record<string, Write> = WRITES): { name: string; sql: string; params: unknown[] } {
  const name = asked.write;
  if (typeof name !== 'string' || !Object.hasOwn(writes, name)) throw new Error(`write must be one of ${Object.keys(writes).join(', ')}.`);
  const given = asked.values ?? {};
  if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new Error('values must be an object of the write\'s value names.');
  const { sql, values } = writes[name];
  const unknown = Object.keys(given).filter(key => !values.some(value => value.name === key));
  if (unknown.length) throw new Error(`The ${name} write takes no ${unknown.join(', ')}; it takes ${values.map(value => value.name).join(', ')}.`);
  const params = values.map(({ name: key, type, most, required }) => {
    const value = (given as Record<string, unknown>)[key];
    if (value === undefined || value === null) {
      if (required) throw new Error(`The ${name} write needs ${key}.`);
      return null;
    }
    if (type === 'text') {
      if (typeof value !== 'string' || value.length > most) throw new Error(`${key} must be text of at most ${most} characters.`);
      return value;
    }
    if (type === 'json') {
      const text = JSON.stringify(value);
      if (typeof value !== 'object' || Buffer.byteLength(text) > most) throw new Error(`${key} must be a JSON list or object of at most ${most} bytes.`);
      return text;
    }
    if (!Array.isArray(value) || value.length > most || value.some(each => typeof each !== 'string' || each.length > 400)) throw new Error(`${key} must be a list of at most ${most} texts.`);
    return value;
  });
  return { name, sql, params };
}

/** Runs the named write on the step's one claimed transaction and answers what the statement answered. */
export async function keepASiteWrite(asked: Asked, query: Query) {
  const { name, sql, params } = statementOf(asked);
  const answer = await query(sql, params);
  return { write: name, row_count: answer.row_count, rows: answer.rows };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let connection = '', ticket = '';
  try {
    const asked: Asked = JSON.parse(readFileSync(0, 'utf8'));
    statementOf(asked);
    connection = readFileSync(3, 'utf8').trim();
    // An unmounted descriptor may be Node's own queue: descriptor 5 is read only when the input makes the engine mount a ticket.
    if (asked.use !== undefined && asked.use !== null && typeof asked.database === 'string') ticket = readFileSync(5, 'utf8').trim();
    const answer = await withSqlWrite({ connection, ticket, use: asked.use ?? undefined }, query => keepASiteWrite(asked, query as Query));
    console.log(JSON.stringify(answer));
  } catch (error) {
    console.error(sayWithout(error, connection, ticket));
    process.exitCode = 1;
  }
}

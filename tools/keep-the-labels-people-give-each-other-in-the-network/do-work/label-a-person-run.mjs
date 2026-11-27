// tools/keep-the-labels-people-give-each-other-in-the-network/do-work/label-a-person-run.mjs
//
// The container command of `tool:label-a-person` (what-this-tool-does-and-how-to-run-it.json): one label, written in the person's own Postgres database
// named in the input, through the mounted connection the run hands on descriptor 3 (the row's invoke.key:
// the vault name `<database>-connection`). The connection string is never in the request, argv, a file or an answer.
// The label itself is do-work/label-a-person.mjs; this file only opens the connection and answers { result } or { error }.
import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import pg from 'pg';
import { labelAPerson } from './label-a-person.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;

// The label module writes `?` placeholders; Postgres takes `$1, $2 ...`. Each statement gets a named prepared statement.
let named = 0;
const postgres = client => async (sql, ...values) => {
  let index = 0;
  const statement = sql.replace(/\?/g, () => `$${index += 1}`);
  const result = await client.query({ name: `label_a_person_${named += 1}`, text: statement, values });
  return result.rows ?? [];
};

const input = JSON.parse((await text(process.stdin)) || '{}');
const { database, ...label } = input;
const proxy = process.env.HTTPS_PROXY;
const client = new pg.Client({ connectionString: readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim(), ...(proxy ? { stream: throughProxy(proxy) } : {}) });
try {
  if (typeof database !== 'string' || !database) throw Object.assign(new Error('Name the database the label is written in.'), { status: 400 });
  await client.connect();
  const result = await labelAPerson({ db: { exec: postgres(client) }, input: label });
  console.log(JSON.stringify({ result: { ...result, database } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, status: error.status ?? 500 }));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

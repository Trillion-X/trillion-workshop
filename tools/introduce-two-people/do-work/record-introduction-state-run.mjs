// tools/introduce-two-people/do-work/record-introduction-state-run.mjs
//
// The container command of `tool:record-an-introduction-state` (what-this-tool-does-and-how-to-run-it.json): one introduction state, recorded in the
// person's own Postgres database named in the input (records only: it sends nothing and sets no route, wake or notice), through the mounted connection the run hands on descriptor 3 (the row's invoke.key:
// the vault name `<database>-connection`). The connection string is never in the request, argv, a file or an answer.
// The state move is do-work/record-introduction-state.mjs; this file only opens the connection and answers { result } or { error }.
import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import pg from 'pg';
import { recordIntroductionState } from './record-introduction-state.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;

// The state module writes `?` placeholders; Postgres takes `$1, $2 ...`. Each statement gets a named prepared statement.
let named = 0;
const postgres = client => async (sql, ...values) => {
  let index = 0;
  const statement = sql.replace(/\?/g, () => `$${index += 1}`);
  const result = await client.query({ name: `record_state_${named += 1}`, text: statement, values });
  return result.rows ?? [];
};

const input = JSON.parse((await text(process.stdin)) || '{}');
const { database, ...move } = input;
const proxy = process.env.HTTPS_PROXY;
const client = new pg.Client({ connectionString: readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim(), ...(proxy ? { stream: throughProxy(proxy) } : {}) });
try {
  if (typeof database !== 'string' || !database) throw Object.assign(new Error('Name the database the introduction state is recorded in.'), { status: 400 });
  await client.connect();
  const result = await recordIntroductionState({ db: { exec: postgres(client) }, input: move });
  console.log(JSON.stringify({ result: { ...result, database } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, status: error.status ?? 500 }));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

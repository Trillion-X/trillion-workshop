// tools/network-people/do-work/network-profile-sql.mjs
//
// The one process the Network rows run (tools/network-people/tool-rows.json): the action is the first argument, the request is one
// JSON object on standard input, and the answer is one JSON line. The rows are kept in a `network_records` table of the database the
// caller names (`database`, or `credential_name`): the person's own pursuit database for their profile, and the database the search
// reads for the listings. The connection string is a held value the engine hands this process on descriptor 3 (the row's
// invoke.credential_mounts); it is never in the request, argv, a file or the environment. The table is made when it is missing
// (CREATE TABLE IF NOT EXISTS, as tool:sales-contracts does). Each statement goes through run-sql's own proxy.
import { readFileSync } from 'node:fs';
import { findNetworkPeople, networkProfile, onMyPath, readNetworkContact } from './network-people.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

export const RECORD_TABLE = 'network_records';
const CONNECTION_DESCRIPTOR = 3;
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${RECORD_TABLE} (
  id text PRIMARY KEY,
  type text NOT NULL,
  value jsonb NOT NULL
)`;
const WANTED = ['record:network-profile', 'record:network-label', 'record:network-introduction'];
const FUNCTIONS = { networkProfile, findNetworkPeople, onMyPath, readNetworkContact };

/** One action over the rows of `client` ({ query(text, values) → { rows, rowCount } }): the rows the function needs are read, the
 * function answers, and a row it changes is written with the value it expected, so a row that moved since it was read is refused. */
export async function runNetworkAction(action, input, client) {
  const run = FUNCTIONS[action];
  if (!run) throw new Error(`Say which: ${Object.keys(FUNCTIONS).join(', ')}.`);
  const asked = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  await client.query(TABLE_SQL, []);
  const { rows } = await client.query(`SELECT id, type, value FROM ${RECORD_TABLE} WHERE type = ANY($1)`, [WANTED]);
  const answer = run({ ...asked, records: rows });
  for (const row of answer.keep ?? []) {
    if (row.expected) {
      const { rowCount } = await client.query(`UPDATE ${RECORD_TABLE} SET value = $2::jsonb WHERE id = $1 AND value = $3::jsonb`, [row.id, JSON.stringify(row.value), JSON.stringify(row.expected.value)]);
      if (rowCount !== 1) throw new Error('This row changed since it was read; ask again.');
    } else {
      const { rowCount } = await client.query(`INSERT INTO ${RECORD_TABLE} (id, type, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING`, [row.id, row.type, JSON.stringify(row.value)]);
      if (rowCount !== 1) throw new Error('This row was made since it was read; ask again.');
    }
  }
  const { keep, ...shown } = answer;
  return { ...shown, ...(keep ? { stored: keep.length } : {}) };
}

/** The process entry: `node network-profile-sql.mjs <action>` with one JSON request on standard input. */
export async function main(argv = process.argv, stdin = 0) {
  const { default: pg } = await import('pg');
  const request = JSON.parse(readFileSync(stdin, 'utf8') || '{}');
  const connection = readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim();
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    return { result: await runNetworkAction(argv[2], request, client) };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(answer => console.log(JSON.stringify(answer))).catch(error => {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}

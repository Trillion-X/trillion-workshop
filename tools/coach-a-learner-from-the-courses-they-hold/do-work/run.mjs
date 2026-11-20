// tools/coach-a-learner-from-the-courses-they-hold/do-work/run.mjs
//
// The container process the three rows run: `node run.mjs <operation>`, the request as JSON on stdin. It opens the three held
// connections on the descriptors HELD_CONNECTIONS fixes (3 sign-ins, 4 access, 5 lessons; each row mounts them under the names
// given there), reads the school's settings from the access database's coach_settings row, applies the statement time limit those
// settings give, answers the operation as one line of JSON on stdout, and on a refusal or a failure writes plain words to stderr
// and exits 1. A connection string and its password are taken out of every message before it is written.
import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import pg from 'pg';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';
import { answer, CoachRefusal, HELD_CONNECTIONS, settingsOf } from './coach.mjs';

// The access database's table of the school's coach settings: one row, id 'coach', settings as jsonb.
const SETTINGS_TABLE = 'coach_settings';

const operation = process.argv[2];
const secrets = [];
const clients = {};

/** The connection string on a descriptor the row mounted, and its password, kept only to be taken out of messages. */
function heldConnection(fd) {
  let connection;
  try {
    connection = readFileSync(fd, 'utf8').trim();
  } catch {
    throw new CoachRefusal('The school database connection is not held for this run.');
  }
  secrets.push(connection);
  try {
    secrets.push(decodeURIComponent(new URL(connection).password));
  } catch {
    // Not a URL: the connection text alone is taken out.
  }
  return connection;
}

/** The message with every held secret taken out. */
function sayWithout(error) {
  const message = error instanceof CoachRefusal ? error.message : `The coach could not answer: ${error?.message ?? error}`;
  return secrets.filter(Boolean).reduce((said, secret) => said.split(secret).join('[held]'), message);
}

try {
  const request = JSON.parse((await text(process.stdin)) || '{}');
  const proxy = process.env.HTTPS_PROXY;
  for (const [name, { fd }] of Object.entries(HELD_CONNECTIONS)) {
    const client = new pg.Client({ connectionString: heldConnection(fd), ...(proxy ? { stream: throughProxy(proxy) } : {}) });
    clients[name] = client;
    await client.connect();
  }
  const dbs = Object.fromEntries(Object.entries(clients).map(([name, client]) => [name, { query: async (sql, params) => (await client.query(sql, params)).rows }]));
  const settings = await settingsOf(dbs.runs, SETTINGS_TABLE);
  for (const client of Object.values(clients)) await client.query("select set_config('statement_timeout', $1, false)", [String(settings.statement_timeout_ms)]);
  console.log(JSON.stringify(await answer(operation, request, dbs, settings)));
} catch (error) {
  console.error(sayWithout(error));
  process.exitCode = 1;
} finally {
  await Promise.all(Object.values(clients).map(client => client.end().catch(() => {})));
}

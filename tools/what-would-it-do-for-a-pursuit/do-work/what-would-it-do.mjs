import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/what-would-it-do-for-a-pursuit/do-work/what-would-it-do.mjs
//
// tool:what-would-it-do: what the platform would do for a pursuit, one container process. The caller hands in the pursuit's words,
// the pursuit's vector (from its own embedding), the moves table, the rows and the recordings; this process checks the words, picks
// the closest tools and workflows (read-data/closest-tools.mjs), and keeps the answer for one day in the person's own database,
// in this tool's table pursuit_answers, when a database is named. The connection is a held value the engine hands this process
// on descriptor 3, named by `database`; it is never in the request, argv, a file or the environment.
import { readFileSync } from 'node:fs';
import { answerFromMoves, pursuitWords } from '../read-data/closest-tools.mjs';
import { pursuitAnswerKey } from '../read-data/pursuit-answer-key.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;
const KEEP_SECONDS = 86400;

const CREATE = `CREATE TABLE IF NOT EXISTS pursuit_answers (
  key TEXT PRIMARY KEY, person TEXT NOT NULL, pursuit TEXT NOT NULL, answer JSONB NOT NULL,
  kept_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL)`;

/** The answer for one pursuit, kept in `client`'s pursuit_answers when the person is given; a kept, unexpired answer is returned as it was. */
export async function whatWouldItDo(request, client, { now = () => new Date() } = {}) {
  const pursuit = pursuitWords(request.pursuit);
  const recordings = Array.isArray(request.recordings) ? request.recordings : [];
  const key = pursuitAnswerKey(pursuit, recordings);
  const person = typeof request.person === 'string' ? request.person.trim() : '';
  if (client && person) {
    await client.query(CREATE, []);
    const { rows } = await client.query('SELECT answer FROM pursuit_answers WHERE key = $1 AND expires_at > $2', [key, now()]);
    if (rows.length) return { ...rows[0].answer, kept: true };
  }
  const rows = Array.isArray(request.rows) ? request.rows : [];
  const rowsById = new Map(rows.map(row => [row.id, row]));
  const moves = { ...request.moves, vectors: Float64Array.from(request.moves?.vectors ?? []) };
  const chosen = answerFromMoves(moves, request.pursuit_vector, rowsById, recordings);
  const answer = { pursuit, ...chosen, ...(chosen.first_moves.length + chosen.workflows.length + chosen.tools.length + chosen.screens.length ? {} : { note: 'Nothing in the Marketplace is close to this yet.' }) };
  if (client && person) {
    const kept = new Date(now().getTime() + KEEP_SECONDS * 1000);
    await client.query(
      `INSERT INTO pursuit_answers (key, person, pursuit, answer, kept_at, expires_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (key) DO UPDATE SET answer = EXCLUDED.answer, kept_at = EXCLUDED.kept_at, expires_at = EXCLUDED.expires_at`,
      [key, person, pursuit, JSON.stringify(answer), now(), kept]);
  }
  return { ...answer, kept: false };
}

/** The process entry: one JSON request on stdin; the connection on descriptor 3 only when `database` is named. */
export async function main() {
  const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (!request.database) return { result: await whatWouldItDo(request, null) };
  const { default: pg } = await import('pg');
  const connection = readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim();
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    await client.query('BEGIN', []);
    const result = await whatWouldItDo(request, client);
    await client.query('COMMIT', []);
    return { result };
  } catch (error) {
    await client.query('ROLLBACK', []);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().then(answer => console.log(JSON.stringify(answer))).catch(error => {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}

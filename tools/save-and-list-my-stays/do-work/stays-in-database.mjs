import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/save-and-list-my-stays/do-work/stays-in-database.mjs
//
// tool:save-a-stay and tool:list-my-stays, one container process each (tool-rows.json): a person's own stays, kept in the pursuit
// database the request names (`database`), in this tool's own table `stays`. The person is the one the request names; a stay that
// is not theirs is refused. Ported from the old Network's saveStay and the own-stays half of staysOf (src/network-stays.mjs at
// b6ae0ebf815f). The connection string is a held value the engine hands this process on descriptor 3, named by `database`; it
// is never in the request, argv, a file or the environment.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { STAY_RULES } from '../read-data/stay-rules.mjs';
import { stayValues, visible } from '../read-data/stays.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;
const LIST_LIMIT = 100;

export class StayError extends Error {}

const CREATE = `CREATE TABLE IF NOT EXISTS stays (
  id TEXT PRIMARY KEY, person TEXT NOT NULL, title TEXT NOT NULL, where_text TEXT NOT NULL, about TEXT NOT NULL,
  when_text TEXT NOT NULL, price_kind TEXT NOT NULL, amount_cents INTEGER, currency TEXT, active BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;

const newId = () => `stay_${randomBytes(12).toString('hex')}`;

/** Saves one stay for the person (a new one, or the one stay_id names when it is theirs). Refused past the active limit. */
export async function saveStay(request, client, rules = STAY_RULES) {
  const person = String(request.person ?? '').trim();
  if (!person) throw new StayError('Give person, the person whose stay this is.');
  const values = stayValues(request, rules);
  await client.query(CREATE, []);
  const id = typeof request.stay_id === 'string' && request.stay_id.trim() ? request.stay_id.trim() : newId();
  const { rows: before } = await client.query('SELECT person, active FROM stays WHERE id = $1', [id]);
  if (before.length && before[0].person !== person) throw new StayError('This stay is not yours.');
  const wasActive = before.length ? before[0].active === true : false;
  if (values.active && !wasActive) {
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM stays WHERE person = $1 AND active = true', [person]);
    if (rows[0].n >= rules.per_host) throw new StayError(`You can show up to ${rules.per_host} stays.`);
  }
  const { rows } = await client.query(
    `INSERT INTO stays (id, person, title, where_text, about, when_text, price_kind, amount_cents, currency, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, where_text = EXCLUDED.where_text, about = EXCLUDED.about,
       when_text = EXCLUDED.when_text, price_kind = EXCLUDED.price_kind, amount_cents = EXCLUDED.amount_cents,
       currency = EXCLUDED.currency, active = EXCLUDED.active, updated_at = now()
     RETURNING *`,
    [id, person, values.title, values.where_text, values.about, values.when_text, values.price_kind, values.amount_cents, values.currency, values.active]);
  return { stay: visible(rows[0]) };
}

/** The person's own stays, inactive ones included, newest first. */
export async function listMyStays(request, client) {
  const person = String(request.person ?? '').trim();
  if (!person) throw new StayError('Give person, the person whose stays these are.');
  await client.query(CREATE, []);
  const { rows } = await client.query('SELECT * FROM stays WHERE person = $1 ORDER BY updated_at DESC LIMIT $2', [person, LIST_LIMIT]);
  return { stays: rows.map(visible) };
}

/** The process entry: the action is the argument (save or list); one JSON request on stdin, the connection on descriptor 3. */
export async function main(action = process.argv[2]) {
  const { default: pg } = await import('pg');
  const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const connection = readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim();
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    await client.query('BEGIN', []);
    const result = action === 'save' ? await saveStay(request, client) : await listMyStays(request, client);
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

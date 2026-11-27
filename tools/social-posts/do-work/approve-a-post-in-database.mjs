import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/social-posts/do-work/approve-a-post-in-database.mjs
//
// tool:approve-a-post, one container process (what-this-tool-does-and-how-to-run-it.json): approves a drafted post exactly as reviewed, reading the post and
// the person's approval setting from the pursuit database the request names (`database`), never from records the caller hands in.
// So a caller can never carry an `auto` setting in: any `records`, `by_person` or `approval-setting` the request holds is ignored.
// Each answer, approved or refused, is kept in the same database: the post's new state and one approval-decision row.
//
// The connection string is a held value the engine hands this process on descriptor 3 (the row's invoke.key), named
// by the request's `database`; it is never in the request, argv, a file or the environment. The gate is approveAPost (read-data/posts.mjs),
// unchanged: this file only reads the records it judges and writes back what it keeps.
import { readFileSync } from 'node:fs';
import { approveAPost } from '../read-data/posts.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;
const SCOPE = 'reaching-posts';
const SETTING_TYPE = 'approval-setting';
const DECISION_TYPE = 'approval-decision';

export class ApproveInDatabaseError extends Error {}

/** The approval in one database: { post_id, expected_values, approved_by, database } in, { result } out. The client is a pg client
 *  (or any object with query(text, values) → { rows }). */
export async function approveInDatabase(request, client, { now = () => new Date() } = {}) {
  const asked = request !== null && typeof request === 'object' && !Array.isArray(request) ? request : {};
  const postId = typeof asked.post_id === 'string' ? asked.post_id.trim() : '';
  if (!postId) throw new ApproveInDatabaseError('Give post_id, the post to approve.');
  const { rows: postRows } = await client.query('SELECT post_id, person, value FROM post WHERE post_id = $1', [postId]);
  if (!postRows.length) throw new ApproveInDatabaseError(`There is no post ${postId} in this database.`);
  const person = postRows[0].person;
  // The setting is read for the post's own person, from this database. A person with no row gets no setting record: ask.
  const { rows: settingRows } = await client.query('SELECT mode FROM approval_setting WHERE person = $1 AND scope = $2', [person, SCOPE]);
  const records = [
    { id: postId, type: 'post', value: postRows[0].value },
    ...(settingRows.length ? [{ id: `${SETTING_TYPE}:${SCOPE}`, type: SETTING_TYPE, value: { mode: settingRows[0].mode } }] : []),
  ];
  // by_person is never read from the request: only the host's page can set it, and this process is not that page.
  const answer = await approveAPost({ post_id: postId, expected_values: asked.expected_values, approved_by: asked.approved_by, records }, { now });
  const kept = answer.keep ?? [];
  await client.query('BEGIN', []);
  try {
    for (const row of kept) {
      if (row.type === 'post') {
        await client.query('UPDATE post SET value = $2::jsonb, status = $3, updated_at = now() WHERE post_id = $1', [row.id, JSON.stringify(row.value), row.value.status]);
      } else if (row.type === DECISION_TYPE) {
        const d = row.value;
        await client.query(
          `INSERT INTO approval_decision (id, post_id, person, at, decision, approved_how, setting_id, mode, reason, approved_by)
           VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
          [row.id, d.post_id, person, d.at, d.decision, d.approved_how ?? null, d.setting_id ?? null, d.mode ?? null, d.reason ?? null, d.approved_by ?? null]);
      }
    }
    await client.query('COMMIT', []);
  } catch (error) {
    await client.query('ROLLBACK', []);
    throw error;
  }
  const decisions = kept.filter(row => row.type === DECISION_TYPE).map(row => row.id);
  const { keep, ...shown } = answer;
  return { ...shown, database_decisions: decisions };
}

/** The process entry: one JSON request on stdin, the connection on descriptor 3, one JSON answer on stdout. Without `database`
 *  the request is answered from the records it carries, as before (no connection is opened): old callers keep working until
 *  every caller names a database. */
export async function main() {
  const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (!request?.database) return { result: await approveAPost(request, { now: () => new Date() }) };
  const { default: pg } = await import('pg');
  const connection = readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim();
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    return { result: await approveInDatabase(request, client) };
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

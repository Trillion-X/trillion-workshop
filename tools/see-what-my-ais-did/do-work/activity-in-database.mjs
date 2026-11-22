import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/see-what-my-ais-did/do-work/activity-in-database.mjs
//
// tool:keep-an-ai-activity-row and tool:read-ai-activity, one container process each (tool-rows.json): a person's AI activity
// kept in the pursuit database the request names (`database`), in the tables this tool makes there: activity_g<n>,
// activity_links_g<n> and activity_counts_g<n>, with the views activity and activity_links over the newest two generations
// (the layout of tools/shared-code/src/activity.mjs). The tables are made by this tool the first time it runs in that database
// (CREATE TABLE IF NOT EXISTS); nothing here names a database. The connection string is a held value the engine hands this
// process on descriptor 3, named by `database`; it is never in the request, argv, a file or the environment.
import { readFileSync } from 'node:fs';
import { keepRow, listRows, traceItem, openActivity } from '../read-data/activity-generations.mjs';
import { rowFromCall } from './activity-row-from-a-call.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;
const LOCK_KEY = 'activity-record';

const ids = (generation, name) => `${name}_g${generation}`;
const visible = generations => generations.slice(-2);

/** The Postgres store: each method is one statement (or a short run of them) over the generation tables named by number. */
export function postgresActivityStore(client) {
  const union = (generations, select) => generations.map(select).join(' UNION ALL ');
  return {
    async generations() {
      const { rows } = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name ~ '^activity_g[0-9]+$'", []);
      return rows.map(row => Number(row.table_name.slice('activity_g'.length))).sort((a, b) => a - b);
    },
    async createGeneration(n) {
      await client.query(`CREATE TABLE IF NOT EXISTS ${ids(n, 'activity')} (seq BIGINT PRIMARY KEY, at TEXT NOT NULL, app TEXT, row TEXT NOT NULL, ok INTEGER)`, []);
      await client.query(`CREATE INDEX IF NOT EXISTS ${ids(n, 'activity')}_by_ok ON ${ids(n, 'activity')} (ok, seq)`, []);
      await client.query(`CREATE TABLE IF NOT EXISTS ${ids(n, 'activity_links')} (seq BIGINT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL)`, []);
      await client.query(`CREATE INDEX IF NOT EXISTS ${ids(n, 'activity_links')}_by_id ON ${ids(n, 'activity_links')} (id, role)`, []);
      await client.query(`CREATE INDEX IF NOT EXISTS ${ids(n, 'activity_links')}_by_seq ON ${ids(n, 'activity_links')} (seq)`, []);
      await client.query(`CREATE TABLE IF NOT EXISTS ${ids(n, 'activity_counts')} (id TEXT PRIMARY KEY, n INTEGER NOT NULL)`, []);
    },
    async refreshViews(generations) {
      await client.query(`CREATE OR REPLACE VIEW activity AS ${union(generations, n => `SELECT seq, at, app, row, ok FROM ${ids(n, 'activity')}`)}`, []);
      await client.query(`CREATE OR REPLACE VIEW activity_links AS ${union(generations, n => `SELECT seq, id, role FROM ${ids(n, 'activity_links')}`)}`, []);
    },
    async roll(previous, next) {
      await this.createGeneration(next);
      await this.refreshViews([previous, next]);
      for (const old of (await this.generations()).filter(n => n < previous)) {
        await client.query(`DROP TABLE IF EXISTS ${ids(old, 'activity_links')}`, []);
        await client.query(`DROP TABLE IF EXISTS ${ids(old, 'activity_counts')}`, []);
        await client.query(`DROP TABLE IF EXISTS ${ids(old, 'activity')}`, []);
      }
    },
    async count(n) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${ids(n, 'activity')}`, []);
      return rows[0].n;
    },
    async maxSeq() {
      let newest = 0;
      for (const n of visible(await this.generations())) {
        const { rows } = await client.query(`SELECT COALESCE(MAX(seq), 0)::bigint AS s FROM ${ids(n, 'activity')}`, []);
        newest = Math.max(newest, Number(rows[0].s));
      }
      return newest;
    },
    async insertRow(n, { seq, at, app, row, ok }) {
      await client.query(`INSERT INTO ${ids(n, 'activity')} (seq, at, app, row, ok) VALUES ($1, $2, $3, $4, $5)`, [seq, at, app, JSON.stringify(row), ok]);
    },
    async insertLinks(n, seq, links) {
      for (const { id, role } of links) {
        await client.query(`INSERT INTO ${ids(n, 'activity_links')} (seq, id, role) VALUES ($1, $2, $3)`, [seq, id, role]);
      }
    },
    async bumpCounts(n, idList) {
      for (const id of idList) {
        await client.query(`INSERT INTO ${ids(n, 'activity_counts')} (id, n) VALUES ($1, 1) ON CONFLICT (id) DO UPDATE SET n = ${ids(n, 'activity_counts')}.n + 1`, [id]);
      }
    },
    async list({ before, app, failed, forIds, limit }) {
      const clauses = [];
      const params = [];
      if (before !== null) { params.push(before); clauses.push(`seq < $${params.length}`); }
      if (app !== null) { params.push(app); clauses.push(`app = $${params.length}`); }
      if (failed) clauses.push('ok = 0');
      if (forIds.length) { params.push(forIds); clauses.push(`seq IN (SELECT seq FROM activity_links WHERE role = 'for' AND id = ANY($${params.length}))`); }
      params.push(limit);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await client.query(`SELECT seq, row FROM activity ${where} ORDER BY seq DESC LIMIT $${params.length}`, params);
      return rows.map(row => ({ seq: Number(row.seq), row: JSON.parse(row.row) }));
    },
    async links({ id, roles, newest, limit }) {
      const { rows } = await client.query(
        `SELECT seq, role FROM activity_links WHERE id = $1 AND role = ANY($2) ORDER BY seq ${newest ? 'DESC' : 'ASC'} LIMIT $3`, [id, roles, limit]);
      return rows.map(row => ({ seq: Number(row.seq), role: row.role }));
    },
    async rowsBySeq(seqs) {
      if (!seqs.length) return new Map();
      const { rows } = await client.query('SELECT seq, row FROM activity WHERE seq = ANY($1)', [seqs]);
      return new Map(rows.map(row => [Number(row.seq), JSON.parse(row.row)]));
    },
  };
}

/** Keeps what one request hands in: a finished row (`row`), or one raw tool call (`call`, with the person's `access`) that the marks turn into a row. */
export async function keepOne(store, request) {
  if (request.call !== undefined) {
    const { row, left } = rowFromCall(request.call, request.access ?? []);
    if (!row) return { kept: false, left };
    return { kept: true, ...(await keepRow(store, row)) };
  }
  return keepRow(store, request.row);
}

/** The process entry: the action is the argument (keep or read); one JSON request on stdin, the connection on descriptor 3. */
export async function main(action = process.argv[2]) {
  const { default: pg } = await import('pg');
  const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const connection = readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim();
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    await client.query('BEGIN', []);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
    const store = postgresActivityStore(client);
    await openActivity(store);
    let result;
    if (action === 'keep') result = await keepOne(store, request);
    else if (typeof request.item === 'string' && request.item.trim()) result = await traceItem(store, { item: request.item, depth: request.depth });
    else result = await listRows(store, request);
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

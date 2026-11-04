// src/agent-work-queue.mjs
//
// PURPOSE
//   An agent asks the account for its next job without naming one (POST /handoffs/take with only agent_id), and the
//   account's own records answer it; but a handoff made for a case or another piece of work is kept in that work's own
//   resource (`work:…`). This is the queue that joins them: each work resource tells the account's own records which
//   of its jobs wait for which agent, and a take by agent reads the oldest one it may take now from there, then takes
//   it where it is kept (src/native-own-consumer-context.mjs). A take reads only the rows it offers, however many jobs
//   the account has handed in however many work resources.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A work resource's queue fact for a job changes in the same transaction as the job (outbox.note inside its
//      handoff write), so a job written is never left out of the queue and a finished one never stays offered, whatever
//      reply is lost: an outbox row stays until the account's own records have applied it.
//   2. Applying is idempotent and keyed by handoff_id: the same row applied twice is one row, and a newer fact for a job
//      replaces the one before (an outbox row is taken away only when it is still the one delivered).
//   3. A fact is sent only when it changed (the last one sent is kept beside it, for open work only), so a write that
//      does not move a job in the queue costs one point read.
//   4. The queue is never the job: a job read from it is taken where it is kept, which checks it again; one that is not
//      there to take any more is dropped from the queue by the take that met it.
//
//   agentWorkOutbox(sql, { now }) → in a work resource
//     note(item)                      in the job write's transaction: queue the change of its fact (queueFactsOf)
//     pending(limit) → [{ handoff_id, seq, facts | null, created_at }]
//     delivered(rows)                 takes away the rows still as they were sent
//     nextAt() → epoch ms | null      now, while anything waits to be sent
//     backfillAt(), backfillStep(openHandoffs)  the jobs held open before the queue, noted a page at a time
//   agentWorkIndex(sql) → in the account's own records
//     apply(work, rows)               upserts each row with facts, deletes each without
//     next({ agent_id, now, limit }) → [{ handoff_id, work, agent_id, available_at, created_at }]
//                                     the agent's own jobs and the jobs for any agent it may take now, oldest first
//     taking(request_key) → { work, handoff_id } | null; keepTaking({ request_key, work, handoff_id }, at)
//                                     the job a take chose, kept for a day for that take sent again
import { queueFactsOf } from '../../shared-code/src/agents.mjs';

const OUTBOX = 'agent_work_outbox', SENT = 'agent_work_sent', BACKFILL = 'agent_work_backfill', INDEX = 'own_agent_work', TAKING = 'own_agent_work_taking';
// How long the job a take chose is kept under its request_key, for that take sent again after a lost answer.
const TAKING_KEPT_MS = 24 * 3_600_000;
const MOST = 64;
const text = (value, most = 512) => typeof value === 'string' && value.length > 0 && value.length <= most;

export function agentWorkOutbox(sql, { now = () => new Date() } = {}) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${SENT} (handoff_id TEXT PRIMARY KEY, facts TEXT) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${OUTBOX} (handoff_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, facts TEXT, created_at TEXT NOT NULL) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${BACKFILL} (id INTEGER PRIMARY KEY CHECK (id = 1), after TEXT, done INTEGER NOT NULL)`);
  const backfill = () => sql.exec(`SELECT after, done FROM ${BACKFILL} WHERE id = 1`).toArray()[0] ?? null;
  return {
    note(item) {
      const facts = queueFactsOf(item);
      const value = facts ? JSON.stringify(facts) : null;
      const sent = sql.exec(`SELECT facts FROM ${SENT} WHERE handoff_id = ?`, item.handoff_id).toArray()[0];
      // A job never queued that no take offers has nothing to send; one whose fact is unchanged neither.
      if (sent ? sent.facts === value : value === null) return false;
      // A job no take offers any more keeps nothing here once its removal is queued, so this grows with open work only.
      if (value === null) sql.exec(`DELETE FROM ${SENT} WHERE handoff_id = ?`, item.handoff_id);
      else sql.exec(`INSERT INTO ${SENT} (handoff_id, facts) VALUES (?, ?) ON CONFLICT (handoff_id) DO UPDATE SET facts = excluded.facts`, item.handoff_id, value);
      sql.exec(`INSERT INTO ${OUTBOX} (handoff_id, seq, facts, created_at) VALUES (?, 1, ?, ?)
        ON CONFLICT (handoff_id) DO UPDATE SET seq = seq + 1, facts = excluded.facts`, item.handoff_id, value, item.handed_at ?? now().toISOString());
      return true;
    },
    pending(limit = MOST) {
      return sql.exec(`SELECT handoff_id, seq, facts, created_at FROM ${OUTBOX} ORDER BY handoff_id LIMIT ?`, Math.min(limit, MOST)).toArray()
        .map(row => ({ handoff_id: row.handoff_id, seq: row.seq, facts: row.facts === null ? null : JSON.parse(row.facts), created_at: row.created_at }));
    },
    delivered(rows) {
      for (const row of rows) sql.exec(`DELETE FROM ${OUTBOX} WHERE handoff_id = ? AND seq = ?`, row.handoff_id, row.seq);
    },
    nextAt: () => (sql.exec(`SELECT 1 FROM ${OUTBOX} LIMIT 1`).toArray().length ? now().getTime() : null),
    // The jobs this resource held open before it queued them: a page of them at a time, from where the last page ended.
    backfillAt: () => (backfill()?.done ? null : now().getTime()),
    backfillStep(openHandoffs) {
      const after = backfill()?.after ?? null;
      const page = openHandoffs({ after, limit: MOST });
      for (const item of page) this.note(item);
      sql.exec(`INSERT INTO ${BACKFILL} (id, after, done) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET after = excluded.after, done = excluded.done`,
        page.at(-1)?.handoff_id ?? after, page.length < MOST ? 1 : 0);
      return page.length;
    },
  };
}

export function agentWorkIndex(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${INDEX} (handoff_id TEXT PRIMARY KEY, work TEXT NOT NULL, agent_id TEXT NOT NULL, available_at TEXT NOT NULL, created_at TEXT NOT NULL) WITHOUT ROWID`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${INDEX}_next ON ${INDEX} (agent_id, available_at, created_at, handoff_id)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TAKING} (request_key TEXT PRIMARY KEY, work TEXT NOT NULL, handoff_id TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${TAKING}_at ON ${TAKING} (at)`);
  const fail = message => Object.assign(new Error(message), { status: 400 });
  return {
    apply(work, rows) {
      if (!text(work) || !Array.isArray(rows) || rows.length > MOST) throw fail(`Name the work resource and at most ${MOST} queued jobs.`);
      for (const row of rows) {
        if (!text(row?.handoff_id, 200)) throw fail('Each queued job names its handoff_id.');
        if (row.facts === null) { sql.exec(`DELETE FROM ${INDEX} WHERE handoff_id = ? AND work = ?`, row.handoff_id, work); continue; }
        const { agent_id, available_at } = row.facts ?? {};
        if (typeof agent_id !== 'string' || agent_id.length > 200 || typeof available_at !== 'string' || available_at.length > 40 || !text(row.created_at, 40))
          throw fail('A queued job says the agent it waits for, from when, and when it was handed.');
        sql.exec(`INSERT INTO ${INDEX} (handoff_id, work, agent_id, available_at, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (handoff_id) DO UPDATE SET work = excluded.work, agent_id = excluded.agent_id, available_at = excluded.available_at`,
        row.handoff_id, work, agent_id, available_at, row.created_at);
      }
      return { applied: rows.length };
    },
    // The job a take is about to take where it is kept, under the take's request_key: the same take sent again after a
    // lost answer asks that job again (its own take there answers as it did), never a second one.
    taking(request_key) {
      if (!text(request_key)) return null;
      return sql.exec(`SELECT work, handoff_id FROM ${TAKING} WHERE request_key = ?`, request_key).toArray()[0] ?? null;
    },
    keepTaking({ request_key, work, handoff_id }, at) {
      if (!text(request_key) || !text(work) || !text(handoff_id, 200) || !Number.isSafeInteger(at)) throw fail('A take keeps its request_key and the job it is taking.');
      sql.exec(`DELETE FROM ${TAKING} WHERE request_key IN (SELECT request_key FROM ${TAKING} WHERE at < ? ORDER BY at LIMIT ?)`, at - TAKING_KEPT_MS, MOST);
      sql.exec(`INSERT INTO ${TAKING} (request_key, work, handoff_id, at) VALUES (?, ?, ?, ?)
        ON CONFLICT (request_key) DO UPDATE SET work = excluded.work, handoff_id = excluded.handoff_id, at = excluded.at`, request_key, work, handoff_id, at);
    },
    next({ agent_id, now, limit = 8 }) {
      if (!text(agent_id, 200) || !text(now, 40)) throw fail('Name the agent asking, and the time it asks.');
      const size = Math.max(1, Math.min(MOST, limit));
      const read = id => sql.exec(`SELECT handoff_id, work, agent_id, available_at, created_at FROM ${INDEX} WHERE agent_id = ? AND available_at <= ?
        ORDER BY available_at, created_at, handoff_id LIMIT ?`, id, now, size).toArray();
      return [...read(agent_id), ...read('')].sort((a, b) => (a.agent_id === b.agent_id ? 0 : a.agent_id ? -1 : 1)
        || a.created_at.localeCompare(b.created_at) || a.handoff_id.localeCompare(b.handoff_id)).slice(0, size);
    },
  };
}

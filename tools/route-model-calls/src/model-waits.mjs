// src/model-waits.mjs
//
// Purpose
//   Work that needs a model and found none answering waits for one, and runs again by itself, instead of being
//   dropped. Trillion never pays for a chat model (src/model-calls.mjs NoChosenAI): when the person's own computer is
//   asleep or busy and no other route of theirs answers, a story, a privacy rewrite or an outcome check has no model
//   to run on. Before this, each such piece of work was recorded as failed or simply not done at that moment, and
//   nothing ever tried it again (2026-10-07: 70 stories, 58 privacy rewrites and 4 outcome checks refused in one day).
//
// Non-negotiable invariants
//   1. A wait is one row per (kind, key): asking to wait again for the same work while it already waits changes
//      nothing, so a piece of work is never run twice at once from here.
//   2. Nothing here names a kind of work: the store's own wiring (`run`, kind -> async key) runs each kind, and the
//      work itself says when it is still waiting (wait); work that ran without saying so waits no longer. Timing is
//      DATA (`settings`).
//   3. A wait is never dropped for having waited long: each try that finds no model moves its next try further out,
//      up to `longest_seconds`, so a computer asleep for days costs one try per that many seconds per piece of work.
//   4. A row's next try is moved out before it runs: work that throws, has no configured runner, or is cut off by a
//      restart is tried again then. Missing wiring is not a successful completion and never removes the work.
//   5. A host may keep the runner alive separately from its alarm. The alarm only starts one tracked batch and
//      returns; slow inference never holds every other timed source behind it. The same batch cannot be started
//      twice in one instance, and its rows remain durable until their work finishes. A future recovery wake remains
//      armed while it runs, so losing the instance never loses the work or creates a tight retry loop.
//   6. Each attempt owns a unique claim. Only its successful completion may remove that claim, so an older answer
//      cannot delete a newer retry of the same (kind, key). A finished batch rearms the alarm for whatever remains.
//
// Shapes
//   modelWaits(sql, { settings: { first_seconds, longest_seconds, batch }, run: { [kind]: async key => void },
//     now, keepAlive?: promise => void, onSettled?: async () => void }) ->
//     { wait(kind, key), nextAt() -> ms | null, runDue() -> { ran, started?, running?, progress? }, waiting() -> count,
//       running() -> [{ kind, key, started_at }] }
//

const one = (sql, query, ...args) => sql.exec(query, ...args).toArray()[0] ?? null;

// `step(purpose, work)` runs one bookkeeping step of a batch (the claim and the release of a row) as its own measured
// command, so no statement of a batch runs in the scope of the alarm that started it: that scope drains its kept work
// for a few seconds and then refuses SQL, while a model call takes longer. The model call itself is never inside a step.
export function modelWaits(sql, { settings, run, now = () => Date.now(), keepAlive = null, onSettled = async () => {}, step = (purpose, work) => work() }) {
  sql.exec('CREATE TABLE IF NOT EXISTS model_waits (kind TEXT NOT NULL, key TEXT NOT NULL, due_ms INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, claim_id TEXT, PRIMARY KEY (kind, key))');
  if (!sql.exec('PRAGMA table_info(model_waits)').toArray().some(column => column.name === 'claim_id'))
    sql.exec('ALTER TABLE model_waits ADD COLUMN claim_id TEXT');
  sql.exec('CREATE INDEX IF NOT EXISTS model_waits_due ON model_waits (due_ms)');
  const later = tries => Math.min(settings.first_seconds * 2 ** tries, settings.longest_seconds) * 1000;
  // Work running now; waiting again from inside it keeps the row whose next try was moved out before it ran.
  const running = new Map();
  const id = (kind, key) => `${kind}\0${key}`;
  let batch = null;
  const dueAt = () => one(sql, 'SELECT MIN(due_ms) AS due FROM model_waits')?.due ?? null;
  async function runRows(due) {
    let ranCount = 0;
    for (const row of due) {
      // Re-read immediately before claiming: an earlier row's work may have settled or moved this one.
      const claim = crypto.randomUUID();
      const current = await step('model-waits:claim', () => {
        const found = one(sql, 'SELECT tries FROM model_waits WHERE kind = ? AND key = ? AND due_ms <= ?', row.kind, row.key, now());
        if (found) sql.exec('UPDATE model_waits SET due_ms = ?, tries = ?, claim_id = ? WHERE kind = ? AND key = ?',
          now() + later(found.tries + 1), found.tries + 1, claim, row.kind, row.key);
        return found;
      });
      if (!current) continue;
      const ran = { again: false, kind: row.kind, key: row.key, started_at: new Date(now()).toISOString() };
      running.set(id(row.kind, row.key), ran);
      ranCount += 1;
      try {
        const runner = Object.hasOwn(run, row.kind) && run[row.kind];
        if (typeof runner !== 'function') throw new Error(`No model-wait runner is configured for ${row.kind}.`);
        await runner(row.key);
        if (!ran.again) await step('model-waits:release', () => sql.exec('DELETE FROM model_waits WHERE kind = ? AND key = ? AND claim_id = ?', row.kind, row.key, claim));
      } catch (error) {
        console.error('model wait', row.kind, error);
      } finally {
        running.delete(id(row.kind, row.key));
      }
    }
    return { ran: ranCount };
  }
  return {
    /** The work of `kind` named by `key` waits for a model, and is run again later by itself. */
    wait(kind, key) {
      const ran = running.get(id(kind, String(key)));
      if (ran) { ran.again = true; return; }
      sql.exec('INSERT OR IGNORE INTO model_waits (kind, key, due_ms, tries) VALUES (?, ?, ?, 0)', kind, String(key), now() + later(0));
    },
    nextAt() {
      const due = dueAt();
      // The rows are still durable while inference runs. Keep a future recovery wake without starting another
      // batch against the same local model or repeatedly waking on the other rows whose original time has passed.
      return due === null ? null : batch ? Math.max(due, now() + settings.first_seconds * 1000) : due;
    },
    waiting() {
      return one(sql, 'SELECT COUNT(*) AS n FROM model_waits')?.n ?? 0;
    },
    running() {
      return [...running.values()].map(({ kind, key, started_at }) => ({ kind, key, started_at }));
    },
    async runDue() {
      // A run that started nothing says so (src/scheduler.mjs invariant 12).
      if (batch) return { ran: 0, running: running.size, progress: false };
      const due = sql.exec('SELECT kind, key, tries FROM model_waits WHERE due_ms <= ? ORDER BY due_ms LIMIT ?', now(), settings.batch).toArray()
        .filter(row => !running.has(id(row.kind, row.key)));
      if (!due.length) return { ran: 0, progress: false };
      // Register the promise with the host before any model starts. It owns the batch until every row settles;
      // rows still run one after another because they ask the same model. The next alarm can run other sources.
      const work = Promise.resolve().then(() => runRows(due)).finally(async () => {
        batch = null;
        await onSettled();
      });
      batch = work;
      if (keepAlive) {
        try { keepAlive(work); }
        catch { return await work; } // A host unable to retain it must await it instead of dropping the promise.
        return { ran: 0, started: due.length };
      }
      return await work;
    },
  };
}


// src/live-work.mjs
//
// Purpose
//   A job a person on a plan that keeps nothing hands to their AI with a button in the app ("Hand this to my AI"),
//   kept for one working session only: an hour from the press. Their AI hears of it on its next tool reply and takes
//   and finishes it with the same take_work and finish_work every AI uses, and the app shows who took it and what came
//   back. An hour after the press the job, its result and who was told of it are deleted, whether or not anyone
//   finished it, which is what the free plan promises. It lives in the person's store's own tables, so a store that
//   restarts in that hour (a new Worker version, an idle store put to sleep) still holds it. A plan that keeps work
//   uses the kept road instead (src/queued-work.mjs, handed on by the person's rules through src/agents.mjs).
//
// Non-negotiable invariants
//   1. Session only: every row is deleted `keep_ms` after its press; every call deletes what has run out first, and
//      `nextExpiry()` / `prune()` let the store's alarm delete it on time when nobody calls. No EEAF record, no notice
//      list, no KV: nothing of it outlives the session in any history.
//   2. A job reads like a handoff to the AI (handoff_id, job, state, taken_by, result, summary), so an AI needs no new
//      tool and a screen needs no new shape; its handoff_id is the press's asked_id.
//   3. Only the AI that took a job finishes it, once; a job taken and held past `hold_ms` can be taken again.
//   4. At most `most` jobs are held; the oldest finished ones go first, then the oldest waiting.
//   5. Nothing here names a job, a screen, an AI or a plan: the words are the caller's.
//
// Security
//   One set of tables per person's store, reached only through that store, so one person's jobs are never another's.
//

import { titleOf } from '../../shared-code/src/work-title.mjs';

export class LiveWorkError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

// sql: the store's SQLite (exec). now: () => Date. keep_ms: how long anything of a press lasts. hold_ms: how long a
// taken job stays with the AI that took it. result_max: longest result accepted.
export function liveWork({ sql, now = () => new Date(), keep_ms = 60 * 60 * 1000, hold_ms = 10 * 60 * 1000, most = 50, result_max = 20_000 }) {
  sql.exec('CREATE TABLE IF NOT EXISTS live_work (handoff_id TEXT PRIMARY KEY, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS live_work_told (reader TEXT NOT NULL, handoff_id TEXT NOT NULL, PRIMARY KEY (reader, handoff_id))');
  const at = () => now().toISOString();
  const view = ({ held_until, ...job }) => job;
  const available = job => job.state === 'open' || (job.state === 'taken' && job.held_until <= now().getTime());
  // Deletes only when something has run out: a read that changes nothing writes nothing, so it never repaints a screen.
  const prune = () => {
    const before = new Date(now().getTime() - keep_ms).toISOString();
    if (!sql.exec('SELECT 1 FROM live_work WHERE handed_at <= ? LIMIT 1', before).toArray().length) return;
    sql.exec('DELETE FROM live_work_told WHERE handoff_id IN (SELECT handoff_id FROM live_work WHERE handed_at <= ?)', before);
    sql.exec('DELETE FROM live_work WHERE handed_at <= ?', before);
  };
  const jobs = () => { prune(); return sql.exec('SELECT value FROM live_work ORDER BY handed_at').toArray().map(row => JSON.parse(row.value)); };
  const one = id => { prune(); const row = sql.exec('SELECT value FROM live_work WHERE handoff_id = ?', id).toArray()[0]; return row ? JSON.parse(row.value) : null; };
  const save = job => sql.exec('INSERT INTO live_work (handoff_id, handed_at, value) VALUES (?, ?, ?) ON CONFLICT (handoff_id) DO UPDATE SET value = excluded.value', job.handoff_id, job.handed_at, JSON.stringify(job));
  const trim = () => {
    const held = jobs();
    if (held.length <= most) return;
    const order = held.sort((a, b) => Number(b.state === 'finished') - Number(a.state === 'finished') || a.handed_at.localeCompare(b.handed_at));
    for (const job of order.slice(0, held.length - most)) {
      sql.exec('DELETE FROM live_work_told WHERE handoff_id = ?', job.handoff_id);
      sql.exec('DELETE FROM live_work WHERE handoff_id = ?', job.handoff_id);
    }
  };

  return {
    // One pressed job: { asked_id, job, said, label, context } -> the job as a handoff (said: the work as the person sees it). The same asked_id is the same job.
    put({ asked_id, job, said = null, label = null, context = {} }) {
      if (!text(asked_id, 200) || !text(job, 20_000)) throw new LiveWorkError('A job needs its id and its words.');
      const held = one(asked_id);
      if (held) return { handoff: view(held), repeated: true };
      const made = { handoff_id: asked_id, state: 'open', job, said: titleOf({ said: typeof said === 'string' ? said.slice(0, 300) : null, job }), label, context, to_agent: null, from_agent: null, handed_at: at(), taken_by: null, taken_at: null, finished_at: null, result: null, summary: null, held_until: 0 };
      save(made);
      trim();
      return { handoff: view(made), repeated: false };
    },

    // take_work: { agent_id, handoff_id? } -> { handoff, generation, next_call } or { handoff: null, note }.
    take(input = {}) {
      if (!text(input.agent_id, 200)) throw new LiveWorkError('agent_id is required: the name this AI goes by.');
      const agent_id = input.agent_id.trim();
      const wanted = typeof input.handoff_id === 'string' ? input.handoff_id : null;
      const chosen = wanted ? one(wanted) : jobs().filter(available)[0];
      if (!chosen || !(available(chosen) || (chosen.state === 'taken' && chosen.taken_by === agent_id))) {
        return { handoff: null, note: wanted ? `${wanted} is not waiting for ${agent_id}.` : 'Nothing is waiting for this AI right now.' };
      }
      Object.assign(chosen, { state: 'taken', taken_by: agent_id, taken_at: at(), held_until: now().getTime() + hold_ms });
      save(chosen);
      return { handoff: view(chosen), generation: 1, next_call: { tool: 'finish_work', arguments: { handoff_id: chosen.handoff_id, agent_id, result: '(what was done)' } } };
    },

    // finish_work: { handoff_id, agent_id, result, summary? } -> { handoff }.
    finish(input = {}) {
      const job = one(input.handoff_id);
      if (!job) throw new LiveWorkError(`${input.handoff_id} is not a job this account holds now.`, 404);
      if (job.state === 'finished') return { handoff: view(job), repeated: true };
      if (job.state !== 'taken' || job.taken_by !== input.agent_id) throw new LiveWorkError(`Take ${job.handoff_id} with take_work as ${input.agent_id} before finishing it.`, 409);
      if (input.result === undefined) throw new LiveWorkError('result is required: what was done.');
      // A partial result cannot finish a job: the AI must shorten it and retry while the job stays taken.
      const written = typeof input.result === 'string' ? input.result : JSON.stringify(input.result);
      if (typeof written !== 'string') throw new LiveWorkError('result must be text or a JSON value.');
      if (written.length > result_max) throw new LiveWorkError(`result is too long; send at most ${result_max} characters and try finish_work again.`);
      if (typeof input.summary === 'string' && input.summary.length > 2000) throw new LiveWorkError('summary is too long; send at most 2000 characters and try finish_work again.');
      Object.assign(job, { state: 'finished', finished_at: at(), result: input.result, summary: typeof input.summary === 'string' ? input.summary : null, held_until: 0 });
      save(job);
      return { handoff: view(job) };
    },

    // Is this one of the held jobs?
    holds(handoffId) { return typeof handoffId === 'string' && one(handoffId) !== null; },
    // Every held job as the AI work board lists handoffs, newest first.
    list() { return jobs().map(view).reverse(); },
    // The jobs this reader has not been told of yet, as notices for its next tool reply; each is told once per reader.
    // `peek` tells nothing yet: the caller shows them and then says so with `tell`.
    unseen(reader, words, { peek = false } = {}) {
      if (!reader) return [];
      const told = new Set(sql.exec('SELECT handoff_id FROM live_work_told WHERE reader = ?', reader).toArray().map(row => row.handoff_id));
      const fresh = jobs().filter(job => job.state === 'open' && !told.has(job.handoff_id));
      if (!peek) for (const job of fresh) sql.exec('INSERT OR IGNORE INTO live_work_told (reader, handoff_id) VALUES (?, ?)', reader, job.handoff_id);
      return fresh.map(job => ({ kind: 'handoff', at: job.handed_at, refs: { handoff_id: job.handoff_id }, said: words(job) }));
    },
    // Notes these jobs as told to this reader, or false, noting none, when another call told one of them first.
    tell(reader, ids) {
      const told = new Set(sql.exec('SELECT handoff_id FROM live_work_told WHERE reader = ?', reader).toArray().map(row => row.handoff_id));
      if (ids.some(id => told.has(id))) return false;
      for (const id of ids) sql.exec('INSERT OR IGNORE INTO live_work_told (reader, handoff_id) VALUES (?, ?)', reader, id);
      return true;
    },
    // When the oldest press runs out (ms since the epoch), or null with nothing held: the store's alarm deletes it then.
    nextExpiry() {
      const row = sql.exec('SELECT MIN(handed_at) AS first FROM live_work').toArray()[0];
      return row?.first ? Date.parse(row.first) + keep_ms : null;
    },
    prune,
  };
}

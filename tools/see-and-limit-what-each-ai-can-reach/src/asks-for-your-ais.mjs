// src/asks-for-your-ais.mjs
//
// Purpose
//   Resumable model work is answered by the connected AIs the person already pays for. Trillion never
//   pays for a chat model (src/model-calls.mjs NoChosenAI), and the person's own routes (src/model-routes.json) are the
//   model on their computer and the keys they set a budget for. A reading of 60,000 characters does not fit a Mac's
//   model in its 45 seconds, and a key held at $0 is never asked, so before this such work failed and retried the same
//   routes forever (2026-10-07: one account's hourly reading had failed since 2026-10-05, beside 70 stories, 58 privacy
//   rewrites and 4 outcome checks in one day). The ask is kept here instead; one job handed to the person's AIs asks
//   them to answer what waits through the MCP (model_asks_waiting, answer_model_ask), and the work that asked finds
//   the answer by the ask's identity the next time it runs.
//
// Non-negotiable invariants
//   1. An ask is kept by its content identity (BLAKE3 over its messages and max_tokens): the same ask waits once, and
//      an answer serves only that exact ask, so work whose input changed asks again rather than using a stale answer.
//   2. Nothing here names a kind of work: which purposes may wait is a rule in the route row (src/model-routes.json
//      `your-ais`), decided by the store's formula engine; limits and words are DATA in the same row.
//   3. Only the person's own AIs on their own account see or answer their asks; nothing here sends an ask anywhere.
//   4. At most `most_waiting` unanswered asks are kept (the oldest are let go); answers are kept `keep_days`.
//   5. An answer is any non-empty text; the work that asked validates it as it validates any model reply.
//   6. One durable batch key owns the aggregate work while it is open or held. Evicting or answering the oldest
//      ask never creates another aggregate job. A dispatch retry uses the same key, including after a restart;
//      after a batch drains, later work gets a new key. An explicit withdrawal is not reopened by a repeated ask.
//   7. A device answer retires only the unanswered incarnation captured before that device was asked. A later
//      replacement or subscription answer is untouched. Only this owner's linked waiting job may be retired;
//      held work, unsettled effects, unfinished parts and dependent work remain with their existing owners.
//
// Shapes
//   asksForYourAis(sql, { settings: { most_waiting, keep_days }, now,
//     work?: { read(request_key), create(request_key), retire(handoff_id) } }) -> {
//     identity(input) -> '1f:<hex>', answered(input) -> { reply, answered_by } | null,
//     wait(purpose, input) -> { id, oldest }, waiting(limit) -> [{ id, purpose, messages, max_tokens, asked_at }],
//     answer(id, reply, by) -> { id, purpose }, pending(input) -> token | null, resolve(token), syncWork(),
//     checkFinish(handoff) }
//   Work callbacks are synchronous owner operations. Only this table's kept key links a carrier; old unlinked
//   aggregate jobs are not adopted or closed by matching their words or sender label.
//   asksTools(call) -> MCP tool rows; asksAnnotations
//

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const ASKS_PATH = '/asks-for-your-ais';
const DAY = 86_400_000;
const one = (sql, query, ...args) => sql.exec(query, ...args).toArray()[0] ?? null;

export function asksForYourAis(sql, { settings, now = () => Date.now(), work = null, deferDispatch = null }) {
  sql.exec('CREATE TABLE IF NOT EXISTS asks_for_your_ais (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, input TEXT NOT NULL, asked_ms INTEGER NOT NULL, answered_ms INTEGER, reply TEXT, answered_by TEXT)');
  sql.exec('CREATE INDEX IF NOT EXISTS asks_for_your_ais_waiting ON asks_for_your_ais (answered_ms, asked_ms)');
  if (!sql.exec('PRAGMA table_info(asks_for_your_ais)').toArray().some(column => column.name === 'pending_key'))
    sql.exec('ALTER TABLE asks_for_your_ais ADD COLUMN pending_key TEXT');
  sql.exec('CREATE TABLE IF NOT EXISTS asks_for_your_ais_work (slot INTEGER PRIMARY KEY CHECK (slot = 1), request_key TEXT NOT NULL)');
  const identity = input => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([input?.messages ?? [], input?.max_tokens ?? null]))))}`;
  const hasWaiting = () => Boolean(one(sql, 'SELECT id FROM asks_for_your_ais WHERE answered_ms IS NULL LIMIT 1'));
  const batch = () => one(sql, 'SELECT request_key FROM asks_for_your_ais_work WHERE slot = 1');
  const linked = () => { const kept = batch(); return kept ? work?.read(kept.request_key) ?? null : null; };
  function syncWork({ newAsk = false, retry_request_key = null } = {}) {
    if (!work) return null;
    let kept = batch();
    if (retry_request_key !== null && kept?.request_key !== retry_request_key) return null;
    const current = kept ? work.read(kept.request_key) : null;
    if (!hasWaiting()) {
      // The agent owner rechecks idle-work eligibility synchronously before withdrawal. It never interrupts a holder.
      if (current?.state === 'open') work.retire(current.handoff_id);
      return current;
    }
    // A retry only repairs an absent dispatch for its exact retained batch.
    // Existing handoffs, including withdrawal and terminal states, are never recreated.
    if (retry_request_key !== null) return current ?? work.create(retry_request_key);
    if (current && current.state !== 'finished') return current;
    if (current?.withdrawal && !newAsk) return current;
    if (!kept || current?.state === 'finished') {
      kept = { request_key: `asks-for-your-ais:batch:${crypto.randomUUID()}` };
      // Keep the key before dispatch. A thrown/lost dispatch answer retries this same identity, not a second job.
      sql.exec('INSERT INTO asks_for_your_ais_work (slot, request_key) VALUES (1, ?) ON CONFLICT(slot) DO UPDATE SET request_key = excluded.request_key', kept.request_key);
    }
    return work.create(kept.request_key);
  }
  const prune = () => {
    sql.exec('DELETE FROM asks_for_your_ais WHERE id IN (SELECT id FROM asks_for_your_ais WHERE answered_ms IS NOT NULL AND answered_ms < ? LIMIT 500)', now() - settings.keep_days * DAY);
    sql.exec('DELETE FROM asks_for_your_ais WHERE answered_ms IS NULL AND id NOT IN (SELECT id FROM asks_for_your_ais WHERE answered_ms IS NULL ORDER BY asked_ms DESC LIMIT ?)', settings.most_waiting);
  };
  return {
    identity,
    syncWork,
    /** The exact pending incarnation a route is about to answer; null means there was no fallback ask yet. */
    pending(input) {
      return one(sql, 'SELECT id, asked_ms, pending_key FROM asks_for_your_ais WHERE id = ? AND answered_ms IS NULL', identity(input));
    },
    /** Another authorized route answered this exact pending incarnation. It needs no subscription answer now. */
    resolve(pending) {
      if (!pending) return;
      sql.exec('DELETE FROM asks_for_your_ais WHERE id = ? AND answered_ms IS NULL AND asked_ms = ? AND pending_key IS ?', pending.id, pending.asked_ms, pending.pending_key ?? null);
      syncWork();
    },
    /** Called inside the shared agent owner's final write, so arrivals during an agent's work cannot be lost. */
    checkFinish(item) {
      if (!work || linked()?.handoff_id !== item.handoff_id || !hasWaiting()) return;
      const error = new Error('Model asks still wait in this aggregate job. Answer or resolve them before finishing it.');
      error.next_call = { tool: 'model_asks_waiting', arguments: {} };
      throw error;
    },
    /** The answer one of the person's AIs gave to exactly this ask, or null. */
    answered(input) {
      const row = one(sql, 'SELECT reply, answered_by FROM asks_for_your_ais WHERE id = ? AND answered_ms >= ?', identity(input), now() - settings.keep_days * DAY);
      return row ? { reply: row.reply, answered_by: row.answered_by } : null;
    },
    /** Keeps the ask for the person's AIs (once per identity); returns its id and the oldest ask still waiting. */
    wait(purpose, input) {
      const id = identity(input);
      // Expired answers no longer answer this ask. Retire this exact old incarnation
      // before INSERT OR IGNORE, even when bounded housekeeping has older rows left.
      sql.exec('DELETE FROM asks_for_your_ais WHERE id = ? AND answered_ms < ?', id, now() - settings.keep_days * DAY);
      const existed = one(sql, 'SELECT id FROM asks_for_your_ais WHERE id = ?', id);
      sql.exec('INSERT OR IGNORE INTO asks_for_your_ais (id, purpose, input, asked_ms, pending_key) VALUES (?, ?, ?, ?, ?)', id, String(purpose), JSON.stringify({ messages: input.messages, ...(input.max_tokens ? { max_tokens: input.max_tokens } : {}) }), now(), crypto.randomUUID());
      prune();
      try {
        syncWork({ newAsk: !existed });
      } catch (error) {
        // Only a declared transient failure enters the existing durable continuation owner.
        // Permanent refusals keep their real failure; an uncertain dispatch retains its key.
        if (typeof deferDispatch !== 'function' || error?.retryable !== true) throw error;
        const request_key = batch()?.request_key;
        if (!request_key || deferDispatch(request_key, error) !== true) throw error;
      }
      return { id, oldest: one(sql, 'SELECT id FROM asks_for_your_ais WHERE answered_ms IS NULL ORDER BY asked_ms, id LIMIT 1')?.id ?? id };
    },
    /** The asks still waiting, oldest first. */
    waiting(limit = 10) {
      return sql.exec('SELECT id, purpose, input, asked_ms FROM asks_for_your_ais WHERE answered_ms IS NULL ORDER BY asked_ms, id LIMIT ?', Math.max(1, Math.min(Number(limit) || 10, 50))).toArray()
        .map(row => ({ id: row.id, purpose: row.purpose, ...JSON.parse(row.input), asked_at: new Date(row.asked_ms).toISOString() }));
    },
    /** What an answer whose call is gone did (its readback; reads only): the ask answered with this reply is the answer,
     *  an ask still waiting was never answered, an ask answered otherwise is unknown. */
    answerOutcome(id, reply) {
      const row = one(sql, 'SELECT purpose, reply, answered_ms FROM asks_for_your_ais WHERE id = ?', String(id));
      if (row?.answered_ms === null) return { state: 'aborted' };
      return row && row.reply === (typeof reply === 'string' ? reply.trim() : '') ? { state: 'committed', answered: { id: String(id), purpose: row.purpose } } : { state: 'unknown' };
    },
    /** One of the person's AIs answers a waiting ask; the work that asked uses it when it runs again. */
    answer(id, reply, by) {
      const text = typeof reply === 'string' ? reply.trim() : '';
      if (!text) throw new Error('Send the reply as the text the ask\'s messages call for.');
      const row = one(sql, 'SELECT purpose, answered_ms FROM asks_for_your_ais WHERE id = ?', String(id));
      if (!row) throw new Error('No ask with that id is waiting. Read model_asks_waiting for the ones that are.');
      if (row.answered_ms !== null) throw new Error('That ask was already answered.');
      sql.exec('UPDATE asks_for_your_ais SET reply = ?, answered_ms = ?, answered_by = ? WHERE id = ?', text, now(), String(by ?? 'your AI'), String(id));
      syncWork();
      return { id: String(id), purpose: row.purpose };
    },
  };
}

/** The asks route, answered by whichever store keeps the account's asks: GET lists what waits, POST { id, reply }
 *  answers one (by: the app that answered), then arms the store's scheduler so the work that asked runs again. */
export async function handleAsksRequest({ asks, arm }, request, by) {
  try {
    if (request.method !== 'POST') return Response.json({ waiting: asks.waiting(Math.min(Number(new URL(request.url).searchParams.get('limit')) || 10, 50)) });
    const { id, reply } = await request.json();
    const answered = asks.answer(id, reply, by || null);
    await arm();
    return Response.json({ answered, still_waiting: asks.waiting(50).length });
  } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
}

// The tools the person's AIs answer waiting asks with.
export function asksTools(call) {
  return [{
    name: 'model_asks_waiting',
    description: 'The resumable questions Trillion is holding for any connected AI on this person\'s account, such as a reading, article, story, rewrite or grounded file choice, oldest first. A local model or paid API key is not required first. Each has id, purpose, messages and max_tokens. Follow its messages exactly and send the reply with answer_model_ask; the source work uses and validates that answer when it runs again. Keep private input within this account. limit (default 10, at most 50). It changes nothing.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    run: ({ limit } = {}) => call(`${ASKS_PATH}${limit ? `?limit=${Number(limit)}` : ''}`),
  }, {
    name: 'answer_model_ask',
    description: 'Answers one ask from model_asks_waiting: id, and reply, the exact text its messages call for (when they ask for JSON, the JSON alone). The work that asked (the person\'s reading, a story, a rewrite) uses it the next time it runs and checks it as it checks any model reply. Returns the ask and how many still wait.',
    inputSchema: { type: 'object', required: ['id', 'reply'], properties: { id: { type: 'string' }, reply: { type: 'string' } } },
    run: ({ id, reply }) => call(ASKS_PATH, { id, reply }),
  }];
}
export const asksAnnotations = {
  model_asks_waiting: { title: 'Read what Trillion needs my AIs to answer', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  answer_model_ask: { title: 'Answer what Trillion needs my AIs to answer', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

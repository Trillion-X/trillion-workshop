// src/model-calls.mjs
//
// The one road every model call takes: it counts what each call used, keeps a model's answers by content identity so
// the same question is never paid for twice, and stops a kind of call once a budget row says it has used enough.
// Trillion never pays for a chat model: a call that is a conversation (messages) goes to `person`, the person's own
// routes (src/model-routes.json: the model on their own computer, then the keys they picked, each within their spend
// budget, src/api-spend.mjs); when none answers it is refused with NoChosenAI (the work waits for the AIs they already
// pay for) and the person is told once a day, never answered by a model on Trillion's bill. Only work no chosen AI can do (embeddings, speech to text)
// runs on the AI binding, bounded by the budget rows; any other call (an image to draw, a prompt to complete) is refused
// with NotPaidByTrillion before anything is sent, whoever asks (a store, the shared pool, a hosted Site, a model tool).
//
// Why it exists: on 2026-10-04 the model that judges check answers ran up to 15,000 calls an hour and 4.8 million
// neurons a day (about $53), six times what it used five days earlier, and nobody saw it until the bill. Every model
// call went straight to the AI binding, so nothing counted it and nothing could stop it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every call is counted by day, purpose (what the call is for, named by its caller) and model; a refused call is
//      counted as refused and an answer taken from memory as remembered.
//   2. Budgets are DATA (src/model-budgets.json): which calls a row covers is a formula-engine rule tree over the
//      call's facts, what it counts is a measure the counter keeps, and how much is enough is a number. Nothing here
//      names a purpose, a model or a budget.
//   3. A call over a budget is refused with ModelBudgetReached, never silently dropped: the caller decides what a
//      refusal means (the check judge marks the check unjudged), and the person is told once per row per day.
//   4. A remembered answer is reused only for the same identity, which the caller derives from everything the answer
//      depends on; remembered answers are pruned after their row's days.
//   5. Trillion's binding answers only input shapes a paid_inputs row names (src/model-budgets.json); a conversation
//      goes to the person, and anything else is counted as refused and never sent (Sites and model tools included).
//   6. A paid_inputs row that says `remember` answers each item the same way every time (an embedding of the same words
//      by the same model): each item's answer is kept by its identity (model and item) and never paid for twice, and
//      the same item asked twice at once is sent once. On 2026-10-10 one person's store made 19,955 embedding calls of
//      about 11 tokens each, most of them the same few job and goal texts again, and reached its daily limit by 08:10Z.
//   7. A budget row with `per: "purpose"` counts and stops each purpose on its own: the kind of work that ran away stops,
//      every other kind keeps going (the same rule as the hourly saving limit, src/metered-use.json).
//
// Shapes
//   modelCalls({ ai, sql, scope, matches(tree, facts) -> boolean, alert(notice), report(day, rows) -> { reached },
//     now }) -> { run(purpose, model, input), answered(purpose, model, input) -> { reply, model }, allow(purpose, model), count(purpose, model, input, reply), spend({ days }),
//     memory(name) -> { recall, keep } }
//   accountModelSpend({ sql, matches, alert }) -> { report(person, day, rows) -> { reached }, spend(since) }

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import data from './model-budgets.json' with { type: 'json' };
import poolSettings from './pool-settings.json' with { type: 'json' };
import { modelAdmissionTables } from './model-admission.mjs';

export class NoChosenAI extends Error {
  constructor() { super(data.words.no_ai_body); this.no_chosen_ai = true; }
}
const chatShaped = input => Array.isArray(input?.messages);
// Work Trillion pays for is named by the shape of what is sent (src/model-budgets.json paid_inputs: a field such work
// always carries), never by model: a new embedding or speech model needs no row, and an image or prompt model never
// matches one.
const paidShaped = input => input !== null && typeof input === 'object' && data.paid_inputs.some(row => input[row.input_has] !== undefined);

/** A call that is neither a conversation nor work Trillion pays for (an image to draw, a prompt to complete). */
export class NotPaidByTrillion extends Error {
  constructor() { super(data.words.not_paid); this.not_paid_by_trillion = true; }
}

export class ModelBudgetReached extends Error {
  // words: a refusal that is not one of these rows (a reached spend budget, src/spend-meter.mjs) says its own.
  constructor(budget, used, words = null) {
    super(words ?? `${budget.label} is used up for today (${used} of ${budget.most} ${data.measures[budget.measure]?.label ?? budget.measure}).`);
    this.budget = budget.id;
    this.model_budget_reached = true;
  }
}

/** A paid call made where no model binding is reachable. */
export class NoModelRoad extends Error {
  constructor() { super(data.words.no_model_road); this.no_model_road = true; }
}

/** Shared admission did not confirm allowance; paid dispatch stays closed. */
export class ModelAdmissionUnavailable extends Error {
  constructor(why = null) { super(`The paid model allowance could not be confirmed${why ? `: ${why}` : ''}.`); this.model_admission_unavailable = true; }
}

/** Whether `error` is the model road declining to answer now (a budget row or the spending stop reached, a shape
 * Trillion does not pay for, no binding), rather than a fault in the caller. Read by src/meaning-or-words.mjs. */
export const modelRoadStopped = error => Boolean(error?.model_budget_reached || error?.not_paid_by_trillion || error?.no_model_road || error?.model_admission_unavailable);

/** What the person is told when a budget row gets close or is reached (the words are DATA in model-budgets.json). */
export function modelBudgetNotice({ key, budget, used, most, day, reached, no_chosen_ai }) {
  if (no_chosen_ai) return { key, kind: 'ai-unavailable', title: data.words.no_ai_title, body: data.words.no_ai_body, refs: { open: data.words.no_ai_open } };
  const fill = template => template.replace(/\{(\w+)\}/g, (_, name) => String({ label: budget.label, share: `${Math.round((used / most) * 100)}%`, used: used.toLocaleString('en-US'), most: most.toLocaleString('en-US'), measure: data.measures[budget.measure]?.label ?? budget.measure, day }[name] ?? ''));
  return { key, kind: data.words.kind, title: fill(reached ? data.words.reached_title : data.words.near_title), body: fill(budget.notice?.body ?? data.words.body), open: data.words.open };
}

// Grouped spend rows are read a page at a time in key order, never cut short: a cap or a plan meter that totals them must see every group.
const SPEND_PAGE = 500;
const dayOf = date => date.toISOString().slice(0, 10);
// The paid_inputs row whose items are remembered for this input, if any.
const rememberedShape = input => (input !== null && typeof input === 'object'
  ? data.paid_inputs.find(row => row.remember && Array.isArray(input[row.input_has])) ?? null : null);
const itemIdentity = (model, item) => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([model, item]))))}`;
const dispatchIdentity = (purpose, model, input) => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([purpose, model, input]))))}`;
// How much of a budget row the rows of a day used, by purpose for a row counted per purpose ('*' holds the total).
async function amountsOf(budget, rows, covered) {
  const amounts = new Map([['*', 0]]);
  for (const row of rows) {
    if (!await covered(budget, { purpose: row.purpose, model: row.model })) continue;
    const amount = Number(row[budget.measure] ?? 0);
    amounts.set('*', amounts.get('*') + amount);
    amounts.set(row.purpose, (amounts.get(row.purpose) ?? 0) + amount);
  }
  return amounts;
}
const perPurpose = budget => budget.per === 'purpose';
const usedBy = (budget, amounts, purpose) => amounts.get(perPurpose(budget) ? purpose : '*') ?? 0;
// The largest share of a row in use: the total, or for a row counted per purpose its busiest purpose.
const largestOf = (budget, amounts) => {
  if (!perPurpose(budget)) return { used: amounts.get('*'), purpose: null };
  let found = { used: 0, purpose: null };
  for (const [purpose, used] of amounts) if (purpose !== '*' && used > found.used) found = { used, purpose };
  return found;
};
const estimateTokens = value => Math.ceil(String(value ?? '').length / data.characters_per_token);
const textOf = value => (typeof value === 'string' ? value : Array.isArray(value) ? value.map(textOf).join(' ') : value == null ? '' : JSON.stringify(value));

/** The counter's and the memory's tables, made once per store. */
export function modelCallTables(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS model_spend (day TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0, remembered INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, purpose, model))');
  // Who pays for a row's calls: Trillion (its AI binding) or the person (the AI they chose, on their own account).
  try { sql.exec("ALTER TABLE model_spend ADD COLUMN paid_by TEXT NOT NULL DEFAULT 'trillion'"); } catch { /* already there */ }
  sql.exec('CREATE TABLE IF NOT EXISTS model_answers (name TEXT NOT NULL, identity TEXT NOT NULL, answer TEXT NOT NULL, kept_at INTEGER NOT NULL, PRIMARY KEY (name, identity))');
  sql.exec('CREATE INDEX IF NOT EXISTS model_answers_kept ON model_answers (kept_at)');
  sql.exec('CREATE INDEX IF NOT EXISTS model_answers_namespace_kept ON model_answers (name, kept_at)');
}

// What a reply used: the model's own count when it gives one, else an estimate from the words sent and received.
// Output is never less than total minus input: a model that thinks before it answers (Gemini 2.5, o-series) bills the
// thinking as output but may report it only in total_tokens, and counting completion_tokens alone put a $103 bill at $4.
export function usageOf(input, reply) {
  const usage = reply?.usage;
  if (usage && Number.isFinite(usage.prompt_tokens)) {
    const output = Number(usage.completion_tokens ?? 0);
    const total = Number(usage.total_tokens);
    return { input_tokens: usage.prompt_tokens, output_tokens: Number.isFinite(total) ? Math.max(output, total - usage.prompt_tokens) : output };
  }
  const sent = Array.isArray(input?.messages) ? input.messages.map(message => message.content) : input?.audio ?? input?.text ?? input?.prompt ?? '';
  const said = reply?.response ?? reply?.choices?.[0]?.message?.content ?? '';
  return { input_tokens: estimateTokens(textOf(sent)), output_tokens: estimateTokens(textOf(said)) };
}

// Whether a budget row covers calls with these facts, decided once per row and pair by the row's own rule tree.
function coverage(matches) {
  const known = new Map();
  return async (budget, facts) => {
    const key = JSON.stringify([budget.id, facts.purpose, facts.model]);
    if (!known.has(key)) known.set(key, budget.when ? await matches(budget.when, facts) : true);
    return known.get(key);
  };
}

/**
 * @param {{ ai: { run(model: string, input: object): Promise<any> }, sql: any, scope: string,
 *   matches: (tree: object, facts: object) => Promise<boolean>, alert?: (notice: object) => Promise<void>,
 *   report?: (day: string, rows: object[]) => Promise<{ reached?: string[] }>, now?: () => Date }} setup
 */
export function modelCalls({ ai, env, sql, scope, matches, alert = async () => {}, report = null, preflight = null, person = null, now = () => new Date(), rows: budgetRows = data.budgets, transaction = fn => fn(), admission = null, admissionOwner = null, spending = null }) {
  if (!ai && env) ai = env.AI;
  modelCallTables(sql);
  modelAdmissionTables(sql);
  const budgets = budgetRows.filter(row => row.scope === scope);
  const covered = coverage(matches);
  const rowsOf = day => sql.exec('SELECT purpose, model, paid_by, calls, refused, remembered, input_tokens, output_tokens FROM model_spend WHERE day = ?', day).toArray();
  const add = (day, purpose, model, change) => sql.exec(
    'INSERT INTO model_spend (day, purpose, model, paid_by, calls, refused, remembered, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, purpose, model) DO UPDATE SET calls = calls + excluded.calls, refused = refused + excluded.refused, remembered = remembered + excluded.remembered, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens',
    day, purpose, model, change.paid_by ?? 'trillion', change.calls ?? 0, change.refused ?? 0, change.remembered ?? 0, change.input_tokens ?? 0, change.output_tokens ?? 0);
  // Budgets reached further up (every person's calls together), as the last report said, for the day it said it.
  // An entry is a row id (counted together) or { id, purpose } (counted per purpose).
  let reachedAbove = { day: null, ids: [] };
  let reportedAt = 0;
  const alerted = new Set();
  // Items being answered now, by identity, so the same item asked twice at once is sent once.
  const answering = new Map();
  // A row in `reserving` is recoverable after a cold restart, but while its remote
  // reserve call is still in flight this process must not mistake it for an orphan.
  const activeAcquisitions = new Set();

  // Local person limits use the person's SQL transaction and include outstanding dispatches.
  async function reserveLocal(purpose, model, day, input, id, reservation) {
    const candidates = [];
    const sent = Array.isArray(input?.messages) ? input.messages.map(message => message.content) : input?.audio ?? input?.text ?? input?.prompt ?? '';
    const estimateFor = budget => budget.measure === 'calls' ? 1 : budget.measure === 'input_tokens' ? estimateTokens(textOf(sent)) : budget.most;
    for (const budget of budgets) if (budget.stop !== false && await covered(budget, { purpose, model })) {
      const coverageByRow = new Map();
      for (const row of rowsOf(day)) coverageByRow.set(JSON.stringify([row.purpose, row.model]), await covered(budget, row));
      candidates.push({ budget, amount: estimateFor(budget), coverageByRow });
    }
    const result = transaction(() => {
      for (const { budget, amount: reserveAmount, coverageByRow } of candidates) {
        const measure = data.measures[budget.measure] ? budget.measure : 'calls';
        const currentRows = rowsOf(day).filter(row => row.paid_by === 'trillion');
        if (currentRows.some(row => !coverageByRow.has(JSON.stringify([row.purpose, row.model])))) return { retry: true };
        const used = currentRows.filter(row => row.paid_by === 'trillion' && (budget.per !== 'purpose' || row.purpose === purpose) && coverageByRow.get(JSON.stringify([row.purpose, row.model])) !== false).reduce((total, row) => total + Number(row[measure] ?? 0), 0);
        const held = Number(sql.exec(`SELECT COALESCE(SUM(amount), 0) AS used FROM model_call_reservation_amounts WHERE day = ? AND budget_id = ?${budget.per === 'purpose' ? ' AND purpose = ?' : ''} LIMIT 1`,
          ...(budget.per === 'purpose' ? [day, budget.id, purpose] : [day, budget.id])).toArray()[0]?.used ?? 0);
        if (used + held + reserveAmount > budget.most) return { budget, amount: used + held };
      }
      const uncertain = sql.exec("SELECT id FROM model_call_reservations WHERE state IN ('reserving', 'reserve_unknown', 'dispatching') AND dispatch_identity = ? LIMIT 1", dispatchIdentity(purpose, model, input)).toArray()[0];
      if (uncertain) return { uncertain: true };
      sql.exec("INSERT INTO model_call_reservations (id, day, purpose, model, amount, owner, state, created_at, dispatch_identity, remote_id, spending_permit, reservation_json) VALUES (?, ?, ?, ?, 1, ?, 'reserving', ?, ?, ?, ?, ?)",
        id, day, purpose, model, admissionOwner, now().getTime(), dispatchIdentity(purpose, model, input), reservation.remote_id, reservation.spending_permit, JSON.stringify(reservation));
      for (const { budget, amount } of candidates) sql.exec('INSERT INTO model_call_reservation_amounts (id, budget_id, day, purpose, owner, amount) VALUES (?, ?, ?, ?, ?, ?)', id, budget.id, day, purpose, admissionOwner, amount);
      activeAcquisitions.add(id);
      return { id };
    });
    if (result.retry) return reserveLocal(purpose, model, day, input, id, reservation);
    if (result.uncertain) throw new ModelAdmissionUnavailable();
    if (result.budget) { add(day, purpose, model, { refused: 1 }); await tellOnce(result.budget, day, result.amount, true, purpose); throw new ModelBudgetReached(result.budget, result.amount); }
    return result.id;
  }
  // reads-ok: O(changed) completion acknowledgements only; successful acknowledgement retires these rows immediately.
  const accountedIds = day => sql.exec("SELECT remote_id FROM model_call_reservations WHERE day = ? AND state = 'settled' AND remote_id IS NOT NULL", day).toArray().map(row => row.remote_id);
  const forgetAccounted = ids => transaction(() => { for (const id of ids) sql.exec("DELETE FROM model_call_reservations WHERE state = 'settled' AND remote_id = ?", id); });
  async function reservePaid(purpose, model, day, input) {
    const localId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    let remoteId = admission ? `model-call:${localId}` : null;
    const spendingPermit = spending ? `model-spend:${localId}` : null;
    const spendingPrepared = spending?.prepare ? await spending.prepare({ id: localId, day, purpose, model, input }) : null;
    const reserveFacts = { day, purpose, model, owner: admissionOwner, remote_id: remoteId, spending_permit: spendingPermit,
      spending_request: spendingPrepared?.request ?? null, remote_accepted: false, spending_accepted: false };
    const reservedLocalId = await reserveLocal(purpose, model, day, input, localId, reserveFacts);
    try {
      const accounted = accountedIds(day);
      const remote = admission ? await admission.reserve({ id: remoteId, day, purpose, model, owner: admissionOwner, input, rows: rowsOf(day), accounted }) : null;
      if (remote?.refused) {
        transaction(() => sql.exec('UPDATE model_call_reservations SET reservation_json = ? WHERE id = ?', JSON.stringify(reserveFacts), localId));
        await tellOnce(remote.refused.budget, day, remote.refused.amount, true, purpose);
        throw new ModelBudgetReached(remote.refused.budget, remote.refused.amount, remote.refused.words);
      }
      if (admission && (typeof remote?.id !== 'string' || !remote.id)) throw new ModelAdmissionUnavailable();
      // An older pool in a rolling deployment can still return its own id.
      // Keep its acknowledged original so settlement reaches that exact hold.
      remoteId=remote?.id??null;
      reserveFacts.remote_id=remoteId;
      reserveFacts.remote_accepted = Boolean(remote?.id);
      transaction(() => sql.exec('UPDATE model_call_reservations SET remote_id=?,reservation_json = ? WHERE id = ?',remoteId,JSON.stringify(reserveFacts),localId));
      if (spending) {
        const reserved = await spending.reserve({ id: localId, day, purpose, model, input, prepared: spendingPrepared });
        if (reserved?.refused) { transaction(() => sql.exec('UPDATE model_call_reservations SET reservation_json = ? WHERE id = ?', JSON.stringify(reserveFacts), localId)); throw new ModelBudgetReached(reserved.refused.budget, reserved.refused.amount, reserved.refused.words); }
        if (reserved?.accepted === false) { const error = new ModelAdmissionUnavailable(reserved.why); error.definitive = true; throw error; }
        if (reserved?.accepted !== true || (reserved.permit_id && reserved.permit_id !== spendingPermit)) throw new ModelAdmissionUnavailable();
        reserveFacts.spending_accepted = true;
        transaction(() => sql.exec('UPDATE model_call_reservations SET reservation_json = ? WHERE id = ?', JSON.stringify(reserveFacts), localId));
      }
      transaction(() => sql.exec('UPDATE model_call_reservations SET state = ? WHERE id = ?', 'pending', localId));
      return { localId: reservedLocalId, remoteId, spendingPermit };
    } catch (error) {
      // A failed or missing reply can mean the other owner committed its hold. Keep
      // the local capacity and exact idempotency keys until an acknowledged cleanup.
      if (error?.model_budget_reached || error?.model_admission_unavailable && error?.definitive === true) {
        transaction(() => sql.exec('UPDATE model_call_reservations SET state = ? WHERE id = ?', 'releasing', localId));
        // Preserve the original refusal even if a cleanup acknowledgement is lost.
        // The durable releasing row will retry the same exact IDs on the next call.
        await releasePaid({ localId, remoteId, spendingPermit }).catch(() => {});
      } else {
        reserveFacts.reserve_unknown = true;
        transaction(() => sql.exec('UPDATE model_call_reservations SET state = ?, reservation_json = ? WHERE id = ?', 'reserve_unknown', JSON.stringify(reserveFacts), localId));
      }
      if (error?.model_budget_reached) add(day, purpose, model, { refused: 1 });
      throw error;
    } finally {
      activeAcquisitions.delete(localId);
    }
  }
  async function releasePaid(held) {
    if (!held?.localId) return;
    transaction(() => sql.exec('UPDATE model_call_reservations SET state = ? WHERE id = ? AND settlement_json IS NULL', 'releasing', held.localId));
    const row = sql.exec('SELECT remote_id, spending_permit, state, settlement_json, reservation_json FROM model_call_reservations WHERE id = ? LIMIT 1', held.localId).toArray()[0];
    if (!row || row.settlement_json !== null) return;
    const facts = row.reservation_json ? JSON.parse(row.reservation_json) : { remote_accepted: !row.remote_id, spending_accepted: !row.spending_permit };
    const uncertainReserve = facts.reserve_unknown === true;
    if (row.remote_id && (facts.remote_accepted || uncertainReserve)) {
      const answer = uncertainReserve && typeof admission?.cancel === 'function'
        ? await admission.cancel(row.remote_id) : await admission?.release(row.remote_id);
      if (answer?.released !== true) throw new Error('The shared model reservation release was not acknowledged.');
    }
    if (row.spending_permit && uncertainReserve && !facts.spending_accepted && !facts.spending_absent) {
      if (typeof spending?.recover !== 'function' || !facts.spending_request) throw new Error('The uncertain model spend reservation has no recoverable request.');
      const recovered = await spending.recover(facts.spending_request);
      if (recovered?.accepted === true) facts.spending_accepted = true;
      else if (recovered?.accepted === false) facts.spending_absent = true;
      else throw new Error('The uncertain model spend reservation was not resolved.');
      transaction(() => sql.exec('UPDATE model_call_reservations SET reservation_json = ? WHERE id = ?', JSON.stringify(facts), held.localId));
    }
    if (row.spending_permit && facts.spending_accepted) await spending?.release?.(row.spending_permit);
    transaction(() => { sql.exec('DELETE FROM model_call_reservation_amounts WHERE id = ?', held.localId); sql.exec('DELETE FROM model_call_reservations WHERE id = ? AND state = \'releasing\' AND settlement_json IS NULL', held.localId); });
  }
  const RECONCILE_PAGE = 64;
  async function reconcileReleases() {
    // A page at a time in id order, past the last id read, so a row that stays (a release that did not finish) is not read again this pass.
    let after = '';
    for (;;) {
    const pending = sql.exec("SELECT id, remote_id, spending_permit, reservation_json, state FROM model_call_reservations WHERE state IN ('releasing','reserve_unknown','reserving') AND settlement_json IS NULL AND id > ? ORDER BY id LIMIT ?", after, RECONCILE_PAGE).toArray();
    for (const row of pending) {
      after = row.id;
      if (activeAcquisitions.has(row.id)) continue;
      if (row.state === 'reserving') {
        const facts = row.reservation_json ? JSON.parse(row.reservation_json) : {};
        facts.reserve_unknown = true;
        transaction(() => sql.exec("UPDATE model_call_reservations SET state='reserve_unknown', reservation_json=? WHERE id=? AND state='reserving'", JSON.stringify(facts), row.id));
      }
      await releasePaid({ localId: row.id, remoteId: row.remote_id, spendingPermit: row.spending_permit });
    }
    if (pending.length < RECONCILE_PAGE) break;
    }
  }

  async function settlePaid(held, purpose, model, day, input, reply) {
    const usage = usageOf(input, reply);
    const remoteAccounted = held?.remoteId ? accountedIds(day) : [];
    const settlement = { day, purpose, model, usage,
      remote: held?.remoteId ? { id: held.remoteId, owner: admissionOwner, rows: null, accounted: remoteAccounted } : null,
      spending: held?.spendingPermit ? { permit_id: held.spendingPermit, day, purpose, model, usage } : null };
    if (held?.localId) transaction(() => {
      add(day, purpose, model, { calls: 1, ...usage });
      sql.exec('DELETE FROM model_call_reservation_amounts WHERE id = ?', held.localId);
      settlement.remote && (settlement.remote.rows = rowsOf(day));
      sql.exec("UPDATE model_call_reservations SET state = 'settled', settlement_json = ? WHERE id = ?", JSON.stringify(settlement), held.localId);
    });
    await reconcileSettlements();
    await sendReport(day);
  }

  function claimForDispatch(held, purpose, model, input) {
    if (!held?.localId) return;
    const claimed = transaction(() => {
      const row = sql.exec("SELECT state, settlement_json, dispatch_identity FROM model_call_reservations WHERE id = ? LIMIT 1", held.localId).toArray()[0];
      const binding = dispatchIdentity(purpose, model, input);
      if (!row || row.state !== 'pending' || row.settlement_json !== null || row.dispatch_identity !== binding) return false;
      sql.exec("UPDATE model_call_reservations SET state = 'dispatching' WHERE id = ? AND state = 'pending' AND settlement_json IS NULL AND dispatch_identity = ?",
        held.localId, binding);
      return sql.exec("SELECT state FROM model_call_reservations WHERE id = ? LIMIT 1", held.localId).toArray()[0]?.state === 'dispatching';
    });
    if (!claimed) throw new ModelAdmissionUnavailable();
  }

  // The reservation is the durable outbox. Retries send byte-for-byte equivalent facts and
  // keep its capacity until both quota owners acknowledge; no inference is repeated here.
  async function reconcileSettlements() {
    let after = '';
    for (;;) {
    const pending = sql.exec("SELECT id, remote_id, spending_permit, settlement_json, remote_settled, spending_settled FROM model_call_reservations WHERE state = 'settled' AND settlement_json IS NOT NULL AND id > ? ORDER BY id LIMIT ?", after, RECONCILE_PAGE).toArray();
    for (const row of pending) {
      after = row.id;
      const facts = JSON.parse(row.settlement_json);
      if (row.remote_id && !row.remote_settled) {
        try {
          await admission.settle(row.remote_id, { day: facts.remote.rows?.[0]?.day ?? facts.day, purpose: facts.purpose, model: facts.model, owner: facts.remote.owner, usage: facts.usage, rows: facts.remote.rows, accounted: facts.remote.accounted });
          transaction(() => sql.exec('UPDATE model_call_reservations SET remote_settled = 1 WHERE id = ?', row.id));
        } catch (error) { console.error('model allowance result remains to be kept:', error?.message ?? ''); }
      } else if (!row.remote_id) transaction(() => sql.exec('UPDATE model_call_reservations SET remote_settled = 1 WHERE id = ?', row.id));
      if (row.spending_permit && !row.spending_settled) {
        try {
          await spending.settle(row.spending_permit, facts.spending);
          transaction(() => sql.exec('UPDATE model_call_reservations SET spending_settled = 1 WHERE id = ?', row.id));
        } catch (error) { console.error('model spend result remains to be settled:', error?.message ?? ''); }
      } else if (!row.spending_permit) transaction(() => sql.exec('UPDATE model_call_reservations SET spending_settled = 1 WHERE id = ?', row.id));
      const current = sql.exec('SELECT remote_settled, spending_settled FROM model_call_reservations WHERE id = ? LIMIT 1', row.id).toArray()[0];
      if (current?.remote_settled && current?.spending_settled) {
        if (row.remote_id) forgetAccounted([row.remote_id]);
        transaction(() => sql.exec('DELETE FROM model_call_reservations WHERE id = ?', row.id));
      }
    }
    if (pending.length < RECONCILE_PAGE) break;
    }
  }

  // A budget bounds what Trillion pays for; calls the person's own AI answered are theirs.
  const amounts = (budget, day) => amountsOf(budget, rowsOf(day).filter(row => row.paid_by === 'trillion'), covered);
  async function tellOnce(budget, day, amount, reached, purpose = null) {
    const key = `${budget.id}:${perPurpose(budget) && purpose ? `${purpose}:` : ''}${day}:${reached ? 'reached' : 'near'}`;
    if (alerted.has(key)) return;
    alerted.add(key);
    await alert({ key: `model-budget:${key}`, budget, used: amount, most: budget.most, day, reached }).catch(() => {});
  }
  async function refusal(facts, day) {
    if (reachedAbove.day === day) {
      for (const entry of reachedAbove.ids) {
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (typeof entry === 'object' && entry?.purpose !== facts.purpose) continue;
        const budget = budgetRows.find(row => row.id === id);
        if (budget && budget.stop !== false && await covered(budget, facts)) return { budget, amount: budget.most };
      }
    }
    for (const budget of budgets) {
      if (!await covered(budget, facts)) continue;
      const amount = usedBy(budget, await amounts(budget, day), facts.purpose);
      if (amount >= budget.most) { await tellOnce(budget, day, amount, true, facts.purpose); if(budget.stop !== false)return { budget, amount }; }
      else if (amount >= budget.most * budget.alert_at) await tellOnce(budget, day, amount, false, facts.purpose);
    }
    return null;
  }
  async function sendReport(day) {
    if (!report || now().getTime() - reportedAt < data.report_every_seconds * 1000) return;
    reportedAt = now().getTime();
    const answer = await report(day, rowsOf(day)).catch(() => null);
    if (answer) reachedAbove = { day, ids: answer.reached ?? [] };
  }

  return {
    /** Runs one model call for `purpose`, counted, and refused with ModelBudgetReached when a budget row says enough. */
    async run(purpose, model, input) { return (await this.answered(purpose, model, input)).reply; },
    /** Like run, with the model that really answered: { reply, model }. A conversation goes to the person's own routes,
     * which may answer with another model than the one named (a smaller one when the first does not answer), so the
     * named `model` is only what a call that is not a conversation asked of the AI binding. */
    async answered(purpose, model, input) {
      if (chatShaped(input)) return this.ask(purpose, input);
      if (!paidShaped(input)) { add(dayOf(now()), purpose, model, { refused: 1 }); throw new NotPaidByTrillion(); }
      const shape = rememberedShape(input);
      if (shape) return { reply: await this.rememberedReply(purpose, model, input, shape), model };
      if (typeof ai?.run !== 'function') { add(dayOf(now()), purpose, model, { refused: 1 }); throw new NoModelRoad(); }
      const day = dayOf(now());
      await reconcileReleases();
      await reconcileSettlements();
      await this.allow(purpose, model);
      const held = await reservePaid(purpose, model, day, input);
      try { claimForDispatch(held, purpose, model, input); }
      catch (error) {
        // A changed or stale input has not crossed the provider boundary. Close the exact
        // acknowledged reservations and retain them locally if either owner loses its reply.
        await releasePaid(held);
        throw error;
      }
      let reply;
      try { reply = await ai.run(model, input); }
      catch (error) {
        if (error?.definitelyNotDispatched === true) await releasePaid(held);
        throw error;
      }
      await settlePaid(held, purpose, model, day, input, reply);
      return { reply, model };
    },
    /** A call whose items are each answered the same way every time (invariant 6): items kept by identity are read
     * back, items being answered now are waited on, and only the rest are sent, in one call. */
    async rememberedReply(purpose, model, input, shape) {
      const items = input[shape.input_has];
      const identities = items.map(item => itemIdentity(model, item));
      const memory = this.memory(shape.remember.memory);
      const found = await memory.recall([...new Set(identities)], { purpose, model });
      const waiting = new Map();
      const missing = [];
      identities.forEach((identity, n) => {
        if (found.has(identity) || waiting.has(identity)) return;
        if (answering.has(identity)) waiting.set(identity, answering.get(identity));
        else { waiting.set(identity, null); missing.push(n); }
      });
      if (missing.length) {
        const asked = (async () => {
          if (typeof ai?.run !== 'function') { add(dayOf(now()), purpose, model, { refused: 1 }); throw new NoModelRoad(); }
          const sent = { ...input, [shape.input_has]: missing.map(n => items[n]) };
          const day = dayOf(now());
          await reconcileReleases();
          await reconcileSettlements();
          await this.allow(purpose, model);
          const held = await reservePaid(purpose, model, day, sent);
          try { claimForDispatch(held, purpose, model, sent); }
          catch (error) {
            await releasePaid(held);
            throw error;
          }
          let reply;
          try { reply = await ai.run(model, sent); }
          catch (error) { if (error?.definitelyNotDispatched === true) await releasePaid(held); throw error; }
          await settlePaid(held, purpose, model, day, sent, reply);
          const answers = reply?.[shape.remember.answers_in];
          if (!Array.isArray(answers) || answers.length !== missing.length) throw new Error('The model answered a different number of items than it was sent.');
          await memory.keep(missing.map((n, at) => ({ identity: identities[n], verdict: answers[at] })));
          return new Map(missing.map((n, at) => [identities[n], answers[at]]));
        })();
        for (const n of missing) {
          answering.set(identities[n], asked);
          waiting.set(identities[n], asked);
        }
        asked.catch(() => {}).finally(() => { for (const n of missing) if (answering.get(identities[n]) === asked) answering.delete(identities[n]); });
      }
      for (const [identity, pending] of waiting) found.set(identity, (await pending).get(identity));
      const answers = identities.map(identity => found.get(identity));
      return { [shape.remember.answers_in]: answers, shape: [answers.length, answers[0]?.length ?? 0] };
    },
    /** A conversation, answered by the AI the person chose on their own account: { reply, model }, counted under that
     * model; NoChosenAI when they chose none (told to them once a day). */
    async ask(purpose, input) {
      const day = dayOf(now());
      if (!chatShaped(input)) throw new Error('Only a conversation (messages) is asked of the person\'s AI.');
      try {
        if (!person) throw new NoChosenAI();
        const answer = await person(input, { purpose });
        add(day, purpose, answer.model, { paid_by: 'person', calls: 1, ...usageOf(input, answer.reply) });
        await sendReport(day);
        return answer;
      } catch (error) {
        if (!error?.no_chosen_ai) throw error;
        add(day, purpose, 'no-chosen-ai', { paid_by: 'person', refused: 1 });
        const key = `no-chosen-ai:${day}`;
        if (!alerted.has(key)) { alerted.add(key); await alert({ key: `model-budget:${key}`, no_chosen_ai: true, day }).catch(() => {}); }
        throw error;
      }
    },
    /** For a call made elsewhere (a live socket, another worker): refused with ModelBudgetReached when a row says enough. */
    async allow(purpose, model) {
      const day = dayOf(now());
      const stop = await refusal({ purpose, model }, day) ?? await preflight?.({ purpose, model }, day);
      if (stop) { add(day, purpose, model, { refused: 1 }); throw new ModelBudgetReached(stop.budget, stop.amount, stop.words); }
    },
    /** Claims a streaming call before the provider socket opens. Its outcome may remain
     * unknown, so the charged call is retained even if the opening response is lost. */
    async start(purpose, model, input = null) {
      const day = dayOf(now());
      await reconcileReleases();
      await reconcileSettlements();
      await this.allow(purpose, model);
      const held = await reservePaid(purpose, model, day, input);
      await settlePaid(held, purpose, model, day, input, null);
    },
    /** Counts one call made with `input` that answered `reply` (either may be null when the call streams). */
    async count(purpose, model, input = null, reply = null) {
      const day = dayOf(now());
      add(day, purpose, model, { calls: 1, ...usageOf(input, reply) });
      await sendReport(day);
    },
    /** The calls of the last `days` days by day, purpose and model, and each budget row with how much of it is used today. */
    async spend({ days = data.shown_days } = {}) {
      const today = dayOf(now());
      const since = dayOf(new Date(now().getTime() - (days - 1) * 86400000));
      const rows = sql.exec('SELECT day, purpose, model, paid_by, calls, refused, remembered, input_tokens, output_tokens FROM model_spend WHERE day >= ? ORDER BY day DESC, input_tokens DESC', since).toArray();
      return {
        days: rows.map(row => ({ ...row, neurons: neuronsOf(row) })),
        // A row counted per purpose shows its busiest purpose: that is the one that would stop.
        budgets: await Promise.all(budgets.map(async budget => {
          const largest = largestOf(budget, await amounts(budget, today));
          return { id: budget.id, label: budget.label, measure: budget.measure, most: budget.most, used_today: largest.used, ...(perPurpose(budget) ? { per: 'purpose', busiest_purpose: largest.purpose } : {}) };
        })),
        reached_for_everyone: reachedAbove.day === today ? reachedAbove.ids : [],
      };
    },
    /** Answers kept by identity under `name`, for a caller that derives the identity from all an answer depends on. */
    memory(name) {
      const keepDays = data.memory_days[name] ?? data.memory_days.default;
      return {
        async recall(identities, { purpose = name, model = 'remembered' } = {}) {
          const found = new Map();
          for (let start = 0; start < identities.length; start += 50) {
            const part = identities.slice(start, start + 50);
            const cutoff = now().getTime() - keepDays * 86400000;
            for (const row of sql.exec(`SELECT identity, answer FROM model_answers WHERE name = ? AND kept_at >= ? AND identity IN (${part.map(() => '?').join(', ')}) LIMIT 50`, name, cutoff, ...part).toArray()) found.set(row.identity, JSON.parse(row.answer));
          }
          if (found.size) add(dayOf(now()), purpose, model, { remembered: found.size });
          return found;
        },
        async keep(entries) {
          const at = now().getTime();
          for (const { identity, verdict } of entries) sql.exec('INSERT OR REPLACE INTO model_answers (name, identity, answer, kept_at) VALUES (?, ?, ?, ?)', name, identity, JSON.stringify(verdict), at);
          // Physical pruning is bounded and confined to this namespace: one namespace's
          // retention setting must never delete another namespace's still-valid answers.
          sql.exec('DELETE FROM model_answers WHERE rowid IN (SELECT rowid FROM model_answers WHERE name = ? AND kept_at < ? LIMIT 500)', name, at - keepDays * 86400000);
        },
      };
    },
  };
}

// Neurons (what Workers AI bills) for a row, from the model's price row; null when no price row names the model.
export function neuronsOf(row) {
  const exact = pricedNeuronsOf(row);
  return exact === null ? null : Math.round(exact);
}
export function pricedNeuronsOf(row) {
  const price = data.prices.find(item => item.model === row.model);
  if (!price) return null;
  if (Number.isFinite(price.neurons_per_audio_minute)) {
    // Audio reaches Workers AI as base64. The fallback token estimate is one token
    // per four encoded characters; decoding removes one quarter of those chars,
    // and the media pipeline uses constant-rate 64 kbit/s MP3 chunks.
    const minutes = Number(row.input_tokens ?? 0) * 3 / (8000 * 60);
    return minutes * price.neurons_per_audio_minute;
  }
  return (row.input_tokens * price.neurons_per_million_input + row.output_tokens * price.neurons_per_million_output) / 1e6;
}

/** Why a model cannot be priced for admission, in words that name it. */
const unpricedWhy = model => {
  const price = data.prices.find(item => item.model === model);
  if (price) return `model ${model} is priced by its output and no output ceiling is recorded for it (the request's max_tokens, the model's default, or its context window in model-budgets.json)`;
  const known = data.unpriced_models?.find(item => item.model === model);
  return `model ${model} has no price row${known ? ` (${known.why})` : ''}`;
};

// The most a call can generate: the request's own max_tokens, else the model's default when the provider states one, else the room its
// context window leaves after the prompt; never more than that room. Null when the model's context window is not recorded: a bound
// is never invented. A call that really generates more still settles at what it really used (settle below).
export const outputCeilingOf = (price, input, inputTokens) => {
  const context = Number(price.context_window_tokens);
  if (!Number.isFinite(context) || context <= 0) return null;
  const room = Math.max(0, context - inputTokens);
  const asked = [input?.max_tokens, input?.max_completion_tokens].map(Number).find(value => Number.isFinite(value) && value > 0);
  const stated = asked ?? Number(price.default_max_output_tokens);
  return Math.min(room, Number.isFinite(stated) && stated > 0 ? stated : room);
};

export const estimatedDollarsOf = (model, input) => {
  const price = data.prices.find(item => item.model === model);
  // Missing price is deliberately not represented as zero. Admission can refuse
  // a model whose provider price has not been verified and published in DATA.
  if (!price) return null;
  const usage = usageOf(input, null);
  const output = Number(price.neurons_per_million_output ?? 0) > 0 ? outputCeilingOf(price, input, usage.input_tokens) : usage.output_tokens;
  if (output === null) return null;
  const neurons = pricedNeuronsOf({ model, ...usage, output_tokens: output });
  return neurons === null ? null : dollarsOfNeurons(neurons);
};
export const dollarsOfNeurons = neurons => Number.isFinite(neurons)
  ? Math.ceil((neurons * data.neuron_price_usd_per_1000 / 1000) * 1e6) / 1e6 : null;

// The quota owner asks every request for every measure its rows count; a model call reads and writes no store rows.
const NO_STORE_ROWS = { rows_read: 0, rows_written: 0 };

/** A reusable adapter from the one paid model road to the existing account quota ledger. */
export function quotaModelSpending({ quota, owner, resource, placement }) {
  if (typeof resource !== 'string' || !resource || typeof placement?.binding !== 'string' || typeof placement?.id !== 'string') {
    throw new TypeError('Model spending needs its actual resource address and physical placement.');
  }
  const key = 'model-work:all';
  const target = { owner, address: resource, resource, placement };
  const facts = { line: 'trillion-model-calls', group: 'Counted inside Trillion', kind: 'model-work', key };
  const requestFor = ({ id, day, purpose, model, input }) => {
    const dollars = estimatedDollarsOf(model, input);
    if (dollars === null) return null;
    const permit_id = `model-spend:${id}`;
    const line = { key, facts, estimate: dollars };
    return { id: permit_id, target, purpose: 'model inference', entry: 'model', input_identity: { day, purpose, model, id },
      resource_facts: facts, resource_lines: [line], work_facts: { kind: 'model-call', purpose, entry: 'model', paid_by: 'trillion' }, estimate: { ...NO_STORE_ROWS, dollars } };
  };
  const budgetRefusal = (answer, current, dollars) => ({ refused: {
    budget: { id: answer.budget, label: 'Daily limit for Trillion-paid work', measure: 'dollars', most: answer.limit ?? current.policies.find(row => row.id === answer.budget)?.limit },
    amount: Number(answer.used ?? 0) + Number(answer.reserved ?? 0) + Number(answer.held ?? 0) + Number(answer.asked ?? dollars),
    words: `The daily limit for Trillion-paid work is reached ($${Number(answer.used ?? 0) + Number(answer.reserved ?? 0) + Number(answer.held ?? 0)} of $${answer.limit ?? current.policies.find(row => row.id === answer.budget)?.limit}).`,
  } });
  return {
    prepare(facts) { return { request: requestFor(facts) }; },
    async reserve({ id, day, purpose, model, input, prepared = null }) {
      const current = await quota.quotaCurrent(owner);
      if (!current?.plan_spending) return { accepted: false, why: 'the account has no plan spending terms' };
      const request = prepared?.request ?? requestFor({ id, day, purpose, model, input });
      if (!request) return { accepted: false, why: unpricedWhy(model) };
      const dollars = request.estimate.dollars;
      const answer = await quota.quotaReserve(owner, request);
      if (answer == null) throw new Error('Model spending reservation reply was not received.');
      if (!answer.accepted) return answer.reason === 'budget_reached' ? budgetRefusal(answer, current, dollars) : { accepted: false, why: `the quota owner refused it (${answer.reason ?? 'no reason given'})` };
      return { accepted: true, permit_id: request.id };
    },
    async recover(request) {
      if (!request) return { accepted: false };
      const answer = await quota.quotaReserve(owner, request);
      if (answer == null) throw new Error('The exact model spend reservation could not be recovered.');
      if (answer.reason === 'identity_conflict') throw new Error('The deterministic model spend permit belongs to different facts.');
      return { accepted: answer.accepted === true };
    },
    release: async permit_id => {
      const answer = await quota.quotaSettle(owner, { event_id: `model-spend-release:${permit_id}`, permit_id, amounts: { ...NO_STORE_ROWS, dollars: 0 }, line_amounts: { [key]: 0 }, outcome: { released_before_dispatch: true } });
      if (!answer?.settled) throw new Error(`Model spend release was not acknowledged: ${answer?.reason ?? 'unknown result'}`);
      return answer;
    },
    settle: async (permit_id, { day, purpose, model, usage }) => {
      const neurons = pricedNeuronsOf({ model, ...usage });
      if (!Number.isFinite(neurons)) throw new Error('The dispatched model has no verified price row.');
      const dollars = dollarsOfNeurons(neurons);
      const answer = await quota.quotaSettle(owner, { event_id: `model-spend-settle:${permit_id}`, permit_id, accounting_day: day, observed: true, amounts: { ...NO_STORE_ROWS, dollars }, line_amounts: { [key]: dollars },
        outcome: { day, purpose, model, neurons, dollars, paid_by: 'trillion' } });
      if (!answer?.settled) throw new Error(`Model spend settlement was not acknowledged: ${answer?.reason ?? 'unknown result'}`);
      return answer;
    },
  };
}

/** The account's side: every person's day totals, kept by person, summed against the account budget rows. */
export function accountModelSpend({ sql, matches, alert = async () => {}, rows: budgetRows = data.budgets }) {
  sql.exec('CREATE TABLE IF NOT EXISTS model_spend_people (day TEXT NOT NULL, person TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, refused INTEGER NOT NULL, remembered INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, PRIMARY KEY (day, person, purpose, model))');
  try { sql.exec("ALTER TABLE model_spend_people ADD COLUMN paid_by TEXT NOT NULL DEFAULT 'trillion'"); } catch { /* already there */ }
  const budgets = budgetRows.filter(row => row.scope === 'account');
  const covered = coverage(matches);
  const alerted = new Set();
  // Account budgets bound what Trillion pays for; rows the people's own AIs answered are kept for the readout only.
  // Every group of (day, purpose, model, paid_by) from `since`, read SPEND_PAGE at a time past the last key and ordered newest day first.
  const spendGroups = (extra, where, params) => {
    const rows = [];
    for (let after = ['', '', '', '']; ;) {
      const page = sql.exec(`SELECT day, purpose, model, paid_by, SUM(calls) AS calls, SUM(refused) AS refused, SUM(remembered) AS remembered, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens${extra ? `, ${extra}` : ''} FROM model_spend_people WHERE ${where} GROUP BY day, purpose, model, paid_by HAVING (day, purpose, model, paid_by) > (?, ?, ?, ?) ORDER BY day, purpose, model, paid_by LIMIT ?`, ...params, ...after, SPEND_PAGE).toArray();
      rows.push(...page);
      if (page.length < SPEND_PAGE) break;
      const last = page.at(-1);
      after = [last.day, last.purpose, last.model, last.paid_by];
    }
    return rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.input_tokens - a.input_tokens))
      .map(row => ({ ...row, neurons: neuronsOf(row), dollars: dollarsOfNeurons(pricedNeuronsOf(row)) }));
  };
  const totalsFor = day => sql.exec("SELECT purpose, model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(calls) AS calls FROM model_spend_people WHERE day = ? AND paid_by = 'trillion' GROUP BY purpose, model", day).toArray();
  return {
    /** Read the persisted account total before a shared call, including after this Durable Object restarts. */
    async refusal(facts, day) {
      const totals = totalsFor(day);
      for (const budget of budgets) {
        if (budget.stop === false || !await covered(budget, facts)) continue;
        const amount = usedBy(budget, await amountsOf(budget, totals, covered), facts.purpose);
        if (amount >= budget.most) return { budget, amount };
      }
      return null;
    },
    async report(person, day, rows) {
      for (const row of rows) sql.exec(`INSERT INTO model_spend_people (day, person, purpose, model, paid_by, calls, refused, remembered, input_tokens, output_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, person, purpose, model) DO UPDATE SET
        paid_by = excluded.paid_by, calls = MAX(calls, excluded.calls), refused = MAX(refused, excluded.refused),
        remembered = MAX(remembered, excluded.remembered), input_tokens = MAX(input_tokens, excluded.input_tokens),
        output_tokens = MAX(output_tokens, excluded.output_tokens)`, day, person, row.purpose, row.model, row.paid_by ?? 'trillion', row.calls, row.refused, row.remembered, row.input_tokens, row.output_tokens);
      const totals = totalsFor(day);
      const reached = [];
      for (const budget of budgets) {
        const counted = await amountsOf(budget, totals, covered);
        const parts = perPurpose(budget) ? [...counted].filter(([purpose]) => purpose !== '*') : [['*', counted.get('*')]];
        for (const [purpose, amount] of parts) {
          const state = amount >= budget.most ? 'reached' : amount >= budget.most * budget.alert_at ? 'near' : null;
          if (state === 'reached' && budget.stop !== false) reached.push(purpose === '*' ? budget.id : { id: budget.id, purpose });
          const key = `${budget.id}:${purpose === '*' ? '' : `${purpose}:`}${day}:${state}`;
          if (state && !alerted.has(key)) { alerted.add(key); await alert({ key: `model-budget:${key}`, budget, used: amount, most: budget.most, day, reached: state === 'reached' }).catch(() => {}); }
        }
      }
      return { reached };
    },
    spend(since) {
      return spendGroups('COUNT(DISTINCT person) AS people', 'day >= ?', [since]);
    },
    spendFor(person, since) {
      return spendGroups(null, '(person = ? OR person LIKE ?) AND day >= ?', [person, `[${JSON.stringify(person)},%`, since]);
    },
  };
}

// Callers supply the already metered environment returned by their model owner.
// Keep its embedding primitives here, beside the one counted provider road.
export async function embed(env,text){const reply=await env.AI.run(poolSettings.embedding_model.id,{text:[String(text)]});return reply.data[0];}
export async function embedMany(env,texts,model=poolSettings.embedding_model.id){if(!texts.length)return [];const reply=await env.AI.run(model,{text:texts.map(String)});return reply.data;}

// src/api-spend.mjs
//
// Purpose: what a person's own API accounts cost them, in dollars per account per day, counted at the one place
// Trillion sends to them, and capped by the person's own daily budget before the next request leaves. Every request
// a Workshop row sends on a person's connection passes src/workshop.mjs sendThroughBox; that send asks this meter
// first (before: refused once today's dollars for that account reached a cap) and tells it what came back (after: the
// call's model and usage, priced from src/api-spend.json and kept per day, account and model).
//
// Why it exists: on 2026-10-05 an earlier background AI, working on a person's own Google key, ran up $103 of Gemini calls in
// a few hours, and nothing in Trillion counted it or could stop it. The person pays those accounts directly, so the
// bill arrived with no warning. Counting at the send makes every account any Workshop row can reach count the same
// way, whoever sends (the person's own AIs, awareness reading, a run_tool from any AI).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a service or a model: services, prices and where usage sits in an answer are DATA rows.
//   2. A call is counted from what the service itself said it used. A model with no price row keeps its calls and
//      tokens and adds to `unpriced`; its dollars are unknown and never shown as zero.
//   3. The cap is checked before sending, from counts already kept (rows per account and day, read by the primary key),
//      so a refused call costs the person nothing and no request is sent. The refusal names when it lifts
//      (refused_until, the end of the cap's period), so the AI working it rests that account until then and hands the
//      job to the next one the person picked.
//   4. Caps come from the host (the person's budget rows, src/spend-meter.json); the person is told once per cap, account
//      and period when one gets close (alert_at) and when it is reached.
//   5. A successful response without valid usage, or without a known price, is an unknown cost. It still counts as a
//      call; another capped request waits until that period ends. Missing usage can never create a zero-cost allowance.
//
// Shapes
//   apiSpend({ sql, caps, tell?, now?, data? }) -> {
//     covers(tool) -> boolean                    whether a send by this Workshop row is counted
//     before(tool) -> Promise                    throws ApiCapReached when a cap for the row's account is reached
//     after(tool, request, status, text) -> void counts the call from its request and answer
//     usedSince(key, since) -> number            dollars this account cost from that day (YYYY-MM-DD) on
//     read(period) -> { rows: [{ key, label, amount, shown, calls, input_tokens, output_tokens, unpriced }] }
//   }
//   caps(key, label) -> Promise<[{ id, label, most_dollars, alert_at?, since, until }]>  the person's caps covering one account:
//     each counts from day `since` and lifts at `until` (ms)
//   period: { since, until } (YYYY-MM-DD, UTC)
//

import defaults from './api-spend.json' with { type: 'json' };

const DAY_MS = 86_400_000;
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const money = dollars => `$${dollars.toFixed(2)}`;
const compact = amount => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(amount);
const keyOf = connectionId => String(connectionId ?? '').split(':').pop();

export class ApiCapReached extends Error {
  constructor({ cap, label, used }) {
    super(`${cap.label} is reached (${money(used)} of ${money(cap.most_dollars)}). Nothing more is sent to ${label} until ${new Date(cap.until).toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
    this.cap = cap.id;
    this.not_sent = true;
    this.refused_until = cap.until;
  }
}

export class ApiCostUnknown extends Error {
  constructor({ cap, label }) {
    super(`The cost of a previous request to ${label} is unknown, so ${cap.label} cannot be checked. Nothing more is sent until ${new Date(cap.until).toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
    this.cap = cap.id;
    this.not_sent = true;
    this.refused_until = cap.until;
  }
}

function numberAt(value, paths) {
  for (const path of paths ?? []) {
    let at = value;
    for (const key of path) at = at === null || at === undefined ? undefined : at[key];
    if (typeof at === 'number' && Number.isSafeInteger(at) && at >= 0) return at;
  }
  return null;
}

/** The model a call used and what the service said it used: { model, input_tokens, output_tokens }. */
export function usageOf({ requestBody, answer, data = defaults }) {
  const asked = typeof requestBody?.model === 'string' ? requestBody.model : null;
  const said = (data.model_at ?? []).map(path => path.reduce((at, key) => at?.[key], answer)).find(value => typeof value === 'string');
  const input = numberAt(answer, data.usage.input_tokens) ?? 0;
  const output = numberAt(answer, data.usage.output_tokens) ?? 0;
  const total = numberAt(answer, data.usage.total_tokens);
  return { model: String(asked ?? said ?? 'unknown').replace(/^models\//, ''), input_tokens: input, output_tokens: Math.max(output, total === null ? 0 : total - input) };
}

/** What one call cost at its service's price rows, or null when no row prices its model. */
export function dollarsOf(service, usage) {
  const row = (service?.prices ?? []).filter(price => usage.model.startsWith(price.model)).sort((a, b) => b.model.length - a.model.length)[0];
  if (!row) return null;
  const rates = row.above && usage.input_tokens > row.above.input_tokens ? row.above.per_million : row.per_million;
  return Object.entries(rates).reduce((sum, [measure, rate]) => sum + (Number(usage[measure]) || 0) * rate / 1e6, 0);
}

export function apiSpend({ sql, caps = async () => [], tell = async () => {}, now = () => Date.now(), data = defaults }) {
  sql.exec(`CREATE TABLE IF NOT EXISTS api_spend (day TEXT NOT NULL, key TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
    unpriced INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, dollars REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key, model))`);
  const services = new Map(data.services.map(service => [service.connection_id, service]));
  // A before/after pair owns an account lock while a request is in flight. Otherwise every
  // parallel request can pass the same stale spend read before any response is counted.
  const accountLocks = new Map();
  async function lockAccount(key) {
    let state = accountLocks.get(key);
    if (!state) { state = { busy: false, waiters: [] }; accountLocks.set(key, state); }
    if (state.busy) await new Promise(resolve => state.waiters.push(resolve));
    state.busy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) next();
      else { state.busy = false; accountLocks.delete(key); }
    };
  }
  const serviceOf = tool => services.get(tool?.invoke?.connection_id) ?? null;
  const labelOf = key => services.get(`service_connection:${key}`)?.label ?? key;
  const totalsSince = (key, since) => sql.exec('SELECT COALESCE(SUM(dollars), 0) AS dollars, COALESCE(SUM(unpriced), 0) AS unpriced FROM api_spend WHERE day >= ? AND key = ? LIMIT 1', since, key).toArray()[0];
  const usedSince = (key, since) => Number(totalsSince(key, since)?.dollars ?? 0);

  return {
    covers: tool => serviceOf(tool) !== null,
    usedSince,
    async before(tool) {
      const service = serviceOf(tool);
      if (!service) return null;
      const key = keyOf(service.connection_id);
      const release = await lockAccount(key);
      try {
        const covering = await caps(key, service.label);
        // An account without a configured cap needs no in-flight ordering.
        if (!covering.length) { release();return null; }
        for (const cap of covering) {
          const totals = totalsSince(key, cap.since ?? dayOf(now()));
          const used = Number(totals?.dollars ?? 0);
          const until = Number.isFinite(cap.until) ? cap.until : (Math.floor(now() / DAY_MS) + 1) * DAY_MS;
          if (Number(totals?.unpriced ?? 0) > 0) {
            const error = new ApiCostUnknown({ cap: { ...cap, until }, label: service.label });
            await tell({ kind: defaults.kind, open: defaults.open, key: `spend-budget:${cap.id}:${cap.since ?? dayOf(now())}:unknown`, title: `${cap.label}: cost unknown`, body: error.message }).catch(() => null);
            throw error;
          }
          if (used < cap.most_dollars) {
            // Getting close is told once, under the same key the Spend meter uses, before the cap is reached.
            if (cap.alert_at && used >= cap.most_dollars * cap.alert_at) await tell({ kind: defaults.kind, open: defaults.open, key: `spend-budget:${cap.id}:${cap.since ?? dayOf(now())}:near`, title: `${cap.label}: ${Math.round((used / cap.most_dollars) * 100)}% used`, body: `${money(used)} of ${money(cap.most_dollars)} so far on ${service.label}.` }).catch(() => null);
            continue;
          }
          const reached = { ...cap, until };
          // The same key the Spend meter tells under (src/spend-meter.mjs), so the person hears it once.
          await tell({ kind: defaults.kind, open: defaults.open, key: `spend-budget:${cap.id}:${cap.since ?? dayOf(now())}:reached`, title: `${cap.label}: reached`, body: `${money(used)} of ${money(cap.most_dollars)}. Nothing more is sent to ${service.label} until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC. Ask your AI to raise or remove it.` }).catch(() => null);
          throw new ApiCapReached({ cap: reached, label: service.label, used });
        }
        return { key, release };
      } catch (error) {
        release();
        throw error;
      }
    },
    release(permit) { permit?.release?.(); },
    after(tool, request, status, text, permit = null) {
      this.release(permit);
      const service = serviceOf(tool);
      if (!service || !(status >= 200 && status < 300)) return;
      let answer;
      let requestBody = null;
      try { answer = JSON.parse(text); } catch { answer = null; }
      try { requestBody = request?.body ? JSON.parse(new TextDecoder().decode(request.body)) : null; } catch { /* a body that is not JSON names no model */ }
      const usage = usageOf({ requestBody, answer, data });
      const input = numberAt(answer, data.usage.input_tokens);
      const output = numberAt(answer, data.usage.output_tokens);
      const total = numberAt(answer, data.usage.total_tokens);
      const sum = input === null || output === null ? null : input + output;
      const reported = input !== null && (output !== null || total !== null) &&
        (sum === null || Number.isSafeInteger(sum)) && (total === null || total >= (sum ?? input));
      const dollars = reported ? dollarsOf(service, usage) : null;
      sql.exec(`INSERT INTO api_spend (day, key, model, calls, unpriced, input_tokens, output_tokens, dollars) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT (day, key, model) DO UPDATE SET calls = calls + 1, unpriced = unpriced + excluded.unpriced, input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens, dollars = dollars + excluded.dollars`,
      dayOf(now()), keyOf(service.connection_id), usage.model, dollars === null ? 1 : 0, usage.input_tokens, usage.output_tokens, dollars ?? 0);
    },
    read(period) {
      const rows = sql.exec(`SELECT key, SUM(dollars) AS amount, SUM(calls) AS calls, SUM(unpriced) AS unpriced, SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens FROM api_spend WHERE day >= ? AND day <= ? GROUP BY key ORDER BY amount DESC`, period.since, period.until).toArray();
      const shown = row => `${compact(row.calls)} calls, ${compact(row.input_tokens + row.output_tokens)} tokens${row.unpriced ? `, ${compact(row.unpriced)} with cost unknown` : ''}`;
      return { rows: rows.map(row => ({ ...row, label: labelOf(row.key), shown: shown(row) })) };
    },
  };
}

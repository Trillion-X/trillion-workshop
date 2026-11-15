// Source-first port; configuration is supplied by authenticated list rows.

export function createJourney(reports, { readSharing }) {
// src/journey.mjs
//
// PURPOSE
//   The per-customer journey Trillion HQ reads: one row per thing a customer did (account, at, surface, kind, label,
//   facts), kept in separate `journeys-<n>` instances of the interaction log class (src/interaction-log.mjs), never in
//   a person's store and never mixed with the anonymous counts, which are unchanged. This module decides whether an
//   event may be kept (the account's choice, src/hq-sharing.mjs), cuts it to what records/hq-reports.json `journey.recorded`
//   names, and sends it to its shard; it also reads every shard together for HQ's Customers screen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is kept for an account whose `activity` choice is off, and a failure to keep an event never fails the
//      request that caused it (a journey is told after the answer, with `ctx.waitUntil`, and logged when it fails).
//   2. A row keeps only the facts its kind's rule names, each cut to `label_chars`; a page or click keeps its route
//      group, never a name, id or code after it. Free text (a report's words, a notice's body) is kept only when the
//      account's `content` choice is on, and only the words the rule names.
//   3. No kind, surface, fact or threshold is named in code: each is a row of records/hq-reports.json.
//   4. Trillion HQ (OPERATOR_ACCOUNT_ID) is not a customer: nothing is kept for it, and its choice is never read, so the
//      operator's own agents' tool calls cost no key read and put no writes on a shard.
//   5. An account's rows are on one shard (its id's hash), so forgetting one account asks one place, and a row is swept
//      after `keep_days`.
//

const JOURNEY = reports.journey;
const clean = (value, max = JOURNEY.label_chars) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** The shard one account's journey is on. */
function journeyShardOf(account) {
  let hash = 0;
  for (const char of String(account)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % Math.max(1, JOURNEY.shards);
}
const journeyLog = (env, shard) => env.journeyLog(shard);

/**
 * One event as the row it would be kept as, or null when its kind is not one the journey keeps. `facts` and `words` are
 * what the caller knows; the kind's rule names which of them stay, and `words` stay only with `content`.
 */
function journeyRow(kind, facts = {}, words = {}, { content = false, now = Date.now() } = {}) {
  const rule = JOURNEY.recorded[kind];
  if (!rule) return null;
  const label = clean(facts[rule.label] ?? words[rule.label] ?? '');
  const kept = Object.fromEntries(rule.facts.map(name => [name, clean(facts[name])]).filter(([, value]) => value));
  const spoken = content ? Object.fromEntries((rule.words ?? []).map(name => [name, clean(words[name], 8000)]).filter(([, value]) => value)) : {};
  return { at: now, surface: rule.surface, kind, label, facts: Object.keys(spoken).length ? { ...kept, words: spoken } : kept };
}

/**
 * Keeps events for one account if it shares its activity. `events` are { kind, facts, words?, at? }. Never throws.
 * → the number kept.
 */
async function recordJourney(env, account, events) {
  if (!account || !env?.journeyLog || !events?.length) return 0;
  if (env.operatorAccount && account === env.operatorAccount) return 0;
  try {
    const sharing = await readSharing(env, account);
    if (!sharing.activity) return 0;
    const rows = events.map(event => journeyRow(event.kind, event.facts, event.words, { content: sharing.content, now: event.at ?? Date.now() })).filter(Boolean);
    if (!rows.length) return 0;
    await journeyLog(env, journeyShardOf(account)).journeyKeep({ account, events: rows });
    return rows.length;
  } catch (error) {
    console.error('journey not kept:', String(error?.message ?? error));
    return 0;
  }
}

/** Removes everything HQ kept about one account's journey (it turned activity off, or deleted the account). */
async function forgetJourney(env, account, {required=false}={}) {
  if (!account || !env?.journeyLog) {
    if (required) throw new Error('Journey erasure requires an account and an authorized journey log.');
    return 0;
  }
  try { return (await journeyLog(env, journeyShardOf(account)).journeyForget({ account })).removed; }
  catch (error) { if(required)throw error;console.error('journey not forgotten:', String(error?.message ?? error)); return 0; }
}

/** The SQL that matches a trouble event (src records `journey.struggling.trouble`), with its values. */
function troubleWhere() {
  const parts = [];
  const values = [];
  for (const row of JOURNEY.struggling.trouble) {
    if (row.labels?.length) { parts.push(`(kind = ? AND label IN (${row.labels.map(() => '?').join(', ')}))`); values.push(row.kind, ...row.labels); }
    else { parts.push('kind = ?'); values.push(row.kind); }
  }
  return { sql: parts.join(' OR ') || '0', values };
}

/** Every customer's journey summary, read from every shard and put in HQ's order: struggling first, then the most
 *  recently seen. → [{ account, last_seen, total, recent, by_kind, trouble, struggling, timeline }] */
async function readJourneys(env, now = Date.now()) {
  if (!env?.journeyLog) throw new Error('An authorized journey log is required to read customer journeys.');
  const shards = await Promise.all(Array.from({ length: Math.max(1, JOURNEY.shards) }, (_, shard) => journeyLog(env, shard).journeyRead({ now })));
  return shards.flat().sort((a, b) => Number(b.struggling) - Number(a.struggling) || b.trouble - a.trouble || b.last_seen - a.last_seen).slice(0, JOURNEY.most_customers);
}

return { JOURNEY, journeyShardOf, journeyLog, journeyRow, recordJourney, forgetJourney, troubleWhere, readJourneys };
}

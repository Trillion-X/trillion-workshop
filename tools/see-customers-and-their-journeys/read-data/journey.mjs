// Source-first port; configuration is supplied by authenticated list rows.

export function createJourney(reports) {
// src/journey.mjs
//
// PURPOSE
//   The per-customer journey the operator reads: one row per thing a customer did (account, at, surface, kind, label,
//   facts). This module decides values only: which rows an event may become, and the summary HQ reads from the rows the
//   store keeps. It keeps nothing and reads nothing itself (rule a-tool-is-only-what-the-store-cannot-do; recipe
//   workflow:keep-customer-journeys-and-their-choices keeps the rows, sweeps them, erases them and reads them back). It
//   never sits in a person's store, and it is never mixed with the anonymous counts (read-data/interactions.mjs).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is kept for an account whose `activity` choice is off (src/hq-sharing.mjs), and nothing is kept for the operator
//      account (OPERATOR_ACCOUNT_ID), which is not a customer.
//   2. A row keeps only the facts its kind's rule names, each cut to `label_chars`; a page or click keeps its route group,
//      never a name, id or code after it. Free text (a report's words, a notice's body) is kept only when the account's
//      `content` choice is on, and only the words the rule names.
//   3. No kind, surface, fact or threshold is named in code: each is a row of records/hq-reports.json.
//   4. The rows of one account are the ones erased when it turns activity off or deletes its account.
//   5. A row is out of the summary, and due for the sweep, after `keep_days`.
//

const JOURNEY = reports.journey;
const DAY_MS = 86400000;
const clean = (value, max = JOURNEY.label_chars) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

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
 * The rows one account's events keep, as values for the store to keep; none when the account shares no activity or is
 * the operator account. `events` are { kind, facts, words?, at? }; `sharing` is what sharingOf says of the account.
 */
function journeyRows(account, events, sharing, { operatorAccount, now = Date.now() } = {}) {
  if (!account || !events?.length) return [];
  if (operatorAccount && account === operatorAccount) return [];
  if (!sharing.activity) return [];
  return events.map(event => journeyRow(event.kind, event.facts, event.words, { content: sharing.content, now: event.at ?? now }))
    .filter(Boolean)
    .map(row => ({ account, ...row }));
}

/**
 * Every customer's journey summary from the kept rows (each { id, account, at, surface, kind, label, facts }), in HQ's
 * order: struggling first, then the most recently seen. → [{ account, last_seen, total, recent, by_kind, trouble,
 * struggling, timeline }]
 */
function summarizeJourneys(rows, now = Date.now()) {
  const since = now - JOURNEY.struggling.days * DAY_MS;
  const retained = now - JOURNEY.keep_days * DAY_MS;
  const groups = new Map();
  for (const row of rows) {
    if (row.at < retained) continue;
    if (!groups.has(row.account)) groups.set(row.account, []);
    groups.get(row.account).push(row);
  }
  return [...groups].map(([account, events]) => {
    const recent = events.filter(event => event.at >= since);
    const trouble = recent.filter(event => JOURNEY.struggling.trouble.some(rule => rule.kind === event.kind && (!rule.labels?.length || rule.labels.includes(event.label)))).length;
    const byKind = new Map();
    for (const event of recent) byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
    return { account, last_seen: Math.max(...events.map(event => event.at)), total: events.length, recent: recent.length,
      trouble, struggling: trouble >= JOURNEY.struggling.at_least,
      by_kind: Object.fromEntries([...byKind].sort(([a], [b]) => a.localeCompare(b))),
      timeline: events.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, JOURNEY.timeline).map(({ account: _account, id: _id, ...event }) => event) };
  }).sort((a, b) => b.trouble - a.trouble || b.last_seen - a.last_seen).slice(0, JOURNEY.most_customers);
}

/** The ids of the rows older than the retention window: what the sweep removes. */
const expiredJourneyIds = (rows, now = Date.now()) => rows.filter(row => row.at < now - JOURNEY.keep_days * DAY_MS).map(row => row.id);

/** The ids of one account's rows: what erasure removes when the account turns activity off or is deleted. */
const journeyIdsOf = (rows, account) => rows.filter(row => row.account === account).map(row => row.id);

return { JOURNEY, journeyRow, journeyRows, summarizeJourneys, expiredJourneyIds, journeyIdsOf };
}

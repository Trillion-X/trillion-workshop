// src/setup-checks.mjs
//
// Purpose: the sub-checks of each setup step, read from LIVE owner evidence and said with the values that were found
// (which AIs, which devices, which sources), never a bare "Verified". A step's checks are DATA rows in
// src/setup-policy.json (`requirements[].checks`); this file names no step, no product and no owner. A check says where
// its rows are (`of`, a dotted path into the facts below), which of them count (`where`), how they are named (`pick`),
// and the words for found and missing (`found`, `missing`).
//
// Non-Negotiable Invariants:
//   1. A path that cannot be read is UNKNOWN (state null) and says so; it is never missing-and-fine, and never found.
//   2. A check is found only when real rows match. An empty list is not evidence, unless the check is `expect: none`
//      or `expect: all` over nothing, and then its own words say what was (not) listed.
//   3. A step whose row is `live: true` is DONE when every non-optional check of it is found on live owner evidence; that
//      reading is its verification and the found values are kept as its evidence (src/setup-steps.mjs). Nothing passes on
//      partial evidence: one missing or unreadable check keeps the step open and its own words say which one and what to
//      do. A step without `live` keeps the saved workflow's independently verified result as its only proof.
//   4. Words never leave the data: templates only fill values that were read.
//   5. Nothing internal reaches a person: every check's words pass through plainWords (data: `words.plain` in
//      src/setup-policy.json) before they leave this file. A sentence naming an error, an id, an AI client or agent name,
//      a computer name, or a vendor's or operator's policy wording is dropped whole; a check left with nothing to say is
//      calmly "still being set up", never an error and never a raw value.
//   6. Items: a check with `items` (data: `logo` = dotted path to a row's domain, `status` = words filled from the row,
//      `reconnect_status`, `rest` = "hide", `add` = {label, open}, `open` = {label, address, field}) lists each of its rows
//      as a thing with a logo and, when it cannot be read, its own status and reconnect action; a row with `open` opens its
//      own place when pressed. `rest: "hide"` lists only the rows that count: a thing the
//      person does not have or no longer uses is not a gap, so it is not drawn. Its sentence is then not shown for those
//      rows. A check whose source is unknown reports no items and keeps its sentence.
//


import capabilityPolicy from './setup-policy.json' with { type: 'json' };
import { logoOf } from './site-icon-url.mjs';

const FEW = 3;
const at = (root, path) => String(path).split('.').reduce((here, key) => here == null ? undefined : here[key], root);
const present = value => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim()) && !(Array.isArray(value) && !value.length);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clock = value => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
};
const few = list => list.length > FEW ? `${list.slice(0, FEW).join(', ')} and ${list.length - FEW} more` : list.join(', ');
const shorten = text => text.length > 120 ? `${text.slice(0, 119)}…` : text;
const FILTERS = {
  time: value => Array.isArray(value) ? value.map(clock).join(', ') : clock(value),
  few: value => Array.isArray(value) ? few(value) : String(value ?? ''),
  short: value => shorten(String(value ?? '')),
};
const text = value => Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value);

/** `{path|filter}` fills a read value; `[ ... ]` is dropped whole when a value inside it was not read. */
export function fillWords(template, scope) {
  let missing = false;
  const filled = String(template).replace(/\{([\w.]+)(?:\|(\w+))?\}/g, (_, path, filter) => {
    const value = at(scope, path);
    if (!present(value)) { missing = true; return ''; }
    return text(filter && FILTERS[filter] ? FILTERS[filter](value) : value);
  });
  return { text: filled, missing };
}
const say = (template, scope) => {
  const withOptional = String(template).replace(/\[([^[\]]*)\]/g, (_, inner) => { const part = fillWords(inner, scope); return part.missing ? '' : part.text; });
  return fillWords(withOptional, scope).text.replace(/\s+/g, ' ').trim();
};

const PLAIN = capabilityPolicy.words.plain;
const lowered = value => (typeof value === 'string' && value.trim().length > 1 ? [value.trim().toLowerCase()] : []);
/** Values that name this person's own machines and accounts, which no screen shows. */
const privateValues = facts => [...new Set([
  ...(Array.isArray(facts?.computers) ? facts.computers.flatMap(row => [...lowered(row?.name), ...lowered(row?.computer_id)]) : []),
  ...lowered(facts?.owned?.profile?.handle),
])];

/**
 * The one plain-words pass: the words with every sentence that names something internal taken out (an error, an id, an
 * AI client or agent name, a computer name or handle, vendor or operator policy wording). `calm` says what a check left
 * with nothing to say says instead; without it nothing is said.
 */
export function plainWords(words, facts = null, { plain = PLAIN, calm = '' } = {}) {
  const internal = plain.internal.map(source => new RegExp(source, 'i'));
  const own = privateValues(facts);
  const kept = String(words ?? '').split(/(?<=[.!?])\s+/).filter(sentence => sentence.trim()
    && !internal.some(pattern => pattern.test(sentence)) && !own.some(value => sentence.toLowerCase().includes(value)));
  return kept.join(' ').trim() || calm;
}

const sameOrNot = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function holds(row, test, now) {
  const value = at(row, test.field);
  if ('is' in test) return sameOrNot(value, test.is);
  if ('not' in test) return !sameOrNot(value, test.not);
  if ('in' in test) return test.in.some(item => sameOrNot(item, value));
  if ('exists' in test) return present(value) === test.exists;
  if ('gt' in test) return Number(value) > test.gt;
  if ('starts_with' in test) return typeof value === 'string' && value.startsWith(test.starts_with);
  if ('within_hours' in test) { const ms = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) && now - ms >= 0 && now - ms <= test.within_hours * 3600_000; }
  return false;
}

/** One check against the facts: { id, label, state: true | false | null, text }. */
export function evaluateCheck(check, facts, options) {
  const { now = Date.now(), words } = options;
  const base = { id: check.id, label: check.label, ...(check.optional ? { optional: true } : {}) };
  const source = at(facts, check.of);
  if (source === undefined || source === null) return { ...base, state: null, text: plainWords(words.unknown, facts, { plain: words.plain ?? PLAIN, calm: (words.plain ?? PLAIN).still }) };
  let rows = Array.isArray(source) ? source : [source];
  if (check.spread) rows = rows.flatMap(row => Array.isArray(row?.[check.spread]) ? row[check.spread] : []);
  const choices = [check.pick ?? '{value}'].flat();
  const name = row => {
    const scope = typeof row === 'object' && row !== null ? row : { value: row };
    // A name needs every value it mentions; a template with an unread value falls through to the next one.
    for (const choice of choices) { const filled = fillWords(choice, scope); if (!filled.missing && filled.text.trim()) return filled.text.trim(); }
    return '';
  };
  const matching = rows.filter(row => (check.where ?? []).every(test => holds(row, test, now)));
  const rest = rows.filter(row => !matching.includes(row));
  const expect = check.expect ?? 'some';
  const state = expect === 'none' ? matching.length === 0 : expect === 'all' ? rest.length === 0 : matching.length >= (check.need ?? 1);
  // A value kept from an earlier read says when it was read (`known_at`, src/setup-known.mjs), in the words `as_of`.
  // The owner a check reads is its first two path parts (`owned.connections`, `ai.apps`, `components.<id>`); its kept time is keyed by that.
  const ownerKey = String(check.of).split('.').slice(0, 2).join('.');
  const asOf = fillWords(words?.as_of ?? '', { at: at(facts, `known_at.${ownerKey}`) });
  const scope = { names: matching.map(name).filter(Boolean), rest: rest.map(name).filter(Boolean), count: matching.length, total: rows.length, first: matching[0] ?? rows[0], as_of: asOf.missing ? '' : asOf.text };
  const template = state ? (rows.length || expect !== 'all' ? check.found : check.found_empty ?? check.found) : check.missing;
  const plain = options.words.plain ?? PLAIN;
  // Items mode (data: `items` on the check): each row is a thing the person has, drawn as a name with its logo (`items.logo`
  // is a dotted path to the row's domain). A row the check cannot read carries its own status and reconnect action, and the
  // check's add action is offered once. Items replace the sentence for these rows; an empty list keeps the sentence.
  const logo = row => (check.items?.logo ? logoOf(at(row, check.items.logo)) : '');
  const item = (row, extra) => { const label = name(row); return label ? { name: label, ...(logo(row) ? { logo: logo(row) } : {}), ...extra } : null; };
  // A row that names its own place (data: `items.open` = {label, address, field}) opens there: the address followed by that
  // row's field, so a pursuit listed in a step opens itself from inside the step (a press, never an open by itself).
  const opens = row => {
    const open = check.items?.open, value = open && typeof row === 'object' && row !== null ? row[open.field] : null;
    return typeof value === 'string' && value ? { label: open.label, tone: 'quiet', open: `${open.address}${encodeURIComponent(value)}` } : null;
  };
  const items = check.items ? [
    ...matching.map(row => {
      const own = check.items.status ? say(check.items.status, typeof row === 'object' && row !== null ? row : { value: row }) : '';
      const label = [own, asOf.missing ? '' : asOf.text].filter(Boolean).join(' ');
      return item(row, { ...(label ? { status: { label, tone: 'quiet' } } : {}), ...(opens(row) ? { action: opens(row) } : {}) });
    }),
    ...(check.items.rest === 'hide' ? [] : rest).map(row => item(row, {
      ...(check.items.reconnect_status ? { status: { label: check.items.reconnect_status, tone: 'attention' } } : {}),
      ...(check.reconnect ? { action: { label: say(check.reconnect.label, { service: name(row) }), tone: 'quiet', open: check.reconnect.screen } } : {}),
    })),
  ].filter(Boolean) : null;
  // Each row the check cannot read gets its own action (data: `reconnect` on the check), so a broken reader is fixed by its own button.
  // Items mode carries those actions on its items instead.
  const reconnect = check.reconnect && rest.length && !check.items ? rest.map(name).filter(Boolean).map(service => ({ label: say(check.reconnect.label, { service }), screen: check.reconnect.screen })) : [];
  return { ...base, state, text: plainWords(say(template, scope), facts, { plain, calm: state ? '' : plain.still }), ...(!state && check.open ? { open: check.open } : {}),
    // "Add another" follows things already there; with none, the step's own action is the one way to start.
    ...(items ? { items } : {}), ...(items?.length && check.items?.add ? { add:{ label: check.items.add.label, tone: 'quiet', open: check.items.add.open } } : {}),
    ...(reconnect.length ? { reconnect } : {}) };
}

/** A step's checks, and what they add up to: observed (every needed check found), not observed, or unknown. */
export function evaluateChecks(checks, facts, options) {
  const results = (Array.isArray(checks) ? checks : []).map(check => evaluateCheck(check, facts, options));
  const needed = results.filter(result => !result.optional);
  const observed = !needed.length ? null : needed.every(result => result.state === true) ? true : needed.some(result => result.state === false) ? false : null;
  // The first check that is not found says where to go (data: `open` on the check), so a person is pointed to the fix.
  const open = needed.find(result => result.state === false && result.open)?.open ?? null;
  // While the observed value is unknown, the step says how many of its checks are found so far ("1 of 2").
  const progress = observed === null && needed.length ? { done: needed.filter(result => result.state === true).length, total: needed.length,
    label: `${needed.filter(result => result.state === true).length} of ${needed.length}` } : null;
  return { checks: results, observed, open, progress, items: results.flatMap(result => result.items ?? []),
    add: results.find(result => result.add)?.add ?? null, reconnect: results.flatMap(result => result.reconnect ?? []) };
}

/** The accounts a person has connected, one row per service, for the setup screen's own words. A row is named by its
 *  service's display name only: an account's own label can be a stale or wrong name for the person, and two sign-ins of
 *  one service are one thing they use. A raw id is never shown: with no name anywhere the vendor is title-cased. A service
 *  reads as connected when any of its accounts is, so an old disconnected sign-in beside a working one is settled, not
 *  reported. */
export function namedConnections(rows) {
  const byLabel = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const service = String(row?.service ?? '').trim() || String(row?.vendor ?? '').split(/[-_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
    const label = service;
    const status = row?.status ?? 'connected', seen = byLabel.get(label);
    if (label && (!seen || status === 'connected')) byLabel.set(label, { vendor: row.vendor, label, status: seen?.status === 'connected' ? 'connected' : status });
  }
  return [...byLabel.values()];
}

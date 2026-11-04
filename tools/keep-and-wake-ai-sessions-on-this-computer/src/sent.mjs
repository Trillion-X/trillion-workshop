// src/sent.mjs
//
// Purpose
//   Sent: one record of everything a person's AIs sent out in the world (an email, a post, a comment, a direct
//   message, a reply, an order, anything), kept as the person's own record type `sent` (src/your-records.mjs shape:
//   EEAF type `record:sent`, id `record:sent:<id>`). Three roads keep one, all through recordSent:
//     - a Workshop run whose row declares `invoke.external_effect.sent` (src/workshop.mjs finish, reading the run's
//       output and input through sentFromRun), under the run's task id;
//     - record_sent, for something an AI sent by any other road (src/person-store.mjs POST /sent), under the id it
//       gives or a new random one;
//     - an invitation's mail dispatch (src/person-spaces.mjs), with the actual rendered identity and provider receipt.
//   No code here names a service, a kind or a field of one.
//   How each kind reads (its label, icon, view, title and preview fields and the link that opens it where it went) is
//   DATA: records/sent-kinds.json, read here and handed to the screen with every page, together with that file's `view`
//   (the list's columns, empty words and opened-record roles), which the one shared record-set screen draws.
//
// Record shape (the contract the Sent list and every reader build against)
//   { id, kind, to: [string], from, reply_to, subject, preheader, body_markdown, body_text, body_html, sent_at (ISO),
//     provider, provider_id, open_url, copies: [{ to, how }], by: { tool_id, task_id, app }, state: 'sent' }
//   Every field but kind, to, body_markdown, sent_at, copies, by and state may be null.
//
// Non-negotiable invariants
//   1. One owner: every sent record is written by recordSent and read by listSent/readSent; nothing else writes the
//      `record:sent` type.
//   2. A kind with no row in records/sent-kinds.json is refused when kept (the known ids are named), and a stored
//      record whose kind lost its row reads as `other`.
//   3. The same id kept again replaces the record; its earlier values stay in the EEAF log.
//   4. listSent reads one page: the newest kept records (by the sent_at fact's own index, never every record whole),
//      ordered newest first by sent_at.
//   5. An open link is the record's own open_url, else its kind's url_template with every hole filled; one empty or
//      unknown hole means no link, never a half-filled one.
//
import { executionText, providerObservation } from './execution-context.mjs';
import SENT_KINDS from '../records/sent-kinds.json' with { type: 'json' };
import { selectDeclaredValue } from '../../ui/read-data/declared-selector.ts';
import { claimedTime } from './claimed-time.mjs';

export { SENT_KINDS };

const TYPE = 'record:sent';
const LIMITS = { page_default: 50, page_max: 200, id_chars: 200, preview_chars: 200, recipients: 100 };
const FALLBACK_KIND = 'other';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() ? value : null);
const addresses = value => (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]).map(item => String(item).trim()).filter(Boolean);

/** The kind row a record reads with: its own, or `other`. */
export function kindOf(kind, kinds = SENT_KINDS.kinds) {
  return kinds.find(row => row.id === kind) ?? kinds.find(row => row.id === FALLBACK_KIND);
}

// One field of a kind's mapping read from a finished run: `{ from: "output" | "input" | "item", path: "$..." }` reads a
// value, `{ value }` is that value, and `each: { field: mapping }` turns every item of a list into an object read from
// that item (`from: "item"`). A path that is not there reads as null.
function mapped(spec, sources) {
  if (!object(spec)) return null;
  if ('value' in spec) return spec.value;
  const found = selectDeclaredValue(sources[spec.from], spec.path ?? '$');
  if (object(found) && 'selector_contract_error' in found) return null;
  if (object(spec.each) && Array.isArray(found)) return found.map(item => Object.fromEntries(Object.entries(spec.each).map(([field, inner]) => [field, mapped(inner, { ...sources, item })])));
  return found ?? null;
}

/**
 * The sent record a finished run declares, from its row's `invoke.external_effect.sent`:
 * { kind, only_when?: { from, path, equals }, fields: { <record field>: mapping } } → a record value, or null when
 * `only_when` does not hold (a run that finished without sending anything).
 */
export function sentFromRun(mapping, { output, input }) {
  if (!object(mapping) || !object(mapping.fields)) return null;
  const sources = { output, input };
  if (object(mapping.only_when) && mapped(mapping.only_when, sources) !== mapping.only_when.equals) return null;
  return { kind: mapping.kind, ...Object.fromEntries(Object.entries(mapping.fields).map(([field, spec]) => [field, mapped(spec, sources)])) };
}

// A record value in its one stored shape, or an error naming what is wrong in words an AI can act on.
function sentRecord(id, value, now) {
  const kinds = SENT_KINDS.kinds;
  if (!kinds.some(row => row.id === value.kind)) throw new Error(`kind must be one of ${kinds.map(row => row.id).join(', ')}; ${JSON.stringify(value.kind)} is not one.`);
  const to = addresses(value.to);
  if (!to.length || to.length > LIMITS.recipients) throw new Error(`to names who it went to: between 1 and ${LIMITS.recipients} addresses, handles or places.`);
  const words = text(value.body_markdown) ?? text(value.body_text);
  if (!words) throw new Error('body_markdown holds the exact words that were sent.');
  const sentAt = value.sent_at ?? now;
  if (typeof sentAt !== 'string' || Number.isNaN(Date.parse(sentAt))) throw new Error(`sent_at is when it went out, a date and time like 2026-09-30T14:00:00Z; ${JSON.stringify(value.sent_at)} is not one.`);
  // Something that went out has already gone: a time still to come is refused (src/claimed-time.mjs).
  claimedTime(sentAt, { now: new Date(now), field: 'sent_at' });
  const copies = (Array.isArray(value.copies) ? value.copies : []).filter(object).map(copy => ({ to: String(copy.to ?? '').trim(), how: text(copy.how) ?? 'bcc' })).filter(copy => copy.to);
  const by = object(value.by) ? value.by : {};
  return {
    id, kind: value.kind, to,
    from: text(value.from), reply_to: text(value.reply_to), subject: text(value.subject), preheader: text(value.preheader),
    body_markdown: words, body_text: text(value.body_text), body_html: text(value.body_html),
    sent_at: new Date(sentAt).toISOString(),
    provider: text(value.provider), provider_id: text(value.provider_id), open_url: text(value.open_url),
    copies, by: { tool_id: text(by.tool_id), task_id: text(by.task_id), app: text(by.app) }, state: 'sent',
    execution_ref: executionText(value.execution_ref, 'execution_ref'),
    effect_ref: executionText(value.effect_ref, 'effect_ref'),
    provider_account: executionText(value.provider_account, 'provider_account'),
    origin: ['real', 'synthetic', 'unknown'].includes(value.origin) ? value.origin : 'unknown',
    recorded_by: object(value.recorded_by) ? { app: text(value.recorded_by.app), reader: text(value.recorded_by.reader), at: text(value.recorded_by.at) ?? now } : null,
    ...(value.observation ? { observation: providerObservation(value.observation, { basis: value.observation.basis === 'provider_response' ? 'provider_response' : 'claimed', now, origin: value.origin ?? 'unknown' }) } : {}),
  };
}

/**
 * Keeps one sent record: `value` in the record shape above, with an optional `id` (text without "/"; a new random id
 * when absent). `actor` is who kept it, for the EEAF log ({ by, task_id? }). → { id }.
 */
export function recordSent(eeaf, { id, ...value } = {}, actor = {}) {
  const recordId = id === undefined || id === null ? crypto.randomUUID() : id;
  if (typeof recordId !== 'string' || !recordId.trim() || recordId.length > LIMITS.id_chars || recordId.includes('/')) throw new Error(`id is the record's own id, text of at most ${LIMITS.id_chars} characters without "/"; ${JSON.stringify(id)} is not one.`);
  const record = sentRecord(recordId, value, new Date().toISOString());
  eeaf.write([{ id: `${TYPE}:${recordId}`, type: TYPE, value: record }], { actor: { by: actor.by ?? record.recorded_by?.reader ?? record.recorded_by?.app ?? record.by.tool_id ?? record.by.app ?? 'unknown recorder', ...(record.by.task_id ? { task_id: record.by.task_id } : {}) } });
  return { id: recordId };
}

/** One sent record by its id, or null. */
export function readSent(eeaf, id) {
  if (typeof id !== 'string' || !id || id.includes('/')) return null;
  return eeaf.read(`${TYPE}:${id}`) ?? null;
}

/** The newest sent records, newest first by sent_at: a page of at most `limit` (default 50, at most 200). */
export function listSent(eeaf, { limit, before } = {}) {
  const page = Math.max(1, Math.min(LIMITS.page_max, Math.floor(Number(limit) || LIMITS.page_default)));
  const selected = eeaf.indexPage(TYPE, 'sent_at', { before, limit: page });
  const records = eeaf.readMany(selected.map(found => found.id));
  return selected.map(found => records.get(found.id)).filter(object);
}

// The link that opens a record where it went, from its kind's `open_outside`.
function openOf(record, kind) {
  const outside = object(kind?.open_outside) ? kind.open_outside : null;
  if (text(record.open_url)) return { label: outside?.label ?? kind?.label ?? 'Open', url: record.open_url };
  if (!outside || !text(outside.url_template)) return null;
  const holes = object(outside.holes) ? outside.holes : {};
  const trimmed = (value, marks) => {
    let word = value.trim();
    while (word && marks.includes(word[0])) word = word.slice(1);
    while (word && marks.includes(word.at(-1))) word = word.slice(0, -1);
    return word;
  };
  let missing = false;
  const url = outside.url_template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const hole = object(holes[name]) ? holes[name] : null;
    const raw = hole ? record[hole.field] : record[name];
    const value = typeof raw === 'string' ? (hole ? trimmed(raw, Array.isArray(hole.trim) ? hole.trim : []) : raw.trim()) : '';
    if (!value) missing = true;
    return encodeURIComponent(value);
  });
  return missing ? null : { label: outside.label, url };
}

/** A record as a row reads it: the record plus { id, title, preview, open: { label, url } | null }. */
export function itemOf(record, kinds = SENT_KINDS.kinds) {
  const kind = kindOf(record.kind, kinds);
  const words = text(record[kind?.preview_field]) ?? text(record.body_text) ?? text(record.body_markdown) ?? '';
  const flat = words.replace(/\s+/g, ' ').trim();
  return {
    ...record,
    id: record.id,
    title: text(record[kind?.title_field]),
    preview: flat.length > LIMITS.preview_chars ? `${flat.slice(0, LIMITS.preview_chars).trimEnd()}…` : flat,
    open: openOf(record, kind),
  };
}

/** The Sent list's page and list_sent's answer: { view, kinds, items } newest first. `view` is records/sent-kinds.json's
 *  view DATA, so the one shared record-set screen draws this page without knowing it is Sent. */
export function sentPage(eeaf, { limit, before } = {}) {
  const page = Math.max(1, Math.min(LIMITS.page_max, Math.floor(Number(limit) || LIMITS.page_default)));
  const selected = eeaf.indexPage(TYPE, 'sent_at', { before, limit: page });
  const records = eeaf.readMany(selected.map(found => found.id));
  const items = selected.map(found => records.get(found.id)).filter(object)
    .map(record => itemOf(record));
  return { view: SENT_KINDS.view, kinds: SENT_KINDS.kinds, items,
    ...(selected.length === page && selected.length ? { next_page: selected.at(-1).cursor } : {}) };
}

/** One record as the Sent screen opens it: { item } or null. */
export function sentItem(eeaf, id) {
  const record = readSent(eeaf, id);
  return record ? { item: itemOf(record) } : null;
}

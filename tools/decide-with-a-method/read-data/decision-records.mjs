// tools/decide-with-a-method/read-data/decision-records.mjs
//
// How a decision is laid out in the person's records, so that a decision of any size keeps every record small (`record_bytes`). The root `decision` record holds only fields each set by one call (the goal, the options,
// bounded at start by `options` in the settings, the current decision, a share, a plan) and counts and pointers: nothing
// in it grows as the decision grows. Everything that grows is
// a record of its own, linked to the decision's id, named in `records` of read-data/decide-with-a-method.json:
//
//   decision-evidence:<id>:<nnnn>        one evidence row { ref, claim, added_at?, from?, retracted_at? }
//   decision-answered-step:<id>:<nnn>:c<identity>  one answered step's summary (counts, version, needs_recheck), write-once
//   decision-evidence:<id>:<nnnn>:c<identity>  (and every other laid-apart list: reports, candidates, ...), write-once
//   decision-step:<id>:<nnn>:c<identity>[:v<vvv>]  one answered step whole (its answer, checks, verdicts), write-once; each old version
//   decision-refs:<id>:c<identity>       the per-index identities of the steps and summaries the root holds (`refs` on the root)
//   decision-candidate:<id>:<nnn>        one candidate a step left standing
//   decision-report:<id>:<nnnn>          one result the person reported; decision-carried-out:<id>:<nnnn> one receipt
//   decision-history:<id>:<nnn>          one earlier decision; decision-cited-pursuit:<id>:<nnnn> one cited pursuit
//   decision-call:<id>:<nnnnnn>          one logged call of a decision once kept whole
//   decision-method:<identity>           the method snapshot, kept once by its content identity and shared by it
//   decision-part:<key>:part:<nnn>       a piece of any one of these too large for one record (`record_bytes`)
//   decision-part:<id>:root-fields:part:<nnn>  the root's largest fields, when the root alone is over `record_bytes`
//                                        (named on the root in `fields_in_parts`, and put back on it when read)
//
// The root names each list's length (`counts`), its method's id and identity, and the identity of the input it was
// started with, so the same source with the same input is still that decision. A root written before this layout
// (evidence, options, reports and the rest inside it, the method snapshot inline, `answered_steps` on it, or the whole
// guidance in it) reads as it is and is laid apart at its next change. A root written while options were laid apart too
// (`decision-option:<id>:<nnn>`, counted in `counts.options`) reads them back, and its next change folds them into the
// root's input again and removes those records. A record too large for `record_bytes` goes in parts, and the root is
// kept last, so a reader never meets a root that counts records not written yet; a reader takes only the first `counts`
// items of each list, so a part a store does not hold is never read (it is refused by name).
// The settings are imported, not read from disk, so the join also runs where this file is bundled (the old engine's Worker).
import settings from './decide-with-a-method.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';


const { records: NAMES } = settings;
const LAID = NAMES.laid_apart;
const utf8 = new TextEncoder();

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Same content in any key order is the same request, so a retried call replays instead of failing.
export const canonical = value => JSON.stringify(value, (key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const identityOf = value => makeHashCodeHexFromBytes(utf8.encode(canonical(value)));
/** The identity of the input a decision was started with: the same source with input of this identity is that decision. */
export const inputIdentity = input => identityOf(input);
const bytesOf = value => utf8.encode(JSON.stringify(value)).length;

const pad = (n, digits) => String(n).padStart(digits, '0');
const stepKey = (id, n) => `${NAMES.step}${id}:${pad(n, NAMES.step_digits)}`;
// A superseded version of a step, kept beside the step: its key, then the version (`:v001`, `:v002`, ...).
export const versionKey = (id, n, version) => `${stepKey(id, n)}${NAMES.version}${pad(version, NAMES.version_digits)}`;
const callKey = (id, n) => `${NAMES.call}${id}:${pad(n, NAMES.call_digits)}`;
const itemKey = (list, id, n) => `${LAID[list].type}:${id}:${pad(n, LAID[list].digits)}`;
// Steps and every laid-apart list are write-once: each version of one is kept at its own content identity (`:c<hex>`),
// and the root names the identity of the one it holds per index (`refs`: `step_refs` and `items`). A write puts new records
// under new keys and moves nothing in place, so a write refused before its root lands leaves nothing the root names.
const CONTENT = ':c';
const contentRef = value => identityOf(value);
const stepAt = (id, n, ref) => (ref ? `${stepKey(id, n)}${CONTENT}${ref}` : stepKey(id, n));
const itemAt = (list, id, n, ref) => (ref ? `${itemKey(list, id, n)}${CONTENT}${ref}` : itemKey(list, id, n));
// The per-index references are one write-once record (`decision-refs:<id>:c<hex>`) named by the root's `refs`, so the root
// keeps one identity however many steps a decision has.
const refsKey = (id, ref) => `${NAMES.refs}:${id}${CONTENT}${ref}`;
const methodKey = identity => `${NAMES.method}:${identity}`;
const partKey = (key, n) => `${key}${NAMES.part.suffix}${pad(n, NAMES.part.digits)}`;

// A logged call keeps what it was, never the payload it carried (the old store kept those apart and bounded).
const bareCall = call => (object(call) ? Object.fromEntries(Object.entries(call).filter(([field]) => !['submission', 'problems'].includes(field))) : call);
// A step's checks are kept as { checks } and its verdicts as { given } (a store keeps objects, not lists, once);
// callers read and write the lists.
const PACKED = { checklist: 'checks', verdicts: 'given' };
const packStep = entry => (object(entry) ? Object.fromEntries(Object.entries(entry).map(([field, item]) => [field, PACKED[field] && Array.isArray(item) ? { [PACKED[field]]: item } : item])) : entry);
export const unpackStep = entry => (object(entry) ? Object.fromEntries(Object.entries(entry).map(([field, item]) => [field, PACKED[field] && object(item) && Array.isArray(item[PACKED[field]]) ? item[PACKED[field]] : item])) : entry);
// Whether a step needs a recheck is kept on its summary only, so flagging later steps never rewrites their records.
const FLAGS = ['needs_recheck', 'recheck_of', 'rechecked_at'];
/** The fields an answered step's summary carries that its own record does not (a flag is set on the summary only). */
export const STEP_FLAGS = ['version', ...FLAGS];
const stepRecordOf = entry => Object.fromEntries(Object.entries(entry).filter(([field]) => !FLAGS.includes(field)));
// A step read whole carries its verdicts; a step read as its summary carries the counts already made from them.
const gradingOf = entry => (Array.isArray(entry.verdicts)
  ? { checks: entry.judged_checks ?? entry.verdicts.length, graded: entry.verdicts.length, graded_by: [...new Set(entry.verdicts.map(verdict => verdict.graded_by))].join(', ') }
  : Object.fromEntries(['checks', 'graded', 'graded_by'].filter(field => entry[field] !== undefined).map(field => [field, entry[field]])));
// Which version is current and whether it stands to be asked again. A step answered before versions existed is version 1.
const flagsOf = entry => ({
  version: entry.version ?? 1, needs_recheck: entry.needs_recheck === true,
  ...(entry.recheck_of ? { recheck_of: entry.recheck_of } : {}), ...(entry.rechecked_at ? { rechecked_at: entry.rechecked_at } : {}),
});
const stubOf = entry => ({ step_id: entry.step_id, answered_at: entry.answered_at, ...gradingOf(entry), ...flagsOf(entry) });
// A step whose record cannot be read keeps its summary's times and no step_id: the identity field is what makes it a step.
const lostStep = stub => ({ answer: {}, answered_at: stub?.answered_at ?? null });

// The lists laid apart, by the name of their count on the root: where each lives on the decision as the tools use it.
// `answered_steps` is the decision's guidance as summaries, kept by recordsOf and readDecision themselves.
const LISTS = {
  evidence: { from: record => record.input?.evidence, into: (record, items) => { record.input = { ...record.input, evidence: items }; } },
  candidates: { from: record => record.candidates, into: (record, items) => { if (items.length) record.candidates = items; } },
  reports: { from: record => record.reports, into: (record, items) => { if (items.length) record.reports = items; } },
  carried_out: { from: record => record.carried_out, into: (record, items) => { if (items.length) record.carried_out = items; } },
  decision_history: { from: record => record.decision_history, into: (record, items) => { if (items.length) record.decision_history = items; } },
  // A cited pursuit is kept as { ref, said }; the decision reads them as one map from ref to what it said then.
  cited_pursuits: {
    from: record => (object(record.cited_pursuits) ? Object.entries(record.cited_pursuits).map(([ref, said]) => ({ ref, said })) : undefined),
    into: (record, items) => { if (items.length) record.cited_pursuits = Object.fromEntries(items.map(item => [item.ref, item.said])); },
  },
};
const LIST_NAMES = Object.keys(LISTS);
// Options were laid apart for a while; such a root's options are read back and folded into its input at its next change.
const FOLDED = 'options';
// Fields of a root written before this layout that this layout keeps elsewhere.
// The root's per-index references to write-once records (see stepAt, itemAt); never copied into the decision a tool reads.
const REFS = ['refs'];
const MOVED = ['answered_steps', 'original_input', 'candidates', 'reports', 'carried_out', 'decision_history', 'cited_pursuits'];

// What was read of each laid-apart list and the method, so a write keeps only what changed.
const LOADED = new WeakMap();
const REVISION = settings.records.record_revision.type;
const revisionKey = id => `${REVISION}:${id}`;

// What a record can weigh in a store, however the store carries it on the way: its JSON with every character past
// ASCII written as a \u escape, quoted once more as a JSON string. A part's text is itself JSON, so a quote, backslash or
// newline in it is already escaped once, and each further encoding doubles that escape again: a part sized by its plain
// UTF-8 bytes (a 67 KB chat message full of quotes, newlines and emoji) left a write of 46 KB plain that grew to 74 KB
// carried. Sizing parts and records by this measure keeps every record under `record_bytes` as a store carries it.
const PAST_ASCII = /[\u007f-\uffff]/g;
const escaped = char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
const carriedText = text => JSON.stringify(text.replace(PAST_ASCII, escaped));
/** The most bytes `value` can take in a store: its JSON, past-ASCII escaped, quoted once more. Never under its UTF-8. */
export const carriedBytes = value => carriedText(JSON.stringify(value)).length;
// What one character of a string adds to its record's carried bytes (each character's escapes are its own).
const QUOTED = carriedBytes('');
const charBytes = new Map();
const carriedChar = char => {
  let size = charBytes.get(char);
  if (size === undefined) charBytes.set(char, size = carriedBytes(char) - QUOTED);
  return size;
};

// A record larger than `record_bytes` (carried) is kept as its short fields with the count of its parts (`kept_in_parts`),
// and its whole value as text in parts of `decision-part`, each under the bound as carried; it reads back whole.
function cut(text, bound) {
  const parts = [];
  let part = '', held = 0;
  for (const char of text) {
    const size = carriedChar(char);
    if (held + size > bound && part) { parts.push(part); part = ''; held = 0; }
    part += char;
    held += size;
  }
  return part ? [...parts, part] : parts;
}
// A root over `record_bytes` (carried) keeps its largest fields, largest first, as one value laid apart in parts of
// `decision-part` under <its id> + ROOT_FIELDS, until it fits: the root names them in `fields_in_parts` and the number of
// parts in `root_fields_in_parts`, and a reader puts them back (joinLaid). An old-layout root with a 100 KB
// `method_history` was too large for any write; the fields that say what the decision is and where it stands never move.
const ROOT_FIELDS = ':root-fields';
const IN_PARTS = 'fields_in_parts';
const PARTS_COUNT = 'root_fields_in_parts';
const ROOT_BOOKKEEPING = [IN_PARTS, PARTS_COUNT];
const STAYS = new Set([
  'id', 'status', 'previous_status', 'ended_at', 'ended_by', 'ended_because', 'decided_at', 'created_at', 'source_id',
  'method_id', 'method_identity', 'input_identity', 'counts', 'decision', IN_PARTS, PARTS_COUNT,
]);
const staysOnRoot = field => STAYS.has(field) || field.startsWith('ended_');
const rootFieldsKey = id => `${id}${ROOT_FIELDS}`;
const partShell = key => carriedBytes({ id: partKey(key, 10 ** NAMES.part.digits - 1), type: NAMES.part.type, value: { of: key, at: 10 ** NAMES.part.digits - 1, text: '' } });
function rootFitted(id, root) {
  const entry = value => ({ id, type: 'decision', value });
  if (carriedBytes(entry(root)) <= settings.record_bytes) return { root, parts: [] };
  const movable = Object.keys(root).filter(field => !staysOnRoot(field)).sort((a, b) => carriedBytes(root[b]) - carriedBytes(root[a]));
  const kept = { ...root };
  const moved = {};
  // The names and count are on the root while it is measured, so the root that fits is the root written.
  const marked = () => ({ ...kept, [IN_PARTS]: Object.keys(moved), [PARTS_COUNT]: 10 ** NAMES.part.digits - 1 });
  for (const field of movable) {
    moved[field] = kept[field];
    delete kept[field];
    if (carriedBytes(entry(marked())) <= settings.record_bytes) break;
  }
  const key = rootFieldsKey(id);
  const texts = cut(JSON.stringify(moved), settings.record_bytes - partShell(key));
  const parts = texts.map((text, n) => ({ id: partKey(key, n), type: NAMES.part.type, value: { of: key, at: n, text } }));
  return { root: { ...kept, [IN_PARTS]: Object.keys(moved), [PARTS_COUNT]: texts.length }, parts };
}
/** The root's fields laid apart in parts (fields_in_parts), put back on it; a root that names none is as it is. */
export function rootFieldsIn(id, root, get) {
  if (!object(root) || !Array.isArray(root[IN_PARTS]) || !Number.isInteger(root[PARTS_COUNT])) return root;
  const { [IN_PARTS]: names, [PARTS_COUNT]: count, ...own } = root;
  const key = rootFieldsKey(id);
  // Every part is asked for at once, so a reader reads them together.
  const parts = Array.from({ length: count }, (_, n) => get(NAMES.part.type, partKey(key, n)));
  if (parts.some(part => part === undefined)) return undefined;
  if (parts.some(part => typeof part?.text !== 'string')) return { ...own, lost_fields: names };
  const text = parts.map(part => part.text).join('');
  let moved;
  try { moved = JSON.parse(text); } catch { return { ...own, lost_fields: names }; }
  return { ...own, ...Object.fromEntries(names.filter(name => name in moved).map(name => [name, moved[name]])) };
}

function fitted(records) {
  const out = [];
  for (const record of records) {
    if (record.value === null || record.type === 'decision' || carriedBytes(record) <= settings.record_bytes) { out.push(record); continue; }
    // Room for the text is the bound less the part record around it, its key at the widest part number.
    const texts = cut(JSON.stringify(record.value), settings.record_bytes - partShell(record.id));
    const short = Object.fromEntries(Object.entries(record.value).filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item) && JSON.stringify(item).length <= 200));
    for (const [n, text] of texts.entries()) out.push({ id: partKey(record.id, n), type: NAMES.part.type, value: { of: record.id, at: n, text } });
    out.push({ id: record.id, type: record.type, value: { ...short, kept_in_parts: texts.length } });
  }
  return out;
}
/**
 * The one check that a record a read depends on is there: a value that is absent or unreadable (null, or a lost entry) is
 * refused with one named error carrying what it was and which record it is. Nothing is returned in its place.
 */
export function mustRead(kind, id, value) {
  const field = settings.identity_fields[kind];
  if (value === null || value === undefined || (field && !Object.hasOwn(value, field))) throw Object.assign(new Error(`${kind} ${id} is not visible to this read. Nothing was changed.`), { code: 'not_visible', kind, id });
  return value;
}
/** A record's value whole: as kept, or put back together from its parts; throws when a part is not visible. */
export function wholeValue(key, value, get) {
  if (!object(value) || !Number.isInteger(value.kept_in_parts)) return value;
  let text = '';
  for (let n = 0; n < value.kept_in_parts; n += 1) {
    const partOf = partKey(key, n);
    const part = get(NAMES.part.type, partOf);
    if (part === undefined) return undefined;
    // A part that is not there is an error, never a missing value: a summary read as lost would be written back as a stub.
    mustRead('part', partOf, typeof part?.text === 'string' ? part : null);
    text += part.text;
  }
  return unpackStep(JSON.parse(text));
}
/** The per-index references of a root (`refs` names the record that holds them); none for a root that names none. */
function refsOf(id, root, get) {
  const none = { step_refs: [], items: {} };
  if (typeof root.refs !== 'string') return none;
  const key = refsKey(id, root.refs);
  const value = get(NAMES.refs, key);
  if (value === undefined) return undefined;
  const kept = wholeValue(key, value, get);
  if (kept === undefined) return undefined;
  // A root that names its refs record reads that record or is refused: an absent record is never read as empty refs.
  mustRead('refs', key, kept);
  return { step_refs: kept.step_refs ?? [], items: kept.items ?? {} };
}
/**
 * The records a call is given: `input.records`, each { id, type, value }, read by the caller from its own store (every record
 * the tool reads: a decision's own records, its method, the rows and pursuits it names). Nothing else is read.
 */
export function recordsIn(input) {
  const records = input?.records ?? [];
  if (!Array.isArray(records) || !records.every(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string' && 'value' in record)) {
    throw new Error('records must be the records the caller read from its own store, each { id, type, value }.');
  }
  return holding(records);
}

/**
 * The records a decision is read from, handed in by the caller: every record its tool reads, each { id, type, value }, as its
 * own store holds it. A record that was not handed in is absent: `get` answers null for it. Values are copied, so a join
 * never changes what was handed in, and `expected` (what a write asserts is still there) is the value as it was handed in.
 */
export function holding(records) {
  const byType = new Map();
  for (const { id, type, value } of records) {
    if (!byType.has(type)) byType.set(type, new Map());
    byType.get(type).set(id, structuredClone(value));
  }
  const held = (type, key) => byType.get(type)?.get(key);
  return {
    get: (type, key) => structuredClone(held(type, key) ?? null),
    expected: (type, key) => (held(type, key) === undefined ? null : { type, value: structuredClone(held(type, key)) }),
    // The rows of one type whose id starts with `prefix` (and whose fields equal `where`), as { id, value }: by id, greatest
    // first, or by the field `order` names (`<type>/<field>`, ascending); `reverse` flips it, `below` keeps the rows whose order key is less than it
    // (a page's cursor), `limit` keeps the first rows and `fields` only these.
    rows(type, { prefix = '', where, fields, order, reverse = false, below, limit } = {}) {
      const ascending = order ? !reverse : reverse;
      // An order names a field of the rows as `<type>/<field>` (work-screen.json, similar); the field is what sorts them.
      const field = order ? order.slice(order.indexOf('/') + 1) : undefined;
      const keyOf = ({ id, value }) => (order ? value?.[field] : id) ?? null;
      const matching = [...(byType.get(type) ?? [])].filter(([id, value]) => id.startsWith(prefix)
        && (!where || Object.entries(where).every(([name, want]) => JSON.stringify(value?.[name]) === JSON.stringify(want)))
        && (below === undefined || (keyOf({ id, value }) !== null && keyOf({ id, value }) < below)))
        .map(([id, value]) => ({ id, value }));
      matching.sort((a, b) => {
        const [x, y] = ascending ? [keyOf(a), keyOf(b)] : [keyOf(b), keyOf(a)];
        return x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
      });
      const found = matching.slice(0, limit).map(({ id, value }) => ({ id, value: fields ? Object.fromEntries(fields.filter(name => value && name in value).map(name => [name, value[name]])) : value }));
      return found;
    },
  };
}

/** One answered step, or one of its versions, whole: its checks and verdicts as lists; null when it cannot be read. */
export const stepIn = (get, key) => {
  const kept = wholeValue(key, get('decision-step', key), get);
  return kept === undefined ? undefined : unpackStep(kept);
};
export const readStep = (held, key) => stepIn(held.get, key);

/** The first `count` items of one list laid apart, in order; one that cannot be read is named as lost. */
export function itemsIn(get, id, list, count, refs = []) {
  if (!count) return [];
  const { type } = LAID[list];
  return Array.from({ length: count }, (_, n) => {
    const key = itemAt(list, id, n, refs[n]);
    const kept = wholeValue(key, get(type, key), get);
    return kept ?? {};
  });
}

/** Whether a root was written by this layout: it names the length of each list laid apart and the input it began with. */
export const isLaid = root => object(root?.counts) && typeof root.input_identity === 'string';

/**
 * The root with the lists named in `lists` put back where the tools read them (`input.evidence`, `reports`, ...), and the
 * method snapshot when `method` is true. A root written before this layout already holds them.
 */
export function joinLaid(id, root, get, lists = LIST_NAMES, { method = false } = {}) {
  const loaded = {};
  const own = rootFieldsIn(id, root, get) ?? root;
  const record = { ...own, input: { ...own.input } };
  const counts = object(own.counts) ? own.counts : null;
  // A root that names its refs record cannot place its items until that record is read: this pass asks for the refs only.
  if (typeof root.refs === 'string' && refsOf(id, root, get) === undefined) return { record, loaded };
  if (counts?.[FOLDED]) {
    const items = itemsIn(get, id, FOLDED, counts[FOLDED], refsOf(id, root, get)?.items?.[FOLDED]);
    loaded[FOLDED] = items.map(canonical);
    record.input.options = items;
  }
  const refs = refsOf(id, root, get) ?? { step_refs: [], items: {} };
  loaded.item_refs = refs.items;
  loaded.step_refs = refs.step_refs;
  for (const list of lists) {
    if (!counts || !LISTS[list]) continue;
    const items = itemsIn(get, id, list, counts[list] ?? 0, refs.items[list]);
    loaded[list] = items.map(canonical);
    LISTS[list].into(record, items);
  }
  if (method && own.method_identity) {
    const key = methodKey(own.method_identity);
    const kept = wholeValue(key, get(NAMES.method, key), get);
    if (kept?.method) { record.method = kept.method; loaded.method_identity = own.method_identity; }
  }
  delete record.counts;
  return { record, loaded };
}
export const laidTogether = (held, id, root, lists, options) => joinLaid(id, root, held.get, lists, options);

// A decision kept apart (its root names its answered steps) or kept whole (its root holds its guidance itself).
const keptWhole = root => Array.isArray(root.guidance) && !Array.isArray(root.answered_steps) && !object(root.counts);

/** The decision with its scope answer whole and every later step as its summary; `steps` names others to read whole. */
export function joinDecision(id, root, get, steps = []) {
  if (keptWhole(root)) return { ...root, id, whole: true };
  const { record, loaded } = joinLaid(id, root, get, LIST_NAMES, { method: true });
  if (typeof root.refs === 'string' && refsOf(id, root, get) === undefined) return { ...record, id, guidance: [] };
  let stubs = Array.isArray(record.answered_steps) ? record.answered_steps : [];
  if (object(root.counts)) {
    const refs = refsOf(id, root, get) ?? { step_refs: [], items: {} };
    stubs = itemsIn(get, id, 'answered_steps', root.counts.answered_steps ?? 0, refs.items.answered_steps);
    loaded.answered_steps = stubs.map(canonical);
    loaded.item_refs = refs.items;
    loaded.step_refs = refs.step_refs;
  }
  const wanted = new Set([0, ...stubs.flatMap((stub, n) => (steps === EVERY_STEP || steps.includes(stub.step_id) ? [n] : []))]);
  const guidance = [];
  for (const [n, stub] of stubs.entries()) {
    if (wanted.has(n)) guidance.push({ ...(stepIn(get, stepAt(id, n, loaded.step_refs?.[n])) ?? lostStep(stub)), ...flagsOf(stub) });
    else guidance.push({ ...stub, ...flagsOf(stub) });
  }
  const { answered_steps: _stubs, refs: _refs, ...own } = record;
  const decision = { ...own, id, guidance };
  LOADED.set(decision, loaded);
  return decision;
}
/** A step that cannot be read is an error, never a stub: no reader returns an entry with no step in it, and no write sees one to keep. */
export function refuseUnreadableSteps(decision) {
  decision.guidance.forEach((entry, n) => mustRead('step', `${decision.id}:${n}`, entry));
  (decision.input?.evidence ?? []).forEach((row, n) => mustRead('evidence', `${decision.id}:${n}`, row));
  return decision;
}
export function readDecision(held, id, steps = [], { lost = false } = {}) {
  const root = held.get('decision', id);
  if (!root) return null;
  mustRead('decision', id, root);
  const joined = joinDecision(id, root, held.get, steps);
  // `lost` is the repair's read (putBackSteps): it is handed the entries whose step cannot be read, to put them right from
  // the case's own records; every other reader is refused them by name.
  const decision = lost ? joined : refuseUnreadableSteps(joined);
  // The revision read with the root is the one the write expects to find (writeDecision keeps it as `expected`).
  LOADED.set(decision, { ...(LOADED.get(decision) ?? {}), revision: readRevision(held, id)?.revision ?? null });
  return decision;
}

/** The revision record of a decision as the held records have it (null when none): read with the root, expected by its write. */
export const readRevision = (held, id) => held.get(REVISION, revisionKey(id));

// Each item of a list that is new or changed since it was read, and a removal for each item past its new end.
function changedItems(id, list, items, was = [], wasRefs = []) {
  const out = [];
  for (const [n, item] of items.entries()) if (canonical(item) !== was[n]) out.push({ id: itemAt(list, id, n, contentRef(item)), type: LAID[list].type, value: item });
  for (let n = items.length; n < was.length; n += 1) out.push({ id: itemAt(list, id, n, wasRefs[n]), type: LAID[list].type, value: null });
  return out;
}
// The reference each item is held at after a write: a changed one at its new identity, an unchanged one where it was read.
const refsAfter = (items, was = [], wasRefs = [], changedOf = item => item) => items.map((item, n) => (canonical(item) !== was[n]
  ? contentRef(changedOf(item)) : (wasRefs[n] ?? null)));

/** The `steps` of a read that asks for every answered step whole, whatever its summary says its step is. */
export const EVERY_STEP = 'every-step';

// The refs records a case was ever given: write-once, one per write, so together the history of what each index named.
function refsHistory(held, id) {
  const out = [];
  for (const row of held.rows(NAMES.refs, { prefix: `${NAMES.refs}:${id}${CONTENT}` })) {
    const value = wholeValue(row.id, row.value, held.get);
    if (object(value)) out.push({ step_refs: value.step_refs ?? [], items: value.items ?? {} });
  }
  return out;
}
// The step and the summary a past refs record named at index n, when both are there and are the same graded step.
function pastStepAt(held, id, n, past) {
  const stepRef = past.step_refs[n];
  const summaryRef = past.items.answered_steps?.[n];
  if (!summaryRef) return null;
  const { get } = held;
  const kept = stepIn(get, stepAt(id, n, stepRef));
  const stub = wholeValue(itemAt('answered_steps', id, n, summaryRef), get(LAID.answered_steps.type, itemAt('answered_steps', id, n, summaryRef)), get);
  const [step, summary] = kept === undefined || stub === undefined ? [undefined, undefined] : [kept, stub];
  return step && summary && summary.checks !== undefined && step.step_id === summary.step_id ? { step, summary, stepRef, summaryRef } : null;
}
const newest = (a, b) => (b === null || (a.step.version ?? 1) > (b.step.version ?? 1)
  || ((a.step.version ?? 1) === (b.step.version ?? 1) && String(a.summary.answered_at) > String(b.summary.answered_at)) ? a : b);

/**
 * Puts right the answered steps of a decision read with every step whole (`EVERY_STEP`): a summary that lost its grading
 * (`checks`) gets, when its step's own record is there, the summary that step makes; when its step's record cannot be read, the
 * summary and step the case's own history of refs named for that index with the highest version. Nothing else changes: the
 * record is made ready for `recordsOf`, which keeps every other reference as it was read.
 * Returns the steps put right and how many answered steps carried their step before.
 */
export function putBackSteps(held, record) {
  const loaded = LOADED.get(record) ?? { answered_steps: [] };
  const was = loaded.answered_steps.map(text => JSON.parse(text));
  const graded = was.filter(stub => stub.checks !== undefined).length;
  const repaired = [];
  let history = null;
  for (const [n, entry] of record.guidance.entries()) {
    if (was[n] === undefined || was[n].checks !== undefined) continue;
    if (entry.step_id !== undefined) {
      if (stubOf(entry).checks !== undefined && was[n].step_id === entry.step_id) repaired.push({ index: n, step_id: entry.step_id, from: 'step' });
      continue;
    }
    history ??= refsHistory(held, record.id);
    let best = null;
    for (const past of history) {
      const found = pastStepAt(held, record.id, n, past);
      if (found) best = newest(found, best);
    }
    if (!best) continue;
    loaded.step_refs = Object.assign([], loaded.step_refs, { [n]: best.stepRef });
    loaded.item_refs = { ...loaded.item_refs, answered_steps: Object.assign([], loaded.item_refs?.answered_steps, { [n]: best.summaryRef }) };
    loaded.answered_steps[n] = canonical(best.summary);
    record.guidance[n] = { ...best.summary };
    repaired.push({ index: n, step_id: best.summary.step_id, from: 'history' });
  }
  // Every summary that is not being put right is written back as it was read.
  const mended = new Set(repaired.map(item => item.index));
  record.guidance = record.guidance.map((entry, n) => (mended.has(n) || n === 0 ? entry : { ...was[n] }));
  return { repaired, answered: graded, total: was.length };
}

/**
 * The records one write keeps: the root with its counts and pointers, the steps at `changed` (indices into the guidance),
 * the superseded versions `archived` ({ key, entry }), and every item of a laid-apart list that is new or changed, with
 * the method snapshot when it was not kept yet. A decision written before this layout is laid apart in this write: its
 * lists and summaries become records of their own (all its steps and calls too, when it was kept whole).
 */
export function recordsOf(record, changed = [], archived = []) {
  const { guidance = [], calls, whole, id, method, input = {}, input_identity: kept, ...rest } = record;
  const loaded = LOADED.get(record) ?? {};
  const own = Object.fromEntries(Object.entries(rest).filter(([field]) => !MOVED.includes(field) && ![...ROOT_BOOKKEEPING, ...REFS, 'counts'].includes(field)));
  const counts = {};
  const items = [];
  const itemRefs = {};
  for (const list of LIST_NAMES) {
    const now = LISTS[list].from(record) ?? [];
    counts[list] = now.length;
    items.push(...changedItems(id, list, now, loaded[list], loaded.item_refs?.[list]));
    itemRefs[list] = refsAfter(now, loaded[list], loaded.item_refs?.[list]);
  }
  const stubs = guidance.map(stubOf);
  counts.answered_steps = stubs.length;
  items.push(...changedItems(id, 'answered_steps', stubs, loaded.answered_steps, loaded.item_refs?.answered_steps));
  itemRefs.answered_steps = refsAfter(stubs, loaded.answered_steps, loaded.item_refs?.answered_steps);
  const methodIdentity = method ? identityOf(method) : undefined;
  items.push(...changedItems(id, FOLDED, [], loaded[FOLDED], loaded.item_refs?.[FOLDED]));
  const { evidence: _evidence, ...shortInput } = input;
  // The method's id beside its identity, so a list that weighs decisions by method reads one short field.
  const root = {
    ...own, id, input: shortInput, ...(method?.id ? { method_id: method.id } : {}), ...(methodIdentity ? { method_identity: methodIdentity } : {}),
    input_identity: kept ?? inputIdentity(record.original_input ?? input), counts,
    call_count: record.call_count ?? (Array.isArray(calls) ? calls.length : 0),
  };
  const steps = whole ? guidance.map((_, n) => n) : changed;
  const packed = guidance.map(entry => packStep(stepRecordOf(entry)));
  const stepRefs = guidance.map((_, n) => (steps.includes(n) ? contentRef(packed[n]) : (loaded.step_refs?.[n] ?? null)));
  const refsValue = { step_refs: stepRefs, items: itemRefs };
  const refsWritten = stepRefs.some(Boolean) || Object.values(itemRefs).some(refs => refs.some(Boolean));
  if (refsWritten) root.refs = contentRef(refsValue);
  const { root: fittedRoot, parts: rootParts } = rootFitted(id, root);
  // The revision record is written with the root, in the same write, and expects the revision it was read at (or none).
  const was = loaded.revision ?? null;
  const revision = { id: revisionKey(id), type: REVISION, value: { revision: (was?.revision ?? 0) + 1 } };
  return [
    { id, type: 'decision', value: fittedRoot },
    revision,
    ...rootParts,
    ...(refsWritten ? [{ id: refsKey(id, root.refs), type: NAMES.refs, value: refsValue }] : []),
    ...steps.map(n => ({ id: stepAt(id, n, stepRefs[n]), type: 'decision-step', value: packed[n] })),
    ...archived.map(({ key, entry }) => ({ id: key, type: 'decision-step', value: packStep(stepRecordOf(entry)) })),
    ...(whole && Array.isArray(calls) ? calls.map((call, n) => ({ id: callKey(id, n), type: 'decision-call', value: bareCall(call) })) : []),
    ...items,
    ...(methodIdentity && methodIdentity !== loaded.method_identity ? [{ id: methodKey(methodIdentity), type: NAMES.method, value: { method } }] : []),
  ];
}

// The records one change keeps, as a store holds them: each record with `expected`, the value the store must still hold for
// it (null when it was not there, so a write-once record must be new). Parts come first, removals with the root, and the
// revision and the root last: a store that applies the list in order inside one transaction, and refuses it whole when an
// expected record has moved, commits the root only with the records it names. Nothing is written here.
const expectedBy = held => ({ id, type, value }) => ({ id, type, value, expected: held.expected(type, id) });
export function writeDecision(held, list) {
  const [root, revision, ...rest] = list;
  // A removal is a record the committed root still counts until this change moves it: it lands with the root, never before.
  const removals = rest.filter(record => record.value === null);
  const parts = fitted(rest.filter(record => record.value !== null));
  return [...parts, ...removals, revision, root].map(expectedBy(held));
}


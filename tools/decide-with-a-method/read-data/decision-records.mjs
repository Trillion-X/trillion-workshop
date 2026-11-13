// tools/decide-with-a-method/read-data/decision-records.mjs
//
// How a decision is laid out in the person's records, so that a decision of any size fits under the records door's
// write cap (64 KiB a message). The root `decision` record holds only fields each set by one call (the goal, the options,
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
// root's input again and removes those records. A change too large for one door message goes in
// parts with the root last, so a reader never meets a root that counts records not written yet; a reader takes only the
// first `counts` items of each list, so a part written before a write that failed is never read.
// The settings are imported, not read from disk, so the join also runs where this file is bundled (the old engine's Worker).
import settings from './decide-with-a-method.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';


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
const lostStep = stub => ({ step_id: stub?.step_id ?? null, answer: {}, answered_at: stub?.answered_at ?? null, lost: true });

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
// What the door held for the root and its revision record when the decision was read: a write expects the revision to
// still hold it, so a write made from an older read is refused, not written over newer rows.
const ROOT_READ = new WeakMap();
const REVISION = settings.records.record_revision.type;
// Whether a write expects the revision it was read at. Switched off in DATA while a spurious conflict on the revision is found.
const CHECK_REVISION = settings.records.record_revision.check !== false;
const revisionKey = id => `${REVISION}:${id}`;

// What a record can weigh in a door message, however the door carries it on the way: its JSON with every character past
// ASCII written as a \u escape, quoted once more as a JSON string. A part's text is itself JSON, so a quote, backslash or
// newline in it is already escaped once, and each further encoding doubles that escape again: a part sized by its plain
// UTF-8 bytes (a 67 KB chat message full of quotes, newlines and emoji) left a write of 46 KB plain that grew to 74 KB
// carried, and the door answered 413. Sizing parts and writes by this measure keeps every write under the cap.
const PAST_ASCII = /[\u007f-\uffff]/g;
const escaped = char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
const carriedText = text => JSON.stringify(text.replace(PAST_ASCII, escaped));
/** The most bytes `value` can take in a door message: its JSON, past-ASCII escaped, quoted once more. Never under its UTF-8. */
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
// Reading is one pure, synchronous join over records already read, so a reader that reads synchronously (the old engine's store)
// and one that reads through the door call the same code. `get(type, key)` answers the record a reader already holds: its
// value, null when it is known not to exist, undefined when it was not read yet. The join asks for what it needs through
// `get`; `settled` runs it again over the records read for the ones it asked about, until it asks about no more.
/** A record's value whole: as kept, or put back together from its parts; throws when a part is not visible. */
export function wholeValue(key, value, get) {
  if (!object(value) || !Number.isInteger(value.kept_in_parts)) return value;
  let text = '';
  for (let n = 0; n < value.kept_in_parts; n += 1) {
    const partOf = partKey(key, n);
    const part = get(NAMES.part.type, partOf);
    if (part === undefined) return undefined;
    // A part that is not there is an error, never a missing value: a summary read as lost would be written back as a stub.
    if (typeof part?.text !== 'string') throw Object.assign(new Error(`Part ${partOf} of this decision is not visible to this read. Nothing was changed.`), { code: 'part_unreadable' });
    text += part.text;
  }
  return unpackStep(JSON.parse(text));
}
/** The per-index references of a root (`refs` names the record that holds them); none for a root that names none. */
// Undefined while the record is not read yet: the join runs again over what is read (see `settled`).
function refsOf(id, root, get) {
  const none = { step_refs: [], items: {} };
  if (typeof root.refs !== 'string') return none;
  const key = refsKey(id, root.refs);
  const value = get(NAMES.refs, key);
  if (value === undefined) return undefined;
  const kept = wholeValue(key, value, get);
  if (kept === undefined) return undefined;
  return kept ? { step_refs: kept.step_refs ?? [], items: kept.items ?? {} } : none;
}
/** The join run over what `door` holds: every record it asked about is read together, until it asks about no more. */
export async function settled(door, join) {
  const held = new Map();
  for (;;) {
    const asked = new Map();
    const get = (type, key) => {
      if (held.has(key)) return held.get(key);
      asked.set(key, type);
      return undefined;
    };
    const joined = join(get);
    if (!asked.size) return joined;
    await Promise.all([...asked].map(async ([key, type]) => held.set(key, (await door.read(type, key)) ?? null)));
  }
}
/** One answered step, or one of its versions, whole: its checks and verdicts as lists; null when it cannot be read. */
export const stepIn = (get, key) => {
  const kept = wholeValue(key, get('decision-step', key), get);
  return kept === undefined ? undefined : unpackStep(kept);
};
export const readStep = (door, key) => settled(door, get => stepIn(get, key));

/** The first `count` items of one list laid apart, in order; one that cannot be read is named as lost. */
export function itemsIn(get, id, list, count, refs = []) {
  if (!count) return [];
  const { type } = LAID[list];
  return Array.from({ length: count }, (_, n) => {
    const key = itemAt(list, id, n, refs[n]);
    const kept = wholeValue(key, get(type, key), get);
    return kept ?? { lost: true };
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
export const laidTogether = (door, id, root, lists, options) => settled(door, get => joinLaid(id, root, get, lists, options));

// A decision kept apart (its root names its answered steps) or kept whole (its root holds its guidance itself).
const keptWhole = root => Array.isArray(root.guidance) && !Array.isArray(root.answered_steps) && !object(root.counts);

/** The decision with its scope answer whole and every later step as its summary; `steps` names others to read whole. */
export function joinDecision(id, root, get, steps = []) {
  if (keptWhole(root)) return { ...root, id, whole: true };
  const { record, loaded } = joinLaid(id, root, get, LIST_NAMES, { method: true });
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
  const unreadable = decision.guidance.flatMap((entry, n) => (entry.lost === true || !entry.step_id ? [n] : []));
  if (unreadable.length) throw Object.assign(new Error(`Step ${unreadable.join(', ')} of this decision could not be read: its record holds no step. The decision was not changed.`), { code: 'step_unreadable' });
  return decision;
}
export async function readDecision(door, id, steps = []) {
  // The revision is read before the root: a commit between the two reads then leaves a revision older than the root,
  // which the write made from this read refuses, never a stale root under a newer revision it would be accepted against.
  const revision = await readRevision(door, id);
  const root = await door.read('decision', id);
  if (!root) return null;
  const decision = refuseUnreadableSteps(await settled(door, get => joinDecision(id, root, get, steps)));
  markRead(decision, revision);
  return decision;
}

/** The revision record of a decision as the door holds it now (null when none): read with the root, expected by its write. */
export const readRevision = (door, id) => door.read(REVISION, revisionKey(id));

/** The case changed under a write that expected it unchanged (the door's original_command_conflict). */
export const CASE_CHANGED = 'original_command_conflict';

/**
 * Runs `attempt(n)` (n counts from 1) again when the case changed under it: each attempt reads the case afresh and writes
 * under its own key, so the same request is never replayed with the stale expectation the door already answered. Up to
 * `settings.conflict.reads` attempts in all; then the answer says the case was re-read and retried.
 */
export async function retriedOnConflict(attempt) {
  for (let n = 1; ; n += 1) {
    try {
      return await attempt(n);
    } catch (error) {
      if (error?.code !== CASE_CHANGED) throw error;
      if (n >= settings.conflict.reads) throw Object.assign(new Error('The case changed while this answer was being kept. It was re-read and retried, and it changed again. Read it again and answer again.'), { code: CASE_CHANGED });
    }
  }
}

/** Records that `record` was read with this revision, so the write made from it expects that revision to still hold. */
export function markRead(record, revision) {
  ROOT_READ.set(record, { revision: structuredClone(revision ?? null) });
}

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
async function refsHistory(door, id) {
  const out = [];
  for await (const row of door.list({ type: NAMES.refs, prefix: `${NAMES.refs}:${id}${CONTENT}` })) {
    const value = await settled(door, get => wholeValue(row.id, row.value, get));
    if (object(value)) out.push({ step_refs: value.step_refs ?? [], items: value.items ?? {} });
  }
  return out;
}
// The step and the summary a past refs record named at index n, when both are there and are the same graded step.
async function pastStepAt(door, id, n, past) {
  const stepRef = past.step_refs[n];
  const summaryRef = past.items.answered_steps?.[n];
  if (!summaryRef) return null;
  const [step, summary] = await settled(door, get => {
    const kept = stepIn(get, stepAt(id, n, stepRef));
    const stub = wholeValue(itemAt('answered_steps', id, n, summaryRef), get(LAID.answered_steps.type, itemAt('answered_steps', id, n, summaryRef)), get);
    return kept === undefined || stub === undefined ? undefined : [kept, stub];
  });
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
export async function putBackSteps(door, record) {
  const loaded = LOADED.get(record) ?? { answered_steps: [] };
  const was = loaded.answered_steps.map(text => JSON.parse(text));
  const graded = was.filter(stub => stub.checks !== undefined).length;
  const repaired = [];
  let history = null;
  for (const [n, entry] of record.guidance.entries()) {
    if (was[n] === undefined || was[n].checks !== undefined) continue;
    if (entry.lost !== true) {
      if (stubOf(entry).checks !== undefined && was[n].step_id === entry.step_id) repaired.push({ index: n, step_id: entry.step_id, from: 'step' });
      continue;
    }
    history ??= await refsHistory(door, record.id);
    let best = null;
    for (const past of history) {
      const found = await pastStepAt(door, record.id, n, past);
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
  const was = ROOT_READ.get(record)?.revision ?? null;
  const revision = { id: revisionKey(id), type: REVISION, value: { revision: (was?.revision ?? 0) + 1 }, ...(CHECK_REVISION ? { expected: was ? { type: REVISION, value: was } : null } : {}) };
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

// One write when it fits one door message (`writes` records, `write_bytes` bytes); otherwise every other record first
// and the root last, so a root never counts a record that is not there yet. Each part keeps its own request key, so a
// write sent again answers the receipt it already saved. A record too large for `record_bytes` goes in its parts. Writes
// are measured as carried (carriedBytes), so one fits the door's cap however the door encodes it on the way.
const writeBounds = { rows: settings.writes, bytes: settings.write_bytes, measure: carriedBytes };
export async function writeDecision(door, list, key) {
  // The key names what is written, so a retry of the same write replays and a different write under the same name is never a conflict.
  const [root, revision, ...rest] = list;
  // A removal is a record the committed root still counts until this write moves it: it lands with the root, never before.
  const removals = rest.filter(record => record.value === null);
  const parts = fitted(rest.filter(record => record.value !== null));
  const whole = [root, revision, ...parts, ...removals];
  const named = `${key}:${identityOf(whole)}`;
  try {
    if (writeBatches(whole, writeBounds).length === 1) return await door.write(whole, { key: named });
    // Several writes. Every record a write adds is write-once (content-addressed) and named by nothing until the root
    // names it, so parts that land before a refused root are invisible and cannot be written over. Only the root and its
    // revision commit the change: the revision expectation is checked there, and nothing else moves the revision.
    for (const [at, batch] of writeBatches(parts, writeBounds).entries()) await door.write(batch, { key: `${named}:part:${at}` });
    return await door.write([root, revision, ...removals], { key: named });
  } catch (error) {
    if (error?.code === CASE_CHANGED) throw Object.assign(new Error('The case changed while this answer was being kept. Read it again and answer again.'), { code: CASE_CHANGED });
    throw error;
  }
}

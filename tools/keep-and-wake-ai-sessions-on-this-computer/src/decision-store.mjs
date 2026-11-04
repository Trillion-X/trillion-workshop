// One person's decisions, pursuits and settings, kept in the person's record store (src/record-engine.mjs: the log
// engine, parts/record-log, or a store still on the decomposed tables, parts/eeaf, until it is moved), over whichever
// SQLite the host has: the hosted person's Durable Object, or node:sqlite on this computer. Every change is appended to
// the store's log with the time it happened.
//
// A decision is one root record of type `decision`; its method is stored once under its BLAKE3 identity
// (`method:1f:<hex>`) and linked from every decision run under it, so a run names the exact method it used.
// A pursuit is a root record of type `pursuit`; a setting (plan, sharing, sign-in cut-off) is one of type
// `setting`. Reading or changing one decision reads and writes only that decision's rows.
//
// A decision's answered steps and the calls made on it are records of their own beside it (types `decision-step` and
// `decision-call`, numbered in order), so answering one step reads the decision's own fields, its scope answer and at
// most the step it repeats (readStep, addStep), and logging a call writes that call alone (addCall): never every earlier
// answer and every earlier try. The decision keeps the running summary: each answered step's id and time
// (`answered_steps`) and how many calls it has (`call_count`), so its own record stays the same size however often it
// is tried. Refused submissions and problems are kept in a bounded SQLite table, not decomposed into the record log.
// read() assembles the whole decision as before. A decision kept whole on the decomposed store stays whole: its own
// fields, one answered step and one call are read and written in place (parts/eeaf readOwn, readMember, memberFields,
// writeOwn, writeMember). A whole decision an older Worker writes after the store moved to the packed log is laid
// apart transactionally before its next mutation, so that mutation never copies the embedded history.
import { decisionResult, decisionStatus } from './check-uses.mjs';
import { progressFromSteps } from './work-progress.mjs';
import decisionSteps from '../../decide-with-a-method/read-data/decision-progress.json' with { type: 'json' };
import { RecordTooLarge } from '../parts/record-log/do-work/record-log-store.mjs';
import { openRecords } from './record-engine.mjs';
import { makeRecordMove } from './record-move.mjs';
import { STEP_FLAGS, isLaid, itemsIn, joinLaid, unpackStep as unpackKept, wholeValue } from '../../decide-with-a-method/read-data/decision-records.mjs';

// A decision grown too large to read whole fails alone, in words the person can act on; every other decision in the
// store reads and changes as before. Its sizes go to the log (where it grew, by top-level field), never to the caller.
export const TOO_LARGE_WORDS = "This decision can't be opened; start it again under a new name.";
export class DecisionTooLarge extends Error {
  constructor(id) { super(TOO_LARGE_WORDS); this.code = 'decision_too_large'; this.case_id = id; }
}
// A write never keeps fewer answers than the decision already holds. Code that cannot see how a decision's answers are
// kept (a version from before a layout, running while a deploy rolls out) would otherwise write back what it saw and
// the answers would vanish; instead the write is refused, nothing changes, and the answers are there for the next try.
// A method replaced moves its answers into method_history, so that write keeps every answer and is not refused.
export const ANSWERS_KEPT_WORDS = 'This decision already holds answers this version of Trillion cannot read, so nothing was changed and its answers are kept. Send it again in a few minutes.';
export class AnswersWouldBeLost extends Error {
  constructor(id, held, kept) { super(ANSWERS_KEPT_WORDS); this.code = 'answers_would_be_lost'; this.case_id = id; this.held = held; this.kept = kept; }
}
const refused = (error, id) => {
  if (!(error instanceof RecordTooLarge)) return error;
  console.error(JSON.stringify({ record_too_large: id, size: error.size }));
  return new DecisionTooLarge(id);
};

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
import { canonical, identityOf } from '../../shared-code/src/record-identity.mjs';
export { canonical, identityOf };

// Whether the AI that took a decision's next action has said it was done (or named the wall it reached), for the
// decision as it stands now: a revised decision is owed again. src/engine.mjs recordCarriedOut keeps what was said.
export const carriedOut = record => Boolean(record?.decision) && (record.carried_out ?? []).some(entry => entry.decision_generation === (record.decision_generation ?? 1));
// What a list of decisions says about a decided one: when it was decided and whether its next action was said done.
export const decidedSummary = record => (record.decision ? { decided: true, decided_at: record.decided_at ?? null, carried_out: carriedOut(record) } : { decided: false });

const STEP = 'decision-step';
const CALL = 'decision-call';
const SUMMARY = ['answered_steps', 'call_count', 'calls_with_submission'];
const stepKey = (id, n) => `${STEP}:${id}:${String(n).padStart(3, '0')}`;
const callKey = (id, n) => `${CALL}:${id}:${String(n).padStart(6, '0')}`;
// The fields of a call a count of calls and checks reads (src/check-uses.mjs); refused payloads are kept apart.
const CALL_FIELDS = ['route', 'step_id', 'accepted', 'reason', 'app', 'at', 'bytes'];
const stubOf = entry => ({ step_id: entry.step_id, answered_at: entry.answered_at });
// A decision's root counts an answered step whose own record is gone (a write that stopped between the two, or a store
// older code wrote to): the step stays in its place, from the id and time the root kept, marked `lost`, so the
// decision still reads, still asks the question after it, and never throws on a null step.
const lostStep = stub => ({ step_id: stub?.step_id ?? null, answer: {}, answered_at: stub?.answered_at ?? null, lost: true });
const lostCall = () => ({ route: 'guide', accepted: false, reason: 'lost', lost: true });
const withoutSummary = root => Object.fromEntries(Object.entries(root).filter(([key]) => !SUMMARY.includes(key)));
/** The calls whose submission is kept: the latest `keep` of those that sent one (every other forgets what it sent). */
export const keptSubmissions = (ordinals, keep) => ordinals.slice(Math.max(0, ordinals.length - keep));
// A decision's own record with the running summary, from the decision whole (answers and calls in it).
function rootOf(record) {
  const { guidance = [], calls = [], ...own } = withoutSummary(record);
  return { ...own, answered_steps: guidance.map(stubOf), call_count: calls.length };
}
const PAYLOAD_FIELDS = ['submission', 'problems'];
const bareCall = call => call && PAYLOAD_FIELDS.some(field => call[field] !== undefined)
  ? Object.fromEntries(Object.entries(call).filter(([field]) => !PAYLOAD_FIELDS.includes(field))) : call;
export const KEPT_CALL_PAYLOADS = 5;
const PAYLOADS_KEPT_IN_ALL = 500;
function callPayloads(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS decision_call_payloads (case_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (case_id, ordinal))');
  return {
    keep(id, n, call, keep) {
      const payload = Object.fromEntries(PAYLOAD_FIELDS.filter(field => call?.[field] !== undefined).map(field => [field, call[field]]));
      if (!Object.keys(payload).length) return;
      // A logged call's ordinal and sent content do not change; re-writing its case must not bill another payload row.
      sql.exec('INSERT INTO decision_call_payloads (case_id, ordinal, payload) VALUES (?, ?, ?) ON CONFLICT (case_id, ordinal) DO NOTHING', id, n, JSON.stringify(payload));
      sql.exec('DELETE FROM decision_call_payloads WHERE case_id = ? AND ordinal NOT IN (SELECT ordinal FROM decision_call_payloads WHERE case_id = ? ORDER BY ordinal DESC LIMIT ?)', id, id, Math.max(0, keep));
      sql.exec('DELETE FROM decision_call_payloads WHERE rowid IN (SELECT rowid FROM decision_call_payloads ORDER BY rowid DESC LIMIT -1 OFFSET ?)', PAYLOADS_KEPT_IN_ALL);
    },
    of(id) { return new Map(sql.exec('SELECT ordinal, payload FROM decision_call_payloads WHERE case_id = ?', id).toArray().map(row => [row.ordinal, JSON.parse(row.payload)])); },
    forget(id) { sql.exec('DELETE FROM decision_call_payloads WHERE case_id = ?', id); },
  };
}
// Kept apart: the decision's own record carries the running summary and holds no answers or calls itself. A decision
// that holds answers or calls itself is kept whole, even if it also carries a summary: a store running code from before
// this layout wrote its answers into it after the summary, so those answers are the latest and the summary is not.
const apart = root => Array.isArray(root.answered_steps) && root.guidance === undefined && root.calls === undefined;
/**
 * The records a decision is written as: its own record with the running summary, each answered step and each call,
 * and the removal of every step or call `had` (the summary it was kept with, or null) counted that it no longer has.
 * A decision apart that code from before the layout then answered into (it carries a summary beside its answers, and
 * its separate steps are still kept) is answered as it is. A null record is its removal with every step and call.
 * Used for every write of a decision kept apart, and by the log engine's move (src/record-move.mjs), which lays each
 * decision kept whole apart in the one write that copies it.
 */
export function decisionRecordsOf(id, record, had = null) {
  const steps = Array.isArray(had?.answered_steps) ? had.answered_steps.length : 0;
  const calls = Array.isArray(had?.answered_steps) ? had.call_count ?? 0 : 0;
  const removed = (count, from, key, type) => Array.from({ length: Math.max(0, count - from) }, (_, k) => ({ id: key(id, from + k), type, value: null }));
  if (record === null) return [{ id, type: 'decision', value: null }, ...removed(steps, 0, stepKey, STEP), ...removed(calls, 0, callKey, CALL)];
  if (Array.isArray(record.answered_steps)) return [{ id, type: 'decision', value: record }];
  const { guidance = [], calls: tries = [] } = record;
  return [
    { id, type: 'decision', value: rootOf(record) },
    ...guidance.map((entry, n) => ({ id: stepKey(id, n), type: STEP, value: entry })),
    ...tries.map((call, n) => ({ id: callKey(id, n), type: CALL, value: call })),
    ...removed(steps, guidance.length, stepKey, STEP),
    ...removed(calls, tries.length, callKey, CALL),
  ];
}
// During the EEAF-to-record-log move, do not assemble a whole decision before splitting it. Each large list member
// is read and yielded separately; record-move writes bounded chunks and verifies each chunk before advancing.
function* streamDecisionRecords(id, _value, had, from, payloads) {
  if (_value === null) { yield* decisionRecordsOf(id, null, had); return; }
  const root = from.readOwn(id, ['guidance', 'calls']);
  if (!root) return;
  // Decisions already kept apart have no large member arrays to expand; this is the same root record as a normal read.
  if (Array.isArray(root.answered_steps)) { yield { id, type: 'decision', value: root }; return; }
  const answered = from.memberFields(id, 'guidance', ['step_id', 'answered_at']).map(({ ordinal, ...entry }) => stubOf(entry));
  const calls = from.memberCount(id, 'calls');
  yield { id, type: 'decision', value: { ...withoutSummary(root), answered_steps: answered, call_count: calls } };
  const steps = from.memberCount(id, 'guidance');
  for (let n = 0; n < steps; n += 1) yield { id: stepKey(id, n), type: STEP, value: from.readMember(id, 'guidance', n) };
  for (let n = 0; n < calls; n += 1) {
    const call = from.readMember(id, 'calls', n);
    payloads.keep(id, n, call, KEPT_CALL_PAYLOADS);
    yield { id: callKey(id, n), type: CALL, value: call && PAYLOAD_FIELDS.some(field => call[field] !== undefined)
      ? Object.fromEntries(Object.entries(call).filter(([field]) => !PAYLOAD_FIELDS.includes(field))) : call };
  }
  const hadSteps = Array.isArray(had?.answered_steps) ? had.answered_steps.length : 0;
  const hadCalls = Array.isArray(had?.answered_steps) ? had.call_count ?? 0 : 0;
  for (let n = steps; n < hadSteps; n += 1) yield { id: stepKey(id, n), type: STEP, value: null };
  for (let n = calls; n < hadCalls; n += 1) yield { id: callKey(id, n), type: CALL, value: null };
};
// A step or call kept as its own record counts only while its decision is kept apart: a decision kept whole (or one
// answered into after it was apart) reads its answers and calls from its own lists, and a separate step or call left
// beside it from before is never read. Moving the store brings in only the ones that count, so a step laid out from a
// decision's own list is never replaced by an older one left beside it.
const partOwner = id => {
  const kind = [STEP, CALL].find(type => id.startsWith(`${type}:`));
  return kind ? id.slice(kind.length + 1, id.lastIndexOf(':')) : null;
};
export function decisionPartRecordsOf(id, value, had, from) {
  const owner = partOwner(id);
  const root = owner === null ? null : from.readOwn(owner, ['guidance', 'calls']);
  const ownerApart = root !== null && Array.isArray(root.answered_steps) && from.memberCount(owner, 'guidance') === 0 && from.memberCount(owner, 'calls') === 0;
  // A decision laid apart as it is copied writes its own steps and calls; one kept whole or removed counts none of these.
  return ownerApart ? [{ id, type: id.startsWith(`${STEP}:`) ? STEP : CALL, value }] : [];
}

// A step's checklist (the checks its question asked, src/private-method.mjs checklistFor) is the same for every decision
// asked that question under one method, so it is kept once under its identity (`checklist:1f:<hex>`, content-addressed
// like the method) and each step links to it: answering a step writes its answer, not its 26 checks again. The checks
// are kept as { checks } because a store keeps objects, not lists, once; every caller reads and writes the list.
const packStep = entry => (Array.isArray(entry?.checklist) ? { ...entry, checklist: { checks: entry.checklist } } : entry);
const unpackStep = entry => (object(entry?.checklist) && Array.isArray(entry.checklist.checks) ? { ...entry, checklist: entry.checklist.checks } : entry);
const eachStep = (change, value) => {
  if (!object(value)) return value;
  if (typeof value.step_id === 'string') return change(value);
  const steps = list => (Array.isArray(list) ? { guidance: list.map(change) } : {});
  return {
    ...value, ...steps(value.guidance),
    ...(Array.isArray(value.method_history) ? { method_history: value.method_history.map(entry => (object(entry) ? { ...entry, ...steps(entry.guidance) } : entry)) } : {}),
  };
};
const packed = value => eachStep(packStep, value);
const unpacked = value => eachStep(unpackStep, value);
// The record store with every step's checklist kept by its identity (above); what callers read and write is unchanged.
function checklistsOnce(records) {
  return {
    ...records,
    read: (...args) => unpacked(records.read(...args)),
    readMany: (ids, options) => new Map([...records.readMany(ids, options)].map(([id, value]) => [id, unpacked(value)])),
    readOwn: (...args) => unpacked(records.readOwn(...args)),
    readMember: (id, field, ...rest) => (field === 'guidance' ? unpackStep(records.readMember(id, field, ...rest)) : records.readMember(id, field, ...rest)),
    write: (list, ...rest) => records.write(list.map(record => (record.value ? { ...record, value: packed(record.value) } : record)), ...rest),
    writeOwn: (id, type, value, ...rest) => records.writeOwn(id, type, packed(value), ...rest),
    writeMember: (id, type, field, n, value, ...rest) => records.writeMember(id, type, field, n, field === 'guidance' ? packStep(value) : value, ...rest),
  };
}

// watch (optional): { active() → whether anyone is watching now, changed([{ id, type, removed }]) } — told, after each write
// while active, which root records it really changed (a record written with the value it already had is left out). A
// write whose context says `unwatched: true` is never told (what a watcher itself keeps about what it did).
// bounds (optional): the size past which one record is refused rather than read (parts/eeaf RECORD_BOUNDS).
// written (optional): (records) → told of every write's records ([{ id, type, value }]) inside that write's transaction,
// so an index kept beside the records (src/record-scope.mjs) changes with them or not at all.
// How many pursuit ids one pursuitPage looks through at most, however many are ended or archived.
const PURSUIT_SCAN = 400;
// How many records one batched read asks the record store for at once (readAll).
const READ_PAGE = 100;
// Setup's cache needs only these source facts. Capture them on both sides of a write using the record owner's bounded
// field projection, so invalidation can follow edits and removals without opening message bodies.
const SETUP_SOURCE_PROJECTIONS = {
  message: { fields: ['app', 'speaker', 'captured_road', 'at'], presence: [['captured_road']] },
  'agent-card': { fields: ['name'] },
  'agent-handoff': { fields: ['state', 'taken_by', 'finished_at'], presence: [['result', 'withdrawn_by']] },
};
export function decisionStore(sql, { transaction, watch = null, written = null, bounds, historyArchives = false, readiness = null, recordSupply = null, originalReadOnly = false } = {}) {
  const contentId = (typeName, value) => (typeName === 'decision/method' ? `method:${identityOf(canonical(value))}`
    : typeName.endsWith('/checklist') && Array.isArray(value?.checks) ? `checklist:${identityOf(canonical(value))}` : null);
  const raw = openRecords(sql, { transaction, bounds, hash: identityOf, contentId, historyArchives, readiness, lazy: Boolean(recordSupply), readOnly: originalReadOnly });
  const stored = checklistsOnce(raw);
  // Every way records are written: whole records, and changes another copy of the store or an undo made (applied
  // field by field, so the watcher and the index beside the records are told what each record now holds). A write
  // that also wrote records it was not handed (the versions a conflict met) names them in its answer's `written`.
  const writers = {
    write: records => records.map(record => record.id),
    applyChanges: rows => rows.flatMap(row => row.envelopes.map(envelope => envelope.id)),
    takeRecords: records => records.map(record => record.id),
  };
  const idsOf = (name, input) => [...new Set(writers[name](input))];
  const alsoWritten = (ids, result) => [...new Set([...ids, ...(result?.written ?? [])])];
  // What the records hold now, each read for all of them together: read one at a time, a record not kept yet costs a
  // read of every run of the store (a watched write of 20 rows over 30 runs read 2,700 rows that way, 2026-10-20).
  const recordsNow = ids => {
    const types = stored.typesOf(ids), values = stored.readMany(ids);
    return ids.map(id => ({ id, type: types.get(id) ?? null, value: values.get(id) ?? null }));
  };
  const setupSourcesNow = ids => {
    const found = new Map(ids.map(id => [id, null]));
    for (const type of Object.keys(SETUP_SOURCE_PROJECTIONS)) {
      const selected = ids.filter(id => id.startsWith(`${type}:`));
      if (!selected.length) continue;
      const projected = stored.fields.projectOf(type, selected, SETUP_SOURCE_PROJECTIONS[type]);
      for (const [id, value] of projected) found.set(id, value);
    }
    return found;
  };
  const watched = watch ? {
    ...stored,
    ...Object.fromEntries(Object.keys(writers).map(name => [name, (input, { unwatched = false, ...context } = {}, ...rest) => {
      if (unwatched || !watch.active()) return stored[name](input, context, ...rest);
      const ids = idsOf(name, input);
      const before = new Map(recordsNow(ids).map(now => [now.id, { type: now.type, text: canonical(now.value) }]));
      const result = stored[name](input, context, ...rest);
      const changed = recordsNow(alsoWritten(ids, result)).map(now => ({ id: now.id, type: now.type ?? before.get(now.id)?.type ?? null, removed: now.value === null, same: canonical(now.value) === (before.get(now.id)?.text ?? canonical(null)) }))
        .filter(item => !item.same).map(({ same, ...item }) => item);
      if (changed.length) watch.changed(changed);
      return result;
    }])),
  } : stored;
  let eeaf = written ? {
    ...watched,
    ...Object.fromEntries(Object.keys(writers).map(name => [name, (input, context, ...rest) => {
      const run = () => {
        const ids = idsOf(name, input);
        const before = setupSourcesNow(ids);
        const result = watched[name](input, context, ...rest);
        const changedIds = alsoWritten(ids, result);
        const after = setupSourcesNow(changedIds);
        const setupSourceChanges = new Map(changedIds.map(id => [id, {
          before: before.get(id) ?? null, after: after.get(id) ?? null, unknownBefore: !before.has(id),
        }]));
        // A write names each id's previous type (the engine knows it from what it replaces); other writers do not, so listeners probe.
        written(name === 'write' ? input : recordsNow(changedIds), { setupSourceChanges, previousTypes: name === 'write' ? result?.previous_types ?? null : null, actor: context?.actor ?? null });
        return result;
      };
      const mark = watched.changeMark?.() ?? null;
      try { return transaction ? transaction(run) : run(); }
      catch (error) {
        // A listener can fail after the engine updated its projection inside the outer SQL transaction.
        // Rebuild that projection before another read; the rejected record must never appear accepted.
        try { watched.forgetCached(error, mark); } catch { /* preserve the original write failure */ }
        throw error;
      }
    }])),
  } : watched;
  // A separately owned synchronous metadata supply participates in the same
  // native transaction while ordinary record writers retain their own observer.
  // Install before closing over eeaf: settings/raw writers must share this road.
  if (recordSupply) eeaf = recordSupply(eeaf);
  // Records named by the caller are read or refused; a walk over every record of a type leaves an oversized one out,
  // so one record past its bounds never stops the others being listed.
  // A decision the Workshop's tools/decide-with-a-method laid apart (its root keeps only one-call fields and counts; each list that
  // grows, the method snapshot and any record past its bounds are records of their own) reads here as the whole decision the
  // engine reads: that tool's own pure join (decision-records.mjs, trillion-workshop) over what this store holds. The decision
  // keeps no logged calls beyond the records named `decision-call:<id>:`; a count of calls never made would read as lost ones.
  const heldRecord = (_type, key) => eeaf.read(key) ?? null;
  const laid = (id, value) => {
    const whole = unpackKept(wholeValue(id, value, heldRecord));
    if (!isLaid(whole)) return whole;
    const { record } = joinLaid(id, whole, heldRecord, undefined, { method: true });
    record.answered_steps = itemsIn(heldRecord, id, 'answered_steps', whole.counts.answered_steps ?? 0);
    record.call_count = eeaf.ids('decision-call', { prefix: `decision-call:${id}:` }).length;
    delete record.method_identity;
    return record;
  };
  const readOne = (id, named) => {
    try { return laid(id, eeaf.read(id)); } catch (error) { const plain = refused(error, id); if (named || plain === error) throw plain; return null; }
  };
  // One answered step of a decision kept apart, with the flags its summary carries (a decision laid apart by the Workshop keeps
  // whether a step needs a recheck on the summary, so flagging later steps never rewrites their answers).
  const answerOf = (id, n, stub) => {
    const step = readOne(stepKey(id, n), true) ?? lostStep(stub);
    const flags = STEP_FLAGS.filter(field => stub?.[field] !== undefined);
    return flags.length ? { ...step, ...Object.fromEntries(flags.map(field => [field, stub[field]])) } : step;
  };
  const payloads = callPayloads(sql);
  const { fields } = stored;
  // Decision ids from a declared index (src/record-indexes.json), newest first or in a range, before any is read.
  const idsBy = (name, options) => eeaf.scan('decision', name, options).map(entry => entry.id);
  const page = limit => Math.max(1, Math.floor(Number(limit) || 20));
  // The records a decision is written as: its own record, each answered step and each call; and, for steps or calls
  // it no longer has (a method replaced, a decision removed), their removal. A step or call read whole this turn and
  // unchanged since (`assembled`) is not written again, so a change to one field of a long decision writes that field.
  const assembled = new WeakMap();
  const unchanged = value => assembled.get(value) === canonical(value);
  const writesOf = (id, record, before) => {
    const had = before ? (apart(before) ? before : rootOf(before)) : null;
    return decisionRecordsOf(id, record === null ? null : withoutSummary(record), had)
      .filter((item, n) => n === 0 || item.value === null || !unchanged(item.value))
      .map(item => item.type === CALL && item.value !== null ? { ...item, value: bareCall(item.value) } : item);
  };
  const kept = value => { assembled.set(value, canonical(value)); return value; };
  // The decision whole: its own fields, every answered step and every call, as the engine reads it.
  const assemble = (id, root) => {
    const held = payloads.of(id);
    const withPayload = (call, n) => call && held.has(n) ? { ...call, ...held.get(n) } : call;
    if (!apart(root)) return { ...withoutSummary(root), ...(Array.isArray(root.calls) ? { calls: root.calls.map(withPayload) } : {}) };
    return {
      ...withoutSummary(root),
      guidance: root.answered_steps.map((stub, n) => kept(answerOf(id, n, stub))),
      calls: Array.from({ length: root.call_count }, (_, n) => kept(withPayload(readOne(callKey(id, n), true), n) ?? lostCall())),
    };
  };
  const readDecision = (id, named) => { const root = readOne(id, named); return root && assemble(id, root); };
  // A decision's own fields, without the answers and calls a decision kept whole holds in them (counted, never read);
  // null when there is none. A decision kept whole answers without any summary it also carries.
  const EMBEDDED = ['guidance', 'calls'];
  const own = id => {
    let root;
    try { root = laid(id, eeaf.readOwn(id, EMBEDDED)); } catch (error) { throw refused(error, id); }
    if (!root || !Array.isArray(root.answered_steps)) return root;
    return EMBEDDED.some(field => eeaf.memberCount(id, field) > 0) ? withoutSummary(root) : root;
  };
  // The answered steps of a decision kept whole, as their ids and times (never the answers).
  const stubsIn = id => eeaf.memberFields(id, 'guidance', ['step_id', 'answered_at']).map(({ ordinal, ...stub }) => stubOf(stub));
  // How many answers the stored decision holds, counted from its summary or its list (never read), and the refusal of a
  // write that would keep fewer: `kept` answers, with `moved` more carried into method_history by this write.
  const held = (id, root) => (!root ? 0 : apart(root) ? root.answered_steps.length : eeaf.memberCount(id, 'guidance'));
  const keepsEveryAnswer = (id, root, kept, moved = 0) => {
    const had = held(id, root);
    if (kept + moved < had) throw new AnswersWouldBeLost(id, had, kept);
  };
  const movedToHistory = (root, value) => (value.method_history ?? []).slice(root?.method_history?.length ?? 0)
    .reduce((sum, entry) => sum + (entry.guidance?.length ?? 0), 0);
  // The record engine holds a projection in memory. If the payload write fails after the record changed inside an
  // outer transaction, that transaction rolls back SQL and the projection must be rebuilt from the committed log.
  const atomic = run => {
    const mark = eeaf.changeMark?.() ?? null;
    try { return transaction ? transaction(run) : run(); }
    catch (error) { try { eeaf.forgetCached(error, mark); } catch { /* preserve the original write failure */ } throw error; }
  };
  // A store that has already moved to the packed log can still meet one whole decision written by an older
  // Worker during a rolling deploy. Reading that legacy shape is bounded enough to show its next question, but
  // changing one embedded list must copy the whole history and can exhaust the person's Durable Object. Before the
  // next mutation, lay its steps and calls apart in the same bounded, transactional shape the store move uses.
  // Stores still on the decomposed engine keep using its member writes: splitting one there can take tens of
  // thousands of statements, while its native member writes stay bounded.
  const splitWholeOnLog = (id, root, context = {}) => {
    if (!root || apart(root) || eeaf.engine() !== 'record-log') return root;
    const steps = stubsIn(id);
    const calls = eeaf.memberCount(id, 'calls');
    const logged = { actor: { by: 'trillion' }, ...context, unwatched: true };
    const run = () => {
      for (let n = 0; n < steps.length; n += 1) eeaf.write([
        { id: stepKey(id, n), type: STEP, value: eeaf.readMember(id, 'guidance', n) },
      ], logged);
      for (let n = 0; n < calls; n += 1) {
        const call = eeaf.readMember(id, 'calls', n);
        eeaf.write([{ id: callKey(id, n), type: CALL, value: bareCall(call) }], logged);
        payloads.keep(id, n, call, KEPT_CALL_PAYLOADS);
      }
      eeaf.write([{ id, type: 'decision', value: { ...withoutSummary(root), answered_steps: steps, call_count: calls } }], logged);
    };
    atomic(run);
    if (watch?.active()) watch.changed([{ id, type: 'decision', removed: false }]);
    return own(id);
  };
  // A change made a part at a time is told to the index kept beside the records and to whoever is watching, as a
  // whole write is.
  const inPlace = (id, change) => {
    const run = () => { const result = change(); written?.([{ id, type: 'decision', value: {} }]); if (watch?.active()) watch.changed([{ id, type: 'decision', removed: false }]); return result; };
    return atomic(run);
  };
  // Every record named (or of the type) read a page of ids at a time: one read of a record looks its key up in each of the
  // key store's runs, so reading them one by one cost a statement per run per record, and the setup screen's pursuits
  // alone cost thousands of statements on a store that keeps every pursuit it ever ended (2026-10-16). A page that holds a
  // record past its bounds is read again one by one, so that one is refused or left out exactly as a lone read does.
  const rootsOf = (wanted, named) => {
    const roots = new Map();
    for (let at = 0; at < wanted.length; at += READ_PAGE) {
      const page = wanted.slice(at, at + READ_PAGE);
      let found;
      // Point reads where the store's membership filters allow: these roots are scattered among every other record.
      try { found = eeaf.readMany(page, { pointReads: true }); } catch { found = new Map(page.map(id => [id, readOne(id, named)])); }
      for (const id of page) roots.set(id, laid(id, found.get(id) ?? null));
    }
    return roots;
  };
  const readAll = (type, ids) => {
    const wanted = ids ?? eeaf.ids(type, type === 'pursuit' ? { all: true } : undefined);
    const roots = rootsOf(wanted, Boolean(ids));
    return Object.fromEntries(wanted.map(id => [id, type === 'decision' && roots.get(id) ? assemble(id, roots.get(id)) : roots.get(id)]).filter(([, value]) => value !== null));
  };
  // Several screens read the same pursuits alongside decision summaries. A record-log
  // type walk opens every run; reuse it until a pursuit root changes, including
  // writes made through another store over this database.
  // Each pursuit handed out is remembered as read (`assembled`), so a change to one decision that writes back the state
  // it read writes the pursuits it changed and no others: every pursuit written is told to the index kept beside the
  // records, so a message arriving cost a walk of the scope links of every pursuit the person has (2026-10-08).
  let pursuitCache = null;
  // States handed out by read() whose pursuits may not have been looked at, and whether they were.
  const lazyPursuits = new WeakMap();
  const handedOut = ({ rows, texts }) => {
    const copy = structuredClone(rows);
    for (const [id, value] of Object.entries(copy)) assembled.set(value, texts[id]);
    return copy;
  };
  const currentPursuits = ids => {
    // A decision that cites named pursuits reads those alone, including refs that name another record kind.
    if (Array.isArray(ids)) return readAll('pursuit', [...new Set(ids)].filter(id => eeaf.typeOf(id) === 'pursuit'));
    const seq = eeaf.changeSeq?.();
    if (pursuitCache && Number.isSafeInteger(seq)) {
      const changed = seq === pursuitCache.seq ? [] : eeaf.changedSince?.(pursuitCache.seq);
      if (Array.isArray(changed) && !changed.some(id => id.startsWith('pursuit:'))) {
        pursuitCache.seq = seq;
        return handedOut(pursuitCache);
      }
    }
    const rows = readAll('pursuit');
    const after = eeaf.changeSeq?.();
    const read = { rows, texts: Object.fromEntries(Object.entries(rows).map(([id, value]) => [id, canonical(value)])) };
    pursuitCache = Number.isSafeInteger(after) ? { seq: after, ...read } : null;
    return handedOut(read);
  };
  const summaryOf = record => ({
    case_id: record.id,
    source_id: record.source_id ?? null,
    goal: record.input.goal,
    method: record.method?.id ?? null,
    status: decisionStatus(record),
    decision: record.decision ? record.input.options.find(option => option.id === record.decision.option_id)?.label ?? null : null,
    created_at: record.created_at,
    outcome_question: record.outcome_question?.question ?? null,
    recheck_on: record.recheck_on ?? null,
    cited_pursuit_ids: Object.keys(record.cited_pursuits ?? {}),
    ...(record.decision ? { move: record.decision.move ?? null, next_action: record.decision.next_action ?? null, success_measure: record.decision.success_measure ?? null } : {}),
    ...decidedSummary(record),
    // How far it has got, from its own facts (src/decision-progress.json): decided, carried out, result checked.
    ...(() => { const facts = { ...decidedSummary(record), result_checked: Boolean(record.decision && decisionResult(record)) }; return { result_checked: facts.result_checked, progress: progressFromSteps(facts, decisionSteps) }; })(),
  });
  // These decisions as summaries, each with the titles of the pursuits it cites: only those pursuits are read, so a
  // page of summaries costs the page and what it cites, never every pursuit the person has.
  const summariesOf = ids => {
    const found = ids.map(id => readOne(id, false)).filter(Boolean).map(summaryOf);
    const pursuits = currentPursuits([...new Set(found.flatMap(summary => summary.cited_pursuit_ids))]);
    return found.map(({ cited_pursuit_ids, ...summary }) => ({ ...summary, pursuits: cited_pursuit_ids.filter(id => pursuits[id]?.title).map(id => ({ id, title: pursuits[id].title })) }));
  };
  return {
    eeaf,
    // The move of these records from the decomposed tables to the log engine (src/record-move.mjs), each decision
    // kept whole laid apart as it is copied.
    move: settings => makeRecordMove({ sql, records: raw, transaction, contentId, hash: identityOf, bounds, reshape: { decision: Object.assign((...args) => decisionRecordsOf(...args), { stream: (...args) => streamDecisionRecords(...args, payloads) }), [STEP]: decisionPartRecordsOf, [CALL]: decisionPartRecordsOf }, ...(settings ? { settings } : {}) }),
    summariesByIds(ids) {
      if (!Array.isArray(ids) || ids.length > 100) throw new Error("Read at most100 decision summaries by identity.");
      return summariesOf(ids);
    },
    summaries(limit, { before } = {}) {
      return summariesOf(idsBy('created_at', { reverse: true, ...(before ? { before } : {}), limit: page(limit) }));
    },
    // The summaries of the newest `limit` decisions decided between `from` and `to` (ISO times), found by their decided_at
    // field alone (the property index), so a decision decided hours ago is found however many were opened since.
    decidedBetween(from, to, limit) {
      return summariesOf(idsBy('decided_at', { from, to, reverse: true, limit: page(limit) }));
    },
    // One page of the decisions opened at or after `from` (an ISO time, none for the oldest), oldest first, as summaries
    // (one record read each), from the created_at index alone, so a walk over what was opened since a time costs that
    // many decisions and never the store (DecisionEngine.undecidedMessages).
    createdPage({ from = '', limit = 50 } = {}) {
      return eeaf.scan('decision', 'created_at', { ...(from ? { from } : {}), limit: page(limit) })
        .map(entry => readOne(entry.id, false)).filter(Boolean)
        .map(summaryOf)
        .map(({ cited_pursuit_ids, ...summary }) => summary);
    },
    // How many decisions were started at or after `since` (an ISO time), counted from the created_at index alone.
    countSince(since) {
      return eeaf.scan('decision', 'created_at', { from: since }).length;
    },
    // The goal and method of the newest `limit` decisions (the created_at index, then each one's own fields, never its
    // answers or calls), for work that weighs decisions by their words (DecisionEngine.related) and then reads only the
    // few it keeps. The goal and method lie inside the decision (input.goal, method.id), where a field read cannot reach
    // them. Every decision's goal was read here before, so a guide cost grew with every decision ever made.
    goals({ limit = 200 } = {}) {
      return idsBy('created_at', { reverse: true, limit: page(limit) })
        .map(id => ({ id, root: own(id) })).filter(({ root }) => root)
        .map(({ id, root }) => ({ id, goal: root.input?.goal ?? '', method: root.method?.id ?? null }));
    },
    // The ids of every decision that has been decided, from its decided_at field alone (no decision rebuilt), for views
    // that read each decided decision on its own and keep a few facts of it (DecisionEngine.mapDecided).
    decidedIds() {
      return [...new Set(idsBy('decided_at'))];
    },
    // A read-only decision view for reasoning and privacy work: its own fields and every actual answered step,
    // never separate diagnostic call records, refused-call payloads or the person's unrelated pursuits. Whole legacy
    // records use readStep's member reader; a whole record still in the packed log needs its one stored value loaded.
    contentOf(id, { acceptOwn } = {}) {
      if (acceptOwn !== undefined && typeof acceptOwn !== 'function') throw new TypeError('Content admission must be a synchronous predicate.');
      const root = own(id);
      if (!root) return null;
      // The root already read for this content is its admission view. Skipped
      // work opens no answered steps; accepted work never rereads that root.
      if (acceptOwn) {
        const allowed = acceptOwn(root);
        if (typeof allowed !== 'boolean') throw new TypeError('Content admission must return a boolean synchronously.');
        if (!allowed) return null;
      }
      const split = apart(root);
      const steps = split ? root.answered_steps : stubsIn(id);
      return {
        ...withoutSummary(root),
        guidance: steps.map((stub, n) => kept(split ? answerOf(id, n, stub) : eeaf.readMember(id, 'guidance', n) ?? lostStep(stub))),
      };
    },
    // One decision's own fields (its input, decision, results and the running summary), never its answered steps or
    // logged tries; null when there is none.
    ownOf(id) { return own(id); },
    // Every decision's id, and the newest `limit` of them by when they were opened (the created_at index alone).
    caseIds() { return eeaf.ids('decision'); },
    newestIds(limit) {
      return idsBy('created_at', { reverse: true, limit: page(limit) });
    },
    // The newest `limit` of the person's pursuits that `wanted` accepts, oldest first, for a question to carry: the ids a
    // page at a time, newest first, each page read together, until `limit` are found or PURSUIT_SCAN ids are looked
    // through. `more` is true when ids remain beyond the last one looked at.
    pursuitPage(limit, wanted) {
      const found = [];
      let before;
      let looked = 0;
      while (found.length < limit && looked < PURSUIT_SCAN) {
        const ids = eeaf.ids('pursuit', { before, limit: Math.min(limit, PURSUIT_SCAN - looked) });
        if (!ids.length) break;
        let rows;
        try { rows = eeaf.readMany(ids); } catch { rows = new Map(ids.map(id => [id, readOne(id, false)])); }
        for (const id of ids) {
          before = id;
          looked += 1;
          if (rows.get(id) && wanted(rows.get(id))) found.push(rows.get(id));
          if (found.length === limit) break;
        }
      }
      return { pursuits: found.reverse(), more: before !== undefined && eeaf.ids('pursuit', { before, limit: 1 }).length > 0 };
    },
    // The decisions named in scope.cases (all of them when no scope is given) and the person's pursuits. A read of named
    // decisions that names no pursuits reads the pursuits only if the caller looks at them: most callers change or show
    // one decision, and reading every pursuit for them cost a model-waits wake 3,100 statements (2026-10-09).
    read(scope) {
      const state = { cases: readAll('decision', scope?.cases) };
      if (!scope?.cases || scope.pursuits) return { ...state, pursuits: currentPursuits(scope?.pursuits) };
      const lazy = { touched: false, rows: null };
      Object.defineProperty(state, 'pursuits', { enumerable: true, configurable: true,
        get: () => { lazy.touched = true; return (lazy.rows ??= currentPursuits()); },
        set: rows => { lazy.touched = true; lazy.rows = rows; } });
      lazyPursuits.set(state, lazy);
      return state;
    },
    // Writes each decision and pursuit in state; an unchanged record appends nothing, and a null one is removed.
    write(state, context = {}) {
      const cases = Object.entries(state.cases ?? {});
      const run = () => {
        eeaf.write([
          // A decision kept whole is written whole (only the rows that changed); every other is written apart.
          ...cases.flatMap(([id, value]) => {
            const before = own(id);
            if (value !== null) keepsEveryAnswer(id, before, value.guidance?.length ?? 0, movedToHistory(before, value));
            return before && !apart(before)
              ? [{ id, type: 'decision', value: value && Array.isArray(value.calls) ? { ...value, calls: value.calls.map(bareCall) } : value }]
              : writesOf(id, value, before);
          }),
          ...Object.entries(lazyPursuits.get(state)?.touched === false ? {} : state.pursuits ?? {}).filter(([, value]) => value === null || !unchanged(value)).map(([id, value]) => ({ id, type: 'pursuit', value })),
        ], { actor: { by: 'trillion' }, ...context });
        for (const [id, value] of cases) {
          if (value === null) payloads.forget(id);
          else (value.calls ?? []).forEach((call, n) => payloads.keep(id, n, call, KEPT_CALL_PAYLOADS));
        }
      };
      return atomic(run);
    },
    // One step's view of a decision: its own fields, its scope answer whole, every later answered step as its id and
    // time, and the answer already given to `stepId` (replay) when there is one. A submitted step reads only the
    // pursuits its answer cites; callers omitting citedRefs retain the full-list view.
    readStep(id, stepId, citedRefs = null) {
      const root = own(id);
      if (!root) return null;
      const whole = !apart(root);
      const steps = whole ? stubsIn(id) : root.answered_steps;
      const answer = n => (whole ? eeaf.readMember(id, 'guidance', n) ?? lostStep(steps[n]) : answerOf(id, n, steps[n]));
      const scope = steps.length ? answer(0) : null;
      const at = steps.findIndex(step => step.step_id === stepId);
      return {
        record: { ...root, guidance: steps.map((step, n) => (n === 0 ? scope : step)) },
        replay: at < 0 ? null : at === 0 ? scope : answer(at),
        pursuits: stepId === null ? null : citedRefs === null ? currentPursuits() : Object.fromEntries(
          [...new Set(citedRefs)].flatMap(ref => {
            // A case evidence ref may be any string, including another record's id. Only a current pursuit is citable.
            if (eeaf.typeOf(ref) !== 'pursuit') return [];
            const item = readOne(ref, false);
            return item ? [[ref, item]] : [];
          })),
      };
    },
    // Keeps the decision's own fields from a readStep view and adds the answer to its next step.
    addStep(id, record, entry, context = {}) {
      const { guidance, ...root } = record;
      // The next answer goes after every answer the decision holds, never over one a view read too early did not see.
      const storedRoot = splitWholeOnLog(id, own(id), context);
      keepsEveryAnswer(id, storedRoot, guidance.length);
      const logged = { actor: { by: 'trillion' }, ...context };
      if (!apart(storedRoot)) return inPlace(id, () => { eeaf.writeMember(id, 'decision', 'guidance', guidance.length, entry, logged); eeaf.writeOwn(id, 'decision', root, EMBEDDED, logged); });
      // The step's record goes in with the root that counts it, in one transaction and the step first, so a write that
      // stops partway never leaves a root pointing at a step that is not there.
      atomic(() => eeaf.write([
        { id: stepKey(id, guidance.length), type: STEP, value: entry },
        { id, type: 'decision', value: { ...storedRoot, ...withoutSummary(root), answered_steps: [...guidance.map(stubOf), stubOf(entry)] } },
      ], { actor: { by: 'trillion' }, ...context }));
    },
    // Keeps several answered steps and the calls that made them in ONE transaction, with the decision's own fields from
    // a readStep view (the decision made, when this answers it too): the steps and calls first, the root that counts
    // them last, so a write that stops partway leaves nothing and never a root pointing at a step that is not there.
    // The decision need not exist yet: this is then also its opening. `record.guidance` is the answers it already held.
    addSteps(id, record, entries, calls = [], keep = KEPT_CALL_PAYLOADS, context = {}) {
      const { guidance = [], calls: _, ...root } = record;
      const storedRoot = splitWholeOnLog(id, own(id), context);
      keepsEveryAnswer(id, storedRoot, guidance.length);
      const logged = { actor: { by: 'trillion' }, ...context };
      if (storedRoot && !apart(storedRoot)) {
        return inPlace(id, () => {
          entries.forEach((entry, k) => eeaf.writeMember(id, 'decision', 'guidance', guidance.length + k, entry, logged));
          const n = eeaf.memberCount(id, 'calls');
          calls.forEach((call, k) => { eeaf.writeMember(id, 'decision', 'calls', n + k, bareCall(call), logged); payloads.keep(id, n + k, call, keep); });
          eeaf.writeOwn(id, 'decision', root, EMBEDDED, logged);
        });
      }
      const n = storedRoot?.call_count ?? 0;
      const { calls_with_submission: legacy, ...counted } = storedRoot ?? {};
      atomic(() => {
        eeaf.write([
          ...entries.map((entry, k) => ({ id: stepKey(id, guidance.length + k), type: STEP, value: entry })),
          ...calls.map((call, k) => ({ id: callKey(id, n + k), type: CALL, value: bareCall(call) })),
          { id, type: 'decision', value: { ...counted, ...withoutSummary(root), answered_steps: [...guidance.map(stubOf), ...entries.map(stubOf)], call_count: n + calls.length } },
        ], logged);
        calls.forEach((call, k) => payloads.keep(id, n + k, call, keep));
      });
    },
    // Logs one call's countable fields as a record and keeps its sent content in the bounded table.
    addCall(id, call, keep = KEPT_CALL_PAYLOADS, context = {}) {
      const root = splitWholeOnLog(id, own(id), context);
      if (!root) return null;
      const logged = { actor: { by: 'trillion' }, ...context };
      if (!apart(root)) {
        const n = eeaf.memberCount(id, 'calls');
        return inPlace(id, () => {
          eeaf.writeMember(id, 'decision', 'calls', n, bareCall(call), logged);
          payloads.keep(id, n, call, keep);
          return call;
        });
      }
      const n = root.call_count;
      const { calls_with_submission: legacy, ...counted } = root;
      const run = () => {
        eeaf.write([
          { id, type: 'decision', value: { ...counted, call_count: n + 1 } },
          { id: callKey(id, n), type: CALL, value: bareCall(call) },
        ], logged);
        payloads.keep(id, n, call, keep);
      };
      atomic(run);
      return call;
    },
    // What counting the latest call needs (person-store countCall): the decision's id, method and opening time; the
    // answered step `stepId` with the one before it; the latest call and the time of the one before it; and every
    // call made at `stepId`, each as its CALL_FIELDS only.
    callsAt(id, stepId) {
      const root = own(id);
      if (!root) return null;
      if (!apart(root)) {
        // A decision kept whole: the calls made at the step (found by the step each names) and the latest two, each as
        // its CALL_FIELDS alone, and the answered step with the one before it.
        const atStep = stepId === null ? [] : eeaf.membersWhere(id, 'calls', 'step_id', stepId);
        const last = eeaf.memberCount(id, 'calls') - 1;
        const read = new Map(eeaf.memberFields(id, 'calls', CALL_FIELDS, [...new Set([...atStep, last, last - 1].filter(n => n >= 0))]).map(({ ordinal, ...call }) => [ordinal, call]));
        const steps = stubsIn(id);
        const at = steps.findIndex(step => step.step_id === stepId);
        return {
          record: { id: root.id, method: root.method, created_at: root.created_at, guidance: at < 0 ? [] : [...(at ? [steps[at - 1]] : []), eeaf.readMember(id, 'guidance', at)], calls: atStep.map(n => read.get(n)).filter(Boolean) },
          last: read.get(last) ?? null,
          previous_at: read.get(last - 1)?.at ?? root.created_at,
        };
      }
      // The calls made at the step, found by the step each names among this decision's calls (an index range, never
      // every call's record), then read as their CALL_FIELDS.
      const atStep = stepId === null ? [] : eeaf.scan(CALL, 'step_id', { equal: [stepId], idFrom: callKey(id, 0), idTo: `${CALL}:${id};` }).map(entry => entry.id);
      const last = root.call_count - 1;
      const read = fields.fieldsOf(CALL, [...atStep, ...[last, last - 1].filter(n => n >= 0).map(n => callKey(id, n))], CALL_FIELDS);
      const call = key => { const found = read.get(key); if (!found) return null; const { id: _, ...rest } = found; return rest; };
      const at = root.answered_steps.findIndex(step => step.step_id === stepId);
      return {
        record: { id: root.id, method: root.method, created_at: root.created_at, guidance: at < 0 ? [] : [...(at ? [root.answered_steps[at - 1]] : []), answerOf(id, at, root.answered_steps[at])], calls: atStep.map(call).filter(Boolean) },
        last: last >= 0 ? call(callKey(id, last)) : null,
        previous_at: last >= 1 ? call(callKey(id, last - 1))?.at ?? root.created_at : root.created_at,
      };
    },
    setting(name) {
      return eeaf.read(`setting:${name}`)?.value ?? null;
    },
    setSetting(name, value, context = {}) {
      eeaf.write([{ id: `setting:${name}`, type: 'setting', value: value === null ? null : { value } }], { actor: { by: 'trillion' }, ...context });
      return value;
    },
    settings(prefix = '') {
      const rootPrefix = `setting:${prefix}`;
      // Both record engines seek the literal prefix. The filter keeps the setting-name boundary explicit.
      return eeaf.ids('setting', { prefix: rootPrefix }).filter(id => id.startsWith(rootPrefix)).map(id => ({ name: id.slice('setting:'.length), value: eeaf.read(id)?.value ?? null }));
    },
    /** A bounded page of settings, newest names first. `before` is the last setting name from the prior page. */
    settingsPage(prefix = '', { before, limit = 200 } = {}) {
      if (typeof prefix !== 'string') throw new Error('A setting prefix must be text.');
      if (before !== undefined && (typeof before !== 'string' || !before || !before.startsWith(prefix))) throw new Error('A settings cursor must be a name inside its prefix.');
      const requested = Number(limit);
      const pageSize = Number.isFinite(requested) ? Math.max(1, Math.min(1000, Math.floor(requested))) : 200;
      const rootPrefix = `setting:${prefix}`;
      const ids = eeaf.ids('setting', { prefix: rootPrefix, ...(before === undefined ? {} : { before: `setting:${before}` }), limit: pageSize + 1 })
        .filter(id => id.startsWith(rootPrefix));
      const more = ids.length > pageSize;
      const selected = ids.slice(0, pageSize);
      return {
        settings: selected.map(id => ({ name: id.slice('setting:'.length), value: eeaf.read(id)?.value ?? null })),
        next_before: more && selected.length ? selected.at(-1).slice('setting:'.length) : null,
      };
    },
  };
}

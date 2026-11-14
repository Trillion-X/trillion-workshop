// tools/decide-with-a-method/read-data/decisions.mjs
//
// Decisions a person's AI makes with a method, as Workshop tools over the person's own records. A decision is one root record
// of type `decision` and records of its own beside it, laid out by ./decision-records.mjs so a decision of any size fits under
// the door's write cap: the root holds only fields each set by one call and counts and pointers; each evidence row, option,
// report, receipt, earlier decision and cited pursuit is a record of its own linked to the decision's id. The Decisions screen
// reads these same records. A decision made before the method became rows kept its answered steps (`decision-answered-step`,
// `decision-step:<id>:<nnn>`, each superseded version beside it); they stay readable as they were and are written back as they
// were whenever the decision is, and no new one is made.
//
// A method is a saved view over the person's method rows (../method-rows): the person's AI reads it in one pass
// (tool:read-a-method) and records its answers for any number of its rows in one call (tool:record-method-answers); how strictly
// each answer is checked is an open value on its row or its method. Trillion asks no model, and nothing here asks a judge or
// walks a fixed list of steps (the person's own order, case source:ZGVjaXNpb24tdG9vbC1pcy1yb3dzLWFuZC12aWV3cy0yMDI2LTExLTE0).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One source opens one decision; the same input again is that decision, different input is refused.
//   2. A decision is made only when every row of its method has an answer (method-rows/answers.mjs `methodAnswered`); each
//      answer was checked, for its row, its citations and its strictness, when it was recorded.
//   3. An answer and a decision cite only the decision's own evidence or the person's current pursuits. Evidence is added as
//      rows with the time they came in; an evidence row brought in from another of the person's decisions is copied as it
//      stood and checked as a typed one is.
//   4. A decided decision changes only after a failed result or check (or by the person's own word, 7); the earlier one moves
//      to decision_history.
//   5. A result is the person's: answered_by must be "person"; nothing here can mark it verified by a trusted source.
//   6. A decision is kept as shared only by ./share-a-decision.mjs, after its privacy checks.
//   7. The person may decide without the method (tool:record-a-persons-own-decision), and only the person: the source is a
//      message row they sent, holding the words given, or a run their own signed-in page started (the task's origin, which
//      no input sets). Their words and time are kept as evidence, and the decision and its root say `decided_by: "person"` and
//      `method_walked: false`. The person's word stands over a decision already made, which moves to decision_history.
import { readFileSync } from 'node:fs';
import { currentDecisionOutcome, decisionGeneration, decisionStatus, outcomeIsCurrent } from './decision-outcome.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { canonical, inputIdentity, laidTogether, markRead, mustRead, readDecision, readRevision, recordsOf, retriedOnConflict, writeDecision } from './decision-records.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
import { methodAnswered } from '../method-rows/answers.mjs';
import { methodRecord } from '../method-rows/view.mjs';
import methodRows from '../method-rows/settings.json' with { type: 'json' };

const settings = JSON.parse(readFileSync(new URL('./decide-with-a-method.json', import.meta.url), 'utf8'));
const { records: NAMES, words: WORDS, precedence, revision: REVISION, evidence: EVIDENCE, options: OPTIONS } = settings;
const writeBounds = { rows: settings.writes, bytes: settings.write_bytes };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export { canonical };
const same = (a, b) => canonical(a) === canonical(b);
// What Trillion says, filled from the decision; a filled value loses its trailing full stop, as the old words did.
export const say = (name, parts = {}) => WORDS[name].replace(/\{(\w+)\}/g, (_, key) => String(parts[key] ?? '').trim().replace(/[.\s]+$/, ''));
export const refuse = (name, parts) => { throw new Error(say(name, parts)); };
// A call's fields are the ones its tool row declares: input_schemas in decide-with-a-method.json, copied from each row's input_schema
// in tool-rows.json (the installed tool ships read-data/ only, so the root file is not read here). A field the call does not
// declare is refused by name, and a field a free-form object holds that the call declares at its top level (`verdicts` inside
// `answer`) is refused where it belongs, instead of being read as nothing.
export function refuseMisplacedFields(toolId, input) {
  const schema = settings.input_schemas[toolId];
  if (!object(schema?.properties) || !object(input)) return;
  const fields = Object.keys(schema.properties);
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(input)) if (!fields.includes(name)) refuse('field_unknown', { name, fields: fields.join(', ') });
  }
  for (const [name, value] of Object.entries(input)) {
    if (!object(value)) continue;
    const declared = object(schema.properties[name]?.properties) ? schema.properties[name].properties : {};
    for (const key of Object.keys(value)) if (key !== name && fields.includes(key) && !(key in declared)) refuse('field_misplaced', { name: key, in: name });
  }
}

export const caseIdFor = sourceId => `${NAMES.case_prefix}${Buffer.from(sourceId).toString('base64url')}`;

// Every row of one of the person's lists, in row id order, as its value; `where` keeps only the rows whose fields
// equal it, filtered by the door so the rows a call does not use never cross it.
export async function rowsOf(door, rowType, where) {
  const rows = [];
  for await (const row of door.list({ type: `record:${rowType}`, ...(where ? { where } : {}) })) rows.push(row);
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1)).map(row => row.value);
}

// The saved view that is a decision's method: the one it was opened with, else the person's default (method-rows/settings.json).
export const methodViewOf = record => record?.method_view ?? methodRows.default_method_view;

// The options a decision chooses among: the ones its caller gave.
export const optionsOf = record => record.input.options ?? [];

function validatedCase(input) {
  if (!object(input) || !nonempty(input.source_id) || !nonempty(input.goal) || !Array.isArray(input.evidence)) refuse('new_case');
  if (!Array.isArray(input.options) || input.options.length < 2) refuse('new_case');
  const refs = new Set();
  for (const item of input.evidence) {
    if (!object(item) || !nonempty(item.ref) || !nonempty(item.claim) || refs.has(item.ref)) refuse('evidence_item');
    refs.add(item.ref);
  }
  const choices = new Set();
  for (const item of input.options) {
    if (!object(item) || !nonempty(item.id) || !nonempty(item.label) || choices.has(item.id)) refuse('option_item');
    choices.add(item.id);
  }
  if (input.method !== undefined && !nonempty(input.method)) refuse('method_name');
  return caseIdFor(input.source_id);
}

/** A decision kept again after a change to its own fields (its answered steps unchanged), under request key `key`. */
export const keepDecision = (door, record, key) => writeDecision(door, recordsOf(record), key);

const pursuitIsCurrent = item => item?.status !== 'ended' && item?.status !== 'archived';
async function currentPursuits(door, most) {
  const found = [];
  let seen = 0;
  for await (const row of door.list({ type: 'pursuit', fields: ['title', 'now', 'after', 'why_it_matters', 'status'] })) {
    seen += 1;
    if (pursuitIsCurrent(row.value)) found.push({ id: row.id, ...row.value });
    if (found.length > most || seen >= settings.pursuits.scan) break;
  }
  return found;
}

/** What an answer may cite: the decision's own evidence and the cited pursuits that are current, read one by one. */
async function citable(door, record, refs) {
  const evidence = record.input.evidence.filter(item => !item.retracted_at).map(item => item.ref);
  const own = new Set(evidence);
  const pursuits = {};
  for (const ref of refs) {
    if (own.has(ref)) continue;
    const pursuit = await door.read('pursuit', ref);
    if (pursuit && pursuit.status !== 'ended') pursuits[ref] = pursuit;
  }
  return { refs: new Set([...evidence, ...Object.keys(pursuits)]), pursuits };
}
// A cited pursuit is copied into the decision as it stood then, so the record still reads true after it changes.
const keepCited = (record, pursuits, refs) => { for (const ref of refs) { const item = pursuits[ref]; if (item) (record.cited_pursuits ??= {})[ref] = `${item.title}: now ${item.now}; should be ${item.after}`; } };

const usageOf = value => {
  if (value === undefined) return undefined;
  const fine = item => (typeof item === 'number' && Number.isFinite(item) && item >= 0) || (typeof item === 'string' && item.length <= 200);
  if (!object(value) || !Object.values(value).every(fine)) throw new Error('usage maps names to non-negative numbers or short text');
  return value;
};

// The options live on the decision's root, so a new decision's options are bounded (`options` in the settings): the root
// stays far under the door's write cap however large every other field it holds is.
function optionsFit(options) {
  if (options === undefined) return;
  if (options.length > OPTIONS.most || Buffer.byteLength(JSON.stringify(options)) > OPTIONS.most_bytes) refuse('options_too_large', { count: OPTIONS.most, bytes: OPTIONS.most_bytes });
}

export const decisionId = input => { if (!nonempty(input?.decision_id)) refuse('no_decision'); return input.decision_id; };
export async function decisionOrRefuse(door, id, steps, options) {
  const record = await readDecision(door, id, steps, options);
  if (!record) refuse('not_found');
  return record;
}


// What a call about a decision answers while it is open: where it stands and what to do next, in the order of the tools.
const openReply = record => ({
  case_id: record.id, source_id: record.source_id, method: methodViewOf(record), decision: record.decision ?? null,
  options: optionsOf(record).map(({ id, label }) => ({ id, label })),
  ai_instructions: [say('read_the_method', { method: methodViewOf(record) }), say('record_the_answers'), say('decide_when_answered')],
});

/** tool:start-a-decision. input { source_id, goal, evidence: [{ ref, claim }], options: [{ id, label }], method?, parent_decision_id? }:
 * `method` is the id of a saved view over the person's method rows (the default when left out); the answers to its rows are
 * recorded with tool:record-method-answers and the decision is made when every row has one. */
export async function startADecision(input, { door }) {
  refuseMisplacedFields('tool:start-a-decision', input);
  const id = validatedCase(input);
  const method = input.method ?? methodRows.default_method_view;
  await methodRecord(door, method);
  const current = await readDecision(door, id);
  if (current) {
    if ((current.input_identity ?? inputIdentity(current.original_input ?? current.input)) !== inputIdentity(input)) refuse('source_changed', { source_id: input.source_id, case_id: id });
    return openReply(current);
  }
  optionsFit(input.options);
  const parent = await parentOf(door, input.parent_decision_id, id);
  const record = {
    id, source_id: input.source_id, input, input_identity: inputIdentity(input), method_view: method, scratchpad: [], status: 'needs_decision', decision: null, actions: [], checks: [],
    pursuits_known: (await currentPursuits(door, 0)).length > 0, created_at: new Date().toISOString(), guidance: [],
    ...(parent ? { parent: { decision_id: parent.id } } : {}),
  };
  await writeDecision(door, recordsOf(record), `start-a-decision:${id}`);
  return openReply(record);
}

/** The parent a child decision names: another of the person's decisions, never itself. Null when none is named. */
async function parentOf(door, parentId, id) {
  if (parentId === undefined) return null;
  if (!nonempty(parentId) || parentId === id) refuse('parent_invalid');
  const parent = await readDecision(door, parentId);
  if (!parent) refuse('from_not_found');
  return parent;
}


// Evidence rows as they are added: a claim typed, or a row brought in from another of the person's decisions as it stood.
async function evidenceRows(door, record, items, now) {
  const rows = [];
  for (const item of items) {
    if (!object(item) || !nonempty(item.ref)) refuse('evidence_shape');
    if (item.from !== undefined) {
      if (item.claim !== undefined || !object(item.from) || !nonempty(item.from.decision_id) || !nonempty(item.from.ref)) refuse('evidence_shape');
      if (item.from.decision_id === record.id) refuse('from_self');
      const root = await door.read('decision', item.from.decision_id);
      if (!root) refuse('from_not_found');
      const { record: source } = await laidTogether(door, item.from.decision_id, root, ['evidence']);
      const row = (source.input?.evidence ?? []).find(each => each.ref === item.from.ref && !each.retracted_at);
      if (!row) refuse('evidence_from_missing', { ref: item.from.ref });
      rows.push({ ref: item.ref, claim: row.claim, added_at: now, from: { decision_id: item.from.decision_id, ref: item.from.ref } });
    } else {
      if (!nonempty(item.claim)) refuse('evidence_shape');
      rows.push({ ref: item.ref, claim: item.claim, added_at: now });
    }
  }
  return rows;
}
// The decision's first evidence is kept as it was given; the identity of the input it was started with is kept, so the
// same source with the same input is still that decision.
const keepOriginal = record => { record.input_identity ??= inputIdentity(record.original_input ?? record.input); };
// Rows added to the decision's evidence. A row with the same ref and claim is already there; the same ref with other words
// is refused, so a citation never means two things.
function takeEvidence(record, rows) {
  for (const row of rows) {
    const have = record.input.evidence.find(item => item.ref === row.ref);
    if (have) {
      if (have.claim === row.claim) continue;
      refuse('evidence_ref_taken', { ref: row.ref });
    }
    keepOriginal(record);
    record.input.evidence.push(row);
  }
}

/** tool:add-decision-evidence. input { decision_id, evidence: [{ ref, claim } | { ref, from: { decision_id, ref } }] }: rows
 * added at any time, each kept with when it came in; the same rows again replay, and an answer may cite them at once. */
export async function addDecisionEvidence(input, { door }) {
  refuseMisplacedFields('tool:add-decision-evidence', input);
  const id = decisionId(input);
  const items = input.evidence;
  if (!Array.isArray(items) || items.length < 1 || items.length > EVIDENCE.most_per_call) refuse('evidence_count', { count: EVIDENCE.most_per_call });
  // A changed case is read again and the rows are taken again on the new read; the row that lands keeps the time of that attempt.
  return retriedOnConflict(async attempt => {
    const record = await decisionOrRefuse(door, id);
    const rows = await evidenceRows(door, record, items, new Date().toISOString());
    const before = record.input.evidence.length;
    takeEvidence(record, rows);
    const added = record.input.evidence.slice(before);
    if (!added.length) return { case_id: id, added: [], replayed: true, evidence: record.input.evidence.length };
    await writeDecision(door, recordsOf(record), `add-decision-evidence:${id}:${attempt}`);
    return { case_id: id, added, evidence: record.input.evidence.length };
  });
}

function decisionShape(decision, expectedGeneration) {
  if (!object(decision) || !nonempty(decision.option_id) || !nonempty(decision.reason) || !nonempty(decision.next_action) || !nonempty(decision.success_measure) || !Array.isArray(decision.evidence_refs)) refuse('decision_shape');
  if (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < 1)) refuse('generation_shape');
  if (decision.move !== undefined && !nonempty(decision.move)) refuse('move_shape');
}


/** tool:make-the-decision. input { decision_id, decision: { option_id, reason, next_action, success_measure, evidence_refs, move? }, usage?, expected_generation? } */
export async function makeTheDecision(input, { door }) {
  refuseMisplacedFields('tool:make-the-decision', input);
  const id = decisionId(input);
  const { decision, expected_generation: expectedGeneration } = input;
  const record = await decisionOrRefuse(door, id);
  const decidedBefore = Boolean(record.decision);
  // Every row of the method has an answer: the method is the person's, and a row it holds is a row they asked to have answered.
  const { rows, unanswered } = await methodAnswered(door, id, methodViewOf(record));
  if (unanswered.length) refuse('method_unanswered', { method: methodViewOf(record), count: unanswered.length, rows, first: unanswered.slice(0, settings.unanswered_shown).join(', ') });
  decisionShape(decision, expectedGeneration);
  if (expectedGeneration !== undefined && (record.decision
    ? (record.decision_generation ?? 1) !== expectedGeneration || !same(record.decision, decision)
    : (record.decision_generation ?? 0) + 1 !== expectedGeneration)) refuse('generation_changed');
  if (!optionsOf(record).some(option => option.id === decision.option_id)) {
    refuse('unknown_option', { option: JSON.stringify(decision.option_id), options: optionsOf(record).map(option => `${JSON.stringify(option.id)} (${option.label})`).join(', ') });
  }
  const cited = await citable(door, record, decision.evidence_refs.filter(ref => typeof ref === 'string'));
  if (decision.evidence_refs.length === 0 || decision.evidence_refs.some(ref => !cited.refs.has(ref))) refuse('decision_evidence');
  if (record.decision && same(record.decision, decision)) return decidedReply(record, true);
  keepCited(record, cited.pursuits, decision.evidence_refs);
  if (record.decision) {
    if (record.status !== 'correction_needed') refuse('new_decision_needs_failure');
    record.decision_history ??= [];
    record.decision_history.push({ decision: record.decision, decided_at: record.decided_at, revised_at: new Date().toISOString() });
  }
  record.decision = decision;
  // A decision made with the method, after the person's own one failed: the method was walked this time.
  delete record.decided_by;
  delete record.method_walked;
  record.decision_generation = (record.decision_generation ?? (decidedBefore ? 1 : 0)) + 1;
  record.status = 'needs_outcome';
  record.decided_at = new Date().toISOString();
  const usage = usageOf(input.usage);
  if (usage) record.decision_usage = usage;
  await writeDecision(door, recordsOf(record), `make-the-decision:${id}:${record.decision_generation}`);
  return decidedReply(record, false);
}

const outcomeRevision = record => (record.outcome_revision = (record.outcome_revision ?? 0) + 1);
const carriedOut = record => Boolean(record?.decision) && (record.carried_out ?? []).some(entry => entry.decision_generation === (record.decision_generation ?? 1));
function decidedReply(record, already) {
  return {
    case_id: record.id, source_id: record.source_id, ...(already ? { already_decided: true, note: WORDS.decided_note } : {}),
    decision: record.decision,
    resume: { next_action: record.decision.next_action, success_measure: record.decision.success_measure, instruction: say('resume', record.decision) },
    carried_out: carriedOut(record), ...(carriedOut(record) ? {} : { ai_instructions: [say('carry_out', { ...record.decision, case_id: record.id })] }),
  };
}

// Where a person's own decision came from (settings `person_verdict`): the message row they sent, read here and found to be
// theirs with their words in it, or a run their own signed-in page started, which only the engine can attest (the task's
// origin). Anything else is an AI saying the person decided, and is refused.
async function personSource(door, person, origin, run) {
  const { message: MESSAGE, basis: BASIS } = settings.person_verdict;
  if (nonempty(person.message_id)) {
    const kept = await door.read(MESSAGE.type, person.message_id);
    if (!object(kept)) refuse('person_message_missing', { id: person.message_id });
    if (kept[MESSAGE.speaker_field] !== MESSAGE.person) refuse('person_message_not_theirs', { id: person.message_id, speaker: kept[MESSAGE.speaker_field] ?? 'no one named' });
    if (typeof kept[MESSAGE.text_field] !== 'string' || !kept[MESSAGE.text_field].includes(person.said)) refuse('person_words_not_said', { id: person.message_id });
    const screen = MESSAGE.screen_roads.includes(kept[MESSAGE.road_field]);
    return { basis: screen ? BASIS.screen : BASIS.message, source_ref: person.message_id, said: person.said, at: kept[MESSAGE.at_field] ?? null };
  }
  if (origin === settings.person_verdict.page_origin && nonempty(run)) return { basis: BASIS.screen, source_ref: `run:${run}`, said: person.said, at: new Date().toISOString() };
  refuse('person_verdict_no_person');
}

/** tool:record-a-persons-own-decision. The engine fills { verdict: <the call's input>, origin?, run } from the run (the
 * row's stdin): verdict { decision_id, option_id, next_action, success_measure, person: { said, message_id? } }. The person
 * decided; their words and time are the evidence; the method's rows are not answered by it,
 * and need no answer. A decision an AI makes still has every row of its method answered (tool:make-the-decision). */
export async function recordAPersonsOwnDecision({ verdict, origin, run } = {}, { door }) {
  const PERSON = settings.person_verdict;
  if (!object(verdict)) refuse('person_verdict_shape');
  refuseMisplacedFields('tool:record-a-persons-own-decision', verdict);
  const { option_id: optionId, next_action: nextAction, success_measure: successMeasure, person } = verdict;
  if (!nonempty(optionId) || !nonempty(nextAction) || !nonempty(successMeasure) || !object(person) || !nonempty(person.said)) refuse('person_verdict_shape');
  const id = decisionId(verdict);
  const record = await decisionOrRefuse(door, id);
  if (!optionsOf(record).some(option => option.id === optionId)) {
    refuse('unknown_option', { option: JSON.stringify(optionId), options: optionsOf(record).map(option => `${JSON.stringify(option.id)} (${option.label})`).join(', ') });
  }
  const source = await personSource(door, person, origin, run);
  const sameVerdict = decision => decision?.decided_by === PERSON.decided_by && decision.option_id === optionId && decision.next_action === nextAction
    && decision.success_measure === successMeasure && decision.person_source?.source_ref === source.source_ref && decision.person_source?.said === source.said;
  if (sameVerdict(record.decision)) return { ...decidedReply(record, true), ...personNote(record) };
  const generation = (record.decision_generation ?? (record.decision ? 1 : 0)) + 1;
  const ref = PERSON.evidence_ref.replace('{generation}', String(generation));
  takeEvidence(record, [{ ref, claim: source.said, added_at: new Date().toISOString(), person_source: source }]);
  // The person's word stands over any decision already made: that one moves to the decision's history.
  if (record.decision) {
    record.decision_history ??= [];
    record.decision_history.push({ decision: record.decision, decided_at: record.decided_at, revised_at: new Date().toISOString(), replaced_by: PERSON.decided_by });
  }
  record.decision = { option_id: optionId, reason: source.said, next_action: nextAction, success_measure: successMeasure, evidence_refs: [ref], decided_by: PERSON.decided_by, person_source: source };
  record.decided_by = PERSON.decided_by;
  record.method_walked = false;
  record.decision_generation = generation;
  record.status = 'needs_outcome';
  record.decided_at = new Date().toISOString();
  await writeDecision(door, recordsOf(record), `record-a-persons-own-decision:${id}:${generation}`);
  return { ...decidedReply(record, false), ...personNote(record) };
}
const personNote = record => ({
  decided_by: record.decided_by, method_walked: false,
  note: say('person_decided_note', { basis: record.decision.person_source.basis, at: record.decision.person_source.at }),
});

// The status a new piece of evidence gives the decision, when it is the current outcome.
const applyOutcome = (record, entry) => {
  const current = currentDecisionOutcome(record, precedence);
  if (current?.evidence !== entry) return;
  record.status = current.result === 'failed' ? 'correction_needed'
    : current.result === 'met' && current.by === 'checked' ? 'outcome_verified' : 'needs_outcome';
};
function observedAt(value, now) {
  if (value === undefined) return now;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at > Date.parse(now)) refuse('observed_at_shape');
  return new Date(at).toISOString();
}

/** tool:report-a-decision-result. input { decision_id, result, summary, answered_by: "person", source_ref?, supersedes?, observed_at?, expected_generation? } */
export async function reportADecisionResult(input, { door }) {
  refuseMisplacedFields('tool:report-a-decision-result', input);
  const id = decisionId(input);
  if (!['met', 'failed', 'unknown'].includes(input.result) || !nonempty(input.summary)) refuse('result_shape');
  if (input.answered_by !== 'person') refuse('ask_the_person');
  if (input.source_ref !== undefined && !nonempty(input.source_ref)) refuse('source_ref_shape');
  if (input.expected_generation !== undefined && (!Number.isInteger(input.expected_generation) || input.expected_generation < 1)) refuse('report_generation_shape');
  const record = await decisionOrRefuse(door, id);
  if (!record.decision) refuse('no_decision_yet');
  record.reports ??= [];
  const sameWords = item => item.result === input.result && item.summary === input.summary
    && (input.observed_at === undefined || item.observed_at === new Date(input.observed_at).toISOString()) && item.supersedes === input.supersedes;
  const named = input.source_ref ? record.reports.find(item => item.source_ref === input.source_ref) : null;
  if (named && !sameWords(named)) refuse('report_words_differ');
  const repeated = named ?? record.reports.find(item => outcomeIsCurrent(record, item, 'report') && sameWords(item) && (input.source_ref === undefined || item.source_ref === input.source_ref));
  if (repeated) return { case_id: id, report: repeated, reports: record.reports.length, status: decisionStatus(record, precedence), repeated: true };
  if (input.expected_generation !== undefined && input.expected_generation !== decisionGeneration(record)) refuse('stale_outcome');
  if (input.supersedes !== undefined && (!nonempty(input.supersedes) || input.supersedes === input.source_ref
    || !record.reports.some(item => item.source_ref === input.supersedes && outcomeIsCurrent(record, item, 'report')))) refuse('supersedes_shape');
  const reportedAt = new Date().toISOString();
  const entry = {
    result: input.result, summary: input.summary, answered_by: 'person', reported_for: 'person', attribution_basis: 'caller_claim',
    source_ref: input.source_ref ?? `report:${id}:${decisionGeneration(record)}:${record.reports.length + 1}`,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    observed_at: observedAt(input.observed_at, reportedAt), reported_at: reportedAt,
    decision_generation: decisionGeneration(record), outcome_revision: outcomeRevision(record),
  };
  record.reports.push(entry);
  applyOutcome(record, entry);
  await writeDecision(door, recordsOf(record), `report-a-decision-result:${id}:${entry.source_ref}`);
  return { case_id: id, report: entry, reports: record.reports.length, status: record.status };
}

/** tool:say-what-was-done. input { decision_id, state: "done" | "wall", what_happened, by?, expected_generation? } */
export async function sayWhatWasDone(input, { door }) {
  refuseMisplacedFields('tool:say-what-was-done', input);
  const id = decisionId(input);
  if (!['done', 'wall'].includes(input.state) || !nonempty(input.what_happened)) refuse('said_shape');
  if (input.expected_generation !== undefined && (!Number.isInteger(input.expected_generation) || input.expected_generation < 1)) refuse('generation_shape');
  const record = await decisionOrRefuse(door, id);
  if (!record.decision) refuse('no_decision_yet');
  if (input.expected_generation !== undefined && input.expected_generation !== (record.decision_generation ?? 1)) refuse('said_generation_changed');
  const entry = { decision_generation: record.decision_generation ?? 1, state: input.state, what_happened: String(input.what_happened).slice(0, 4000), by: nonempty(input.by) ? String(input.by).slice(0, 200) : null, at: new Date().toISOString() };
  (record.carried_out ??= []).push(entry);
  await writeDecision(door, recordsOf(record), `say-what-was-done:${id}:${record.carried_out.length}`);
  return { case_id: id, carried_out: entry, status: record.status };
}

// A decision no one will carry on is ended, never deleted: its status becomes `ending.status` and the status it had,
// when, who and why stay on the record beside every field it already had. Each write is conditioned on the value just
// read (`expected`), so a decision that changed in between is left as it is and answered as a conflict. A root too large
// to send beside its own `expected` in one door message is ended through the decision's layout (endLaidApart).
const CHANGED = 'original_command_conflict';
const TOO_LARGE = 'http_413';
const utf8 = new TextEncoder();
const bytesOf = value => utf8.encode(JSON.stringify(value)).length;
const contentKey = (prefix, list) => `${prefix}:${makeHashCodeHexFromBytes(utf8.encode(canonical(list)))}`;
const ENDED_FIELDS = ['status', 'previous_status', 'ended_at', 'ended_by', 'ended_because'];

// The engine's `expected` must carry the whole old root, and a root this large (an old-layout root with its lists inline
// can be 70 KB) cannot fit beside itself in one 64 KiB message. So this path ends the decision the way sayWhatWasDone
// keeps a change: read it with its lists, set the ending fields, and lay it apart so every write fits, its root last. It
// checks for a change by reading the raw root a second time just before the write; the window between that read and
// the write is not covered. A door that still refuses one of its writes as too large (413) leaves that decision as it
// was (a part written before the refusal is never counted by its root) and answers it not ended, so it never fails the
// call for the decisions beside it.
async function endLaidApart(door, { id, root, value }, answers) {
  const record = await readDecision(door, id);
  if (!record) { answers.set(id, { decision_id: id, ended: false, reason: WORDS.not_found }); return; }
  for (const field of ENDED_FIELDS) record[field] = value[field];
  const again = await door.read('decision', id);
  if (canonical(again) !== canonical(root)) {
    answers.set(id, { decision_id: id, ended: false, conflict: true, reason: WORDS.end_changed });
    return;
  }
  // Each end has its own request keys: an earlier end of this decision that wrote some parts and then failed used
  // `end-a-decision:${id}` with other content, and the engine refuses a key reused with different input. The same call
  // retried (same ended_at) still replays under the same keys.
  markRead(record, await readRevision(door, id));
  const ending = { id, ended_at: value.ended_at, ended_because: value.ended_because, ended_by: value.ended_by };
  const key = `end-a-decision:${id}:${makeHashCodeHexFromBytes(utf8.encode(canonical(ending)))}`;
  try { await writeDecision(door, recordsOf(record), key); }
  catch (error) {
    if (error?.code === CHANGED) {
      answers.set(id, { decision_id: id, ended: false, conflict: true, reason: WORDS.end_changed });
      return;
    }
    if (error?.code !== TOO_LARGE) throw error;
    answers.set(id, { decision_id: id, ended: false, too_large: true, reason: WORDS.end_too_large });
    return;
  }
  answers.set(id, { decision_id: id, ended: true, previous_status: value.previous_status, ended_at: value.ended_at, laid_apart: true });
}

async function writeEnded(door, batch, answers, roots) {
  try {
    await door.write(batch, { key: contentKey('end-a-decision', batch) });
    for (const { id, value } of batch) answers.set(id, { decision_id: id, ended: true, previous_status: value.previous_status, ended_at: value.ended_at });
  } catch (error) {
    if (error?.code !== CHANGED && error?.code !== TOO_LARGE) throw error;
    // A refused write changed nothing; each of its decisions is tried alone, so one that changed, or one too large for
    // the door with its `expected`, holds back only itself.
    if (batch.length > 1) for (const record of batch) await writeEnded(door, [record], answers, roots);
    else if (error.code === TOO_LARGE) await endLaidApart(door, { id: batch[0].id, root: roots.get(batch[0].id), value: batch[0].value }, answers);
    else answers.set(batch[0].id, { decision_id: batch[0].id, ended: false, conflict: true, reason: WORDS.end_changed });
  }
}

/** tool:end-a-decision. input { decisions: [{ decision_id, because }] (1 to ending.most, each id once), by }: answers
 * { ended, not_ended, decisions: [{ decision_id, ended, ... }] } in the order asked. A decision already ended answers
 * ended with already; one whose status is in ending.keeps_open, or that is not there, is not ended. One whose conditioned
 * write is over `write_bytes` is ended through its layout and answers laid_apart. */
export async function endDecisions(input, { door }) {
  refuseMisplacedFields('tool:end-a-decision', input);
  const { ending } = settings;
  const asked = input?.decisions;
  if (!Array.isArray(asked) || asked.length < 1 || asked.length > ending.most || !nonempty(input.by)
    || asked.some(item => !object(item) || !nonempty(item.decision_id) || !nonempty(item.because))
    || new Set(asked.map(item => item.decision_id)).size !== asked.length) refuse('end_shape', { most: ending.most });
  const at = new Date().toISOString();
  const by = String(input.by).slice(0, settings.revision.by_max_chars);
  const answers = new Map();
  const roots = new Map();
  const records = [];
  const large = [];
  for (const { decision_id: id, because } of asked) {
    const root = await door.read('decision', id);
    if (root) mustRead('decision', id, root);
    if (!root) answers.set(id, { decision_id: id, ended: false, reason: WORDS.not_found });
    else if (root.status === ending.status) answers.set(id, { decision_id: id, ended: true, already: true, previous_status: root.previous_status ?? null, ended_at: root.ended_at ?? null });
    else if (ending.keeps_open.includes(root.status)) answers.set(id, { decision_id: id, ended: false, status: root.status, reason: say('end_kept_open', { status: root.status }) });
    else {
      const value = { ...root, status: ending.status, previous_status: root.status ?? null, ended_at: at, ended_by: by, ended_because: String(because).slice(0, ending.because_max_chars) };
      const record = { id, type: 'decision', value, expected: { type: 'decision', value: root } };
      roots.set(id, root);
      if (bytesOf({ records: [record] }) <= settings.write_bytes) records.push(record);
      else large.push({ id, root, value });
    }
  }
  for (const batch of writeBatches(records, writeBounds)) await writeEnded(door, batch, answers, roots);
  for (const item of large) await endLaidApart(door, item, answers);
  const decisions = asked.map(({ decision_id: id }) => answers.get(id));
  const ended = decisions.filter(item => item.ended).length;
  return { ended, not_ended: decisions.length - ended, decisions };
}

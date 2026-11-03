// tools/decide-with-a-method/read-data/decisions.mjs
//
// Decisions a person's AI makes with a method, as Workshop tools over the person's own records. Ported from the old
// app's DecisionEngine (src/engine.mjs: admit, guide, decideGuided, decide, reportResult, recordCarriedOut) and the
// record layout of its decision store (src/decision-store.mjs): a decision is one root record of type `decision`
// holding its method snapshot and a running summary of its answered steps (`answered_steps`, each { step_id,
// answered_at, checks, graded, graded_by, version, needs_recheck }: how many checks the step handed its judge, how many
// verdicts came back and who graded them, which version of the answer is current, and whether a revision of an earlier
// step has made it stand to be asked again); each answered step is a record of its own (`decision-step:<id>:<nnn>`)
// holding the current answer, the checks it was asked and the verdicts taken. A superseded version of a step is kept
// beside it (`decision-step:<id>:<nnn>:v<vvv>`), so a revision never overwrites what was answered.
// Answering one step reads the decision's own fields, its scope answer and the step it repeats, never every earlier
// answer. The Decisions screen reads these same records.
//
// The methods are the person's: rows of their Methods list (one per method) and of their Method checks list (one per
// check, naming its step and method), row types in `records` of read-data/decide-with-a-method.json, so they see and
// edit them. Trillion asks no model: the calling AI judges each check and sends its verdicts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One source opens one decision; the same input again is that decision, different input is refused.
//   2. A step is answered in its turn; the same answer again replays, a different one is refused unless it is sent as a
//      revision with its reason (`revise.because`), which keeps the old version and flags every later step to be asked again.
//   3. An answer and a decision cite only the decision's own evidence or the person's current pursuits. Evidence is
//      added as rows with the time they came in; an answer or an evidence row brought in from another of the person's
//      decisions is copied as it stood and checked as a typed one is.
//   4. A decided decision changes only after a failed result or check; the earlier one moves to decision_history, and
//      its answers can be revised only after that failed result.
//   5. A result is the person's: answered_by must be "person"; nothing here can mark it verified by a trusted source.
//   6. A decision is kept as shared only by ./share-a-decision.mjs, after its privacy checks.
import { readFileSync } from 'node:fs';
import { AnswerProblems, judgedProblems, methodCatalogue, refusalWords } from './method.mjs';
import { takeCallerVerdicts } from './verdicts.mjs';
import { currentDecisionOutcome, decisionGeneration, decisionStatus, outcomeIsCurrent } from './decision-outcome.mjs';
import { similarDecisions } from './similar-decisions.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const settings = JSON.parse(readFileSync(new URL('./decide-with-a-method.json', import.meta.url), 'utf8'));
const { records: NAMES, words: WORDS, precedence, candidates: CANDIDATES, revision: REVISION, evidence: EVIDENCE, history: HISTORY } = settings;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
// Same content in any key order is the same request, so a retried call replays instead of failing.
export const canonical = value => JSON.stringify(value, (key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a, b) => canonical(a) === canonical(b);
// What Trillion says, filled from the decision; a filled value loses its trailing full stop, as the old words did.
export const say = (name, parts = {}) => WORDS[name].replace(/\{(\w+)\}/g, (_, key) => String(parts[key] ?? '').trim().replace(/[.\s]+$/, ''));
export const refuse = (name, parts) => { throw new Error(say(name, parts)); };

export const caseIdFor = sourceId => `${NAMES.case_prefix}${Buffer.from(sourceId).toString('base64url')}`;
const stepKey = (id, n) => `${NAMES.step}${id}:${String(n).padStart(NAMES.step_digits, '0')}`;
// A superseded version of a step, kept beside the step: its key, then the version (`:v001`, `:v002`, ...).
const versionKey = (id, n, version) => `${stepKey(id, n)}${NAMES.version}${String(version).padStart(NAMES.version_digits, '0')}`;
const callKey = (id, n) => `${NAMES.call}${id}:${String(n).padStart(NAMES.call_digits, '0')}`;
// A logged call keeps what it was, never the payload it carried (the old store kept those apart and bounded).
const bareCall = call => (object(call) ? Object.fromEntries(Object.entries(call).filter(([field]) => !['submission', 'problems'].includes(field))) : call);
// A step's checks are kept as { checks } and its verdicts as { given } (a store keeps objects, not lists, once);
// callers read and write the lists.
const PACKED = { checklist: 'checks', verdicts: 'given' };
const packStep = entry => (object(entry) ? Object.fromEntries(Object.entries(entry).map(([field, item]) => [field, PACKED[field] && Array.isArray(item) ? { [PACKED[field]]: item } : item])) : entry);
const unpackStep = entry => (object(entry) ? Object.fromEntries(Object.entries(entry).map(([field, item]) => [field, PACKED[field] && object(item) && Array.isArray(item[PACKED[field]]) ? item[PACKED[field]] : item])) : entry);
// Whether a step needs a recheck is kept on the root's summary only, so flagging later steps never rewrites their records.
const FLAGS = ['needs_recheck', 'recheck_of', 'rechecked_at'];
const stepRecordOf = entry => Object.fromEntries(Object.entries(entry).filter(([field]) => !FLAGS.includes(field)));
// A step read whole carries its verdicts; a step read as its stub carries the counts already made from them.
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

// Every row of one of the person's lists, in row id order, as its value; `where` keeps only the rows whose fields
// equal it, filtered by the door so the rows a call does not use never cross it.
export async function rowsOf(door, rowType, where) {
  const rows = [];
  for await (const row of door.list({ type: `record:${rowType}`, ...(where ? { where } : {}) })) rows.push(row);
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1)).map(row => row.value);
}
async function methodsOf(door) {
  const methods = await rowsOf(door, NAMES.method_row);
  if (!methods.length) refuse('no_methods');
  return methods;
}
const catalogue = (methods, checks = []) => methodCatalogue(methods, checks, { grader: settings.grader });
// The method functions with the check rows of one step: that step's rows and the rows it names by id (`check_ids`), each
// read with the door's `where`, so a call carries one step's checks, never the whole list. The step is the one given,
// or the step asked next.
async function catalogueAt(door, methods, record, step = undefined) {
  const bare = catalogue(methods);
  const current = step === undefined ? bare.nextStepOf(record) : step;
  if (!current || current.kind === 'scope') return bare;
  const checks = await rowsOf(door, NAMES.check_row, { [NAMES.check_step_field]: current.id });
  for (const id of current.check_ids ?? []) checks.push(...await rowsOf(door, NAMES.check_row, { [NAMES.check_id_field]: id }));
  return catalogue(methods, checks);
}

// A decision kept apart (its root names its answered steps) or kept whole (its root holds its guidance itself).
const keptWhole = root => Array.isArray(root.guidance) && !Array.isArray(root.answered_steps);

/** The decision with its scope answer whole and every later step as its summary; `steps` names others to read whole. */
async function readDecision(door, id, steps = []) {
  const root = await door.read('decision', id);
  if (!root) return null;
  if (keptWhole(root)) return { ...root, id, whole: true };
  const stubs = Array.isArray(root.answered_steps) ? root.answered_steps : [];
  const wanted = new Set([0, ...stubs.flatMap((stub, n) => (steps.includes(stub.step_id) ? [n] : []))]);
  const guidance = [];
  for (const [n, stub] of stubs.entries()) {
    if (wanted.has(n)) {
      const whole = unpackStep(await door.read('decision-step', stepKey(id, n))) ?? lostStep(stub);
      guidance.push({ ...whole, ...flagsOf(stub) });
    } else guidance.push({ ...stub, ...flagsOf(stub) });
  }
  const { answered_steps: _stubs, ...own } = root;
  return { ...own, id, guidance };
}

/**
 * The records one write keeps: the root with its running summary, the steps at `changed` (indices into the guidance),
 * and the superseded versions `archived` ({ key, entry }). A decision kept whole is laid apart in this write: all its
 * steps and its calls become records of their own.
 */
function recordsOf(record, changed = [], archived = []) {
  const { guidance = [], calls, whole, id, ...own } = record;
  // The method's id beside its snapshot, so a list that weighs decisions by method reads one short field.
  const root = { ...own, id, ...(own.method?.id ? { method_id: own.method.id } : {}), answered_steps: guidance.map(stubOf), call_count: record.call_count ?? (Array.isArray(calls) ? calls.length : 0) };
  const steps = whole ? guidance.map((_, n) => n) : changed;
  return [
    { id, type: 'decision', value: root },
    ...steps.map(n => ({ id: stepKey(id, n), type: 'decision-step', value: packStep(stepRecordOf(guidance[n])) })),
    ...archived.map(({ key, entry }) => ({ id: key, type: 'decision-step', value: packStep(stepRecordOf(entry)) })),
    ...(whole && Array.isArray(calls) ? calls.map((call, n) => ({ id: callKey(id, n), type: 'decision-call', value: bareCall(call) })) : []),
  ];
}

// One write when it fits one door message (`writes` records, `write_bytes` bytes); otherwise the steps and calls first
// and the root last, so a root never names a step that is not there yet. Each part keeps its own request key, so a write
// sent again answers the receipt it already saved.
const writeBounds = { rows: settings.writes, bytes: settings.write_bytes };
async function writeDecision(door, list, key) {
  if (writeBatches(list, writeBounds).length === 1) return door.write(list, { key });
  const [root, ...parts] = list;
  for (const [at, batch] of writeBatches(parts, writeBounds).entries()) await door.write(batch, { key: `${key}:part:${at}` });
  return door.write([root], { key });
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
// The person's pursuits travel with the questions that name the change and judge whether it is worth it.
async function pursuitsFor(door, question) {
  if (!question || !settings.pursuits.with_steps.includes(question.step_id)) return {};
  const found = await currentPursuits(door, settings.pursuits.carried);
  const list = found.slice(0, settings.pursuits.carried);
  if (!list.length) return { pursuits: [], pursuits_note: WORDS.no_pursuits_note };
  const more = found.length > list.length;
  return { pursuits: list.map(({ id, title, now, after, why_it_matters, status }) => ({ id, title, now, after, why_it_matters, status })), pursuits_note: `${WORDS.pursuits_note}${more ? ` ${say('more_pursuits_note', { count: list.length })}` : ''}` };
}

// An answer can cite a pursuit at its top level or in a nested check, omitted switch or workflow answer.
function citedRefsIn(answer) {
  const refs = new Set();
  const pending = [answer];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item === 'object') pending.push(item); continue; }
    if (!object(value)) continue;
    for (const [name, item] of Object.entries(value)) {
      if (name === 'evidence_refs' && Array.isArray(item)) {
        for (const ref of item) if (typeof ref === 'string') {
          refs.add(ref);
          if (refs.size > settings.most_cited_refs) refuse('too_many_refs', { count: settings.most_cited_refs });
        }
      } else if (item && typeof item === 'object') pending.push(item);
    }
  }
  return [...refs];
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

// A planned workflow run is checked by run id; no run can be read here, so a named run is refused, never trusted.
function noRunIds(runs, prefix) {
  for (const [workflow, item] of Object.entries(object(runs) ? runs : {})) {
    if (item?.run_id !== undefined) refuse('run_id_unchecked', { label: `${prefix}.${workflow}` });
  }
}

const usageOf = value => {
  if (value === undefined) return undefined;
  const fine = item => (typeof item === 'number' && Number.isFinite(item) && item >= 0) || (typeof item === 'string' && item.length <= 200);
  if (!object(value) || !Object.values(value).every(fine)) throw new Error('usage maps names to non-negative numbers or short text');
  return value;
};

const outOfTurn = (record, step, sent) => (step
  ? say('out_of_turn', { step: step.id, count: record.guidance.length, sent })
  : say('all_answered', { count: record.guidance.length }));

// The options a decision chooses among: the ones its caller gave, or, for a decision opened from its goal and
// constraints alone, the candidates its own method steps left standing (`candidates` in the settings).
export const optionsOf = record => record.input.options ?? record.candidates ?? [];

// A step's answer that lists what is still standing (the settings' `candidates.field`) becomes the candidates of a
// decision opened without options; each item is its words, or { id, label }.
const candidatesFrom = list => list.map((item, n) => (object(item) && nonempty(item.id) && nonempty(item.label)
  ? { id: item.id, label: item.label } : { id: `${CANDIDATES.id_prefix}${n + 1}`, label: String(item) }));

function validatedCase(input, cat) {
  if (!object(input) || !nonempty(input.source_id) || !nonempty(input.goal) || !Array.isArray(input.evidence)) refuse('new_case');
  if (input.options !== undefined && (!Array.isArray(input.options) || input.options.length < 2)) refuse('new_case');
  const refs = new Set();
  for (const item of input.evidence) {
    if (!object(item) || !nonempty(item.ref) || !nonempty(item.claim) || refs.has(item.ref)) refuse('evidence_item');
    refs.add(item.ref);
  }
  const choices = new Set();
  for (const item of input.options ?? []) {
    if (!object(item) || !nonempty(item.id) || !nonempty(item.label) || choices.has(item.id)) refuse('option_item');
    choices.add(item.id);
  }
  if (input.method !== undefined && !nonempty(input.method)) refuse('method_name');
  return { id: caseIdFor(input.source_id), method: cat.snapshotMethod(input.method ?? cat.defaultMethodId()) };
}

const ready = (cat, record) => {
  const asked = cat.decisionFieldsAsked(record);
  return { ai_instructions: [say(optionsOf(record).length ? 'ready' : 'none_standing')], options: optionsOf(record).map(({ id, label }) => ({ id, label })), how_to_say_it: cat.howToSayIt(record), ...(asked.length ? { decision_fields: asked } : {}) };
};

async function guideReply(door, cat, record) {
  const question = cat.currentQuestion(record);
  // At the moment of choice, what happened in similar earlier decisions.
  const similar = !question && !record.decision ? (await similarDecisions({ decision_id: record.id, limit: 5 }, { door })).similar_decisions : undefined;
  return {
    case_id: record.id, source_id: record.source_id, question, ...(question?.checklist ? { explain: WORDS.explain_note } : {}), ...(question?.recheck ? { recheck_note: say('recheck_note', { step: question.recheck.revised_step }) } : {}), ...(await pursuitsFor(door, question)),
    method_coverage: cat.methodCoverage(record), decision: record.decision ?? null,
    ...(record.workflow_plan ? { workflow_plan: record.workflow_plan } : {}),
    ...(similar ? { similar_decisions: similar } : {}),
    ...(!record.input.options && question?.fields?.includes(CANDIDATES.field) ? { candidates_note: say('candidates_note', { field: CANDIDATES.field }) } : {}),
    ...(!question && !record.decision ? ready(cat, record) : {}),
  };
}

export const decisionId = input => { if (!nonempty(input?.decision_id)) refuse('no_decision'); return input.decision_id; };
export async function decisionOrRefuse(door, id, steps) {
  const record = await readDecision(door, id, steps);
  if (!record) refuse('not_found');
  return record;
}

/** tool:start-a-decision. input { source_id, goal, evidence: [{ ref, claim }], options?: [{ id, label }], method? }: with no
 * options the method's own steps generate and rule out candidates (optionsOf). */
export async function startADecision(input, { door }) {
  const methods = await methodsOf(door);
  const { id, method } = validatedCase(input, catalogue(methods));
  const current = await readDecision(door, id);
  if (current) {
    if (canonical(current.original_input ?? current.input) !== canonical(input)) refuse('source_changed', { source_id: input.source_id, case_id: id });
    return guideReply(door, await catalogueAt(door, methods, current), current);
  }
  const record = {
    id, source_id: input.source_id, input, method, scratchpad: [], status: 'needs_decision', decision: null, actions: [], checks: [],
    pursuits_known: (await currentPursuits(door, 0)).length > 0, created_at: new Date().toISOString(), guidance: [],
  };
  await writeDecision(door, recordsOf(record), `start-a-decision:${id}`);
  return guideReply(door, await catalogueAt(door, methods, record), record);
}

/** tool:next-decision-question. input { decision_id, explain? | versions_of? }: `explain` names checks of the current question,
 * and the reply is then only their whole words (what a good answer does, what it refuses) as `explained`, beside the step
 * they belong to; the question itself was already sent. `versions_of` names a step, and the reply is its versions, oldest
 * first, each with who, when, why and its answer. */
export async function nextDecisionQuestion(input, { door }) {
  if (input.versions_of !== undefined) {
    const record = await decisionOrRefuse(door, decisionId(input), nonempty(input.versions_of) ? [input.versions_of] : []);
    return versionsReply(door, record, input.versions_of);
  }
  const record = await decisionOrRefuse(door, decisionId(input));
  const cat = await catalogueAt(door, await methodsOf(door), record);
  if (input.explain === undefined) return guideReply(door, cat, record);
  if (!Array.isArray(input.explain) || !input.explain.length || input.explain.length > settings.most_explained || !input.explain.every(nonempty)) refuse('explain_shape', { count: settings.most_explained });
  const { texts, unknown } = cat.checkTexts(record, input.explain);
  if (unknown.length) refuse('explain_unknown', { ids: unknown.join(', ') });
  return { case_id: record.id, step_id: cat.currentQuestion(record)?.step_id ?? null, explained: texts };
}

// The versions of one answered step, the newest HISTORY.most_versions at most, oldest first. A version that cannot be read
// is named as lost, never left out.
async function versionsReply(door, record, stepId) {
  if (!nonempty(stepId)) refuse('versions_shape');
  const at = record.guidance.findIndex(item => item.step_id === stepId);
  if (at < 0 || record.guidance[at].lost) refuse('unanswered_step', { step: stepId });
  const current = record.guidance[at];
  const top = current.version ?? 1;
  const versions = [];
  for (let version = Math.max(1, top - HISTORY.most_versions + 1); version <= top; version += 1) {
    const entry = version === top ? current : unpackStep(await door.read('decision-step', versionKey(record.id, at, version)));
    if (!entry) { versions.push({ version, lost: true }); continue; }
    versions.push({
      version, current: version === top, answered_at: entry.answered_at ?? null, by: entry.by ?? null,
      ...(entry.because ? { because: entry.because } : {}), ...(entry.from ? { from: entry.from } : {}), ...(entry.confirmed_at ? { confirmed_at: entry.confirmed_at } : {}),
      ...(entry.superseded_at ? { superseded_at: entry.superseded_at } : {}), answer: entry.answer ?? {},
    });
  }
  return { case_id: record.id, step_id: stepId, versions };
}

// What an answer call names: an answer or a `from`, not both; a confirmation alone; a revision with its reason.
function answerShape(input) {
  if (input.confirm !== undefined && input.confirm !== true) refuse('confirm_shape');
  if (input.confirm === true && (input.answer !== undefined || input.from !== undefined || input.revise !== undefined)) refuse('confirm_alone');
  if (input.answer !== undefined && input.from !== undefined) refuse('from_and_answer');
  if (input.from !== undefined) fromShape(input.from);
  if (input.revise !== undefined) reviseShape(input.revise);
}
const fromShape = from => {
  if (!object(from) || !nonempty(from.decision_id) || !nonempty(from.step_id) || (from.version !== undefined && !(Number.isInteger(from.version) && from.version >= 1))) refuse('from_shape');
};
const reviseShape = revise => {
  if (!object(revise) || Object.keys(revise).some(name => !['because', 'by'].includes(name))) refuse('revise_shape');
  const count = nonempty(revise.because) ? revise.because.trim().split(/\s+/).length : 0;
  if (count < REVISION.because_min_words || count > REVISION.because_max_words) refuse('revise_because', { min: REVISION.because_min_words, max: REVISION.because_max_words });
  if (revise.by !== undefined && (!nonempty(revise.by) || revise.by.length > REVISION.by_max_chars)) refuse('revise_shape');
};
// A `from` names the same step of the same decision, and the version when one is named.
const fromMatches = (stored, from) => Boolean(stored) && stored.decision_id === from.decision_id && stored.step_id === from.step_id && (from.version === undefined || from.version === stored.version);

/** The answer a `from` brings in: the step of another of the person's decisions as it stood, at the version named (or its current
 * one), and the evidence it cites that this decision does not have yet, each with where it came from. */
async function copyStep(door, record, from, now) {
  if (from.decision_id === record.id) refuse('from_self');
  const source = await readDecision(door, from.decision_id, [from.step_id]);
  if (!source) refuse('from_not_found');
  const at = source.guidance.findIndex(item => item.step_id === from.step_id);
  const current = at >= 0 ? source.guidance[at] : null;
  if (!current || current.lost) refuse('from_step_missing', { step: from.step_id, version: from.version ?? 1 });
  const version = from.version ?? current.version ?? 1;
  let entry = current;
  if (version !== (current.version ?? 1)) {
    entry = source.whole ? null : unpackStep(await door.read('decision-step', versionKey(source.id, at, version)));
    if (!entry) refuse('from_step_missing', { step: from.step_id, version });
  }
  const answer = structuredClone(entry.answer);
  const have = new Set(record.input.evidence.map(item => item.ref));
  const sourceRows = new Map((source.input.evidence ?? []).filter(item => !item.retracted_at).map(item => [item.ref, item]));
  const evidence = [];
  for (const ref of citedRefsIn(answer)) {
    const row = sourceRows.get(ref);
    if (row && !have.has(ref)) evidence.push({ ref, claim: row.claim, added_at: now, from: { decision_id: source.id, ref } });
  }
  return { answer, from: { decision_id: source.id, step_id: from.step_id, version }, evidence };
}

// Evidence rows as they are added: a claim typed, or a row brought in from another of the person's decisions as it stood.
async function evidenceRows(door, record, items, now) {
  const rows = [];
  for (const item of items) {
    if (!object(item) || !nonempty(item.ref)) refuse('evidence_shape');
    if (item.from !== undefined) {
      if (item.claim !== undefined || !object(item.from) || !nonempty(item.from.decision_id) || !nonempty(item.from.ref)) refuse('evidence_shape');
      if (item.from.decision_id === record.id) refuse('from_self');
      const source = await door.read('decision', item.from.decision_id);
      if (!source) refuse('from_not_found');
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
// The decision's first evidence is kept as it was given; the original input stays as it was started, so the same
// source with the same input is still that decision.
const keepOriginal = record => { record.original_input ??= structuredClone(record.input); };
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
  const id = decisionId(input);
  const items = input.evidence;
  if (!Array.isArray(items) || items.length < 1 || items.length > EVIDENCE.most_per_call) refuse('evidence_count', { count: EVIDENCE.most_per_call });
  const record = await decisionOrRefuse(door, id);
  const rows = await evidenceRows(door, record, items, new Date().toISOString());
  const before = record.input.evidence.length;
  takeEvidence(record, rows);
  const added = record.input.evidence.slice(before);
  if (!added.length) return { case_id: id, added: [], replayed: true, evidence: record.input.evidence.length };
  await writeDecision(door, recordsOf(record), `add-decision-evidence:${id}:${added.map(row => row.ref).join(',')}`);
  return { case_id: id, added, evidence: record.input.evidence.length };
}

// A confirmation: the answer a re-asked step already has stands unchanged. Nothing is answered again and no version is made.
async function confirmStep(door, methods, record, at) {
  const entry = record.guidance[at];
  entry.needs_recheck = false;
  delete entry.recheck_of;
  entry.rechecked_at = new Date().toISOString();
  record.change_count = (record.change_count ?? 0) + 1;
  await writeDecision(door, recordsOf(record), `confirm-a-decision-step:${record.id}:${at}:${record.change_count}`);
  const reply = await guideReply(door, await catalogueAt(door, methods, record), record);
  return { ...reply, confirmed: { step_id: entry.step_id, version: entry.version ?? 1 }, ready_for_decision: !reply.question };
}

// A confirmation with verdicts: the answer stands and the judge's verdicts on its checks are added as a new version of the
// step, each added verdict kept with when it came in. A verdict the step already has stands, and one that differs is refused.
// Verdicts are checked as a typed answer's are. Returns null when no verdict is new, so the caller replays or confirms.
async function confirmWithVerdicts(door, methods, record, at, step, given, now) {
  const entry = record.guidance[at];
  const cat = await catalogueAt(door, methods, record, step);
  const cited = await citable(door, record, citedRefsIn(entry.answer));
  const toJudge = cat.checkAnswersToJudge(record, step, entry.answer);
  const { verdicts } = takeCallerVerdicts(toJudge, given, { answer: entry.answer, refs: [...cited.refs] });
  const problems = judgedProblems(verdicts);
  if (problems.length) throw new AnswerProblems(problems);
  const kept = new Map((entry.verdicts ?? []).map(item => [item.id, item]));
  const added = [];
  for (const verdict of verdicts) {
    const have = kept.get(verdict.id);
    if (!have) added.push({ ...verdict, added_at: now });
    else if (have.meets !== verdict.meets || have.graded_by !== verdict.graded_by) refuse('verdict_taken', { check: verdict.id });
  }
  if (!added.length) return null;
  const version = (entry.version ?? 1) + 1;
  const archived = [{ key: versionKey(record.id, at, entry.version ?? 1), entry: { ...entry, superseded_at: now } }];
  // The same answer as it stood, with the checks it was asked and every verdict kept. Why it was given or brought in is kept too.
  record.guidance[at] = {
    step_id: entry.step_id, answer: entry.answer, ...(entry.checklist ? { checklist: entry.checklist } : {}),
    verdicts: [...(entry.verdicts ?? []), ...added], judged_checks: toJudge.length, ...(entry.usage ? { usage: entry.usage } : {}),
    answered_at: entry.answered_at, confirmed_at: now, version, by: entry.by,
    ...(entry.because ? { because: entry.because, revised_from: entry.revised_from } : {}),
    ...(entry.from ? { from: entry.from } : {}),
    ...(entry.needs_recheck ? { rechecked_at: now } : {}),
  };
  await writeDecision(door, recordsOf(record, [at], archived), `confirm-a-decision-step:${record.id}:${at}:v${version}`);
  const reply = await guideReply(door, await catalogueAt(door, methods, record), record);
  return { ...reply, confirmed: { step_id: entry.step_id, version, verdicts_added: added.map(item => item.id) }, ready_for_decision: !reply.question };
}

// A revision of a decided decision's answer reopens it: the decision it had moves to decision_history, marked reopened by
// the revision with its reason and when, and the decision is open until it is made again with tool:make-the-decision.
// A share of it stays in the history, not on the open decision.
function reopen(record, { step_id, because, now }) {
  const entry = { decision: record.decision, decided_at: record.decided_at, revised_at: now, reopened: { by: 'revision', step_id, because, at: now } };
  if (record.shared) { entry.shared = record.shared; delete record.shared; }
  (record.decision_history ??= []).push(entry);
  record.decision = null;
  delete record.decided_at;
  record.status = 'needs_decision';
}

/** tool:answer-a-decision-question. input { decision_id, step_id, answer?, from?, revise?: { because, by? }, confirm?: true,
 * verdicts?, usage? }. An answer in its turn; a revision of any answered step with its reason (the old version is kept and
 * every later step is flagged to be asked again; on a decided decision it reopens the decision, which must be made again); a
 * confirmation of a re-asked step unchanged, or with verdicts added as a new version of the same answer (a decided decision stays
 * decided); `from` answers with another decision's step as it stood. */
export async function answerADecisionQuestion(input, { door }) {
  const id = decisionId(input);
  if (!nonempty(input.step_id)) refuse('answer_needs_step');
  answerShape(input);
  const methods = await methodsOf(door);
  const record = await decisionOrRefuse(door, id, [input.step_id]);
  const bare = catalogue(methods);
  const at = record.guidance.findIndex(item => item.step_id === input.step_id);
  const entry = at < 0 ? null : record.guidance[at];
  const next = bare.nextStepOf(record);
  const revising = input.revise !== undefined;
  const flagged = Boolean(entry?.needs_recheck);
  const replayed = async () => ({ ...(await guideReply(door, await catalogueAt(door, methods, record), record)), replayed: true });
  if (input.confirm === true) {
    if (!entry) refuse('unanswered_step', { step: input.step_id });
    if (flagged && (!next || next.id !== input.step_id)) throw new Error(outOfTurn(record, next, input.step_id));
    if (input.verdicts !== undefined) {
      const step = bare.stepsFor(record).find(item => item.id === input.step_id);
      if (!step || entry.lost) refuse('confirm_inactive', { step: input.step_id });
      const added = await confirmWithVerdicts(door, methods, record, at, step, input.verdicts, new Date().toISOString());
      if (added) return added;
    }
    return flagged ? confirmStep(door, methods, record, at) : replayed();
  }
  if (revising && !entry) refuse('unanswered_step', { step: input.step_id });
  if (entry && !flagged && !revising) {
    if (input.from !== undefined ? fromMatches(entry.from, input.from) : same(entry.answer, input.answer)) return replayed();
    refuse('different_answer', { step: input.step_id });
  }
  // A decided decision is reopened by a revision of one of its answers; any other new answer waits for a failed result.
  const reopening = Boolean(record.decision) && record.status !== 'correction_needed';
  if (reopening && !revising) refuse('already_decided');
  if ((!entry || flagged) && (!next || next.id !== input.step_id)) throw new Error(outOfTurn(record, next, input.step_id));
  const step = bare.stepsFor(record).find(item => item.id === input.step_id);
  if (!step) refuse('revise_inactive', { step: input.step_id });
  const cat = await catalogueAt(door, methods, record, step);
  const now = new Date().toISOString();
  const copied = input.from !== undefined ? await copyStep(door, record, input.from, now) : null;
  const answer = copied ? copied.answer : input.answer;
  if (entry && same(entry.answer, answer)) return flagged ? confirmStep(door, methods, record, at) : replayed();
  if (flagged && !revising) refuse('different_answer', { step: input.step_id });
  if (copied) takeEvidence(record, copied.evidence);
  const refs = citedRefsIn(answer);
  const cited = await citable(door, record, refs);
  cat.validateMethodAnswer(record, step, answer, cited.refs);
  noRunIds(answer?.workflow_runs, 'workflow_runs');
  const toJudge = cat.checkAnswersToJudge(record, step, answer);
  const { verdicts } = takeCallerVerdicts(toJudge, input.verdicts, { answer, refs: [...cited.refs] });
  const problems = judgedProblems(verdicts);
  if (problems.length) throw new AnswerProblems(problems);
  keepCited(record, cited.pursuits, refs);
  // The checks this step asked are kept with the answer, each as its id, its question and the content identity of its
  // whole row as asked, so the record shows what was weighed after the rows change without holding every row again.
  const checklist = cat.checklistFor(record, step).map(row => ({ id: row.id, check: row.check, identity: makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(row))) }));
  const usage = usageOf(input.usage);
  if (record.method?.answer_rules && cat.workflowsDue(record, step).length) {
    record.workflow_plan = { version: 1, step_id: step.id, items: structuredClone(answer.workflow_runs) };
  }
  if (!record.input.options && Array.isArray(answer?.[CANDIDATES.field])) record.candidates = candidatesFrom(answer[CANDIDATES.field]);
  // The verdicts taken, each with who graded it, and how many checks were handed to the judge: a step answered with no
  // verdict for a check it asked shows as answered, not judged.
  const version = (entry?.version ?? 0) + 1;
  const fresh = {
    step_id: step.id, answer, ...(checklist.length ? { checklist } : {}), verdicts, judged_checks: toJudge.length, ...(usage ? { usage } : {}),
    answered_at: now, version, by: revising && nonempty(input.revise.by) ? input.revise.by : REVISION.by,
    ...(revising ? { because: input.revise.because, revised_from: entry.version ?? 1 } : {}),
    ...(copied ? { from: copied.from } : {}),
  };
  const index = entry ? at : record.guidance.length;
  const archived = [];
  if (reopening) reopen(record, { step_id: step.id, because: input.revise.because, now });
  if (entry) {
    // The version it replaces is kept as it was, and every later step must be asked again.
    archived.push({ key: versionKey(id, index, entry.version ?? 1), entry: { ...entry, superseded_at: now } });
    record.guidance[index] = fresh;
    for (const later of record.guidance.slice(index + 1)) { later.needs_recheck = true; later.recheck_of = step.id; }
  } else record.guidance.push(fresh);
  const key = entry ? `answer-a-decision-question:${id}:${index}:v${version}` : `answer-a-decision-question:${id}:${index}`;
  await writeDecision(door, recordsOf(record, [index], archived), key);
  const reply = await guideReply(door, await catalogueAt(door, methods, record), record);
  return {
    ...reply,
    ...(entry ? { revised: { step_id: step.id, version, previous_version: entry.version ?? 1, needs_recheck: record.guidance.slice(index + 1).filter(item => item.needs_recheck).map(item => item.step_id) } } : {}),
    ...(reopening ? { reopened: { from_generation: decisionGeneration(record), step_id: step.id, because: input.revise.because, at: now, note: say('reopened_note', { step: step.id }) } } : {}),
    ready_for_decision: !reply.question,
  };
}

function decisionShape(decision, expectedGeneration) {
  if (!object(decision) || !nonempty(decision.option_id) || !nonempty(decision.reason) || !nonempty(decision.next_action) || !nonempty(decision.success_measure) || !Array.isArray(decision.evidence_refs)) refuse('decision_shape');
  if (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < 1)) refuse('generation_shape');
  if (decision.move !== undefined && !nonempty(decision.move)) refuse('move_shape');
}

/** tool:make-the-decision. input { decision_id, decision: { option_id, reason, next_action, success_measure, evidence_refs, move?, ...fields }, verdicts?, usage?, expected_generation? } */
export async function makeTheDecision(input, { door }) {
  const id = decisionId(input);
  const { decision, expected_generation: expectedGeneration } = input;
  const cat = catalogue(await methodsOf(door));
  const record = await decisionOrRefuse(door, id, ['proof']);
  const decidedBefore = Boolean(record.decision);
  // Every question is answered and none of them stands to be asked again.
  if (!record.guidance.length || cat.nextStepOf(record)) refuse('complete_first');
  if (!decidedBefore && object(decision) && cat.decisionFieldsFor(record).every(field => nonempty(decision[field.name]))) {
    const refs = record.input.evidence.filter(item => !item.retracted_at).map(item => item.ref);
    const { verdicts } = takeCallerVerdicts(cat.decisionFieldsToJudge(record, decision), input.verdicts, { answer: decision, refs });
    const problems = verdicts.filter(verdict => verdict.meets === false).map(verdict => refusalWords('', verdict));
    if (problems.length) throw new AnswerProblems(problems);
  }
  decisionShape(decision, expectedGeneration);
  const needed = cat.decisionFieldsFor(record).filter(field => !nonempty(decision[field.name]));
  if (needed.length) throw new Error(needed.map(field => say('needs_field', { name: field.name, ask: field.ask })).join('; '));
  if (expectedGeneration !== undefined && (record.decision
    ? (record.decision_generation ?? 1) !== expectedGeneration || !same(record.decision, decision)
    : (record.decision_generation ?? 0) + 1 !== expectedGeneration)) refuse('generation_changed');
  if (!optionsOf(record).some(option => option.id === decision.option_id)) {
    refuse('unknown_option', { option: JSON.stringify(decision.option_id), options: optionsOf(record).map(option => `${JSON.stringify(option.id)} (${option.label})`).join(', ') });
  }
  const cited = await citable(door, record, decision.evidence_refs.filter(ref => typeof ref === 'string'));
  if (decision.evidence_refs.length === 0 || decision.evidence_refs.some(ref => !cited.refs.has(ref))) refuse('decision_evidence');
  if (record.decision && same(record.decision, decision)) return decidedReply(cat, record, true);
  noRunIds(decision.workflow_runs, 'decision.workflow_runs');
  // Evidence declared necessary for choosing must be finished first; no run can be read here, so such a plan waits.
  const needsRuns = Object.entries(object(record.workflow_plan?.items) ? record.workflow_plan.items : {}).filter(([, item]) => item?.applicable === true && item.required_phase === 'decision').map(([workflow]) => workflow);
  if (needsRuns.length) refuse('decision_phase_runs', { workflows: needsRuns.join(', ') });
  keepCited(record, cited.pursuits, decision.evidence_refs);
  if (record.decision) {
    if (record.status !== 'correction_needed') refuse('new_decision_needs_failure');
    record.decision_history ??= [];
    record.decision_history.push({ decision: record.decision, decided_at: record.decided_at, revised_at: new Date().toISOString() });
  }
  record.decision = decision;
  record.decision_generation = (record.decision_generation ?? (decidedBefore ? 1 : 0)) + 1;
  const proof = record.guidance.find(item => item.step_id === 'proof')?.answer;
  if (proof?.recheck_on && !record.recheck_on) record.recheck_on = proof.recheck_on;
  record.status = 'needs_outcome';
  record.decided_at = new Date().toISOString();
  const usage = usageOf(input.usage);
  if (usage) record.decision_usage = usage;
  await writeDecision(door, recordsOf(record), `make-the-decision:${id}:${record.decision_generation}`);
  return decidedReply(cat, record, false);
}

const outcomeRevision = record => (record.outcome_revision = (record.outcome_revision ?? 0) + 1);
const carriedOut = record => Boolean(record?.decision) && (record.carried_out ?? []).some(entry => entry.decision_generation === (record.decision_generation ?? 1));
function decidedReply(cat, record, already) {
  return {
    case_id: record.id, source_id: record.source_id, ...(already ? { already_decided: true, note: WORDS.decided_note } : {}),
    decision: record.decision, method_coverage: cat.methodCoverage(record),
    resume: { next_action: record.decision.next_action, success_measure: record.decision.success_measure, instruction: [say('resume', record.decision), ...cat.decisionFieldsSaid(record, record.decision)].join(' ') },
    carried_out: carriedOut(record), ...(carriedOut(record) ? {} : { ai_instructions: [say('carry_out', { ...record.decision, case_id: record.id })] }),
    how_to_say_it: cat.howToSayIt(record),
  };
}

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
  const id = decisionId(input);
  if (!['done', 'wall'].includes(input.state) || !nonempty(input.what_happened)) refuse('said_shape');
  if (input.expected_generation !== undefined && (!Number.isInteger(input.expected_generation) || input.expected_generation < 1)) refuse('generation_shape');
  noRunIds(input.workflow_runs, 'workflow_runs');
  const record = await decisionOrRefuse(door, id);
  if (!record.decision) refuse('no_decision_yet');
  if (input.expected_generation !== undefined && input.expected_generation !== (record.decision_generation ?? 1)) refuse('said_generation_changed');
  const entry = { decision_generation: record.decision_generation ?? 1, state: input.state, what_happened: String(input.what_happened).slice(0, 4000), by: nonempty(input.by) ? String(input.by).slice(0, 200) : null, at: new Date().toISOString() };
  (record.carried_out ??= []).push(entry);
  await writeDecision(door, recordsOf(record), `say-what-was-done:${id}:${record.carried_out.length}`);
  return { case_id: id, carried_out: entry, status: record.status };
}

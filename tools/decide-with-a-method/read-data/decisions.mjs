// tools/decide-with-a-method/read-data/decisions.mjs
//
// Decisions a person's AI makes with a method, as Workshop tools over the person's own records. Ported from the old
// app's DecisionEngine (src/engine.mjs: admit, guide, decideGuided, decide, reportResult, recordCarriedOut) and the
// record layout of its decision store (src/decision-store.mjs): a decision is one root record of type `decision` and
// records of its own beside it, laid out by ./decision-records.mjs so a decision of any size fits under the door's write
// cap: the root holds only fields each set by one call and counts and pointers; each evidence row, each answered step's
// summary (`decision-answered-step`, { step_id, answered_at, checks, graded, graded_by, version, needs_recheck }), each
// answered step whole (`decision-step:<id>:<nnn>`: the current answer, the checks it was asked and the verdicts taken),
// each superseded version of a step (`decision-step:<id>:<nnn>:v<vvv>`, so a revision never overwrites what was
// answered), each option, report, receipt, earlier decision and cited pursuit is a record of its own linked to the
// decision's id, and the method snapshot is kept once by its content identity. Answering one step reads the decision's
// own fields, its evidence and summaries, its scope answer and the step it repeats, never every earlier answer whole.
// The Decisions screen reads these same records.
//
// The methods are the person's: rows of their Methods list (one per method) and of their Checks list (one per
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
//   7. Every check a step asks is graded by a second judge: an answer is kept only with a verdict taken for each of its
//      checks, an answer kept before this rule is asked again until its verdicts are added, and a decision is made only
//      when every step is graded.
import { readFileSync } from 'node:fs';
import { AnswerProblems, judgedProblems, methodCatalogue, refusalWords, ungradedOf } from './method.mjs';
import { takeCallerVerdicts } from './verdicts.mjs';
import { currentDecisionOutcome, decisionGeneration, decisionStatus, outcomeIsCurrent } from './decision-outcome.mjs';
import { similarDecisions } from './similar-decisions.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { canonical, inputIdentity, laidTogether, markRead, readDecision, readRevision, readStep, recordsOf, retriedOnConflict, versionKey, writeDecision } from './decision-records.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
import { linksOf } from '../../check-against-a-persons-rules-and-verdicts/do-work/branch.mjs';
import { boundRuns, runProblem, unfinishedRuns } from './workflow-runs.mjs';

const settings = JSON.parse(readFileSync(new URL('./decide-with-a-method.json', import.meta.url), 'utf8'));
const { records: NAMES, words: WORDS, precedence, candidates: CANDIDATES, revision: REVISION, evidence: EVIDENCE, history: HISTORY, options: OPTIONS } = settings;
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
// The link a method and a check name their parent in, then the old fields still read until the rows are rewritten.
const LINK = [NAMES.method_link, ...(NAMES.old_method_links ?? [])];
const rowKey = (rowType, id) => `record:${rowType}:${id}`;
// One row of the person's Checks list read by its id (`record:check:<id>`), as its value with its id; null when absent.
async function rowById(door, rowType, id) {
  const value = await door.read(`record:${rowType}`, rowKey(rowType, id));
  return value ? { ...value, id: value.id ?? id } : null;
}
const isMethodRow = row => Object.entries(NAMES.method_where).every(([name, value]) => canonical(row?.[name]) === canonical(value));
// The rows of one method's lineage, read by id: the method named, then the one it is part of, up to its root, each one
// `records:read` (the old app's private-method.mjs resolved `extends` by id the same way). A call costs the depth of the
// method tree, never the size of the list. Null when the method named is not a branch row of the list.
async function lineageRows(door, id) {
  const rows = [];
  for (let at = id; nonempty(at) && !rows.some(row => row.id === at);) {
    const row = await rowById(door, NAMES.method_row, at);
    if (!row || !isMethodRow(row)) {
      if (!rows.length) return null;
      throw new Error(`Method ${rows.at(-1).id} is ${NAMES.method_link} ${at}, which is not one of the branch rows; fix its ${NAMES.method_link}.`);
    }
    rows.push(row);
    at = linksOf(row, LINK)[0];
  }
  return rows;
}
// The method rows a call needs: the lineage of the method it names (the one asked for, or the one its decision was opened
// with), else of the person's default (`records.default_method`), each read by id. Only an account with neither row falls
// back to listing its branch rows by `where` (`method_where`). A method named that is not there is refused where it is
// snapshotted (`snapshotMethod`); a decision opened under a method since removed keeps its own snapshot.
async function methodsOf(door, named) {
  for (const id of new Set([named, NAMES.default_method])) {
    if (!nonempty(id)) continue;
    const rows = await lineageRows(door, id);
    if (rows) return rows;
  }
  const methods = await rowsOf(door, NAMES.method_row, NAMES.method_where);
  if (!methods.length) refuse('no_methods');
  return methods;
}
const methodIdOf = record => record?.method_id ?? record?.method?.id ?? record?.input?.method;
const catalogue = (methods, checks = []) => methodCatalogue(methods, checks, { grader: settings.grader, link: LINK });
// The method functions with the check rows of one step, each read by its id: the rows the step lists as its parts
// (`records.step_parts_field`) and the rows it names by id (`check_ids`), so a call carries one step's checks and costs
// as many reads as the step has checks, never the size of the list. A step written before it listed its parts is read
// with the door's `where` on its step field, the one read whose cost is the engine's. The step is the one given, or the
// step asked next.
async function catalogueAt(door, methods, record, step = undefined) {
  const bare = catalogue(methods);
  const current = step === undefined ? bare.nextStepOf(record) : step;
  if (!current || current.kind === 'scope') return bare;
  const parts = current[NAMES.step_parts_field];
  const checks = Array.isArray(parts) ? [] : await rowsOf(door, NAMES.check_row, { [NAMES.check_step_field]: current.id });
  const ids = [...new Set([...(Array.isArray(parts) ? parts : []), ...(current.check_ids ?? [])])].filter(nonempty);
  for (const id of ids) {
    if (checks.some(row => row.id === id)) continue;
    const row = await rowById(door, NAMES.check_row, id);
    if (row) checks.push(row);
  }
  return catalogue(methods, checks);
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
  const list = found.slice(0, settings.pursuits.carried).sort((a, b) => a.id.localeCompare(b.id));
  if (!list.length) return { question_pursuits: [], question_pursuits_note: WORDS.no_pursuits_note };
  const more = found.length > list.length;
  return { question_pursuits: list.map(({ id, title, now, after, why_it_matters, status }) => ({ id, title, now, after, why_it_matters, status })), question_pursuits_note: `${WORDS.pursuits_note}${more ? ` ${say('more_pursuits_note', { count: list.length })}` : ''}` };
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

// A run a call names is read back from the person's own records and judged (./workflow-runs.mjs), never trusted.
const refuseRun = problem => refuse(problem.word, problem.parts);
// A plan may name a run it reuses; it must be a run of that workflow on this account. Whether it finished is judged when the
// decision, or the receipt of what was done, is made.
async function checkPlannedRuns(door, runs) {
  for (const [workflow, item] of Object.entries(object(runs) ? runs : {})) {
    if (item?.run_id === undefined) continue;
    const problem = await runProblem(door, workflow, item.run_id, { finished: false });
    if (problem) refuseRun(problem);
  }
}
// The runs a decision's accepted plan and a call's named runs bind, each a finished run of its workflow, or a refusal. A
// receipt (`namedOnly`) judges only the runs it names: a run the plan reuses may still be working when work hits a wall.
async function finishedRuns(door, record, named, label, { namedOnly = false } = {}) {
  const { bound: all, problem } = boundRuns(record.workflow_plan?.items, named, label);
  if (problem) refuseRun(problem);
  const bound = namedOnly ? Object.fromEntries(Object.entries(all).filter(([workflow]) => object(named) && workflow in named)) : all;
  const problems = await unfinishedRuns(door, bound);
  if (problems.length) throw new Error(problems.map(item => say(item.word, item.parts)).join(' '));
  return bound;
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

// The options live on the decision's root, so a new decision's options are bounded (`options` in the settings): the root
// stays far under the door's write cap however large every other field it holds is.
function optionsFit(options) {
  if (options === undefined) return;
  if (options.length > OPTIONS.most || Buffer.byteLength(JSON.stringify(options)) > OPTIONS.most_bytes) refuse('options_too_large', { count: OPTIONS.most, bytes: OPTIONS.most_bytes });
}

const ready = (cat, record) => {
  const asked = cat.decisionFieldsAsked(record);
  return { ai_instructions: [say(optionsOf(record).length ? 'ready' : 'none_standing')], options: optionsOf(record).map(({ id, label }) => ({ id, label })), how_to_say_it: cat.howToSayIt(record), ...(asked.length ? { decision_fields: asked } : {}) };
};

const decisionPhaseWorkflows = record => Object.entries(object(record.workflow_plan?.items) ? record.workflow_plan.items : {})
  .filter(([, item]) => item?.applicable === true && item.required_phase === 'decision').map(([workflow]) => workflow);
const unrunDecisionWorkflows = record => decisionPhaseWorkflows(record).filter(workflow => record.workflow_plan.items[workflow].run_id === undefined);
const replyReady = reply => !reply.question && !reply.decision_blockers?.length;

async function guideReply(door, cat, record) {
  const question = cat.currentQuestion(record);
  // Answering the method's last question does not finish the evidence work its accepted plan still requires. A plan that
  // names no run for a decision-phase workflow waits for one, as makeTheDecision does; a named run is checked there.
  const blockers = !question && !record.decision ? unrunDecisionWorkflows(record).map(workflow =>
    `${workflow} is planned and remains unfinished (decision phase); name its finished run as decision.workflow_runs.${workflow}.run_id when deciding.`) : [];
  // At the moment of choice, what happened in similar earlier decisions.
  const similar = !question && !record.decision ? (await similarDecisions({ decision_id: record.id, limit: 5 }, { door })).similar_decisions : undefined;
  return {
    case_id: record.id, source_id: record.source_id, question, ...(question?.checklist ? { explain: WORDS.explain_note } : {}), ...(question?.recheck ? { recheck_note: say('recheck_note', { step: question.recheck.revised_step }) } : {}),
    ...(question?.ungraded ? { ungraded_note: say('ungraded_note', { step: question.step_id, graded: question.ungraded.graded, checks: question.ungraded.checks }) } : {}), ...(await pursuitsFor(door, question)),
    question_method_coverage: cat.methodCoverage(record), decision: record.decision ?? null,
    ...(record.workflow_plan ? { workflow_plan: record.workflow_plan } : {}),
    ...(similar ? { similar_decisions: similar } : {}),
    ...(!record.input.options && question?.fields?.includes(CANDIDATES.field) ? { candidates_note: say('candidates_note', { field: CANDIDATES.field }) } : {}),
    ...(blockers.length ? { decision_blockers: blockers } : {}),
    ...(!question && !record.decision && !blockers.length ? ready(cat, record) : {}),
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
  refuseMisplacedFields('tool:start-a-decision', input);
  const methods = await methodsOf(door, input?.method);
  const { id, method } = validatedCase(input, catalogue(methods));
  const current = await readDecision(door, id);
  if (current) {
    if ((current.input_identity ?? inputIdentity(current.original_input ?? current.input)) !== inputIdentity(input)) refuse('source_changed', { source_id: input.source_id, case_id: id });
    return guideReply(door, await catalogueAt(door, methods, current), current);
  }
  optionsFit(input.options);
  const parent = await parentOf(door, input.parent_decision_id, id);
  const record = {
    id, source_id: input.source_id, input, input_identity: inputIdentity(input), method, scratchpad: [], status: 'needs_decision', decision: null, actions: [], checks: [],
    pursuits_known: (await currentPursuits(door, 0)).length > 0, created_at: new Date().toISOString(), guidance: [],
    ...(parent ? { parent: { decision_id: parent.id } } : {}),
  };
  await writeDecision(door, recordsOf(record), `start-a-decision:${id}`);
  return guideReply(door, await catalogueAt(door, methods, record), record);
}

/** The parent a child decision names: another of the person's decisions, never itself. Null when none is named. */
async function parentOf(door, parentId, id) {
  if (parentId === undefined) return null;
  if (!nonempty(parentId) || parentId === id) refuse('parent_invalid');
  const parent = await readDecision(door, parentId);
  if (!parent) refuse('from_not_found');
  return parent;
}

/** A standing step the parent answered, offered to the child (never taken): the parent's answer at its current version. Only a
 * step the method lists as standing (`inherit.standing_steps` in DATA) qualifies, so a change-specific step is never offered. */
export async function inheritableFrom(door, record, question, standing = settings.inherit.standing_steps) {
  if (!record.parent || !question || !standing.includes(question.step_id)) return null;
  const parent = await readDecision(door, record.parent.decision_id, [question.step_id]);
  const kept = parent?.guidance?.find(item => item.step_id === question.step_id && !item.lost);
  if (!kept) return null;
  return { decision_id: parent.id, step_id: question.step_id, version: kept.version ?? 1 };
}

/** tool:next-decision-question. input { decision_id, explain? | versions_of? }: `explain` names checks of the current question,
 * and the reply is then only their whole words (what a good answer does, what it refuses) as `explained`, beside the step
 * they belong to; the question itself was already sent. `versions_of` names a step, and the reply is its versions, oldest
 * first, each with who, when, why and its answer. */
export async function nextDecisionQuestion(input, { door }) {
  refuseMisplacedFields('tool:next-decision-question', input);
  if (input.versions_of !== undefined) {
    const record = await decisionOrRefuse(door, decisionId(input), nonempty(input.versions_of) ? [input.versions_of] : []);
    return versionsReply(door, record, input.versions_of);
  }
  const record = await decisionOrRefuse(door, decisionId(input));
  const cat = await catalogueAt(door, await methodsOf(door, methodIdOf(record)), record);
  if (input.explain === undefined) {
    const reply = await guideReply(door, cat, record);
    const inherit = await inheritableFrom(door, record, reply.question);
    return inherit ? { ...reply, inherit } : reply;
  }
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
    const entry = version === top ? current : await readStep(door, versionKey(record.id, at, version));
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

/** The owner read of one step answer as it stood: the source decision, its step by id, and the version named (or its current
 * one). Refuses when the step is missing or was lost. Returns { source, answer, version }. */
export async function readStepAsStood(door, decisionId, stepId, version) {
  const source = await readDecision(door, decisionId, [stepId]);
  if (!source) refuse('from_not_found');
  const at = source.guidance.findIndex(item => item.step_id === stepId);
  const current = at >= 0 ? source.guidance[at] : null;
  if (!current || current.lost) refuse('from_step_missing', { step: stepId, version: version ?? 1 });
  const wanted = version ?? current.version ?? 1;
  let entry = current;
  if (wanted !== (current.version ?? 1)) {
    entry = source.whole ? null : await readStep(door, versionKey(source.id, at, wanted));
    if (!entry) refuse('from_step_missing', { step: stepId, version: wanted });
  }
  return { source, answer: structuredClone(entry.answer), version: wanted, at };
}

/** The answer a `from` brings in: the step of another of the person's decisions as it stood, at the version named (or its current
 * one), and the evidence it cites that this decision does not have yet, each with where it came from. */
async function copyStep(door, record, from, now) {
  if (from.decision_id === record.id) refuse('from_self');
  const { source, answer, version } = await readStepAsStood(door, from.decision_id, from.step_id, from.version);
  // Workflow runs are the source decision's own bindings. The copy leaves them out, and the workflows due here are asked of this decision again.
  delete answer.workflow_runs;
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

// A confirmation: the answer a re-asked step already has stands unchanged. Nothing is answered again and no version is made.
async function confirmStep(door, methods, record, at) {
  const entry = record.guidance[at];
  entry.needs_recheck = false;
  delete entry.recheck_of;
  entry.rechecked_at = new Date().toISOString();
  record.change_count = (record.change_count ?? 0) + 1;
  await writeDecision(door, recordsOf(record), `confirm-a-decision-step:${record.id}:${at}:${record.change_count}`);
  const reply = await guideReply(door, await catalogueAt(door, methods, record), record);
  return { ...reply, confirmed: { step_id: entry.step_id, version: entry.version ?? 1 }, ready_for_decision: replyReady(reply) };
}

// A confirmation with verdicts: the answer stands and the judge's verdicts on its checks are added as a new version of the
// step, each added verdict kept with when it came in. A verdict the step already has stands, and one that differs is refused.
// The verdicts sent for a check that were not taken, each with its reason: empty when none was sent wrong.
const whyNotTaken = dropped => (dropped.length ? ` Not taken: ${dropped.map(item => `${item.id} (${item.why})`).join('; ')}.` : '');
// Verdicts are checked as a typed answer's are. Returns null when no verdict is new, so the caller replays or confirms.
async function confirmWithVerdicts(door, methods, record, at, step, given, now) {
  const entry = record.guidance[at];
  const cat = await catalogueAt(door, methods, record, step);
  const cited = await citable(door, record, citedRefsIn(entry.answer));
  const toJudge = cat.checkAnswersToJudge(record, step, entry.answer);
  const { verdicts, dropped } = takeCallerVerdicts(toJudge, given, { answer: entry.answer, refs: [...cited.refs] });
  const problems = judgedProblems(verdicts);
  if (problems.length) throw new AnswerProblems(problems);
  const kept = new Map((entry.verdicts ?? []).map(item => [item.id, item]));
  const added = [];
  for (const verdict of verdicts) {
    const have = kept.get(verdict.id);
    if (!have) added.push({ ...verdict, added_at: now });
    else if (have.meets !== verdict.meets || have.graded_by !== verdict.graded_by) refuse('verdict_taken', { check: verdict.id });
  }
  // A check with no verdict, kept or given now, leaves the step unanswered: nothing is kept until every check is graded.
  const judgedNow = new Set(verdicts.map(item => item.id));
  const rest = toJudge.filter(row => !kept.has(row.id) && !judgedNow.has(row.id));
  if (rest.length) refuse('verdicts_missing', { missing: rest.length, checks: toJudge.length, ids: rest.map(row => row.id).join(', '), why: whyNotTaken(dropped) });
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
  return { ...reply, confirmed: { step_id: entry.step_id, version, verdicts_added: added.map(item => item.id) }, ready_for_decision: replyReady(reply) };
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
  refuseMisplacedFields('tool:answer-a-decision-question', input);
  const id = decisionId(input);
  if (!nonempty(input.step_id)) refuse('answer_needs_step');
  answerShape(input);
  const record = await decisionOrRefuse(door, id, [input.step_id]);
  const methods = await methodsOf(door, methodIdOf(record));
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
  await checkPlannedRuns(door, answer?.workflow_runs);
  const toJudge = cat.checkAnswersToJudge(record, step, answer);
  const { verdicts, rest, dropped } = takeCallerVerdicts(toJudge, input.verdicts, { answer, refs: [...cited.refs] });
  const problems = judgedProblems(verdicts);
  if (problems.length) throw new AnswerProblems(problems);
  // A check with no verdict taken leaves the step unanswered: nothing is kept until the judge has spoken on every check.
  if (rest.length) refuse('verdicts_missing', { missing: rest.length, checks: toJudge.length, ids: rest.map(row => row.id).join(', '), why: whyNotTaken(dropped) });
  keepCited(record, cited.pursuits, refs);
  // The checks this step asked are kept with the answer, each as its id, its question and the content identity of its
  // whole row as asked, so the record shows what was weighed after the rows change without holding every row again.
  const checklist = cat.checklistFor(record, step).map(row => ({ id: row.id, check: row.check, identity: makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(row))) }));
  const usage = usageOf(input.usage);
  if (record.method?.answer_rules && cat.workflowsDue(record, step).length) {
    record.workflow_plan = { version: 1, step_id: step.id, items: structuredClone(answer.workflow_runs) };
  }
  if (!record.input.options && Array.isArray(answer?.[CANDIDATES.field])) record.candidates = candidatesFrom(answer[CANDIDATES.field]);
  // The verdicts taken, one for every check, each with who graded it, and how many checks were handed to the judge.
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
  const key = contentKey(entry ? `answer-a-decision-question:${id}:${index}:v${version}` : `answer-a-decision-question:${id}:${index}`, [answer, input.from ?? null]);
  try { await writeDecision(door, recordsOf(record, [index], archived), key); }
  catch (error) {
    if (error?.code !== 'original_command_conflict') throw error;
    // Another answer may have committed while this caller checked its evidence. The persisted accepted answer,
    // never this caller's staged rows or a write receipt, decides whether this was a replay or a different answer.
    const current = await decisionOrRefuse(door, id, [input.step_id]);
    const accepted = current.guidance.find(item => item.step_id === input.step_id);
    if (accepted && (input.from !== undefined ? fromMatches(accepted.from, input.from) : same(accepted.answer, answer))) {
      return { ...(await guideReply(door, await catalogueAt(door, methods, current), current)), replayed: true };
    }
    if (accepted) refuse('different_answer', { step: input.step_id });
    throw error;
  }
  const reply = await guideReply(door, await catalogueAt(door, methods, record), record);
  return {
    ...reply,
    ...(entry ? { revised: { step_id: step.id, version, previous_version: entry.version ?? 1, needs_recheck: record.guidance.slice(index + 1).filter(item => item.needs_recheck).map(item => item.step_id) } } : {}),
    ...(reopening ? { reopened: { from_generation: decisionGeneration(record), step_id: step.id, because: input.revise.because, at: now, note: say('reopened_note', { step: step.id }) } } : {}),
    ready_for_decision: replyReady(reply),
  };
}

function decisionShape(decision, expectedGeneration) {
  if (!object(decision) || !nonempty(decision.option_id) || !nonempty(decision.reason) || !nonempty(decision.next_action) || !nonempty(decision.success_measure) || !Array.isArray(decision.evidence_refs)) refuse('decision_shape');
  if (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < 1)) refuse('generation_shape');
  if (decision.move !== undefined && !nonempty(decision.move)) refuse('move_shape');
}

/** tool:make-the-decision. input { decision_id, decision: { option_id, reason, next_action, success_measure, evidence_refs, move?, ...fields }, verdicts?, usage?, expected_generation? } */
export async function makeTheDecision(input, { door }) {
  refuseMisplacedFields('tool:make-the-decision', input);
  const id = decisionId(input);
  const { decision, expected_generation: expectedGeneration } = input;
  const record = await decisionOrRefuse(door, id, ['proof']);
  const cat = catalogue(await methodsOf(door, methodIdOf(record)));
  const decidedBefore = Boolean(record.decision);
  // Every question is answered and none of them stands to be asked again.
  // Every step is graded: an answer kept before every check had a verdict waits for the rest of them.
  const waiting = cat.nextStepOf(record);
  const kept = waiting && record.guidance.find(item => item.step_id === waiting.id);
  if (kept && !kept.needs_recheck && ungradedOf(kept).missing > 0) {
    refuse('ungraded_first', { step: waiting.id, graded: ungradedOf(kept).graded, checks: ungradedOf(kept).checks });
  }
  if (!record.guidance.length || waiting) refuse('complete_first');
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
  // Evidence declared necessary for choosing must be finished first: each such workflow needs a run, bound in the plan or
  // named here, and every run bound is read back as a finished run of its workflow.
  const bound = await finishedRuns(door, record, decision.workflow_runs, 'decision.workflow_runs');
  const needsRuns = decisionPhaseWorkflows(record).filter(workflow => bound[workflow] === undefined);
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
  const runs = await finishedRuns(door, record, input.workflow_runs, 'workflow_runs', { namedOnly: true });
  if (input.expected_generation !== undefined && input.expected_generation !== (record.decision_generation ?? 1)) refuse('said_generation_changed');
  const entry = { decision_generation: record.decision_generation ?? 1, state: input.state, what_happened: String(input.what_happened).slice(0, 4000), by: nonempty(input.by) ? String(input.by).slice(0, 200) : null, at: new Date().toISOString(), ...(input.workflow_runs ? { workflow_runs: Object.fromEntries(Object.keys(input.workflow_runs).map(workflow => [workflow, { run_id: runs[workflow] }])) } : {}) };
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

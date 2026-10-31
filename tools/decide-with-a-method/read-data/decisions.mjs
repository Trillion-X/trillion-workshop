// tools/decide-with-a-method/read-data/decisions.mjs
//
// Decisions a person's AI makes with a method, as Workshop tools over the person's own records. Ported from the old
// app's DecisionEngine (src/engine.mjs: admit, guide, decideGuided, decide, reportResult, recordCarriedOut) and the
// record layout of its decision store (src/decision-store.mjs): a decision is one root record of type `decision`
// holding its method snapshot and a running summary of its answered steps (`answered_steps`, each { step_id,
// answered_at }); each answered step is a record of its own (`decision-step:<id>:<n>`) holding the answer and the checks
// it was asked. Answering one step reads the decision's own fields, its scope answer and the step it repeats, never
// every earlier answer. The Decisions screen reads these same records.
//
// The methods are the person's: rows of their Methods list (one per method) and of their Method checks list (one per
// check, naming its step and method), row types in `records` of read-data/decide-with-a-method.json, so they see and
// edit them. Trillion asks no model: the calling AI judges each check and sends its verdicts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One source opens one decision; the same input again is that decision, different input is refused.
//   2. A step is answered only in its turn; the same answer again replays, a different one is refused.
//   3. An answer and a decision cite only the decision's own evidence or the person's current pursuits.
//   4. A decided decision changes only after a failed result or check; the earlier one moves to decision_history.
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
const { records: NAMES, words: WORDS, precedence } = settings;

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
const callKey = (id, n) => `${NAMES.call}${id}:${String(n).padStart(NAMES.call_digits, '0')}`;
// A logged call keeps what it was, never the payload it carried (the old store kept those apart and bounded).
const bareCall = call => (object(call) ? Object.fromEntries(Object.entries(call).filter(([field]) => !['submission', 'problems'].includes(field))) : call);
// A step's checks are kept as { checks } (a store keeps objects, not lists, once); callers read and write the list.
const packStep = entry => (Array.isArray(entry?.checklist) ? { ...entry, checklist: { checks: entry.checklist } } : entry);
const unpackStep = entry => (object(entry?.checklist) && Array.isArray(entry.checklist.checks) ? { ...entry, checklist: entry.checklist.checks } : entry);
const stubOf = entry => ({ step_id: entry.step_id, answered_at: entry.answered_at });
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
// The method functions with the check rows of the step `record` is at: that step's rows and the rows it names by id
// (`check_ids`), each read with the door's `where`, so a call carries one step's checks, never the whole list.
async function catalogueAt(door, methods, record) {
  const bare = catalogue(methods);
  const step = record.decision ? null : bare.stepsFor(record)[record.guidance?.length ?? 0];
  if (!step || step.kind === 'scope') return bare;
  const checks = await rowsOf(door, NAMES.check_row, { [NAMES.check_step_field]: step.id });
  for (const id of step.check_ids ?? []) checks.push(...await rowsOf(door, NAMES.check_row, { [NAMES.check_id_field]: id }));
  return catalogue(methods, checks);
}

// A decision kept apart (its root names its answered steps) or kept whole (its root holds its guidance itself).
const keptWhole = root => Array.isArray(root.guidance) && !Array.isArray(root.answered_steps);

/** The decision with its scope answer whole and every later step as its id and time; `steps` names others to read whole. */
async function readDecision(door, id, steps = []) {
  const root = await door.read('decision', id);
  if (!root) return null;
  if (keptWhole(root)) return { ...root, id, whole: true };
  const stubs = Array.isArray(root.answered_steps) ? root.answered_steps : [];
  const wanted = new Set([0, ...stubs.flatMap((stub, n) => (steps.includes(stub.step_id) ? [n] : []))]);
  const guidance = [];
  for (const [n, stub] of stubs.entries()) {
    guidance.push(wanted.has(n) ? unpackStep(await door.read('decision-step', stepKey(id, n))) ?? lostStep(stub) : stub);
  }
  const { answered_steps: _stubs, ...own } = root;
  return { ...own, id, guidance };
}

/** The records one write keeps: the root with its running summary, and each step `from` on (all of them for a whole one). */
function recordsOf(record, from) {
  const { guidance = [], calls, whole, id, ...own } = record;
  // The method's id beside its snapshot, so a list that weighs decisions by method reads one short field.
  const root = { ...own, id, ...(own.method?.id ? { method_id: own.method.id } : {}), answered_steps: guidance.map(stubOf), call_count: record.call_count ?? (Array.isArray(calls) ? calls.length : 0) };
  const start = whole ? 0 : from;
  return [
    { id, type: 'decision', value: root },
    ...guidance.slice(start).map((entry, k) => ({ id: stepKey(id, start + k), type: 'decision-step', value: packStep(entry) })),
    // A decision kept whole is laid apart in this write: its calls become records of their own beside it.
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
export const keepDecision = (door, record, key) => writeDecision(door, recordsOf(record, record.guidance.length), key);

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

function validatedCase(input, cat) {
  if (!object(input) || !nonempty(input.source_id) || !nonempty(input.goal) || !Array.isArray(input.evidence) || !Array.isArray(input.options) || input.options.length < 2) refuse('new_case');
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
  return { id: caseIdFor(input.source_id), method: cat.snapshotMethod(input.method ?? cat.defaultMethodId()) };
}

const ready = (cat, record) => {
  const asked = cat.decisionFieldsAsked(record);
  return { ai_instructions: [say('ready')], options: record.input.options.map(({ id, label }) => ({ id, label })), how_to_say_it: cat.howToSayIt(record), ...(asked.length ? { decision_fields: asked } : {}) };
};

async function guideReply(door, cat, record) {
  const question = cat.currentQuestion(record);
  // At the moment of choice, what happened in similar earlier decisions.
  const similar = !question && !record.decision ? (await similarDecisions({ decision_id: record.id, limit: 5 }, { door })).similar_decisions : undefined;
  return {
    case_id: record.id, source_id: record.source_id, question, ...(question?.checklist ? { explain: WORDS.explain_note } : {}), ...(await pursuitsFor(door, question)),
    method_coverage: cat.methodCoverage(record), decision: record.decision ?? null,
    ...(record.workflow_plan ? { workflow_plan: record.workflow_plan } : {}),
    ...(similar ? { similar_decisions: similar } : {}),
    ...(!question && !record.decision ? ready(cat, record) : {}),
  };
}

export const decisionId = input => { if (!nonempty(input?.decision_id)) refuse('no_decision'); return input.decision_id; };
export async function decisionOrRefuse(door, id, steps) {
  const record = await readDecision(door, id, steps);
  if (!record) refuse('not_found');
  return record;
}

/** tool:start-a-decision. input { source_id, goal, evidence: [{ ref, claim }], options: [{ id, label }], method? } */
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
  await writeDecision(door, recordsOf(record, 0), `start-a-decision:${id}`);
  return guideReply(door, await catalogueAt(door, methods, record), record);
}

/** tool:next-decision-question. input { decision_id, explain? }: `explain` names checks of the current question, and
 * the reply is then only their whole words (what a good answer does, what it refuses) as `explained`, beside the step
 * they belong to; the question itself was already sent. */
export async function nextDecisionQuestion(input, { door }) {
  const record = await decisionOrRefuse(door, decisionId(input));
  const cat = await catalogueAt(door, await methodsOf(door), record);
  if (input.explain === undefined) return guideReply(door, cat, record);
  if (!Array.isArray(input.explain) || !input.explain.length || input.explain.length > settings.most_explained || !input.explain.every(nonempty)) refuse('explain_shape', { count: settings.most_explained });
  const { texts, unknown } = cat.checkTexts(record, input.explain);
  if (unknown.length) refuse('explain_unknown', { ids: unknown.join(', ') });
  return { case_id: record.id, step_id: cat.currentQuestion(record)?.step_id ?? null, explained: texts };
}

/** tool:answer-a-decision-question. input { decision_id, step_id, answer, verdicts?, usage? } */
export async function answerADecisionQuestion(input, { door }) {
  const id = decisionId(input);
  if (!nonempty(input.step_id)) refuse('answer_needs_step');
  const methods = await methodsOf(door);
  const record = await decisionOrRefuse(door, id, [input.step_id]);
  const cat = await catalogueAt(door, methods, record);
  const replay = record.guidance.find(item => item.step_id === input.step_id);
  if (replay) {
    if (!same(replay.answer, input.answer)) refuse('different_answer');
    return { ...(await guideReply(door, cat, record)), replayed: true };
  }
  if (record.decision) refuse('already_decided');
  const step = cat.stepsFor(record)[record.guidance.length];
  if (!step || step.id !== input.step_id) throw new Error(outOfTurn(record, step, input.step_id));
  const refs = citedRefsIn(input.answer);
  const cited = await citable(door, record, refs);
  cat.validateMethodAnswer(record, step, input.answer, cited.refs);
  noRunIds(input.answer?.workflow_runs, 'workflow_runs');
  const { verdicts } = takeCallerVerdicts(cat.checkAnswersToJudge(record, step, input.answer), input.verdicts, { answer: input.answer, refs: [...cited.refs] });
  const problems = judgedProblems(verdicts);
  if (problems.length) throw new AnswerProblems(problems);
  keepCited(record, cited.pursuits, refs);
  // The checks this step asked are kept with the answer, each as its id, its question and the content identity of its
  // whole row as asked, so the record shows what was weighed after the rows change without holding every row again.
  const checklist = cat.checklistFor(record, step).map(row => ({ id: row.id, check: row.check, identity: makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(row))) }));
  const usage = usageOf(input.usage);
  if (record.method?.answer_rules && cat.workflowsDue(record, step).length) {
    record.workflow_plan = { version: 1, step_id: step.id, items: structuredClone(input.answer.workflow_runs) };
  }
  const entry = { step_id: step.id, answer: input.answer, ...(checklist.length ? { checklist } : {}), ...(usage ? { usage } : {}), answered_at: new Date().toISOString() };
  const n = record.guidance.length;
  record.guidance.push(entry);
  await writeDecision(door, recordsOf(record, n), `answer-a-decision-question:${id}:${n}`);
  const reply = await guideReply(door, await catalogueAt(door, methods, record), record);
  return { ...reply, ready_for_decision: !reply.question };
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
  if (!decidedBefore && (!record.guidance.length || record.guidance.length !== cat.stepsFor(record).length)) refuse('complete_first');
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
  if (!record.input.options.some(option => option.id === decision.option_id)) {
    refuse('unknown_option', { option: JSON.stringify(decision.option_id), options: record.input.options.map(option => `${JSON.stringify(option.id)} (${option.label})`).join(', ') });
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
  await writeDecision(door, recordsOf(record, record.guidance.length), `make-the-decision:${id}:${record.decision_generation}`);
  return decidedReply(cat, record, false);
}

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

const outcomeRevision = record => (record.outcome_revision = (record.outcome_revision ?? 0) + 1);
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
  await writeDecision(door, recordsOf(record, record.guidance.length), `report-a-decision-result:${id}:${entry.source_ref}`);
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
  await writeDecision(door, recordsOf(record, record.guidance.length), `say-what-was-done:${id}:${record.carried_out.length}`);
  return { case_id: id, carried_out: entry, status: record.status };
}

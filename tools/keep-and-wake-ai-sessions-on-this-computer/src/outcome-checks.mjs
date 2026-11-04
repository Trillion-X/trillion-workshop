// Whether a decision's result actually happened, checked by the service itself and never taken from the caller.
//
// The decision's proof step names how its result is observed (`check_by`, one of the method's observer rows) and
// the date it is checked again (`recheck_on`). On that date, or when asked, the observer named there looks: a public
// page is read, or the person is asked on their own screen. A separate judge model then compares what was observed
// with the outcome the decision stated. The verdict, the observation and its source are saved with the decision.
// Which observers a host can run is the host's capability map; a method's observer rows are DATA.
import { currentDecisionOutcome, decisionGeneration, outcomeIsCurrent, personReportVerified } from './check-uses.mjs';
import handling from '../records/outcome-handling.json' with { type: 'json' };
import { selectDeclaredValue } from '../../ui/read-data/declared-selector.ts';

export const outcomeBasis = record => ({ expected_generation: decisionGeneration(record), expected_decided_at: record.decided_at,
  expected_success_measure: record.decision?.success_measure, expected_check_by: checkPlan(record), expected_stated_outcome: statedOutcome(record) });
const text = value => typeof value === 'string' && value.trim().length > 0;
export function latestTaskReport(task, { personOnly = false } = {}) {
  const rows = (task?.reports ?? []).filter(report => !personOnly || personReportVerified(report));
  const superseded = new Set(rows.map(report => report.supersedes).filter(Boolean));
  return rows.filter(report => !superseded.has(report.source_ref)).map((report, index) => ({ report, index }))
    .sort((a, b) => (Date.parse(a.report.observed_at ?? a.report.reported_at) || 0) - (Date.parse(b.report.observed_at ?? b.report.reported_at) || 0)
      || (a.report.outcome_revision ?? a.index) - (b.report.outcome_revision ?? b.index)).at(-1)?.report ?? null;
}
export function sameObservationTarget(expected, observed) {
  if (!expected || !observed) return false;
  const identities = [...handling.readback.required_identity, 'connection_id', 'provider_origin'];
  return identities.every(field => text(expected[field]) && expected[field] === observed[field])
    && ['task_id', 'effect_ref'].every(field => text(expected[field]) && expected[field] === observed[field])
    && Number.isInteger(expected.attempt_count) && expected.attempt_count > 0 && expected.attempt_count === observed.attempt_count;
}

// A failed current outcome enters the existing work owner once per decision generation. Reading the same evidence
// after a retry cannot dispatch the external effect again. No second incident or outcome store is introduced.
export function outcomeCorrection(record) {
  if (!record?.decision) return null;
  const outcome = currentDecisionOutcome(record);
  if (outcome?.result !== 'failed' || ['invalid_source', 'ended'].includes(record.status)) return null;
  const values = { case_id: record.id, generation: decisionGeneration(record), goal: record.input.goal,
    source_ref: outcome.source_ref ?? `decision:${record.id}`, summary: outcome.summary ?? 'The current outcome failed.' };
  const fill = template => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
  return { case_id: record.id, from_agent: 'trillion', request_key: `outcome-correction:${record.id}:${values.generation}`,
    job: fill(handling.correction.job), said: fill(handling.correction.said), outcome: fill(handling.correction.outcome), priority: handling.correction.priority };
}

// A completed read task may declare which facts its provider response observed. The captured declaration is only
// accepted for a read-only HTTP operation and never for a task that can dispatch an external effect.
export function observationProblems(tool) {
  const mapping = tool?.observes;
  if (mapping === undefined) return [];
  const problems = [];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || !mapping.fields || typeof mapping.fields !== 'object') return ['observes needs fields mapping the provider, account, object_id, route and observed response'];
  if (!['http', 'http-request', 'http-json'].includes(tool.invoke?.kind) || !handling.readback.read_methods.includes(String(tool.invoke.method ?? 'POST').toUpperCase()) || tool.invoke.external_effect)
    problems.push('observes is only supported for an HTTP GET or HEAD with no external_effect');
  for (const field of [...handling.readback.required_identity, 'observed']) {
    const spec = mapping.fields[field];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !(spec.from === 'output' && text(spec.path) || ['provider', 'route'].includes(field) && text(spec.value)))
      problems.push(`observes.fields.${field} must read the actual output; only provider and route may be declared constants`);
  }
  return problems;
}

export function observationFromReadTask(tool, task, dispatch = null) {
  if (!tool?.observes || task.state !== 'completed' || !task.contract?.passed || observationProblems(tool).length
    || !text(dispatch?.connection_id) || !text(dispatch?.provider_origin) || dispatch?.basis !== 'authorized_provider_read') return null;
  const values = {};
  for (const field of [...handling.readback.required_identity, 'observed']) {
    const spec = tool.observes.fields[field];
    const value = Object.hasOwn(spec, 'value') ? spec.value : selectDeclaredValue(task.output, spec.path);
    if (value && typeof value === 'object' && 'selector_contract_error' in value) return null;
    values[field] = value;
  }
  if (!handling.readback.required_identity.every(field => text(values[field])) || values.observed === undefined || values.observed === null) return null;
  return { ...Object.fromEntries(handling.readback.required_identity.map(field => [field, values[field]])),
    connection_id: dispatch.connection_id, provider_origin: dispatch.provider_origin, dispatch_route: dispatch.dispatch_route,
    observed: typeof values.observed === 'string' ? values.observed : JSON.stringify(values.observed),
    source_ref: `task:${task.task_id}`, observed_at: task.finished_at, capture_kind: 'provider-readback' };
}

// What the decision said it would change, gathered from its own answers.
export function statedOutcome(record) {
  const answer = id => record.guidance?.find(item => item.step_id === id)?.answer ?? {};
  return {
    goal: record.input?.goal ?? null,
    desired_result: answer('outcome').desired_result ?? null,
    current_state: answer('outcome').current_state ?? null,
    success_measure: record.decision?.success_measure ?? null,
    success_observation: answer('proof').success_observation ?? null,
    failure_signal: answer('proof').failure_signal ?? null,
  };
}

// How this decision's result is to be observed, or null when it never said.
export function checkPlan(record) {
  return record.guidance?.find(item => item.step_id === 'proof')?.answer?.check_by ?? null;
}

// Decisions whose re-check date has come and whose result has not been checked since: [{ case_id, recheck_on }].
export function dueRechecks(dates, today = new Date().toISOString().slice(0, 10)) {
  return dates.filter(item => item.recheck_on <= today);
}
// Whether a decision waits for a re-check (it has a date whose check has not been made or asked yet), and whether that
// date has already come: a decision whose date is today or past is checked as soon as it is known, never left until
// the next daily round, so one re-dated to today is waiting for the person's answer the same day.
export function recheckWaiting(record, today = new Date().toISOString().slice(0, 10)) {
  const checked = (record?.outcome_checks ?? []).some(check => check.for_recheck_on === record.recheck_on && outcomeIsCurrent(record, check));
  const asked = record?.outcome_question && (record.outcome_question.decision_generation ?? 1) === decisionGeneration(record);
  const waiting = Boolean(record?.decision && record.recheck_on && !checked && !asked);
  return { waiting, due: waiting && dueRechecks([{ recheck_on: record.recheck_on }], today).length > 0 };
}
// When the next re-check falls due, in milliseconds, or null: the start of its date, UTC.
export function nextRecheckAt(dates) {
  const next = dates.map(item => item.recheck_on).sort()[0];
  return next ? Date.parse(`${next}T00:00:00Z`) : null;
}

/**
 * Runs the observer the decision named, then the judge.
 *   observers: { [kind]: ({ record, plan }) -> { source_ref, observed } | { ask: question } }
 *   judge:     ({ stated, observed }) -> { result: 'met' | 'failed' | 'unknown', reason }
 */
export async function checkOutcome(engine, id, { observers, judge }) {
  const record = await (engine.contentOf ? engine.contentOf(id) : engine.get(id));
  if (!record?.decision) throw new Error('This case has no decision yet');
  const plan = checkPlan(record);
  if (!plan) throw new Error('This decision did not say how its result is checked; it was made before outcome checks existed');
  const observer = observers[plan.kind];
  if (typeof observer !== 'function') throw new Error(`This service cannot check a result by ${plan.kind}`);
  const seen = await observer({ record, plan });
  if (seen.ask) return engine.askPerson(id, seen.ask, outcomeBasis(record));
  return judged(engine, id, record, plan.kind, seen, judge);
}

// The action owner and the result checker are separate. Only an observer that can inspect a source without asking
// the person may supply an action-key outcome; a person's answer remains their report on the decision.
export async function observeActionOutcome(engine, id, { observers, judge }, execution = {}) {
  const record = await (engine.contentOf ? engine.contentOf(id) : engine.get(id));
  if (!record?.decision) throw new Error('This case has no decision yet');
  const plan = checkPlan(record);
  if (!plan) throw new Error('This decision did not say how its result is checked');
  const observer = observers[plan.kind];
  if (typeof observer !== 'function') throw new Error(`This service cannot check a result by ${plan.kind}`);
  if (execution.decision_generation !== undefined && execution.decision_generation !== decisionGeneration(record)) throw Object.assign(new Error('The decision changed before observation started.'), { stale_outcome: true });
  const seen = await observer({ record, plan, execution });
  if (seen.ask) throw new Error('This result needs the person; it is not an independent observation');
  if (execution.binding && !sameObservationTarget(execution.binding, seen.binding)) throw new Error('The observer did not inspect the executed target, account and attempt');
  const observed_at = seen.observed_at ?? new Date().toISOString();
  const verdict = await judge({ stated: statedOutcome(record), observed: seen.observed });
  return { source_ref: seen.source_ref, result: verdict.result, summary: verdict.reason, observed_at, ...(seen.binding ? { binding: seen.binding } : {}) };
}

// The person's own answer, given on their own screen (never through their AI), judged the same way.
export async function answerAsPerson(engine, id, text, { judge }) {
  const record = await (engine.contentOf ? engine.contentOf(id) : engine.get(id));
  if (!record?.outcome_question) throw new Error('Nothing is waiting for your answer on this decision');
  if ((record.outcome_question.decision_generation ?? 1) !== decisionGeneration(record)) throw new Error('That question belonged to an earlier decision. Read the current question before answering.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Say what happened, in your own words');
  return judged(engine, id, record, 'person', { source_ref: `person:screen:${new Date().toISOString()}`, observed: text.trim() }, judge);
}

async function judged(engine, id, record, observer, seen, judge) {
  const observed_at = seen.observed_at ?? new Date().toISOString();
  const verdict = await judge({ stated: statedOutcome(record), observed: seen.observed });
  return engine.recordOutcomeCheck(id, { observer, source_ref: seen.source_ref, observed: seen.observed, result: verdict.result, reason: verdict.reason,
    observed_at, ...outcomeBasis(record), ...(seen.binding ? { binding: seen.binding } : {}) });
}

const JUDGE = 'You check whether a stated outcome actually happened. You are given what a decision said would change and what an independent observer saw. Judge only from what was observed. If it clearly shows the stated outcome, the result is "met"; if it clearly shows it did not happen or shows the failure signal, "failed"; if it cannot tell, "unknown". Reply with JSON only: {"result": "met" | "failed" | "unknown", "reason": string}. The reason is one plain sentence a person can read.';

// The judge on a model run by the host (Workers AI), never the caller's model.
export function modelJudge(run, modelId) {
  return async ({ stated, observed }) => {
    const reply = await run(modelId, { messages: [{ role: 'system', content: JUDGE }, { role: 'user', content: JSON.stringify({ stated, observed: String(observed).slice(0, 6000) }) }], max_tokens: 300, temperature: 0 });
    const value = reply?.response ?? reply?.choices?.[0]?.message?.content ?? reply;
    const parsed = typeof value === 'object' ? value : JSON.parse(String(value).slice(String(value).indexOf('{'), String(value).lastIndexOf('}') + 1));
    if (!['met', 'failed', 'unknown'].includes(parsed?.result) || typeof parsed.reason !== 'string') throw new Error('The outcome judge did not give a verdict');
    return { result: parsed.result, reason: parsed.reason };
  };
}

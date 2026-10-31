// tools/evaluate-progress/do-work/requests.mjs
//
// One function per Workshop row. Each takes the request object a person's AI sent, refuses what it cannot run with a sentence that says what to send, and returns the answer.
// The mechanism is in ../read-data; the numbers, rules, definitions and words come in the request, so nothing here belongs to one person.
import { applyRiskGate, evaluateRiskGate } from '../read-data/risk-gate.ts';
import { corroborationGate } from '../read-data/corroboration-gate.ts';
import { decideNudge as decide } from '../read-data/nudge-gate.ts';
import { deriveMeasures } from '../read-data/derive-measure.ts';
import { evaluateProgression } from '../read-data/evaluate-progression.ts';
import { measureOps } from '../read-data/measure-ops.ts';
import { runMeasurePipeline } from '../read-data/measure-pipeline.ts';
import { scoreInstrumentResponses } from '../read-data/score-instrument.ts';
import { stitchCohortLedger } from '../read-data/cohort-stitch.ts';
import { verifyGrounding } from '../read-data/verify-grounding.ts';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };
const isPath = value => Array.isArray(value) && value.every(part => typeof part === 'string');

export function workOutMeasures(request) {
  need(isObject(request), 'Send an object with facts and either measures or a pipeline.');
  need(Array.isArray(request.facts) && request.facts.every(isObject), 'facts must be a list of objects.');
  const { facts, pipeline } = request;
  need(pipeline === undefined || (request.measure_id === undefined && request.params_override === undefined), 'measure_id and params_override pick and change definitions; a pipeline has stages instead, so send them only with measures.');
  const definitions = request.measures ?? (request.measure ? [request.measure] : undefined);
  need((pipeline === undefined) !== (definitions === undefined), 'Send exactly one of measures (a list of definitions, or measure for one) and pipeline.');
  if (pipeline !== undefined) {
    need(isObject(pipeline) && Array.isArray(pipeline.stages), 'pipeline must be { stages: [{ id, def, from? }], result? }.');
    need(pipeline.stages.every(stage => isObject(stage) && typeof stage.id === 'string' && isObject(stage.def)), 'every pipeline stage needs an id and a def.');
    return runMeasurePipeline(facts, pipeline, measureOps);
  }
  need(Array.isArray(definitions) && definitions.every(item => isObject(item) && typeof item.id === 'string' && typeof item.op === 'string'), 'every measure definition needs an id and an op.');
  let chosen = definitions;
  if (request.measure_id !== undefined) {
    chosen = definitions.filter(item => item.id === request.measure_id);
    need(chosen.length === 1, `measure_id ${JSON.stringify(request.measure_id)} is not one of the definitions sent.`);
  }
  if (request.params_override !== undefined) {
    need(isObject(request.params_override), 'params_override must be an object of params.');
    chosen = chosen.map(item => ({ ...item, params: { ...item.params, ...request.params_override } }));
  }
  return { measures: deriveMeasures(facts, chosen, measureOps) };
}

export function pickFiredRules(request) {
  need(isObject(request), 'Send an object with signals and rules.');
  need(Array.isArray(request.signals) && request.signals.every(item => isObject(item) && typeof item.metricRef === 'string'), 'signals must be a list of { metricRef, value }.');
  need(Array.isArray(request.rules) && request.rules.every(item => isObject(item) && typeof item.id === 'string' && typeof item.metricRef === 'string' && isObject(item.band) && isObject(item.adjustment)), 'every rule needs an id, a metricRef, a band and an adjustment.');
  return evaluateProgression({ signals: request.signals, rules: request.rules });
}

export function checkCorroboration(request) {
  need(isObject(request) && Array.isArray(request.checks), 'Send { checks: [{ name, passed, required? }], need }.');
  need(request.checks.every(item => isObject(item) && typeof item.name === 'string' && typeof item.passed === 'boolean'), 'every check needs a name and passed true or false.');
  need(Number.isInteger(request.need) && request.need >= 0, 'need must be a whole number of optional checks that must agree.');
  return corroborationGate(request.checks, request.need);
}

export function holdBackOnRisk(request) {
  need(isObject(request) && isObject(request.assessment ?? {}), 'Send { assessment: { evaluated, risk, categories? }, threshold, support_resources? }.');
  need(Number.isFinite(request.threshold), 'threshold must be a number.');
  const verdict = evaluateRiskGate(request.assessment, { threshold: request.threshold, supportResources: request.support_resources });
  return request.output === undefined ? verdict : { ...verdict, outcome: applyRiskGate(verdict, request.output) };
}

export function decideNudge(request) {
  need(isObject(request), 'Send { context: { risk, rate_limit_ok, opted_out? }, risk_threshold, framing_ref?, tone? }.');
  need(Number.isFinite(request.risk_threshold), 'risk_threshold must be a number.');
  need(request.allowed_tones === undefined || (Array.isArray(request.allowed_tones) && request.allowed_tones.every(item => typeof item === 'string')), 'allowed_tones must be a list of the tones a nudge may carry.');
  return decide(request.context, { riskThreshold: request.risk_threshold, framingRef: request.framing_ref, tone: request.tone, allowedTones: request.allowed_tones });
}

export function checkClaimsAreGrounded(request) {
  need(isObject(request) && Array.isArray(request.claims), 'Send { claims: [{ text, citations: [{ source_id }] }], retrieved_source_ids, min_grounded_ratio? }.');
  need(Array.isArray(request.retrieved_source_ids), 'retrieved_source_ids must be the list of sources that were really read.');
  return verifyGrounding(request.claims, request.retrieved_source_ids, { minGroundedRatio: request.min_grounded_ratio });
}

export function scoreResponses(request) {
  const instrument = request?.instrument;
  need(isObject(instrument) && typeof instrument.id === 'string' && Array.isArray(instrument.subscales), 'Send { instrument: { id, validated, responseScale, subscales }, responses }.');
  need(isObject(instrument.responseScale) && Number.isFinite(instrument.responseScale.min) && Number.isFinite(instrument.responseScale.max), 'instrument.responseScale needs a min and a max number.');
  need(typeof instrument.responseFactKind === 'string' && instrument.responseFactKind !== '', 'instrument.responseFactKind must say what kind the scored facts carry.');
  need(Array.isArray(request.responses) && request.responses.every(item => isObject(item) && typeof item.item === 'string' && Number.isFinite(item.response)), 'responses must be a list of { item, response } with a number response.');
  return { facts: scoreInstrumentResponses(instrument, request.responses) };
}

export function stitchFacts(request) {
  need(isObject(request) && Array.isArray(request.facts) && isObject(request.config), 'Send { facts, config }.');
  const { config } = request;
  need(Array.isArray(config.keyPaths) && config.keyPaths.every(isPath), 'config.keyPaths must be a list of path arrays.');
  need(config.strongKeyPaths === undefined || (Array.isArray(config.strongKeyPaths) && config.strongKeyPaths.every(isPath)), 'config.strongKeyPaths must be a list of path arrays.');
  need(config.stageRules === undefined || (Array.isArray(config.stageRules) && config.stageRules.every(rule => isObject(rule) && isObject(rule.when) && isPath(rule.when.field) && typeof rule.stage === 'string' && Number.isFinite(rule.rank))), 'config.stageRules must be a list of { when: { field: [path], exists | equals | gt }, stage, rank }.');
  need(config.valuePath === undefined || isPath(config.valuePath), 'config.valuePath must be a path array.');
  need(config.baseStage === undefined || (isObject(config.baseStage) && typeof config.baseStage.stage === 'string' && Number.isFinite(config.baseStage.rank)), 'config.baseStage must be { stage, rank }.');
  need(isPath(config.sourcePath) && isPath(config.timePath), 'config.sourcePath and config.timePath must be path arrays.');
  need(isObject(config.confidence) && typeof config.confidence.identified === 'string' && typeof config.confidence.anonymous === 'string', 'config.confidence needs the words for identified and anonymous.');
  return stitchCohortLedger(request.facts, { strongKeyPaths: [], stageRules: [], ...config });
}

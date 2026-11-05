#!/usr/bin/env node
/**
 * Read-only held-out evaluation for the book-specific voice checks.
 * Uses the shared local classifier adapter and /v1/systemone, not film-law
 * rules, weights, or verdict storage. Each result is checkpointed as it lands.
 *
 * Usage:
 *   node evaluate-book-voice.mjs --data <challenge.json> --out <results.json> --live [--single-attempt]
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { placeReports, requestPolicyFor, SERVING_IDENTITY_POLICY, validServingIdentity, requestPlan, reportCriteria, validateInput, validateReport, criterionDecisionLabels, criterionAppliesTo, expectedDecision, aggregateSectionChunkResults } from './evaluate-book-voice-integrity.mjs';
// The shared classifier adapter lives in the ai-command-center checkout this place reports (AI_COMMAND_CENTER).
const { askMany } = await import(join(placeReports('AI_COMMAND_CENTER'), '.claude/hooks/judges/ask-a-hosted-classifier.mjs'));

const args = process.argv.slice(2);
const arg = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const dataPath = arg('--data');
const outPath = arg('--out');
// Evaluation can freeze one attempt per case without changing shared-adapter defaults.
const requestAttempts = args.includes('--single-attempt') ? 1 : 3;
if (!dataPath || !outPath || !args.includes('--live')) {
  console.error('usage: node evaluate-book-voice.mjs --data <challenge.json> --out <results.json> --live [--single-attempt]');
  process.exit(2);
}

const raw = readFileSync(resolve(dataPath), 'utf8');
const dataBlake3 = execFileSync('b3sum', {input: raw, encoding: 'utf8'}).trim().split(/\s+/)[0];
const rubricPath = resolve(dirname(resolve(dataPath)), 'rubric.json');
let input;
try { input = JSON.parse(raw); }
catch {
  const lines = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  input = lines[0]?.items ? lines[0] : { ...lines[0], items: lines.slice(1) };
}
let rubricBlake3 = input.criteria && existsSync(rubricPath)
  ? execFileSync('b3sum', [rubricPath], {encoding: 'utf8'}).trim().split(/\s+/)[0]
  : null;
rubricBlake3 ??= input.rubric_blake3 ?? null;
const { evalItems: items, criteria } = validateInput(input);

// The classifier is wherever this place reports it serves one; no fixed local port is assumed.
const endpoint = placeReports('BOOK_VOICE_CLASSIFIER_ENDPOINT');
const model = process.env.BOOK_VOICE_CLASSIFIER_MODEL || 'decider-v10';
const candidate = { name: model, reach: { endpoint, model, credential: 'local', timeoutSeconds: 60, samples: 1 } };
const labels = ['pass', 'fail', 'uncertain'];
const overallQuestion = input.question;
const requestEvidenceVersion = 1;
const requestPolicy = requestPolicyFor(input);
if (existsSync(resolve(outPath)) && !args.includes('--resume')) throw new Error('output already exists; use --resume to validate and continue without replacing prior evidence');

let resumedReport = null;
if (args.includes('--resume') && existsSync(resolve(outPath))) {
  resumedReport = JSON.parse(readFileSync(resolve(outPath), 'utf8'));
  validateReport(resumedReport, {
    input, model, endpoint, dataPath: resolve(dataPath), dataBlake3, rubricBlake3,
    requestPolicy,
    requestEvidenceVersion: resumedReport.request_evidence_version ?? 0,
    serving: resumedReport.serving ?? null,
    servingIdentityPolicy: resumedReport.serving_identity_policy ?? null,
  });
}
const results = [...(resumedReport?.items ?? [])];
const errors = [];
const completedIds = new Set(results.map(item => item.id));
const queueItems = items.filter(item => !completedIds.has(item.id));
const workerCount = Math.max(1, Math.min(8, Number(process.env.BOOK_VOICE_EVAL_CONCURRENCY || 4)));
let reportHealth = null;
try {
  const response = await fetch(endpoint.replace(/\/v1\/systemone\/?$/, '/health'));
  if (response.ok) reportHealth = await response.json();
} catch { /* health read is supplementary */ }
const hasPendingModelWork = queueItems.some(item => Object.keys(requestPlan(input, item, criteria).asking).length > 0);
const healthIdentityError = hasPendingModelWork && !validServingIdentity(reportHealth?.serving)
  ? 'classifier health did not provide a nonempty serving identity of at most 1024 characters'
  : null;
if (resumedReport) validateReport(resumedReport, {
  input, model, endpoint, dataPath: resolve(dataPath), dataBlake3, rubricBlake3,
  serving: reportHealth?.serving ?? null,
  requestPolicy,
  requestEvidenceVersion: resumedReport.request_evidence_version ?? 0,
  servingIdentityPolicy: resumedReport.serving_identity_policy ?? null,
}, {requireServing: true});

function confusionFor(rows, getGold, getDecision, choices = labels) {
  const matrix = Object.fromEntries(choices.map(gold => [gold, Object.fromEntries(choices.map(decision => [decision, 0]))]));
  let correct = 0;
  let total = 0;
  for (const row of rows) {
    const gold = getGold(row), decision = getDecision(row);
    if (!choices.includes(gold) || !choices.includes(decision)) continue;
    matrix[gold][decision]++;
    total++;
    if (gold === decision) correct++;
  }
  return { matrix, total, correct, accuracy: total ? correct / total : null };
}
function summarizePredictions(rows, choices = labels) {
  const scored = confusionFor(rows, row => row.gold, row => row.decision, choices);
  const prediction_counts = Object.fromEntries(choices.map(label => [label, rows.filter(row => row.decision === label).length]));
  return { ...scored, prediction_counts, predictions: rows.length, abstentions: prediction_counts.uncertain };
}
function summary() {
  if (!criteria) {
    const overall = summarizePredictions(results);
    const grouped = field => Object.fromEntries([...new Set(results.map(row => field(row) ?? 'unknown'))].sort().map(key => {
      const rows = results.filter(row => (field(row) ?? 'unknown') === key);
      return [key, summarizePredictions(rows)];
    }));
    return {
      overall,
      by_family: grouped(row => row.family),
      by_source_kind: grouped(row => row.origin?.kind),
    };
  }
  const byCriterion = {};
  for (const criterion of criteria) {
    const rows = results.flatMap(item => item.checks?.[criterion.id] ? [{...item.checks[criterion.id], gold: item.gold_checks?.[criterion.id]}] : []);
    byCriterion[criterion.id] = summarizePredictions(rows, criterionDecisionLabels(criterion));
  }
  const grouped = field => Object.fromEntries([...new Set(results.map(row => field(row) ?? 'unknown'))].sort().map(key => {
    const group = results.filter(row => (field(row) ?? 'unknown') === key);
    const checks = {};
    for (const criterion of criteria) {
      const rows = group.flatMap(item => item.checks?.[criterion.id] ? [{...item.checks[criterion.id], gold: item.gold_checks?.[criterion.id]}] : []);
      checks[criterion.id] = summarizePredictions(rows, criterionDecisionLabels(criterion));
    }
    return [key, { items: group.length, by_criterion: checks }];
  }));
  return {
    by_criterion: byCriterion,
    by_family: grouped(row => row.family),
    by_source_kind: grouped(row => row.origin?.kind),
  };
}
function writeReport(complete) {
  const hasLegacyEvidence = results.some(row => row.request_evidence === undefined);
  const hasUnverifiedPriorRows = Boolean(resumedReport?.items?.length) && resumedReport.serving_identity_policy !== SERVING_IDENTITY_POLICY;
  const hasUnverifiedRows = hasLegacyEvidence || hasUnverifiedPriorRows;
  const evidenceVersion = hasLegacyEvidence ? 'mixed-legacy-v0+v1' : requestEvidenceVersion;
  const report = {
    schema: 'book-voice-decider-evaluation-v2',
    evaluated_at_local: new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short' }),
    model, endpoint, route: 'shared local classifier adapter -> /v1/systemone',
    serving: reportHealth?.serving ?? null, device: reportHealth?.device ?? null,
    serving_identity_policy: hasUnverifiedRows ? 'historical-unverified' : SERVING_IDENTITY_POLICY,
    request_limits: {samples: 1, attempts: requestAttempts, workers: workerCount},
    data: resolve(dataPath), data_blake3: dataBlake3, rubric_blake3: rubricBlake3,
    dataset_role: input.dataset_role ?? null,
    source_derivative: input.source_derivative ?? null,
    assembled_docx: input.assembled_docx ?? null,
    split: 'eval', evaluated_items: results.length, expected_items: items.length,
    question: criteria ? null : overallQuestion,
    criteria: reportCriteria(criteria),
    request_evidence_version: evidenceVersion,
    request_policy: hasLegacyEvidence ? 'legacy-unknown' : requestPolicy,
    calibration: input.dataset_role === 'evaluation_only'
      ? 'none; held-out challenge outcomes are diagnostic and do not establish a production threshold'
      : input.dataset_role === 'source_feedback_controls'
        ? 'known source-bound feedback controls, not held-out; no representative accuracy or threshold calibration'
        : 'unlabeled manuscript diagnostic; no gold outcomes or calibrated production threshold',
    errors, complete, resume_prior_items: resumedReport?.items?.length ?? 0, prior_errors: resumedReport?.errors ?? [], summary: summary(), items: results,
  };
  const validated = validateReport(report, {
    input, model, endpoint, dataPath: resolve(dataPath), dataBlake3, rubricBlake3,
    serving: report.serving, requestPolicy: report.request_policy,
    requestEvidenceVersion: report.request_evidence_version,
    servingIdentityPolicy: report.serving_identity_policy,
  }, {requireServing: true});
  report.serving_identity_assurance = validated.identity_assurance;
  const checkpointPath = resolve(outPath) + '.checkpoint-tmp';
  writeFileSync(checkpointPath, JSON.stringify(report, null, 2) + '\n');
  renameSync(checkpointPath, resolve(outPath));
  return report.summary;
}

const requestEvidenceById = new Map();
async function evaluate(item) {
  const plan = requestPlan(input, item, criteria);
  const content = plan.content;
  const asking = plan.asking;
  const requestEvidence = {adapter_input: plan, exchanges: []};
  requestEvidenceById.set(item.id, requestEvidence);
  if (Object.keys(plan.asking).length && healthIdentityError) throw new Error(healthIdentityError);
  const captureFetch = async (url, init) => {
    const request = typeof init?.body === 'string' ? init.body : null;
    try {
      const response = await fetch(url, init);
      const rawResponse = await response.text();
      requestEvidence.exchanges.push({url: String(url), status: response.status, statusText: response.statusText, request, response: rawResponse});
      const bodylessStatus = [204, 205, 304].includes(response.status);
      return new Response(bodylessStatus ? null : rawResponse, {
        status: response.status, statusText: response.statusText,
        headers: {'content-type': response.headers.get('content-type') ?? 'application/json'},
      });
    } catch (error) {
      requestEvidence.exchanges.push({url: String(url), status: null, request, response: null, transport_error: error?.name ?? 'Error'});
      throw error;
    }
  };
  if (!criteria) {
    const started = performance.now();
    const answers = await askMany({ candidate, content, asking }, captureFetch, { samples: 1, attempts: requestAttempts });
    assertResponseIdentity(requestEvidence, model, reportHealth.serving);
    const answer = answers.verdict;
    if (!answer?.distribution?.length) throw new Error('classifier returned no probabilities');
    const probabilities = Object.fromEntries(answer.distribution.map(row => [String(row.option), row.probability]));
    const peak = Math.max(probabilities.pass ?? 0, probabilities.fail ?? 0);
    // A substantive verdict needs majority support. This provisional abstention
    // is not fitted calibration and is not a deployable threshold.
    const decision = answer.answer === 'uncertain' || peak <= 0.5 ? 'uncertain' : answer.answer;
    return {id: item.id, family: item.family, axis: item.axis, origin: item.origin, gold: item.gold, request_evidence: requestEvidence,
      serving_identity_policy: SERVING_IDENTITY_POLICY,
      predicted: answer.answer, decision, confidence: answer.confidence, probabilities,
      elapsed_ms: Math.round((performance.now() - started) * 10) / 10};
  }

  const goldChecks = item.checks ?? {};
  const checkResults = {};
  for (const criterion of criteria) {
    if (input.schema !== 'book-voice-decider-challenge-v3' && Object.keys(goldChecks).length && !(criterion.id in goldChecks)) continue;
    if (!criterionAppliesTo(criterion, item, input)) continue;
    if (criterion.deterministic) {
      const hasEmDash = item.text.includes('—');
      const authored = item.role === 'authored';
      const decision = !authored ? 'uncertain' : hasEmDash ? 'fail' : 'pass';
      checkResults[criterion.id] = {gold: goldChecks[criterion.id], predicted: decision, decision,
        confidence: null, probabilities: null, method: 'deterministic local scan',
        criterion_context_used: input.schema === 'book-voice-decider-challenge-v3' ? false : Boolean(item.check_context?.[criterion.id]), elapsed_ms: 0};
    }
  }
  if (Object.keys(asking).length) {
    const started = performance.now();
    const answers = await askMany({candidate, content, asking}, captureFetch, {samples: 1, attempts: requestAttempts});
    assertResponseIdentity(requestEvidence, model, reportHealth.serving);
    const elapsed = Math.round((performance.now() - started) * 10) / 10;
    for (const [id, answer] of Object.entries(answers)) {
      if (!answer?.distribution?.length) throw new Error(`classifier returned no probabilities for ${id}`);
      const criterion = criteria.find(row => row.id === id);
      const binary = criterion.primitive === 'true-or-false';
      const probabilities = Object.fromEntries(answer.distribution.map(row => [
        binary ? row.option === true ? 'pass' : 'fail' : String(row.option), row.probability]));
      const predicted = binary ? answer.answer ? 'pass' : 'fail' : answer.answer;
      const diagnosticMinimum = criterion.diagnostic_min_probability ?? 0.5;
      const decision = expectedDecision(predicted, probabilities, diagnosticMinimum);
      checkResults[id] = {gold: goldChecks[id], predicted, raw_answer: answer.answer, decision, confidence: answer.confidence,
        primitive: binary ? 'noul' : 'choice', diagnostic_min_probability: diagnosticMinimum,
        probabilities, method: 'Decider2B shared endpoint',
        criterion_context_used: input.schema === 'book-voice-decider-challenge-v3' ? Boolean(criterion.reference_context) : Boolean(item.check_context?.[id]), elapsed_ms: elapsed};
    }
  }
  if (plan.chunk_requests?.length) {
    const started = performance.now();
    const chunkResults = [];
    const chunkCriterion = criteria.find(row => row.id === 'section-heading-fit');
    for (const chunkPlan of plan.chunk_requests) {
      const chunkAnswers = await askMany({candidate, content:chunkPlan.content, asking:chunkPlan.asking}, captureFetch,
        {samples:1, attempts:requestAttempts});
      assertResponseIdentity(requestEvidence, model, reportHealth.serving);
      const answer = chunkAnswers['section-heading-fit'];
      if (!answer?.distribution?.length) throw new Error('classifier returned no probabilities for section chunk');
      const probabilities = Object.fromEntries(answer.distribution.map(row => [String(row.option), row.probability]));
      const predicted = answer.answer;
      const decision = expectedDecision(predicted, probabilities, chunkCriterion.diagnostic_min_probability ?? 0.5);
      chunkResults.push({chunk_index:chunkPlan.chunk_index, gold:plan.section_chunk_manifest.chunks[chunkPlan.chunk_index].gold ?? null,
        predicted, raw_answer:answer.answer, decision,
        confidence:answer.confidence, probabilities});
    }
    const aggregate = aggregateSectionChunkResults(chunkResults, plan.chunk_requests.length);
    checkResults['section-heading-fit'] = {gold:goldChecks['section-heading-fit'], predicted:aggregate, decision:aggregate,
      confidence:null, probabilities:null, raw_answer:null, primitive:'derived',
      diagnostic_min_probability:chunkCriterion.diagnostic_min_probability ?? 0.5,
      method:'derived section chunk aggregation', criterion_context_used:true,
      section_chunk_aggregate:{label:aggregate, chunk_results:chunkResults},
      elapsed_ms:Math.round((performance.now()-started)*10)/10};
  }
  return {id: item.id, family: item.family, axes: item.axis, origin: item.origin, ...(input.schema === 'book-voice-decider-challenge-v3' ? {block_kind: item.block_kind} : {}), gold_checks: goldChecks, checks: checkResults, request_evidence: requestEvidence,
    serving_identity_policy: SERVING_IDENTITY_POLICY};
}

function assertResponseIdentity(evidence, expectedModel, expectedServing) {
  for (const exchange of evidence.exchanges) {
    if (exchange.status < 200 || exchange.status >= 300) continue;
    let body;
    try { body = JSON.parse(exchange.response); }
    catch { throw new Error('classifier returned invalid JSON'); }
    if (body?.model !== expectedModel) throw new Error('classifier response model identity did not match the requested model');
    if (!validServingIdentity(body?.served_identity) || body.served_identity !== expectedServing)
      throw new Error('classifier response serving identity was missing or did not match health');
  }
}

let next = 0;
const worker = async () => {
  while (next < queueItems.length) {
    const index = next++;
    const item = queueItems[index];
    let requestEvidence = null;
    try { results.push(await evaluate(item)); }
    catch (error) {
      requestEvidence = requestEvidenceById.get(item.id) ?? error?.request_evidence ?? null;
      errors.push({id: item.id, error: String(error?.message ?? error), ...(requestEvidence ? {request_evidence: requestEvidence} : {})});
    }
    requestEvidenceById.delete(item.id);
    const covered = new Set([...results.map(row => row.id), ...errors.map(row => row.id)]);
    const complete = covered.size === items.length && items.every(row => covered.has(row.id));
    const totals = writeReport(complete);
    console.error(`book-voice eval ${next}/${items.length}: ${errors.length} item errors`);
  }
};
await Promise.all(Array.from({length: workerCount}, worker));
const covered = new Set([...results.map(row => row.id), ...errors.map(row => row.id)]);
const complete = covered.size === items.length && items.every(row => covered.has(row.id));
const totals = writeReport(complete);
console.log(JSON.stringify({output: resolve(outPath), model, serving: reportHealth?.serving ?? null,
  evaluated_items: results.length, expected_items: items.length, errors: errors.length, summary: totals}, null, 2));
if (errors.length) console.error('Some checks remain unjudged; they are preserved as errors, not passes.');

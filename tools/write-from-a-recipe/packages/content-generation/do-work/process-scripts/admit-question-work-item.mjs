/** Workflow process entry for one reviewed, evidence-backed question admission. */
import { admitQuestionWorkItem } from '../admit-question-work-item.mjs';
import { prepareQuestionWorkItem, buildQuestionAdmissionWrites } from '../prepare-question-work-item.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KINDS = Object.freeze({
  candidate: 'content-generation.question-candidate',
  review: 'content-generation.question-review',
  evidence: 'content-generation.question-evidence',
  workItem: 'content-generation.question-work-item',
});

export async function runQuestionAdmission(env = process.env,
  loadRequests = () => import(new URL('./send-requests-to-running-app.mjs', import.meta.url).href)) {
  const carrierUrl = env.BITFIELD_TARGET_CARRIER_URL;
  const partitionLabel = env.BITFIELD_DISPATCH_PARTITION;
  const candidateId = env.CONTENT_QUESTION_CANDIDATE_ID;
  const answerKind = env.CONTENT_QUESTION_ANSWER_KIND;
  if (!carrierUrl || !partitionLabel || !candidateId || !answerKind) {
    throw new Error('Question admission needs the current app, partition, candidate id and answer kind.');
  }
  const requests = await loadRequests();
  const session = await requests.startRunningAppSession({ url: carrierUrl, timeoutMs: 20000 });
  return admitQuestionWorkItem({ requests, session, partitionLabel, candidateId,
    kinds: { ...KINDS, answer: answerKind } });
}

function rowPayloads(items) {
  if (!Array.isArray(items) || items.length >= 512) {
    throw new Error('Current record read is incomplete; admission stopped without a write.');
  }
  return items.map((item) => {
    if (item?.payload) return item.payload;
    if (typeof item?.value_json === 'string') return JSON.parse(item.value_json);
    return item;
  }).filter(Boolean);
}

function one(rows, label) {
  if (rows.length !== 1) throw new Error(`Expected one current ${label}; found ${rows.length}.`);
  return rows[0];
}

/** Native workflow reads from the selected app; no caller-supplied transport URL. */
export function prepareNativeQuestionAdmission({ candidateId, partitionLabel, ventureRef,
  candidateItems, reviewItems, evidenceItems, recipeItems, answerItems, workItems }) {
  if (!candidateId || !partitionLabel || !ventureRef) throw new Error('Question coordinates are required.');
  const candidates = rowPayloads(candidateItems).filter((row) => row.id === candidateId);
  if (candidates.length === 0) return { accepted: false, reason: 'candidate_not_found' };
  const candidate = one(candidates, 'candidate');
  if (candidate.kind !== KINDS.candidate || candidate.partition_label !== partitionLabel
    || candidate.venture_ref !== ventureRef) {
    throw new Error('Candidate kind, venture or partition does not match.');
  }
  const reviews = rowPayloads(reviewItems).filter((row) => row.candidate_ref === candidateId
    && row.candidate_revision === candidate.revision);
  if (reviews.length === 0) return { accepted: false, reason: 'review_not_found' };
  const review = one(reviews, 'review');
  if (review.kind !== KINDS.review) throw new Error('Review kind does not match.');
  const evidenceRows = rowPayloads(evidenceItems).filter((row) => row.kind === KINDS.evidence);
  const recipes = rowPayloads(recipeItems).filter((row) => row.id === candidate.recipe_ref);
  if (recipes.length === 0) return { accepted: false, reason: 'recipe_not_found', recipe_ref: candidate.recipe_ref };
  const recipeRow = one(recipes, 'recipe');
  const answers = rowPayloads(answerItems).filter((row) => row.question_key
    && row.kind !== KINDS.workItem);
  const work = rowPayloads(workItems).filter((row) => row.kind === KINDS.workItem);
  const decision = prepareQuestionWorkItem({ candidate, reviewRow: review, evidenceRows, recipeRow,
    existingAnswers: answers, existingWorkItems: work });
  return decision.accepted ? { ...decision, writes: buildQuestionAdmissionWrites(partitionLabel, decision) } : decision;
}

export async function runNativeQuestionAdmission(argv = process.argv.slice(2)) {
  const [candidateId, partitionLabel, ventureRef, ...paths] = argv;
  if (paths.length !== 6) throw new Error('Six current-record files are required.');
  const [candidateItems, reviewItems, evidenceItems, recipeItems, answerItems, workItems] = await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  return prepareNativeQuestionAdmission({ candidateId, partitionLabel, ventureRef,
    candidateItems, reviewItems, evidenceItems, recipeItems, answerItems, workItems });
}

export function verifyNativeQuestionAdmission(expected, readbackItems) {
  const item = one(rowPayloads(readbackItems).filter((row) => row.id === expected?.id), 'admitted work item');
  if (item.kind !== KINDS.workItem || item.question_key !== expected.question_key
    || item.venture_ref !== expected.venture_ref || item.partition_label !== expected.partition_label
    || item.status !== 'pending') {
    throw new Error('The admitted question did not read back as pending work.');
  }
  return { accepted: true, workItem: item };
}

export async function runNativeReadback(argv = process.argv.slice(2)) {
  const [expectedJson, path] = argv;
  if (!expectedJson || !path) throw new Error('Expected item and current readback are required.');
  return verifyNativeQuestionAdmission(JSON.parse(expectedJson), JSON.parse(await readFile(path, 'utf8')));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const operation = process.argv[2] === '--native' ? runNativeQuestionAdmission(process.argv.slice(3))
    : process.argv[2] === '--verify' ? runNativeReadback(process.argv.slice(3)) : runQuestionAdmission();
  operation.then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.accepted && process.argv[2] !== '--native') process.exitCode = 7;
  }).catch((error) => {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}

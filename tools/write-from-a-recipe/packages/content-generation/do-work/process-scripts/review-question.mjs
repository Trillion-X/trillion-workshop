/** Selected-app workflow process: decide one audience-question review. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareQuestionReview } from '../prepare-question-review.mjs';

function rows(items) {
  if (!Array.isArray(items) || items.length >= 512) {
    throw new Error('Current record read is incomplete; review stopped without a write.');
  }
  return items.map((item) => {
    if (item?.payload) return item.payload;
    if (typeof item?.value_json === 'string') return JSON.parse(item.value_json);
    return item;
  }).filter(Boolean);
}

function one(items, label) {
  if (items.length !== 1) throw new Error(`Expected one current ${label}; found ${items.length}.`);
  return items[0];
}

export function prepareNativeQuestionReview({ candidateId, partitionLabel, ventureRef,
  verdict, reason, candidateItems, reviewItems, evidenceItems, recipeItems, answerItems, workItems }) {
  if (!candidateId || !partitionLabel || !ventureRef || !verdict) {
    throw new Error('Question review coordinates and verdict are required.');
  }
  const candidates = rows(candidateItems).filter((row) => row.kind === 'content-generation.question-candidate'
    && row.id === candidateId);
  if (candidates.length === 0) return { accepted: false, reason: 'candidate_not_found' };
  const candidate = one(candidates, 'candidate');
  if (candidate.partition_label !== partitionLabel || candidate.venture_ref !== ventureRef) {
    throw new Error('Candidate belongs to another venture or partition.');
  }
  const reviews = rows(reviewItems).filter((row) => row.kind === 'content-generation.question-review'
    && row.candidate_ref === candidateId);
  const evidence = rows(evidenceItems).filter((row) => row.kind === 'content-generation.question-evidence');
  const recipes = rows(recipeItems).filter((row) => row.kind === 'content-generation.recipe');
  const answers = rows(answerItems).filter((row) => row.question_key
    && row.kind !== 'content-generation.question-work-item');
  const work = rows(workItems).filter((row) => row.kind === 'content-generation.question-work-item');
  const matchingRecipes = recipes.filter((row) => row.id === candidate.recipe_ref);
  if (verdict === 'accepted' && matchingRecipes.length === 0) {
    return { accepted: false, reason: 'recipe_not_found', recipe_ref: candidate.recipe_ref };
  }
  const recipeRow = verdict === 'accepted' ? one(matchingRecipes, 'recipe') : undefined;
  // The workflow invocation does not expose a verified actor identity. Do not
  // copy a caller-supplied name into the review as if it were authenticated.
  return prepareQuestionReview({ candidate, currentReviews: reviews, verdict, reason,
    evidenceRows: evidence, recipeRow, existingAnswers: answers, existingWorkItems: work });
}

export async function runNativeQuestionReview(argv = process.argv.slice(2)) {
  const [candidateId, partitionLabel, ventureRef, verdict, reason, ...paths] = argv;
  if (paths.length !== 6) throw new Error('Six current-record files are required.');
  const [candidateItems, reviewItems, evidenceItems, recipeItems, answerItems, workItems] = await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  return prepareNativeQuestionReview({ candidateId, partitionLabel, ventureRef, verdict, reason,
    candidateItems, reviewItems, evidenceItems, recipeItems, answerItems, workItems });
}

export function verifyNativeQuestionReview(expected, readbackItems) {
  const review = one(rows(readbackItems).filter((row) => row.id === expected?.id), 'review readback');
  if (review.kind !== 'content-generation.question-review'
    || review.candidate_ref !== expected.candidate_ref
    || review.candidate_revision !== expected.candidate_revision
    || review.venture_ref !== expected.venture_ref
    || review.partition_label !== expected.partition_label
    || review.state !== expected.state) {
    throw new Error('Question review did not read back at the expected candidate revision.');
  }
  return { accepted: true, review };
}

export async function runNativeReviewReadback(argv = process.argv.slice(2)) {
  const [expectedJson, path] = argv;
  if (!expectedJson || !path) throw new Error('Expected review and current readback are required.');
  return verifyNativeQuestionReview(JSON.parse(expectedJson), JSON.parse(await readFile(path, 'utf8')));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const operation = process.argv[2] === '--native' ? runNativeQuestionReview(process.argv.slice(3))
    : process.argv[2] === '--verify' ? runNativeReviewReadback(process.argv.slice(3))
      : Promise.reject(new Error('The review process needs --native or --verify.'));
  operation.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${String(error?.message ?? error)}\n`); process.exitCode = 1; });
}

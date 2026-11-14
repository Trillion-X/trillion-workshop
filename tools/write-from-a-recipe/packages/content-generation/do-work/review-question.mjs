/** Owner-side review over current selected-app records, with create-only readback. */
import { prepareQuestionReview } from './prepare-question-review.mjs';
import { prepareQuestionWorkItem } from './prepare-question-work-item.mjs';

const where = (kind, field, value) => ({ all: [...(kind ? [{ field: 'kind', eq: kind }] : []), { field, eq: value }] });

async function find(requests, session, kind, field, value) {
  const rows = await requests.findCurrentItems(session, 'published-record', where(kind, field, value), { limit: 512 });
  if (!Array.isArray(rows) || rows.length >= 512) throw new Error('Current record read is incomplete.');
  return rows.map((row) => row?.payload ?? row).filter(Boolean);
}

function one(rows, label) {
  if (rows.length !== 1) throw new Error(`Expected one current ${label}; found ${rows.length}.`);
  return rows[0];
}

export async function reviewQuestion({ requests, session, candidateId, partitionLabel, ventureRef,
  verdict, reason, actorRef }) {
  if (!requests || !session || !candidateId || !partitionLabel || !ventureRef) {
    throw new Error('Review needs the selected app and exact question coordinates.');
  }
  const candidate = one(await find(requests, session, 'content-generation.question-candidate', 'id', candidateId), 'candidate');
  if (candidate.partition_label !== partitionLabel || candidate.venture_ref !== ventureRef) {
    throw new Error('Candidate belongs to another venture or partition.');
  }
  const currentReviews = await find(requests, session, 'content-generation.question-review', 'candidate_ref', candidateId);
  let evidenceRows = [];
  let recipeRow;
  let existingAnswers = [];
  let existingWorkItems = [];
  if (verdict === 'accepted') {
    evidenceRows = await Promise.all((candidate.evidence_refs ?? []).map(async (ref) =>
      one(await find(requests, session, 'content-generation.question-evidence', 'id', ref.id), 'evidence')));
    recipeRow = one(await find(requests, session, 'content-generation.recipe', 'id', candidate.recipe_ref), 'recipe');
    // Resolve the stable question key through the existing admission decision, then
    // compare current answers and queue rows before creating an acceptance.
    const provisionalReview = { id: 'provisional', candidate_ref: candidate.id,
      candidate_revision: candidate.revision, venture_ref: candidate.venture_ref,
      partition_label: candidate.partition_label, state: 'accepted' };
    const provisional = prepareQuestionWorkItem({ candidate, reviewRow: provisionalReview, evidenceRows, recipeRow });
    if (!provisional.accepted) return provisional;
    [existingAnswers, existingWorkItems] = await Promise.all([
      find(requests, session, null, 'question_key', provisional.workItem.question_key),
      find(requests, session, 'content-generation.question-work-item', 'question_key', provisional.workItem.question_key),
    ]);
    existingAnswers = existingAnswers.filter((row) => row.kind !== 'content-generation.question-work-item');
  }
  const decision = prepareQuestionReview({ candidate, currentReviews, verdict, reason, actorRef,
    evidenceRows, recipeRow, existingAnswers, existingWorkItems });
  if (!decision.accepted) return decision;
  const reply = await requests.writeRecords(session, [decision.write]);
  if (!reply) throw new Error('Create-only review write did not complete.');
  const readback = one(await find(requests, session, 'content-generation.question-review', 'id', decision.review.id), 'review readback');
  if (readback.candidate_ref !== candidate.id || readback.candidate_revision !== candidate.revision
    || readback.state !== verdict || readback.venture_ref !== ventureRef
    || readback.partition_label !== partitionLabel) {
    throw new Error('Review did not read back at the expected candidate revision.');
  }
  return { accepted: true, review: readback };
}

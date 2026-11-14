/** Resolve current owner records, then admit one reviewed question without publishing. */
import { buildQuestionAdmissionWrites, prepareQuestionWorkItem } from './prepare-question-work-item.mjs';

function payloads(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => row?.payload ?? row).filter(Boolean);
}

function exact(kind, field, value) {
  return { all: [...(kind ? [{ field: 'kind', eq: kind }] : []), { field, eq: value }] };
}

async function matching(requests, session, kind, field, value) {
  const rows = await requests.findCurrentItems(session, 'published-record', exact(kind, field, value), { limit: 512 });
  if (!Array.isArray(rows) || rows.length >= 512) throw new Error('Current record read is incomplete.');
  return payloads(rows);
}

function one(rows, name) {
  if (rows.length !== 1) throw new Error(`Expected one current ${name}; found ${rows.length}.`);
  return rows[0];
}

export async function admitQuestionWorkItem({ requests, session, partitionLabel, candidateId, kinds }) {
  if (!requests || !session || !partitionLabel || !candidateId || !kinds) {
    throw new Error('Admission needs an owner session, partition, candidate, and record kinds.');
  }
  const candidate = one(await matching(requests, session, kinds.candidate, 'id', candidateId), 'candidate');
  if (candidate.partition_label !== partitionLabel) throw new Error('Candidate belongs to another partition.');
  // A later rejection or conflicting review must not leave an older acceptance
  // usable. Resolve the whole current review set, then require one exact verdict.
  const reviewRows = await matching(requests, session, kinds.review, 'candidate_ref', candidateId);
  const reviewRow = one(reviewRows.filter((row) => row.candidate_revision === candidate.revision), 'review');
  if (reviewRow.candidate_revision !== candidate.revision
    || reviewRow.venture_ref !== candidate.venture_ref
    || reviewRow.partition_label !== partitionLabel || reviewRow.state !== 'accepted') {
    throw new Error('The current review is not an acceptance of this candidate revision.');
  }
  const evidenceRows = [];
  for (const ref of candidate.evidence_refs ?? []) {
    evidenceRows.push(one(await matching(requests, session, kinds.evidence, 'id', ref.id), 'evidence row'));
  }
  const recipeRow = one(await matching(requests, session, 'content-generation.recipe', 'id', candidate.recipe_ref), 'recipe');
  const preliminary = prepareQuestionWorkItem({ candidate, reviewRow, evidenceRows, recipeRow });
  if (!preliminary.accepted) return preliminary;
  const key = preliminary.workItem.question_key;
  const [matchingAnswersAndWork, existingWorkItems] = await Promise.all([
    matching(requests, session, null, 'question_key', key),
    matching(requests, session, kinds.workItem, 'question_key', key),
  ]);
  const existingAnswers = matchingAnswersAndWork.filter((row) => row.kind !== kinds.workItem);
  const decision = prepareQuestionWorkItem({ candidate, reviewRow, evidenceRows, recipeRow, existingAnswers, existingWorkItems });
  if (!decision.accepted) return decision;
  const reply = await requests.writeRecords(session, buildQuestionAdmissionWrites(partitionLabel, decision));
  if (!reply) throw new Error('The create-only question write did not complete.');
  const readback = one(await matching(requests, session, kinds.workItem, 'id', decision.workItem.id), 'admitted work item');
  if (readback.id !== decision.workItem.id || readback.question_key !== key
    || readback.venture_ref !== candidate.venture_ref || readback.status !== 'pending') {
    throw new Error('The admitted question did not read back as pending work.');
  }
  return { accepted: true, workItem: readback };
}

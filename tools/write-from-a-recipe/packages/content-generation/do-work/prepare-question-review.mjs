/** Pure review decision over owner-resolved current records. No publication. */
import { blake3 } from '@noble/hashes/blake3.js';
import { prepareQuestionWorkItem } from './prepare-question-work-item.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';

export function prepareQuestionReview({ candidate, currentReviews = [], verdict, reason,
  actorRef, evidenceRows = [], recipeRow, existingAnswers = [], existingWorkItems = [] }) {
  if (!candidate || !text(candidate.id) || !text(candidate.revision)
    || !text(candidate.partition_label) || !text(candidate.venture_ref)) {
    return { accepted: false, reason: 'missing_current_candidate' };
  }
  if (!['accepted', 'rejected'].includes(verdict)) return { accepted: false, reason: 'invalid_verdict' };
  if (!text(reason) || text(reason).length > 2000) return { accepted: false, reason: 'invalid_reason' };
  if (!Array.isArray(currentReviews)) return { accepted: false, reason: 'incomplete_review_read' };
  if (currentReviews.some((row) => row?.candidate_ref === candidate.id
    && row?.candidate_revision === candidate.revision)) {
    return { accepted: false, reason: 'candidate_revision_already_reviewed' };
  }
  const digest = blake3(new TextEncoder().encode([candidate.partition_label, candidate.id, candidate.revision].join(String.fromCharCode(31))));
  const review = {
    kind: 'content-generation.question-review',
    id: `content-question-review:1f:${Buffer.from(digest).toString('hex')}`,
    candidate_ref: candidate.id,
    candidate_revision: candidate.revision,
    partition_label: candidate.partition_label,
    venture_ref: candidate.venture_ref,
    state: verdict,
    reason: text(reason),
    ...(text(actorRef) ? { actor_ref: text(actorRef) } : {}),
  };
  if (verdict === 'accepted') {
    const admission = prepareQuestionWorkItem({ candidate, reviewRow: review, evidenceRows,
      recipeRow, existingAnswers, existingWorkItems });
    if (!admission.accepted) return { accepted: false, reason: admission.reason };
  }
  return { accepted: true, review, write: {
    partition_label: candidate.partition_label,
    address_label: review.id,
    address_mode: 'identity_text',
    path_labels: ['current-item', 'published-record'],
    payload: review,
    expected_current: { payload_hash_base64: null },
  } };
}

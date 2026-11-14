/**
 * Validate an owner-resolved audience question before it can enter a content queue.
 * This is a pure decision. The caller must read evidence and existing answers from
 * their authoritative owners, then make a create-only write for the returned id.
 * No content is generated or published here.
 */
import { blake3 } from '@noble/hashes/blake3.js';

function requiredText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizedQuestion(value) {
  return requiredText(value).normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function questionKey(candidate) {
  return [candidate.venture_ref, candidate.audience_ref, candidate.locale,
    normalizedQuestion(candidate.question)].join(String.fromCharCode(31));
}

function stableId(key) {
  const bytes = blake3(new TextEncoder().encode(key));
  return `content-question:1f:${Buffer.from(bytes).toString('hex')}`;
}

/**
 * Evidence rows are already resolved from their canonical owner. A caller's
 * evidence_ref alone is never accepted as proof that the source exists.
 */
export function prepareQuestionWorkItem({ candidate, reviewRow, evidenceRows, recipeRow, existingAnswers = [], existingWorkItems = [] }) {
  if (!candidate || typeof candidate !== 'object') return { accepted: false, reason: 'invalid_candidate' };
  for (const field of ['id', 'revision', 'partition_label', 'venture_ref', 'audience_ref', 'locale', 'question', 'offer_ref', 'recipe_ref']) {
    if (!requiredText(candidate[field])) return { accepted: false, reason: `missing_${field}` };
  }
  if (!requiredText(reviewRow?.id) || reviewRow?.candidate_ref !== candidate.id || reviewRow?.candidate_revision !== candidate.revision
    || reviewRow?.venture_ref !== candidate.venture_ref
    || reviewRow?.partition_label !== candidate.partition_label || reviewRow?.state !== 'accepted') {
    return { accepted: false, reason: 'missing_or_stale_acceptance' };
  }
  const question = requiredText(candidate.question);
  if (question.length > 500) return { accepted: false, reason: 'question_too_long' };
  if (!Array.isArray(candidate.evidence_refs) || candidate.evidence_refs.length === 0) {
    return { accepted: false, reason: 'missing_evidence' };
  }
  const refs = candidate.evidence_refs;
  if (refs.some((ref) => !requiredText(ref?.id) || !requiredText(ref?.revision))) {
    return { accepted: false, reason: 'invalid_evidence_ref' };
  }
  if (new Set(refs.map((ref) => ref.id)).size !== refs.length) {
    return { accepted: false, reason: 'duplicate_evidence_ref' };
  }
  const resolved = new Map((Array.isArray(evidenceRows) ? evidenceRows : []).map((row) => [row?.id, row]));
  for (const ref of refs) {
    const row = resolved.get(ref.id);
    if (!row || row.revision !== ref.revision || row.venture_ref !== candidate.venture_ref
      || row.partition_label !== candidate.partition_label
      || !validTime(row.observed_at) || !requiredText(row.source_ref)
      || !requiredText(row.evidence_kind)) {
      return { accepted: false, reason: 'missing_stale_or_foreign_evidence', evidence_ref: ref.id };
    }
    if (row.evidence_kind === 'public_page' && candidate.claimed_query_volume != null) {
      return { accepted: false, reason: 'page_is_not_query_volume_evidence', evidence_ref: ref.id };
    }
  }
  if (recipeRow?.kind !== 'content-generation.recipe' || recipeRow.id !== candidate.recipe_ref) {
    return { accepted: false, reason: 'missing_or_wrong_recipe' };
  }
  const groundingRefs = candidate.grounding_refs ?? [];
  if (!Array.isArray(groundingRefs) || groundingRefs.some((ref) => !requiredText(ref?.id)
    || !requiredText(ref?.revision) || !refs.some((item) => item.id === ref.id && item.revision === ref.revision))) {
    return { accepted: false, reason: 'invalid_grounding_refs' };
  }
  const grounded = recipeRow?.gate_policy?.grounded === true
    || requiredText(recipeRow?.context_retrieval?.input_refs_field);
  if (grounded && groundingRefs.length === 0) return { accepted: false, reason: 'missing_answer_grounding' };
  if (groundingRefs.some((ref) => {
    const row = resolved.get(ref.id);
    return row?.supports_answer !== true || row?.rights_status !== 'cleared'
      || !requiredText(row?.rights_basis_ref)
      || !requiredText(row?.source_observation_ref)
      || row.source_observation_ref === candidate.source_observation_ref
      || !['first_party_content', 'licensed_source', 'public_domain_source'].includes(row?.evidence_kind);
  })) return { accepted: false, reason: 'grounding_not_cleared_for_answer' };
  const grounding = [];
  const groundingIds = new Set();
  for (const ref of groundingRefs) {
    const row = resolved.get(ref.id);
    if (!Array.isArray(row?.grounding_excerpts) || row.grounding_excerpts.length === 0) {
      return { accepted: false, reason: 'missing_grounding_excerpts', evidence_ref: ref.id };
    }
    for (const excerpt of row.grounding_excerpts) {
      const id = requiredText(excerpt?.ref);
      const body = requiredText(excerpt?.text);
      if (!id || !body || excerpt?.source_ref !== row.source_ref || groundingIds.has(id)) {
        return { accepted: false, reason: 'invalid_grounding_excerpt', evidence_ref: ref.id };
      }
      groundingIds.add(id);
      grounding.push({ ref: id, text: body, source_ref: row.source_ref });
    }
  }
  const minimumExcerpts = recipeRow?.gate_policy?.min_excerpts;
  if (grounded && grounding.length < (Number.isSafeInteger(minimumExcerpts) && minimumExcerpts > 0 ? minimumExcerpts : 1)) {
    return { accepted: false, reason: 'insufficient_grounding_excerpts' };
  }
  const sourceRefs = groundingRefs.map((ref) => resolved.get(ref.id)?.source_ref).filter(Boolean);
  const key = questionKey(candidate);
  const id = stableId(key);
  const workItemData = { question, search_query: question, topic: question, doc_id: id,
    source_refs: sourceRefs, venture_ref: candidate.venture_ref, audience_ref: candidate.audience_ref,
    locale: candidate.locale, offer_ref: candidate.offer_ref };
  const estimates = {};
  for (const field of ['expected_asset_count', 'estimated_resource_units', 'estimated_cost_minor']) {
    const value = candidate[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { accepted: false, reason: `invalid_${field}` };
    }
    estimates[field] = value;
  }
  const requiredDelivery = Object.values(recipeRow?.delivery_target?.input ?? {})
    .filter((value) => value?.from === 'work_item').map((value) => value.field);
  if (requiredDelivery.some((field) => !Object.hasOwn(workItemData, field))) {
    return { accepted: false, reason: 'recipe_needs_unmapped_work_item_field' };
  }
  const deliveryState = recipeRow?.delivery_target?.input?.status?.value;
  if (!['draft', 'pending_review'].includes(deliveryState)) {
    return { accepted: false, reason: 'recipe_delivery_not_review_safe' };
  }
  if ((Array.isArray(existingAnswers) ? existingAnswers : []).some((row) => row?.question_key === key)) {
    return { accepted: false, reason: 'existing_answer' };
  }
  if ((Array.isArray(existingWorkItems) ? existingWorkItems : []).some((row) => row?.question_key === key)) {
    return { accepted: false, reason: 'already_queued' };
  }
  return {
    accepted: true,
    workItem: {
      kind: 'content-generation.question-work-item',
      id,
      status: 'pending',
      question_key: key,
      venture_ref: candidate.venture_ref,
      partition_label: candidate.partition_label,
      audience_ref: candidate.audience_ref,
      locale: candidate.locale,
      question,
      offer_ref: candidate.offer_ref,
      recipe_ref: candidate.recipe_ref,
      ...estimates,
      evidence_refs: refs.map(({ id, revision }) => ({ id, revision })),
      grounding_refs: groundingRefs.map(({ id, revision }) => ({ id, revision })),
      grounding,
      accepted_review_ref: reviewRow.id,
      candidate_ref: candidate.id,
      candidate_revision: candidate.revision,
      work_item: workItemData,
    },
  };
}

/** The owner must submit this exact create-only write; a concurrent twin loses. */
export function buildQuestionAdmissionWrites(partitionLabel, decision) {
  if (!requiredText(partitionLabel) || decision?.accepted !== true || !decision.workItem) {
    throw new Error('A valid accepted question and partition are required.');
  }
  return [{
    partition_label: partitionLabel,
    address_label: decision.workItem.id,
    address_mode: 'identity_text',
    path_labels: ['current-item', 'published-record'],
    payload: decision.workItem,
    expected_current: { payload_hash_base64: null },
  }];
}

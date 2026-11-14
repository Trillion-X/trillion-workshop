/** Convert a current, traceable observation into reviewable question records. */
import { blake3 } from '@noble/hashes/blake3.js';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const normalized = (value) => text(value).normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const identity = (parts) => Buffer.from(blake3(new TextEncoder().encode(parts.join(String.fromCharCode(31))))).toString('hex');

export function prepareObservedQuestion({ observation, route, question }) {
  if (observation?.kind !== 'observed-content.content-atom' || !text(observation.atom_ref)
    || !text(observation.source_ref) || !text(observation.content?.text)
    || !Number.isFinite(Date.parse(observation.at))) {
    return { accepted: false, reason: 'invalid_current_observation' };
  }
  if (route?.kind !== 'content-generation.question-source-route'
    || route.source_ref !== observation.source_ref) {
    return { accepted: false, reason: 'missing_source_route' };
  }
  if (observation.source_authorization?.status !== 'authorized'
    || observation.source_authorization?.partition_label !== route.partition_label
    || !text(observation.source_authorization?.authorization_scope_ref)) {
    return { accepted: false, reason: 'source_not_authorized_for_route_partition' };
  }
  if (route.question_use_status !== 'cleared') {
    return { accepted: false, reason: 'question_use_not_cleared' };
  }
  if (!['customer_language', 'public_page', 'first_party_query'].includes(route.evidence_kind)) {
    return { accepted: false, reason: 'invalid_question_evidence_kind' };
  }
  for (const field of ['id', 'partition_label', 'venture_ref', 'audience_ref', 'locale', 'offer_ref', 'recipe_ref']) {
    if (!text(route[field])) return { accepted: false, reason: `missing_route_${field}` };
  }
  const exactQuestion = text(question);
  if (!exactQuestion || exactQuestion.length > 500
    || !normalized(observation.content.text).includes(normalized(exactQuestion))) {
    return { accepted: false, reason: 'question_not_in_observation' };
  }
  const revision = `1f:${identity([observation.atom_ref, observation.content.text, observation.at])}`;
  const base = identity([route.partition_label, route.venture_ref, route.id, observation.atom_ref,
    revision, normalized(exactQuestion)]);
  const evidence = {
    kind: 'content-generation.question-evidence', id: `content-question-evidence:1f:${base}`,
    revision, partition_label: route.partition_label, venture_ref: route.venture_ref,
    source_ref: observation.source_ref, source_observation_ref: observation.atom_ref,
    observed_at: observation.at, evidence_kind: route.evidence_kind,
    supports_answer: false, rights_status: 'not_cleared',
    question_excerpt: exactQuestion,
  };
  const candidate = {
    kind: 'content-generation.question-candidate', id: `content-question-candidate:1f:${base}`,
    revision, partition_label: route.partition_label, venture_ref: route.venture_ref,
    audience_ref: route.audience_ref, locale: route.locale, question: exactQuestion,
    offer_ref: route.offer_ref, recipe_ref: route.recipe_ref,
    evidence_refs: [{ id: evidence.id, revision }], grounding_refs: [],
    source_route_ref: route.id, source_observation_ref: observation.atom_ref,
  };
  const writes = [evidence, candidate].map((payload) => ({
    partition_label: route.partition_label, address_label: payload.id,
    address_mode: 'identity_text', path_labels: ['current-item', 'published-record'],
    payload, expected_current: { payload_hash_base64: null },
  }));
  return { accepted: true, evidence, candidate, writes };
}

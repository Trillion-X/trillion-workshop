/** Link an already-current, independently cleared source to one question. */
import { blake3 } from '@noble/hashes/blake3.js';

const text = (value) => typeof value === 'string' ? value.trim() : '';

export function prepareQuestionGroundingLink({ candidate, candidateBasisHashBase64, evidence }) {
  if (candidate?.kind !== 'content-generation.question-candidate'
    || !text(candidate.id) || !text(candidate.revision)
    || !text(candidate.partition_label) || !text(candidate.venture_ref)
    || !Array.isArray(candidate.evidence_refs) || !Array.isArray(candidate.grounding_refs)
    || !text(candidateBasisHashBase64)) {
    return { accepted: false, reason: 'invalid_current_candidate' };
  }
  if (evidence?.kind !== 'content-generation.question-evidence'
    || !text(evidence.id) || !text(evidence.revision)
    || evidence.partition_label !== candidate.partition_label
    || evidence.venture_ref !== candidate.venture_ref
    || evidence.supports_answer !== true || evidence.rights_status !== 'cleared'
    || !text(evidence.rights_basis_ref)
    || !text(evidence.source_ref) || !text(evidence.source_observation_ref)
    || evidence.source_observation_ref === candidate.source_observation_ref
    || !['first_party_content', 'licensed_source', 'public_domain_source'].includes(evidence.evidence_kind)
    || !Array.isArray(evidence.grounding_excerpts) || evidence.grounding_excerpts.length === 0
    || evidence.grounding_excerpts.some((excerpt) => !text(excerpt?.ref)
      || !text(excerpt?.text) || excerpt.source_ref !== evidence.source_ref)) {
    return { accepted: false, reason: 'answer_evidence_not_cleared' };
  }
  if (candidate.evidence_refs.some((ref) => ref?.id === evidence.id)
    || candidate.grounding_refs.some((ref) => ref?.id === evidence.id)) {
    return { accepted: false, reason: 'answer_evidence_already_linked' };
  }
  const ref = { id: evidence.id, revision: evidence.revision };
  const revision = `1f:${Buffer.from(blake3(new TextEncoder().encode([
    candidate.revision, evidence.id, evidence.revision,
  ].join(String.fromCharCode(31))))).toString('hex')}`;
  const updatedCandidate = { ...candidate, revision,
    evidence_refs: [...candidate.evidence_refs, ref],
    grounding_refs: [...candidate.grounding_refs, ref] };
  return { accepted: true, candidate: updatedCandidate, write: {
    partition_label: candidate.partition_label,
    address_label: candidate.id,
    address_mode: 'identity_text',
    path_labels: ['current-item', 'published-record'],
    payload: updatedCandidate,
    expected_current: { payload_hash_base64: candidateBasisHashBase64 },
  } };
}

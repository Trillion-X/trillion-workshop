// tools/form-groups-and-matches/read-data/expected-value.mjs
//
// The expected value of putting a candidate (a person, a tool, a workflow, a place: anything with an id) with a subject.
// It is the exact product of the factor scores the program names, each factor grounded in cited evidence
// (read-data/match-evidence.mjs). Similarity from a search is kept as a tie-break and as evidence of where a candidate
// came from, never as a factor. A candidate with a missing, zero or uncited factor gets no value and joins no group.
//
// The program's policy, given with every request:
//
//   expected_value = {
//     factors: ["<factor>"],              required: what the value is the product of
//     scope_fields: ["<field>"],          required: the scope a candidate's value is for (a goal, a team, a horizon, ...)
//     minimum_expected_value?: number,    a value must be above this (0 when not given)
//     minimum_distinguishable_delta?: number,   the last chosen must beat the first left out by more than this
//     require_scope?: boolean             refuse a candidate whose scope is not complete
//   }
//
// Work is bounded by design: each subject's shortlist is cut to shortlist_size before any candidate is scored, so the
// work is subjects x shortlist_size however large the pool is, and no pair outside a shortlist is ever looked at.
import { validateGroundedFactorEvidence } from './match-evidence.mjs';

const nonEmptyString = value => (typeof value === 'string' && value.length > 0 ? value : null);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const names = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0)
  && new Set(value).size === value.length;

/** The policy, checked: refuses one without its factors or scope fields. */
export function readPolicy(config) {
  if (!object(config) || !names(config.factors) || !names(config.scope_fields)) {
    throw new Error('expected_value must name its factors and scope_fields: { factors: ["<factor>", ...], scope_fields: ["<field>", ...] }.');
  }
  return config;
}

/** "<field>:<value>|..." when every scope field has a value, else null. */
export function scopeKey(value, policy) {
  const scope = object(value?.scope) ? value.scope : value;
  if (!object(scope) || policy.scope_fields.some(field => !nonEmptyString(scope[field]))) return null;
  return policy.scope_fields.map(field => `${field}:${scope[field]}`).join('|');
}

/** A candidate's scope: its own fields first, then its scope object, then the row it came in. */
export function normalizeScope(candidate, row, policy) {
  const scope = object(candidate?.scope) ? candidate.scope : (object(row?.scope) ? row.scope : {});
  return Object.fromEntries(policy.scope_fields.map(field => [
    field, nonEmptyString(candidate?.[field]) ?? nonEmptyString(scope[field]) ?? nonEmptyString(row?.[field]),
  ]));
}

/** May this candidate be grouped? Only with grounded evidence, the exact product as its value, above the minimum. */
export function expectedValueAdmission(candidate, policy) {
  const minimum = Number.isFinite(policy.minimum_expected_value) ? policy.minimum_expected_value : 0;
  const evidence = validateGroundedFactorEvidence(candidate?.factor_evidence, policy.factors);
  if (!evidence.justified) return { admitted: false, reason: 'missing_grounded_factor_evidence', evidence_reasons: evidence.reasons };
  const expectedProduct = policy.factors.reduce((product, factor) => product * evidence.factors[factor], 1);
  if (Math.abs(candidate?.expected_value - expectedProduct) > Number.EPSILON * 16) return { admitted: false, reason: 'expected_value_product_mismatch' };
  if (!Number.isFinite(candidate?.expected_value) || candidate.expected_value <= minimum) return { admitted: false, reason: 'non_positive_expected_value' };
  if (policy.require_scope === true && !scopeKey(candidate, policy)) return { admitted: false, reason: 'scope_missing' };
  return { admitted: true, reason: null };
}

/** Is the cut after the first `selectedCount` values clear? The last kept must beat the first left out by more than the delta. */
export function selectionBoundary(candidateValues, selectedCount, policy) {
  const delta = Number.isFinite(policy.minimum_distinguishable_delta) && policy.minimum_distinguishable_delta >= 0
    ? policy.minimum_distinguishable_delta : 0;
  const values = candidateValues.filter(Number.isFinite).sort((left, right) => right - left);
  if (!Number.isInteger(selectedCount) || selectedCount <= 0 || values.length < selectedCount) {
    return { distinguishable: false, reason: 'insufficient_positive_candidates' };
  }
  const firstExcluded = values[selectedCount];
  if (firstExcluded == null) return { distinguishable: true, reason: null };
  return values[selectedCount - 1] - firstExcluded > delta
    ? { distinguishable: true, reason: null }
    : { distinguishable: false, reason: 'indistinguishable_expected_value' };
}

/** The value of one candidate from its factor evidence, or why it has none. */
export function scoreExpectedValue(candidate, policy) {
  const validation = validateGroundedFactorEvidence(candidate?.factor_evidence, policy.factors);
  if (!validation.justified) {
    return { expected_value: null, factors: validation.factors, factor_evidence: candidate?.factor_evidence ?? null, evidence_refs: [], justified: false, reasons: validation.reasons };
  }
  const product = policy.factors.reduce((value, factor) => value * validation.factors[factor], 1);
  return { expected_value: product, factors: validation.factors, factor_evidence: candidate.factor_evidence, evidence_refs: validation.evidence_refs, justified: true, reasons: [] };
}

function candidateId(candidate) {
  for (const value of [candidate?.resource_ref, candidate?.candidate_ref, candidate?.participant, candidate?.candidate_id, candidate?.target_ref, candidate?.address]) {
    if (nonEmptyString(value)) return value;
  }
  return null;
}

function subjectId(row) {
  for (const value of [row?.subject, row?.event, row?.subject_id, row?.id]) if (nonEmptyString(value)) return value;
  return null;
}

function shortlistOf(row) {
  if (Array.isArray(row?.shortlist)) return row.shortlist;
  if (Array.isArray(row?.candidates)) return row.candidates;
  if (Array.isArray(row?.items)) return row.items;
  return [];
}

/**
 * Search results in, scored candidates out. Each row is one subject with its shortlist; at most `shortlist_size`
 * of each are looked at; access tiers (when any are listed) must match; every kept candidate is grounded and admitted.
 */
export function buildCandidates(retrievalResults, { shortlist_size: shortlistSize, eligibility, expected_value: expectedValue }) {
  const policy = readPolicy(expectedValue);
  if (!Number.isInteger(shortlistSize) || shortlistSize <= 0) throw new Error('retrieval.shortlist_size must be a whole number above 0: how many of each subject\'s search results to look at.');
  const rows = Array.isArray(retrievalResults) ? retrievalResults : [];
  const allowedTiers = new Set(Array.isArray(eligibility?.access_tiers) ? eligibility.access_tiers.filter(tier => typeof tier === 'string') : []);
  const candidates = [];
  const rejections = [];
  const count = { subjects: 0, retrieved: 0, shortlist: 0, scored: 0, tier: 0, value: 0, scope: 0, evidence: 0, corpus: 0 };

  for (const row of rows) {
    const subject = subjectId(row);
    if (!subject) continue;
    count.subjects += 1;
    if (Number.isFinite(row.corpus_size)) count.corpus = Math.max(count.corpus, row.corpus_size);
    const shortlist = shortlistOf(row);
    count.retrieved += shortlist.length;
    for (const candidate of shortlist.slice(0, shortlistSize)) {
      count.shortlist += 1;
      const participant = candidateId(candidate);
      if (!participant || participant === subject) continue;
      if (allowedTiers.size > 0 && !allowedTiers.has(candidate.access_tier)) {
        count.tier += 1;
        continue;
      }
      count.scored += 1;
      const score = scoreExpectedValue(candidate, policy);
      if (!score.justified) {
        count.evidence += 1;
        rejections.push({ subject, participant, status: 'no_justified_match', reasons: score.reasons });
        continue;
      }
      const scope = normalizeScope(candidate, row, policy);
      const record = {
        subject,
        participant,
        resource_ref: participant,
        resource_kind: nonEmptyString(candidate.resource_kind),
        action_ref: nonEmptyString(candidate.action_ref),
        configuration_ref: nonEmptyString(candidate.configuration_ref),
        configuration: candidate.configuration ?? null,
        consent_party_refs: Array.isArray(candidate.consent_party_refs) ? candidate.consent_party_refs.filter(nonEmptyString) : null,
        scope,
        scope_key: scopeKey(scope, policy),
        access_tier: candidate.access_tier ?? null,
        expected_value: score.expected_value,
        factors: score.factors,
        factor_evidence: score.factor_evidence,
        evidence_refs: score.evidence_refs,
        justification_status: 'grounded',
        why: typeof candidate.why === 'string' ? candidate.why : null,
        role: typeof candidate.role === 'string' ? candidate.role : null,
        retrieval_score: Number.isFinite(candidate.retrieval_score) ? candidate.retrieval_score : null,
        retrieval_provenance: candidate.retrieval_provenance ?? null,
      };
      const admission = expectedValueAdmission(record, policy);
      if (!admission.admitted) {
        if (admission.reason === 'scope_missing') count.scope += 1;
        else count.value += 1;
        rejections.push({ subject, participant, status: 'no_justified_match', reason: admission.reason, reasons: admission.evidence_reasons ?? [] });
        continue;
      }
      record.expected_value_admission = admission;
      candidates.push(record);
    }
  }

  candidates.sort((left, right) => {
    if (left.subject !== right.subject) return left.subject.localeCompare(right.subject);
    if (left.expected_value !== right.expected_value) return right.expected_value - left.expected_value;
    return left.participant.localeCompare(right.participant);
  });
  return {
    candidates,
    rejections,
    instrumentation: {
      subject_count: count.subjects,
      corpus_size: count.corpus,
      shortlist_size: shortlistSize,
      retrieved_count: count.retrieved,
      shortlist_evaluation_count: count.shortlist,
      expected_value_evaluation_count: count.scored,
      access_tier_rejected_count: count.tier,
      expected_value_rejected_count: count.value,
      scope_rejected_count: count.scope,
      missing_evidence_rejected_count: count.evidence,
      max_bounded_evaluations: count.subjects * shortlistSize,
      all_pairs_evaluation_count: 0,
      expensive_reasoning_count: 0,
    },
  };
}

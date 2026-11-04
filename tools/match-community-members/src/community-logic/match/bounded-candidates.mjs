// Vendored unchanged except for import paths from bitfield-packages/packages/interaction-program/read-data/bounded-candidates.mjs.
import {
  MATCH_FACTOR_IDS,
  validateGroundedFactorEvidence,
} from "./match-intake-evidence.mjs";

export const EXPECTED_VALUE_FACTORS = MATCH_FACTOR_IDS;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function candidateId(candidate) {
  for (const value of [
    candidate?.resource_ref,
    candidate?.candidate_ref,
    candidate?.participant,
    candidate?.candidate_id,
    candidate?.target_ref,
    candidate?.address,
  ]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function subjectId(row) {
  for (const value of [row?.subject, row?.event, row?.subject_id, row?.id]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function normalizeShortlist(row) {
  if (Array.isArray(row?.shortlist)) return row.shortlist;
  if (Array.isArray(row?.candidates)) return row.candidates;
  if (Array.isArray(row?.items)) return row.items;
  return [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeNeedleMoverScope(candidate, row = {}) {
  const scope = candidate?.scope && typeof candidate.scope === "object"
    ? candidate.scope
    : (row?.scope && typeof row.scope === "object" ? row.scope : {});
  return {
    pursuit_ref: nonEmptyString(candidate?.pursuit_ref) ?? nonEmptyString(scope.pursuit_ref) ?? nonEmptyString(row?.pursuit_ref),
    system_ref: nonEmptyString(candidate?.system_ref) ?? nonEmptyString(scope.system_ref) ?? nonEmptyString(row?.system_ref),
    timescale_ref: nonEmptyString(candidate?.timescale_ref) ?? nonEmptyString(scope.timescale_ref) ?? nonEmptyString(row?.timescale_ref),
    state_ref: nonEmptyString(candidate?.state_ref) ?? nonEmptyString(scope.state_ref) ?? nonEmptyString(row?.state_ref),
  };
}

export function needleMoverScopeKey(value) {
  const scope = value?.scope && typeof value.scope === "object"
    ? value.scope
    : value;
  if (!scope || EXPECTED_VALUE_SCOPE_FIELDS.some((field) => !nonEmptyString(scope[field]))) return null;
  return EXPECTED_VALUE_SCOPE_FIELDS.map((field) => `${field}:${scope[field]}`).join("|");
}

export const EXPECTED_VALUE_SCOPE_FIELDS = Object.freeze([
  "pursuit_ref",
  "system_ref",
  "timescale_ref",
  "state_ref",
]);

export function expectedValueAdmission(candidate, config = {}) {
  const minimum = Number.isFinite(config.minimum_expected_value)
    ? config.minimum_expected_value
    : 0;
  const evidence = validateGroundedFactorEvidence(candidate?.factor_evidence);
  if (!evidence.justified) {
    return {
      admitted: false,
      reason: "missing_grounded_factor_evidence",
      evidence_reasons: evidence.reasons,
    };
  }
  const expectedProduct = EXPECTED_VALUE_FACTORS.reduce(
    (product, factor) => product * evidence.factors[factor],
    1,
  );
  if (Math.abs(candidate?.expected_value - expectedProduct) > Number.EPSILON * 16) {
    return { admitted: false, reason: "expected_value_product_mismatch" };
  }
  if (!Number.isFinite(candidate?.expected_value) || candidate.expected_value <= minimum) {
    return { admitted: false, reason: "non_positive_expected_value" };
  }
  if (config.require_scope === true && !needleMoverScopeKey(candidate)) {
    return { admitted: false, reason: "needle_mover_scope_missing" };
  }
  return { admitted: true, reason: null };
}

export function selectionBoundary(candidateValues, selectedCount, config = {}) {
  const delta = Number.isFinite(config.minimum_distinguishable_delta)
    && config.minimum_distinguishable_delta >= 0
    ? config.minimum_distinguishable_delta
    : 0;
  const values = candidateValues
    .filter(Number.isFinite)
    .sort((left, right) => right - left);
  if (!Number.isInteger(selectedCount) || selectedCount <= 0 || values.length < selectedCount) {
    return { distinguishable: false, reason: "insufficient_positive_candidates" };
  }
  const firstExcluded = values[selectedCount];
  if (firstExcluded == null) return { distinguishable: true, reason: null };
  const boundary = values[selectedCount - 1];
  return boundary - firstExcluded > delta
    ? { distinguishable: true, reason: null }
    : { distinguishable: false, reason: "indistinguishable_expected_value" };
}

export function scoreExpectedValue(candidate) {
  const validation = validateGroundedFactorEvidence(candidate?.factor_evidence);
  const factors = validation.factors;
  if (!validation.justified) {
    return {
      expected_value: null,
      factors,
      factor_evidence: candidate?.factor_evidence ?? null,
      evidence_refs: [],
      justified: false,
      reasons: validation.reasons,
    };
  }
  let product = 1;

  for (const factor of EXPECTED_VALUE_FACTORS) {
    product *= factors[factor];
  }

  return {
    expected_value: product,
    factors,
    factor_evidence: candidate.factor_evidence,
    evidence_refs: validation.evidence_refs,
    justified: true,
    reasons: [],
  };
}

export function buildCandidates(retrievalResults, config = {}) {
  const rows = Array.isArray(retrievalResults) ? retrievalResults : [];
  const shortlistSize = positiveInteger(config.shortlist_size, 10);
  const eligibility = config.eligibility && typeof config.eligibility === "object"
    ? config.eligibility
    : {};
  const allowedTiers = new Set(
    Array.isArray(eligibility.access_tiers)
      ? eligibility.access_tiers.filter((tier) => typeof tier === "string")
      : [],
  );
  const candidates = [];
  const rejections = [];
  let subjectCount = 0;
  let retrievedCount = 0;
  let shortlistEvaluationCount = 0;
  let expectedValueEvaluationCount = 0;
  let accessTierRejectedCount = 0;
  let expectedValueRejectedCount = 0;
  let scopeRejectedCount = 0;
  let missingEvidenceRejectedCount = 0;
  let corpusSize = 0;

  for (const row of rows) {
    const subject = subjectId(row);
    if (!subject) continue;
    subjectCount += 1;
    if (Number.isFinite(row.corpus_size)) corpusSize = Math.max(corpusSize, row.corpus_size);
    const shortlist = normalizeShortlist(row);
    retrievedCount += shortlist.length;

    for (const candidate of shortlist.slice(0, shortlistSize)) {
      shortlistEvaluationCount += 1;
      const participant = candidateId(candidate);
      if (!participant || participant === subject) continue;
      if (allowedTiers.size > 0 && !allowedTiers.has(candidate.access_tier)) {
        accessTierRejectedCount += 1;
        continue;
      }
      expectedValueEvaluationCount += 1;
      const score = scoreExpectedValue(candidate);
      if (!score.justified) {
        missingEvidenceRejectedCount += 1;
        rejections.push({
          subject,
          participant,
          status: "no_justified_match",
          reasons: score.reasons,
        });
        continue;
      }
      const scope = normalizeNeedleMoverScope(candidate, row);
      const record = {
        subject,
        participant,
        resource_ref: participant,
        resource_kind: nonEmptyString(candidate.resource_kind) ?? null,
        action_ref: nonEmptyString(candidate.action_ref) ?? null,
        configuration_ref: nonEmptyString(candidate.configuration_ref) ?? null,
        configuration: candidate.configuration ?? null,
        consent_party_refs: Array.isArray(candidate.consent_party_refs)
          ? candidate.consent_party_refs.filter((value) => nonEmptyString(value))
          : null,
        scope,
        scope_key: needleMoverScopeKey(scope),
        access_tier: candidate.access_tier ?? null,
        expected_value: score.expected_value,
        factors: score.factors,
        factor_evidence: score.factor_evidence,
        evidence_refs: score.evidence_refs,
        justification_status: "grounded",
        why: typeof candidate.why === "string" ? candidate.why : null,
        role: typeof candidate.role === "string" ? candidate.role : null,
        retrieval_score: Number.isFinite(candidate.retrieval_score)
          ? candidate.retrieval_score
          : null,
        retrieval_provenance: candidate.retrieval_provenance ?? null,
      };
      const admission = expectedValueAdmission(record, config.expected_value);
      if (!admission.admitted) {
        if (admission.reason === "needle_mover_scope_missing") scopeRejectedCount += 1;
        else expectedValueRejectedCount += 1;
        rejections.push({
          subject,
          participant,
          status: "no_justified_match",
          reason: admission.reason,
          reasons: admission.evidence_reasons ?? [],
        });
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
      subject_count: subjectCount,
      corpus_size: corpusSize,
      shortlist_size: shortlistSize,
      retrieved_count: retrievedCount,
      shortlist_evaluation_count: shortlistEvaluationCount,
      expected_value_evaluation_count: expectedValueEvaluationCount,
      access_tier_rejected_count: accessTierRejectedCount,
      expected_value_rejected_count: expectedValueRejectedCount,
      scope_rejected_count: scopeRejectedCount,
      missing_evidence_rejected_count: missingEvidenceRejectedCount,
      max_bounded_evaluations: subjectCount * shortlistSize,
      all_pairs_evaluation_count: 0,
      expensive_reasoning_count: 0,
    },
  };
}

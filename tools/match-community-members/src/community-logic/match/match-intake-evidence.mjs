// Vendored from bitfield-packages/packages/interaction-program/read-data/match-intake-evidence.mjs, unchanged except for
// import paths and its contract, which is read from match-intake-contract.json.
import contract from "./match-intake-contract.json" with { type: "json" };

// The contract is DATA (match-intake-contract.json): the factors, the primitives, the intake questions and what each
// factor must cite.
export const MATCH_FACTOR_IDS = Object.freeze(contract.factor_ids);

export const MATCH_PRIMITIVE_IDS = Object.freeze(contract.primitive_ids);

export const MATCH_INTAKE_QUESTION_CONTRACT = Object.freeze(contract.questions);

export const MATCH_FACTOR_CITATION_REQUIREMENTS = Object.freeze(contract.factor_citation_requirements);

const QUESTION_BY_ID = new Map(MATCH_INTAKE_QUESTION_CONTRACT.map((question) => [question.question_id, question]));
const KNOWN_CLAIM_KINDS = new Set(MATCH_INTAKE_QUESTION_CONTRACT.flatMap((question) => question.claim_kinds));

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(nonEmptyString).filter(Boolean))];
}

function hasAnswerValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function stringValues(value) {
  if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) return uniqueStrings(value);
  if (value && typeof value === "object") {
    return uniqueStrings([...(value.allowed ?? []), ...(value.selected ?? []), ...(value.values ?? [])]);
  }
  return [];
}

function answerClaims(answer, problems) {
  const questionId = nonEmptyString(answer?.question_id);
  const descriptor = QUESTION_BY_ID.get(questionId);
  if (!descriptor) {
    problems.push({ kind: "unknown_question", question_id: questionId });
    return [];
  }
  const answerFactRef = nonEmptyString(answer?.answer_fact_ref);
  if (!answerFactRef) {
    problems.push({ kind: "missing_answer_fact_ref", question_id: questionId });
    return [];
  }
  if (!hasAnswerValue(answer?.value)) {
    problems.push({ kind: "missing_answer_value", question_id: questionId, answer_fact_ref: answerFactRef });
    return [];
  }
  const evidenceRefs = uniqueStrings([answerFactRef, ...(answer?.evidence_refs ?? [])]);
  return descriptor.claim_kinds.map((claimKind) => ({
    claim_ref: `${answerFactRef}#${claimKind}`,
    claim_kind: claimKind,
    value: answer.value,
    question_id: questionId,
    primitive_ids: [...descriptor.primitive_ids],
    evidence_refs: evidenceRefs,
    provenance: {
      kind: "answer_fact",
      answer_fact_ref: answerFactRef,
    },
  }));
}

function connectedSourceClaims(fact, problems) {
  const factRef = nonEmptyString(fact?.fact_ref);
  const source = fact?.source && typeof fact.source === "object" ? fact.source : {};
  const claimKinds = uniqueStrings(fact?.claim_kinds);
  const suppliedEvidenceRefs = uniqueStrings(fact?.evidence_refs);
  const evidenceRefs = uniqueStrings([factRef, ...suppliedEvidenceRefs]);
  const requiredProvenance = {
    source_kind: nonEmptyString(source.kind),
    connection_ref: nonEmptyString(source.connection_ref),
    access_lease_ref: nonEmptyString(source.access_lease_ref),
    consent_ref: nonEmptyString(source.consent_ref),
    observed_at: nonEmptyString(source.observed_at),
    expires_at: nonEmptyString(source.expires_at),
  };
  const missing = Object.entries(requiredProvenance).filter(([, value]) => !value).map(([key]) => key);
  if (typeof source.revocable !== "boolean") missing.push("revocable");
  if (!factRef || !hasAnswerValue(fact?.value) || suppliedEvidenceRefs.length === 0 || claimKinds.length === 0 || missing.length > 0) {
    problems.push({
      kind: "invalid_connected_source_fact",
      fact_ref: factRef,
      missing,
      requires_value: !hasAnswerValue(fact?.value),
      requires_evidence_refs: suppliedEvidenceRefs.length === 0,
      requires_claim_kinds: claimKinds.length === 0,
    });
    return [];
  }
  const unknownClaimKinds = claimKinds.filter((claimKind) => !KNOWN_CLAIM_KINDS.has(claimKind));
  if (unknownClaimKinds.length > 0) {
    problems.push({ kind: "unknown_connected_claim_kind", fact_ref: factRef, claim_kinds: unknownClaimKinds });
    return [];
  }
  const fieldScope = uniqueStrings(source.field_scope);
  if (fieldScope.length === 0) {
    problems.push({ kind: "missing_connected_field_scope", fact_ref: factRef });
    return [];
  }
  return claimKinds.map((claimKind) => ({
    claim_ref: `${factRef}#${claimKind}`,
    claim_kind: claimKind,
    value: fact.value,
    question_id: null,
    primitive_ids: MATCH_INTAKE_QUESTION_CONTRACT
      .filter((question) => question.claim_kinds.includes(claimKind))
      .flatMap((question) => question.primitive_ids),
    evidence_refs: evidenceRefs,
    provenance: {
      kind: "connected_source_fact",
      fact_ref: factRef,
      ...requiredProvenance,
      field_scope: fieldScope,
      revocable: source.revocable,
    },
  }));
}

function firstClaimValue(claims, claimKind) {
  return claims.find((claim) => claim.claim_kind === claimKind)?.value ?? null;
}

export function buildMatchIntakeProfile(input) {
  const participantRef = nonEmptyString(input?.participant_ref);
  const problems = [];
  if (!participantRef) problems.push({ kind: "missing_participant_ref" });
  const claims = [];
  for (const answer of Array.isArray(input?.answer_facts) ? input.answer_facts : []) {
    claims.push(...answerClaims(answer, problems));
  }
  for (const fact of Array.isArray(input?.connected_source_facts) ? input.connected_source_facts : []) {
    claims.push(...connectedSourceClaims(fact, problems));
  }

  const scope = {
    pursuit_ref: firstClaimValue(claims, "scope.pursuit"),
    system_ref: firstClaimValue(claims, "scope.system"),
    timescale_ref: firstClaimValue(claims, "scope.timescale"),
    state_ref: firstClaimValue(claims, "scope.state"),
  };
  const missingScope = Object.entries(scope).filter(([, value]) => !nonEmptyString(value)).map(([field]) => field);
  if (missingScope.length > 0) problems.push({ kind: "missing_scope", fields: missingScope });

  const primitiveCoverage = Object.fromEntries(MATCH_PRIMITIVE_IDS.map((primitiveId) => {
    const matching = claims.filter((claim) => claim.primitive_ids.includes(primitiveId));
    return [primitiveId, {
      status: matching.length > 0 ? "grounded" : "missing",
      claim_refs: matching.map((claim) => claim.claim_ref),
      evidence_refs: uniqueStrings(matching.flatMap((claim) => claim.evidence_refs)),
    }];
  }));

  const scopeKeyParts = Object.values(scope).map(nonEmptyString);
  return {
    kind: "interaction-program.match-intake-evidence",
    participant_ref: participantRef,
    scope,
    scope_key: scopeKeyParts.every(Boolean) ? scopeKeyParts.join("|") : null,
    claims,
    primitive_coverage: primitiveCoverage,
    authority: {
      desired_interventions: stringValues(firstClaimValue(claims, "authority.desired_intervention")),
      forbidden_interventions: stringValues(firstClaimValue(claims, "authority.forbidden_intervention")),
      assignment_level: firstClaimValue(claims, "authority.assignment"),
      disclosure: firstClaimValue(claims, "authority.disclosure"),
      vetoes: firstClaimValue(claims, "authority.veto"),
      contact: firstClaimValue(claims, "authority.contact"),
    },
    status: problems.length === 0 ? "grounded" : "partial",
    problems,
  };
}

function assessmentByFactor(assessments) {
  if (Array.isArray(assessments)) {
    return new Map(assessments.map((assessment) => [assessment?.factor, assessment]));
  }
  if (assessments && typeof assessments === "object") {
    return new Map(Object.entries(assessments).map(([factor, assessment]) => [factor, { factor, ...assessment }]));
  }
  return new Map();
}

function claimMap(profile) {
  return new Map((Array.isArray(profile?.claims) ? profile.claims : []).map((claim) => [claim.claim_ref, claim]));
}

function forbiddenInterventionBlockers(subjectProfile, candidateProfile, proposedInterventions) {
  const proposed = new Set(uniqueStrings(proposedInterventions));
  const blockers = [];
  for (const [party, profile] of [["subject", subjectProfile], ["candidate", candidateProfile]]) {
    for (const intervention of profile?.authority?.forbidden_interventions ?? []) {
      if (proposed.has(intervention)) blockers.push({ kind: "forbidden_intervention", party, intervention });
    }
  }
  return blockers;
}

export function deriveGroundedFactorEvidence({
  subject_profile: subjectProfile,
  candidate_profile: candidateProfile,
  assessments,
  proposed_interventions: proposedInterventions = [],
} = {}) {
  const subjectClaims = claimMap(subjectProfile);
  const candidateClaims = claimMap(candidateProfile);
  const byFactor = assessmentByFactor(assessments);
  const blockers = forbiddenInterventionBlockers(subjectProfile, candidateProfile, proposedInterventions);
  const factors = {};

  for (const factor of MATCH_FACTOR_IDS) {
    const assessment = byFactor.get(factor);
    const reasons = [];
    const score = assessment?.score;
    const inferenceRef = nonEmptyString(assessment?.inference_ref);
    const rationale = nonEmptyString(assessment?.rationale);
    const subjectClaimRefs = uniqueStrings(assessment?.subject_claim_refs);
    const candidateClaimRefs = uniqueStrings(assessment?.candidate_claim_refs);
    const citedEvidenceRefs = uniqueStrings(assessment?.evidence_refs);
    const resolvedSubjectClaims = subjectClaimRefs.map((ref) => subjectClaims.get(ref)).filter(Boolean);
    const resolvedCandidateClaims = candidateClaimRefs.map((ref) => candidateClaims.get(ref)).filter(Boolean);

    if (!assessment) reasons.push("missing_assessment");
    if (!Number.isFinite(score) || score <= 0 || score > 1) reasons.push("score_must_be_positive_and_at_most_one");
    if (!inferenceRef) reasons.push("missing_inference_provenance");
    if (!rationale) reasons.push("missing_rationale");
    if (resolvedSubjectClaims.length !== subjectClaimRefs.length) reasons.push("unknown_subject_claim_ref");
    if (resolvedCandidateClaims.length !== candidateClaimRefs.length) reasons.push("unknown_candidate_claim_ref");

    const resolvedEvidenceRefs = uniqueStrings([
      ...resolvedSubjectClaims.flatMap((claim) => claim.evidence_refs),
      ...resolvedCandidateClaims.flatMap((claim) => claim.evidence_refs),
    ]);
    if (citedEvidenceRefs.length === 0) reasons.push("missing_evidence_citations");
    if (citedEvidenceRefs.some((ref) => !resolvedEvidenceRefs.includes(ref))) reasons.push("uncited_evidence_ref");

    for (const requirement of MATCH_FACTOR_CITATION_REQUIREMENTS[factor]) {
      const citedClaims = requirement.side === "subject" ? resolvedSubjectClaims : resolvedCandidateClaims;
      if (!requirement.any_of.some((claimKind) => citedClaims.some((claim) => claim.claim_kind === claimKind))) {
        reasons.push(`missing_${requirement.side}_claim:${requirement.any_of.join("|")}`);
      }
    }

    factors[factor] = reasons.length === 0 && blockers.length === 0
      ? {
          status: "grounded",
          score,
          rationale,
          inference_ref: inferenceRef,
          subject_claim_refs: subjectClaimRefs,
          candidate_claim_refs: candidateClaimRefs,
          evidence_refs: resolvedEvidenceRefs,
          cited_evidence_refs: citedEvidenceRefs,
        }
      : {
          status: "missing",
          score: null,
          reasons: uniqueStrings([...reasons, ...blockers.map((blocker) => `${blocker.kind}:${blocker.party}:${blocker.intervention}`)]),
        };
  }

  const grounded = MATCH_FACTOR_IDS.every((factor) => factors[factor].status === "grounded");
  return {
    kind: "interaction-program.match-factor-evidence",
    subject_ref: subjectProfile?.participant_ref ?? null,
    candidate_ref: candidateProfile?.participant_ref ?? null,
    subject_scope_key: subjectProfile?.scope_key ?? null,
    candidate_scope_key: candidateProfile?.scope_key ?? null,
    proposed_interventions: uniqueStrings(proposedInterventions),
    status: grounded ? "grounded" : "no_justified_match",
    factors,
    blockers,
    evidence_refs: grounded
      ? uniqueStrings(MATCH_FACTOR_IDS.flatMap((factor) => factors[factor].evidence_refs))
      : [],
  };
}

export function validateGroundedFactorEvidence(bundle) {
  const reasons = [];
  if (bundle?.status !== "grounded") reasons.push("factor_evidence_not_grounded");
  if (uniqueStrings(bundle?.evidence_refs).length === 0) reasons.push("missing_bundle_evidence");
  const factors = {};
  for (const factor of MATCH_FACTOR_IDS) {
    const entry = bundle?.factors?.[factor];
    if (entry?.status !== "grounded") reasons.push(`missing_factor:${factor}`);
    if (!Number.isFinite(entry?.score) || entry.score <= 0 || entry.score > 1) reasons.push(`invalid_score:${factor}`);
    if (uniqueStrings(entry?.evidence_refs).length === 0) reasons.push(`missing_evidence:${factor}`);
    if (!nonEmptyString(entry?.inference_ref)) reasons.push(`missing_inference_provenance:${factor}`);
    factors[factor] = Number.isFinite(entry?.score) ? entry.score : null;
  }
  return {
    justified: reasons.length === 0,
    reasons,
    factors,
    evidence_refs: reasons.length === 0 ? uniqueStrings(bundle?.evidence_refs) : [],
  };
}

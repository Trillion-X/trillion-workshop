// tools/form-groups-and-matches/read-data/match-evidence.mjs
//
// The evidence a match may rest on. A person's saved answers (and facts from sources they connected, each with its
// consent, lease, field scope, observation time, expiry and whether it can be revoked) become claims; an assessment of
// a match is usable only when every factor it scores cites the claims and evidence its contract requires. Nothing here
// asks a question, scores a factor or calls a model: answers and assessments arrive from their owners and are checked.
//
// Which questions exist, what claims each answer makes, which factors a match is scored on, what each factor must cite,
// which scope fields a profile needs and which answers say what a person forbids are all the contract's, given at run
// time:
//
//   contract = {
//     factors: ["<factor>"],                         the expected value is the product of these scores
//     primitives: ["<primitive>"],                   what a profile's coverage is counted against
//     scope_fields: ["<field>"],                     the scope every profile and match must name
//     questions: [{ question_id, claim_kinds: [..], primitive_ids: [..], scope_field? }],
//     citation_requirements: { "<factor>": [{ side: "subject" | "candidate", any_of: ["<claim kind>"] }] },
//     authority: [{ name, claim_kind, list? }],      what the profile's authority block holds, by claim kind
//     forbidden_interventions: "<authority name>"     the authority entry whose values block a proposed intervention
//   }

const nonEmptyString = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);
const uniqueStrings = values => [...new Set((Array.isArray(values) ? values : []).map(nonEmptyString).filter(Boolean))];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringList = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0)
  && new Set(value).size === value.length;

/** The contract, checked once: every part present and every name it uses declared. Refuses with what is wrong. */
export function readContract(contract) {
  const wrong = [];
  if (!object(contract)) throw new Error('contract must be { factors, primitives, scope_fields, questions, citation_requirements, authority, forbidden_interventions }.');
  for (const field of ['factors', 'primitives', 'scope_fields']) if (!stringList(contract[field])) wrong.push(`${field} must be a list of distinct names`);
  const questions = Array.isArray(contract.questions) ? contract.questions : [];
  if (questions.length === 0) wrong.push('questions must list at least one question');
  for (const question of questions) {
    if (!object(question) || !nonEmptyString(question.question_id) || !stringList(question.claim_kinds) || !Array.isArray(question.primitive_ids)) {
      wrong.push(`question ${JSON.stringify(question?.question_id ?? null)} needs question_id, claim_kinds and primitive_ids`);
    } else if (question.primitive_ids.some(id => !contract.primitives?.includes?.(id))) {
      wrong.push(`question ${question.question_id} names a primitive the contract does not list`);
    }
  }
  const requirements = object(contract.citation_requirements) ? contract.citation_requirements : {};
  for (const factor of Array.isArray(contract.factors) ? contract.factors : []) {
    const rows = Object.hasOwn(requirements, factor) ? requirements[factor] : null;
    if (!Array.isArray(rows) || !rows.every(row => object(row) && (row.side === 'subject' || row.side === 'candidate') && stringList(row.any_of))) {
      wrong.push(`citation_requirements.${factor} must be a list of { side: subject | candidate, any_of: [claim kinds] }`);
    }
  }
  const authority = Array.isArray(contract.authority) ? contract.authority : [];
  if (!authority.every(entry => object(entry) && nonEmptyString(entry.name) && nonEmptyString(entry.claim_kind))) wrong.push('authority must be a list of { name, claim_kind, list? }');
  if (!authority.some(entry => entry?.name === contract.forbidden_interventions)) wrong.push('forbidden_interventions must name an authority entry');
  if (wrong.length) throw new Error(`The contract is not usable: ${wrong.join('; ')}.`);
  return contract;
}

function hasAnswerValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function stringValues(value) {
  if (typeof value === 'string') return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) return uniqueStrings(value);
  if (object(value)) return uniqueStrings([...(value.allowed ?? []), ...(value.selected ?? []), ...(value.values ?? [])]);
  return [];
}

function answerClaims(answer, questionById, problems) {
  const questionId = nonEmptyString(answer?.question_id);
  const question = questionId ? questionById.get(questionId) : undefined;
  if (!question) {
    problems.push({ kind: 'unknown_question', question_id: questionId });
    return [];
  }
  const answerFactRef = nonEmptyString(answer?.answer_fact_ref);
  if (!answerFactRef) {
    problems.push({ kind: 'missing_answer_fact_ref', question_id: questionId });
    return [];
  }
  if (!hasAnswerValue(answer?.value)) {
    problems.push({ kind: 'missing_answer_value', question_id: questionId, answer_fact_ref: answerFactRef });
    return [];
  }
  const evidenceRefs = uniqueStrings([answerFactRef, ...(answer?.evidence_refs ?? [])]);
  return question.claim_kinds.map(claimKind => ({
    claim_ref: `${answerFactRef}#${claimKind}`,
    claim_kind: claimKind,
    value: answer.value,
    question_id: questionId,
    primitive_ids: [...question.primitive_ids],
    evidence_refs: evidenceRefs,
    provenance: { kind: 'answer_fact', answer_fact_ref: answerFactRef },
  }));
}

function connectedSourceClaims(fact, contract, knownClaimKinds, problems) {
  const factRef = nonEmptyString(fact?.fact_ref);
  const source = object(fact?.source) ? fact.source : {};
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
  if (typeof source.revocable !== 'boolean') missing.push('revocable');
  if (!factRef || !hasAnswerValue(fact?.value) || suppliedEvidenceRefs.length === 0 || claimKinds.length === 0 || missing.length > 0) {
    problems.push({
      kind: 'invalid_connected_source_fact', fact_ref: factRef, missing,
      requires_value: !hasAnswerValue(fact?.value), requires_evidence_refs: suppliedEvidenceRefs.length === 0, requires_claim_kinds: claimKinds.length === 0,
    });
    return [];
  }
  const unknownClaimKinds = claimKinds.filter(claimKind => !knownClaimKinds.has(claimKind));
  if (unknownClaimKinds.length > 0) {
    problems.push({ kind: 'unknown_connected_claim_kind', fact_ref: factRef, claim_kinds: unknownClaimKinds });
    return [];
  }
  const fieldScope = uniqueStrings(source.field_scope);
  if (fieldScope.length === 0) {
    problems.push({ kind: 'missing_connected_field_scope', fact_ref: factRef });
    return [];
  }
  return claimKinds.map(claimKind => ({
    claim_ref: `${factRef}#${claimKind}`,
    claim_kind: claimKind,
    value: fact.value,
    question_id: null,
    primitive_ids: contract.questions.filter(question => question.claim_kinds.includes(claimKind)).flatMap(question => question.primitive_ids),
    evidence_refs: evidenceRefs,
    provenance: { kind: 'connected_source_fact', fact_ref: factRef, ...requiredProvenance, field_scope: fieldScope, revocable: source.revocable },
  }));
}

const firstClaimValue = (claims, claimKind) => claims.find(claim => claim.claim_kind === claimKind)?.value ?? null;

/** One person's scoped profile: claims from answers and connected facts, coverage per primitive, authority, problems. */
export function buildMatchProfile(input, contract) {
  readContract(contract);
  const questionById = new Map(contract.questions.map(question => [question.question_id, question]));
  const knownClaimKinds = new Set(contract.questions.flatMap(question => question.claim_kinds));
  const participantRef = nonEmptyString(input?.participant_ref);
  const problems = [];
  if (!participantRef) problems.push({ kind: 'missing_participant_ref' });
  const claims = [];
  for (const answer of Array.isArray(input?.answer_facts) ? input.answer_facts : []) claims.push(...answerClaims(answer, questionById, problems));
  for (const fact of Array.isArray(input?.connected_source_facts) ? input.connected_source_facts : []) {
    claims.push(...connectedSourceClaims(fact, contract, knownClaimKinds, problems));
  }

  const scope = Object.fromEntries(contract.scope_fields.map(field => {
    const question = contract.questions.find(entry => entry.scope_field === field);
    return [field, question ? firstClaimValue(claims, question.claim_kinds[0]) : null];
  }));
  const missingScope = Object.entries(scope).filter(([, value]) => !nonEmptyString(value)).map(([field]) => field);
  if (missingScope.length > 0) problems.push({ kind: 'missing_scope', fields: missingScope });

  const primitiveCoverage = Object.fromEntries(contract.primitives.map(primitiveId => {
    const matching = claims.filter(claim => claim.primitive_ids.includes(primitiveId));
    return [primitiveId, {
      status: matching.length > 0 ? 'grounded' : 'missing',
      claim_refs: matching.map(claim => claim.claim_ref),
      evidence_refs: uniqueStrings(matching.flatMap(claim => claim.evidence_refs)),
    }];
  }));
  const scopeKeyParts = Object.values(scope).map(nonEmptyString);
  return {
    kind: 'match-profile',
    participant_ref: participantRef,
    scope,
    scope_key: scopeKeyParts.every(Boolean) ? scopeKeyParts.join('|') : null,
    claims,
    primitive_coverage: primitiveCoverage,
    authority: Object.fromEntries(contract.authority.map(entry => {
      const value = firstClaimValue(claims, entry.claim_kind);
      return [entry.name, entry.list ? stringValues(value) : value];
    })),
    status: problems.length === 0 ? 'grounded' : 'partial',
    problems,
  };
}

function assessmentByFactor(assessments) {
  if (Array.isArray(assessments)) return new Map(assessments.map(assessment => [assessment?.factor, assessment]));
  if (object(assessments)) return new Map(Object.entries(assessments).map(([factor, assessment]) => [factor, { factor, ...assessment }]));
  return new Map();
}

const claimMap = profile => new Map((Array.isArray(profile?.claims) ? profile.claims : []).map(claim => [claim.claim_ref, claim]));

function forbiddenInterventionBlockers(subjectProfile, candidateProfile, proposedInterventions, authorityName) {
  const proposed = new Set(uniqueStrings(proposedInterventions));
  const blockers = [];
  for (const [party, profile] of [['subject', subjectProfile], ['candidate', candidateProfile]]) {
    for (const intervention of stringValues(profile?.authority?.[authorityName])) {
      if (proposed.has(intervention)) blockers.push({ kind: 'forbidden_intervention', party, intervention });
    }
  }
  return blockers;
}

/** An assessment checked against both profiles: every factor grounded and cited, or the match is not justified. */
export function deriveGroundedFactorEvidence({ subject_profile: subjectProfile, candidate_profile: candidateProfile, assessments, proposed_interventions: proposedInterventions = [] } = {}, contract) {
  readContract(contract);
  const subjectClaims = claimMap(subjectProfile);
  const candidateClaims = claimMap(candidateProfile);
  const byFactor = assessmentByFactor(assessments);
  const blockers = forbiddenInterventionBlockers(subjectProfile, candidateProfile, proposedInterventions, contract.forbidden_interventions);
  const factors = {};
  for (const factor of contract.factors) {
    const assessment = byFactor.get(factor);
    const reasons = [];
    const score = assessment?.score;
    const inferenceRef = nonEmptyString(assessment?.inference_ref);
    const rationale = nonEmptyString(assessment?.rationale);
    const subjectClaimRefs = uniqueStrings(assessment?.subject_claim_refs);
    const candidateClaimRefs = uniqueStrings(assessment?.candidate_claim_refs);
    const citedEvidenceRefs = uniqueStrings(assessment?.evidence_refs);
    const resolvedSubjectClaims = subjectClaimRefs.map(ref => subjectClaims.get(ref)).filter(Boolean);
    const resolvedCandidateClaims = candidateClaimRefs.map(ref => candidateClaims.get(ref)).filter(Boolean);
    if (!assessment) reasons.push('missing_assessment');
    if (!Number.isFinite(score) || score <= 0 || score > 1) reasons.push('score_must_be_positive_and_at_most_one');
    if (!inferenceRef) reasons.push('missing_inference_provenance');
    if (!rationale) reasons.push('missing_rationale');
    if (resolvedSubjectClaims.length !== subjectClaimRefs.length) reasons.push('unknown_subject_claim_ref');
    if (resolvedCandidateClaims.length !== candidateClaimRefs.length) reasons.push('unknown_candidate_claim_ref');
    const resolvedEvidenceRefs = uniqueStrings([
      ...resolvedSubjectClaims.flatMap(claim => claim.evidence_refs),
      ...resolvedCandidateClaims.flatMap(claim => claim.evidence_refs),
    ]);
    if (citedEvidenceRefs.length === 0) reasons.push('missing_evidence_citations');
    if (citedEvidenceRefs.some(ref => !resolvedEvidenceRefs.includes(ref))) reasons.push('uncited_evidence_ref');
    for (const requirement of contract.citation_requirements[factor]) {
      const citedClaims = requirement.side === 'subject' ? resolvedSubjectClaims : resolvedCandidateClaims;
      if (!requirement.any_of.some(claimKind => citedClaims.some(claim => claim.claim_kind === claimKind))) {
        reasons.push(`missing_${requirement.side}_claim:${requirement.any_of.join('|')}`);
      }
    }
    factors[factor] = reasons.length === 0 && blockers.length === 0
      ? {
        status: 'grounded', score, rationale, inference_ref: inferenceRef, subject_claim_refs: subjectClaimRefs,
        candidate_claim_refs: candidateClaimRefs, evidence_refs: resolvedEvidenceRefs, cited_evidence_refs: citedEvidenceRefs,
      }
      : { status: 'missing', score: null, reasons: uniqueStrings([...reasons, ...blockers.map(blocker => `${blocker.kind}:${blocker.party}:${blocker.intervention}`)]) };
  }
  const grounded = contract.factors.every(factor => factors[factor].status === 'grounded');
  return {
    kind: 'match-factor-evidence',
    subject_ref: subjectProfile?.participant_ref ?? null,
    candidate_ref: candidateProfile?.participant_ref ?? null,
    subject_scope_key: subjectProfile?.scope_key ?? null,
    candidate_scope_key: candidateProfile?.scope_key ?? null,
    proposed_interventions: uniqueStrings(proposedInterventions),
    status: grounded ? 'grounded' : 'no_justified_match',
    factors,
    blockers,
    evidence_refs: grounded ? uniqueStrings(contract.factors.flatMap(factor => factors[factor].evidence_refs)) : [],
  };
}

/** A factor bundle is usable only when it is grounded, every factor has a score in (0, 1], evidence and an inference. */
export function validateGroundedFactorEvidence(bundle, factorIds) {
  const reasons = [];
  if (bundle?.status !== 'grounded') reasons.push('factor_evidence_not_grounded');
  if (uniqueStrings(bundle?.evidence_refs).length === 0) reasons.push('missing_bundle_evidence');
  const factors = {};
  for (const factor of factorIds) {
    const entry = object(bundle?.factors) && Object.hasOwn(bundle.factors, factor) ? bundle.factors[factor] : undefined;
    if (entry?.status !== 'grounded') reasons.push(`missing_factor:${factor}`);
    if (!Number.isFinite(entry?.score) || entry.score <= 0 || entry.score > 1) reasons.push(`invalid_score:${factor}`);
    if (uniqueStrings(entry?.evidence_refs).length === 0) reasons.push(`missing_evidence:${factor}`);
    if (!nonEmptyString(entry?.inference_ref)) reasons.push(`missing_inference_provenance:${factor}`);
    factors[factor] = Number.isFinite(entry?.score) ? entry.score : null;
  }
  return { justified: reasons.length === 0, reasons, factors, evidence_refs: reasons.length === 0 ? uniqueStrings(bundle?.evidence_refs) : [] };
}

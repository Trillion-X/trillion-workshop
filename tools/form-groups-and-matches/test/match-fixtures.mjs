// A made-up program for the matching tests: a bakers' circle whose matches are scored on three factors and kept within
// a goal and a horizon. None of these names is in the code; the tests that use other names prove it.
export const FACTORS = Object.freeze(['fit', 'timing', 'capacity']);
export const SCOPE_FIELDS = Object.freeze(['goal_ref', 'horizon_ref']);
export const POLICY = Object.freeze({ factors: FACTORS, scope_fields: SCOPE_FIELDS });
export const SCOPE = Object.freeze({ goal_ref: 'goal:bake-bread', horizon_ref: 'horizon:this-month' });
export const OTHER_SCOPE = Object.freeze({ goal_ref: 'goal:open-a-stall', horizon_ref: 'horizon:this-month' });
export const scopeKeyOf = scope => SCOPE_FIELDS.map(field => `${field}:${scope[field]}`).join('|');

/** The first factor carries the value, the others are 1, so the product is the value. */
export const factorScores = (value, factors = FACTORS) => Object.fromEntries(factors.map((factor, index) => [factor, index === 0 ? value : 1]));

export function factorEvidence(value, factors = FACTORS, ref = 'evidence:fixture') {
  return {
    status: 'grounded',
    evidence_refs: [ref],
    factors: Object.fromEntries(Object.entries(factorScores(value, factors)).map(([factor, score]) => [factor, {
      status: 'grounded', score, evidence_refs: [ref], inference_ref: `inference:fixture:${factor}`,
    }])),
  };
}

export function candidate(subject, participant, value, extra = {}) {
  return {
    subject,
    participant,
    expected_value: value,
    factors: factorScores(value),
    factor_evidence: factorEvidence(value),
    evidence_refs: ['evidence:fixture'],
    justification_status: 'grounded',
    scope: SCOPE,
    scope_key: scopeKeyOf(SCOPE),
    why: `${participant} brings what is missing`,
    ...extra,
  };
}

/** A shortlist row as a search returns it, with a candidate's own factor evidence. */
export const shortlisted = (participant, value, extra = {}) => ({
  resource_ref: participant, retrieval_score: 0.5, factor_evidence: factorEvidence(value), scope: SCOPE, ...extra,
});

export const GROUPING = {
  modes: [
    { type: '1:1', min_size: 2, max_size: 2 },
    { type: 'small_group', min_size: 3, max_size: 5 },
    { type: 'session', min_size: 6, max_size: 100 },
  ],
};

export function approvedIntroduction(parties) {
  return {
    initiative: { required_level: 'introduce', pre_authorized_levels: ['prepare', 'introduce'] },
    consent_policy: { approved_values: ['approved'], veto_values: ['veto'] },
    consents: Object.fromEntries(parties.map(party => [party, 'approved'])),
    introduction: { agenda: 'Bake one loaf together and compare notes.', next_step: 'Pick a morning and who brings the starter.' },
  };
}

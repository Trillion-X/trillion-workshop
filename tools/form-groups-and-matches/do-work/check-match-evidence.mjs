// tools/form-groups-and-matches/do-work/check-match-evidence.mjs
//
// tool:check-match-evidence. Two operations under one contract (read-data/match-evidence.mjs):
//
//   { operation: "build-profile", contract, participant_ref, answer_facts: [...], connected_source_facts?: [...] }
//   { operation: "check-assessment", contract, subject_profile, candidate_profile, assessments, proposed_interventions? }
//
// The second answers a factor bundle whose status is "grounded" only when every factor is cited as the contract asks;
// that bundle is what a candidate's factor_evidence must be for tool:form-matches to give it a value.
import { buildMatchProfile, deriveGroundedFactorEvidence } from '../read-data/match-evidence.mjs';

export function checkMatchEvidence(input) {
  if (input?.operation === 'build-profile') return buildMatchProfile(input, input.contract);
  if (input?.operation === 'check-assessment') return deriveGroundedFactorEvidence(input, input.contract);
  throw new Error('operation must be build-profile or check-assessment.');
}

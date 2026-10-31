// tools/form-groups-and-matches/do-work/form-matches.mjs
//
// tool:form-matches. One matching cycle of a program (a club, a cohort, a mentoring circle: the program is only its
// data): search shortlists or scored candidates in, groups out, each with its prepared introduction and, for the
// groups whose introduction may be sent, the connection to record. Nothing is sent and nothing is written here; the
// connections are the answer for the caller to keep (tools/relationship-graph) and the introductions for the caller
// to send once their gate is ready.
//
//   { program_id, cycle, relationship_kind,
//     expected_value: { factors, scope_fields, ... },        read-data/expected-value.mjs
//     retrieval_results: [{ subject, shortlist: [candidate] }] with retrieval: { shortlist_size }  | candidates: [scored],
//     pairing, eligibility?, initiative, consents, consent_policy, introduction?, subject_context?, participant_roles?,
//     already_matched? | prior_items? }
import { buildCandidates, readPolicy } from '../read-data/expected-value.mjs';
import { pairKey, priorPairKeys, selectGroups } from '../read-data/select-groups.mjs';

const text = value => typeof value === 'string' && value.length > 0;

// Consents as { party: value }, or as the records that hold them: [{ party, value }].
function consentsOf(raw) {
  if (!Array.isArray(raw)) return raw !== null && typeof raw === 'object' ? raw : {};
  const consents = {};
  for (const entry of raw) if (text(entry?.party) && typeof entry.value === 'string') consents[entry.party] = entry.value;
  return consents;
}

export function formMatches(input) {
  for (const field of ['program_id', 'cycle', 'relationship_kind']) {
    if (!text(input?.[field])) throw new Error(`${field} must be text: program_id and cycle name the connections, relationship_kind is the kind of connection they are.`);
  }
  const policy = readPolicy(input.expected_value);
  const built = Array.isArray(input.candidates)
    ? { candidates: input.candidates, rejections: [], instrumentation: {} }
    : buildCandidates(input.retrieval_results, { shortlist_size: input.retrieval?.shortlist_size, eligibility: input.eligibility, expected_value: policy });
  const selected = selectGroups({
    ...input,
    consents: consentsOf(input.consents),
    already_matched: Array.isArray(input.already_matched) ? input.already_matched : priorPairKeys(input.prior_items, policy),
    candidates: built.candidates,
  });
  const sendable = selected.groups.filter(group => group.introduction.send_authorized);
  return {
    program_id: input.program_id,
    cycle: input.cycle,
    connections: sendable.map(group => ({
      id: `${input.program_id}:${input.cycle}:${group.members.join('-')}`,
      source: group.members[0],
      target: group.members[1] ?? group.members[0],
      members: group.members,
      relation: input.relationship_kind,
      attributes: {
        program_id: input.program_id,
        cycle: input.cycle,
        grouping: group.grouping,
        expected_value: group.expected_value,
        expected_value_factors: group.expected_value_factors,
        scope: group.scope,
        scope_key: group.scope_key,
        match_provenance: group.provenance,
        prepared_introduction_id: group.introduction.id,
        introduction_send_status: group.introduction.send_gate.status,
      },
    })),
    groups: selected.groups,
    introductions: selected.introductions,
    ready_introductions: selected.ready_introductions,
    blocked_introductions: selected.blocked_introductions,
    reasoning_requests: selected.groups.map(group => group.reasoning_request),
    configuration_requests: selected.groups.flatMap(group => group.configuration_requests),
    pair_keys: sendable.filter(group => group.members.length === 2).map(group => pairKey(group.members[0], group.members[1])),
    unmatched: selected.unmatched,
    unmatched_details: [...built.rejections, ...selected.unmatched_details],
    instrumentation: { retrieval: built.instrumentation, selection: selected.instrumentation },
  };
}

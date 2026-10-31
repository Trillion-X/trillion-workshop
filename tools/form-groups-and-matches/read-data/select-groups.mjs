// tools/form-groups-and-matches/read-data/select-groups.mjs
//
// Form groups from scored candidates. For each subject (within one scope) the candidates are ordered by expected value,
// then by search score, then by id, and the best ones fill the group when the cut between kept and left out is clear.
// Everything about the shape of a group is the program's pairing data:
//
//   pairing = {
//     group_size?: 2..n,              how many in a group (2 when not given: a pair)
//     minimum_group_size?: n,         a smaller group is not formed
//     include_subject?: boolean,      the subject is in its own group (true when not given)
//     roles?: { bipartite: [a, b] },  only an a with a b (mentor with mentee, buyer with seller, ...)
//     exclusion?: "none",             "none" lets people meet again; otherwise pairs met in this scope are skipped
//     allow_unscoped_exclusions?: boolean,   also skip pairs met in any scope
//     exclusive_participation?: boolean,     a person joins at most one group this cycle
//     grouping?: { modes: [{ type, min_size?, max_size? }] }   names a group by its size
//   }
//
// Each group carries a prepared introduction that may be sent only when the initiative it needs is pre-authorized and
// every party (members and anyone a candidate names) has approved and none has vetoed; consent values are the
// program's words (consent_policy.approved_values / veto_values). A group also carries a request for the slow review
// of the few already chosen, never of the whole pool.
import { expectedValueAdmission, readPolicy, scopeKey, selectionBoundary } from './expected-value.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A pair's key, the same whichever way round, and safe for ids that hold any characters. */
export function pairKey(a, b) {
  return JSON.stringify([String(a), String(b)].sort());
}

export function scopedPairKey(scope, a, b, policy) {
  const key = typeof scope === 'string' ? scope : scopeKey(scope, policy);
  return key ? `${key}::${pairKey(a, b)}` : null;
}

/** The pairs already met, from earlier groups or connections that name their members and scope. */
export function priorPairKeys(items, policy) {
  const keys = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const value = item?.payload ?? item;
    const members = value?.members ?? value?.member_ids ?? value?.member_names;
    if (!Array.isArray(members)) continue;
    const scope = value?.scope ?? value?.attributes?.scope ?? value;
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const key = scopedPairKey(scope, members[left], members[right], policy);
        if (key) keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

const groupSizeOf = pairing => (Number.isInteger(pairing?.group_size) && pairing.group_size >= 2 ? pairing.group_size : 2);
const minimumSizeOf = (pairing, groupSize) => (Number.isInteger(pairing?.minimum_group_size) && pairing.minimum_group_size >= 2
  ? Math.min(pairing.minimum_group_size, groupSize) : groupSize);

function groupingType(grouping, memberCount) {
  const modes = Array.isArray(grouping?.modes) ? grouping.modes : [];
  const match = modes.find(mode => {
    const min = Number.isInteger(mode?.min_size) ? mode.min_size : 0;
    const max = Number.isInteger(mode?.max_size) ? mode.max_size : Number.POSITIVE_INFINITY;
    return typeof mode?.type === 'string' && memberCount >= min && memberCount <= max;
  });
  return match?.type ?? null;
}

function meanFactors(selected, policy) {
  return Object.fromEntries(policy.factors.map(factor => [
    factor, selected.length > 0 ? selected.reduce((sum, candidate) => sum + candidate.factors[factor], 0) / selected.length : 0,
  ]));
}

function introductionGate(parties, initiative, consents, consentPolicy) {
  const requiredLevel = typeof initiative?.required_level === 'string' ? initiative.required_level : null;
  const authorizedLevels = new Set(Array.isArray(initiative?.pre_authorized_levels) ? initiative.pre_authorized_levels.filter(level => typeof level === 'string') : []);
  const approvedValues = new Set(Array.isArray(consentPolicy?.approved_values) ? consentPolicy.approved_values : []);
  const vetoValues = new Set(Array.isArray(consentPolicy?.veto_values) ? consentPolicy.veto_values : []);
  // Only a party's own answer counts: an inherited object property is never consent.
  const consentValue = party => (object(consents) && Object.hasOwn(consents, party) ? consents[party] : undefined);
  const blockers = [];
  if (!requiredLevel || !authorizedLevels.has(requiredLevel)) blockers.push({ kind: 'insufficient_initiative', required_level: requiredLevel });
  for (const party of parties) {
    const value = consentValue(party);
    if (vetoValues.has(value)) blockers.push({ kind: 'veto', party, value });
    else if (!approvedValues.has(value)) blockers.push({ kind: 'missing_consent', party, value: value ?? null });
  }
  return {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    required_initiative_level: requiredLevel,
    pre_authorized_levels: [...authorizedLevels],
    initiative_authorized: Boolean(requiredLevel) && authorizedLevels.has(requiredLevel),
    every_party_approved: parties.every(party => approvedValues.has(consentValue(party))),
    party_gate: parties.map(party => {
      const value = consentValue(party) ?? null;
      return { party, consent_value: value, approved: approvedValues.has(value), vetoed: vetoValues.has(value) };
    }),
    blockers,
  };
}

function prepareIntroduction(group, selected, req) {
  const introduction = object(req?.introduction) ? req.introduction : {};
  const subjectContext = object(req?.subject_context) && Object.hasOwn(req.subject_context, group.subject) ? req.subject_context[group.subject] : {};
  const candidateReasons = new Map(selected.map(candidate => [candidate.participant, candidate.why]));
  const whyByPerson = object(introduction.why_by_person) ? introduction.why_by_person : {};
  const whyEachPerson = group.members.map(party => ({
    party,
    why: Object.hasOwn(whyByPerson, party) && typeof whyByPerson[party] === 'string'
      ? whyByPerson[party]
      : (candidateReasons.get(party) ?? (party === group.subject ? subjectContext?.why ?? null : null)),
  }));
  const consentParties = [...new Set([...group.members, ...selected.flatMap(candidate => candidate.consent_party_refs ?? [])])].sort();
  const sendGate = introductionGate(consentParties, req?.initiative, req?.consents, req?.consent_policy);
  return {
    kind: 'prepared-multi-party-introduction',
    id: `${group.subject}:${group.members.join('-')}`,
    grouping: group.grouping,
    subject: group.subject,
    parties: group.members,
    consent_parties: consentParties,
    agenda: typeof introduction.agenda === 'string' ? introduction.agenda : null,
    why_each_person: whyEachPerson,
    next_step: typeof introduction.next_step === 'string' ? introduction.next_step : null,
    send_gate: sendGate,
    send_authorized: sendGate.status === 'ready',
  };
}

function allowedByRoles(candidate, subject, roles, participantRoles) {
  if (!roles) return true;
  const subjectRole = participantRoles[subject];
  const candidateRole = candidate.role ?? participantRoles[candidate.participant];
  const [leftRole, rightRole] = roles.bipartite;
  return (subjectRole === leftRole && candidateRole === rightRole) || (subjectRole === rightRole && candidateRole === leftRole);
}

/** Candidates and pairing in, groups with their introductions out, plus who was left out and why. */
export function selectGroups(req) {
  const policy = readPolicy(req?.expected_value);
  const candidates = Array.isArray(req?.candidates) ? req.candidates : [];
  const pairing = object(req?.pairing) ? req.pairing : {};
  const groupSize = groupSizeOf(pairing);
  const minimumGroupSize = minimumSizeOf(pairing, groupSize);
  const includeSubject = pairing.include_subject !== false;
  const selectedPerSubject = includeSubject ? groupSize - 1 : groupSize;
  const roles = Array.isArray(pairing?.roles?.bipartite) && pairing.roles.bipartite.length === 2 ? pairing.roles : null;
  const participantRoles = object(req?.participant_roles) ? req.participant_roles : {};
  const alreadyMatched = new Set(pairing.exclusion === 'none' ? [] : (req?.already_matched ?? []));
  const exclusiveParticipation = pairing.exclusive_participation === true;
  const bySubject = new Map();
  const allParticipants = new Set();
  const rejectedCandidates = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate.subject !== 'string' || typeof candidate.participant !== 'string') continue;
    const admission = expectedValueAdmission(candidate, policy);
    if (!admission.admitted) {
      rejectedCandidates.push({ subject: candidate.subject, participant: candidate.participant, scope_key: scopeKey(candidate, policy), reason: admission.reason });
      continue;
    }
    if (candidate.subject === candidate.participant) continue;
    if (!allowedByRoles(candidate, candidate.subject, roles, participantRoles)) continue;
    const subjectKey = `${scopeKey(candidate, policy)}::${candidate.subject}`;
    if (!bySubject.has(subjectKey)) bySubject.set(subjectKey, []);
    bySubject.get(subjectKey).push(candidate);
    allParticipants.add(candidate.subject);
    allParticipants.add(candidate.participant);
  }

  for (const [subjectKey, shortlist] of bySubject) {
    shortlist.sort((left, right) => {
      if (left.expected_value !== right.expected_value) return right.expected_value - left.expected_value;
      const retrievalDelta = (right.retrieval_score ?? -Infinity) - (left.retrieval_score ?? -Infinity);
      if (retrievalDelta !== 0) return retrievalDelta;
      return left.participant.localeCompare(right.participant);
    });
    const seen = new Set();
    bySubject.set(subjectKey, shortlist.filter(candidate => !seen.has(candidate.participant) && seen.add(candidate.participant)));
  }

  const subjects = [...bySubject.keys()].sort((left, right) => {
    const delta = bySubject.get(right)[0].expected_value - bySubject.get(left)[0].expected_value;
    return delta !== 0 ? delta : left.localeCompare(right);
  });
  const used = new Set();
  const placed = new Set();
  const groups = [];
  const introductions = [];
  const subjectBlockers = [];
  let selectedCandidateCount = 0;

  for (const subjectKey of subjects) {
    const shortlist = bySubject.get(subjectKey);
    const subject = shortlist[0].subject;
    const key = shortlist[0].scope_key ?? scopeKey(shortlist[0], policy);
    if (includeSubject && exclusiveParticipation && used.has(subject)) continue;
    const available = shortlist.filter(candidate => {
      if (exclusiveParticipation && used.has(candidate.participant)) return false;
      if (!includeSubject) return true;
      const scoped = scopedPairKey(key, subject, candidate.participant, policy);
      if (scoped && alreadyMatched.has(scoped)) return false;
      return pairing.allow_unscoped_exclusions === true ? !alreadyMatched.has(pairKey(subject, candidate.participant)) : true;
    });
    const boundary = selectionBoundary(available.map(candidate => candidate.expected_value), selectedPerSubject, policy);
    if (!boundary.distinguishable) {
      subjectBlockers.push({ subject, scope_key: key, reason: boundary.reason });
      continue;
    }
    const selected = available.slice(0, selectedPerSubject);
    const members = includeSubject ? [subject, ...selected.map(candidate => candidate.participant)] : selected.map(candidate => candidate.participant);
    if (members.length < minimumGroupSize) continue;
    if (exclusiveParticipation) {
      if (includeSubject) used.add(subject);
      for (const candidate of selected) used.add(candidate.participant);
    }
    for (const member of members) placed.add(member);
    selectedCandidateCount += selected.length;
    const weakest = selected.reduce((minimum, candidate) => Math.min(minimum, candidate.expected_value), Number.POSITIVE_INFINITY);
    const group = {
      subject,
      scope: selected[0]?.scope ?? null,
      scope_key: key,
      members: [...members].sort(),
      grouping: groupingType(pairing.grouping, members.length),
      expected_value: weakest,
      score: weakest,
      expected_value_aggregation: 'minimum_selected_candidate',
      expected_value_factors: meanFactors(selected, policy),
      expected_value_factor_aggregation: 'mean_selected_candidate',
      provenance: 'per-candidate expected-value products; group aggregate is the minimum selected candidate',
      selected_shortlist: selected.map(candidate => ({
        participant: candidate.participant,
        resource_ref: candidate.resource_ref ?? candidate.participant,
        resource_kind: candidate.resource_kind ?? null,
        action_ref: candidate.action_ref ?? null,
        configuration_ref: candidate.configuration_ref ?? null,
        configuration: candidate.configuration ?? null,
        expected_value: candidate.expected_value,
        factors: candidate.factors,
        evidence_refs: candidate.evidence_refs,
      })),
      configuration_requests: selected
        .filter(candidate => candidate.action_ref || candidate.configuration_ref || candidate.configuration != null)
        .map(candidate => ({
          resource_ref: candidate.resource_ref ?? candidate.participant,
          action_ref: candidate.action_ref ?? null,
          configuration_ref: candidate.configuration_ref ?? null,
          configuration: candidate.configuration ?? null,
        })),
      reasoning_request: { stage: 'after_shortlist', subject, scope: selected[0]?.scope ?? null, parties: [...members].sort() },
    };
    group.introduction = prepareIntroduction(group, selected, req);
    groups.push(group);
    introductions.push(group.introduction);
  }

  const order = entry => `${entry.scope_key ?? ''}|${entry.subject ?? ''}|${entry.participant ?? ''}|${entry.reason}`;
  return {
    groups,
    introductions,
    ready_introductions: introductions.filter(record => record.send_authorized),
    blocked_introductions: introductions.filter(record => !record.send_authorized),
    unmatched: [...allParticipants].filter(participant => !placed.has(participant)).sort(),
    unmatched_details: [...rejectedCandidates, ...subjectBlockers].sort((left, right) => order(left).localeCompare(order(right))),
    instrumentation: {
      subject_count: bySubject.size,
      candidate_count: candidates.length,
      selected_candidate_count: selectedCandidateCount,
      group_count: groups.length,
      all_pairs_evaluation_count: 0,
      expensive_reasoning_requests: groups.length,
      expensive_reasoning_stage: 'after_shortlist',
      rejected_candidate_count: rejectedCandidates.length,
      indistinguishable_subject_count: subjectBlockers.filter(entry => entry.reason === 'indistinguishable_expected_value').length,
      exclusive_participation: exclusiveParticipation,
    },
  };
}

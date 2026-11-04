// Vendored unchanged except for import paths from bitfield-packages/packages/interaction-program/read-data/select-pairs.mjs.
import {
  EXPECTED_VALUE_FACTORS,
  expectedValueAdmission,
  needleMoverScopeKey,
  selectionBoundary,
} from "./bounded-candidates.mjs";

export function pairKey(a, b) {
  return JSON.stringify([String(a), String(b)].sort());
}

export function scopedPairKey(scope, a, b) {
  const scopeKey = typeof scope === "string" ? scope : needleMoverScopeKey(scope);
  return scopeKey ? `${scopeKey}::${pairKey(a, b)}` : null;
}

function configuredGroupSize(pairing) {
  return Number.isInteger(pairing?.group_size) && pairing.group_size >= 2
    ? pairing.group_size
    : 2;
}

export function priorPairKeys(items) {
  const keys = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const value = item?.payload ?? item;
    const members = value?.members ?? value?.member_ids ?? value?.member_names;
    if (!Array.isArray(members)) continue;
    const scope = value?.scope ?? value?.attributes?.needle_mover_scope ?? value;
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const key = scopedPairKey(scope, members[left], members[right]);
        if (key) keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

function configuredMinimumSize(pairing, groupSize) {
  return Number.isInteger(pairing?.minimum_group_size) && pairing.minimum_group_size >= 2
    ? Math.min(pairing.minimum_group_size, groupSize)
    : groupSize;
}

function groupingType(grouping, memberCount) {
  const modes = Array.isArray(grouping?.modes) ? grouping.modes : [];
  const match = modes.find((mode) => {
    const min = Number.isInteger(mode?.min_size) ? mode.min_size : 0;
    const max = Number.isInteger(mode?.max_size) ? mode.max_size : Number.POSITIVE_INFINITY;
    return typeof mode?.type === "string" && memberCount >= min && memberCount <= max;
  });
  return match?.type ?? null;
}

function meanFactors(selected) {
  const factors = {};
  for (const factor of EXPECTED_VALUE_FACTORS) {
    const total = selected.reduce((sum, candidate) => sum + candidate.factors[factor], 0);
    factors[factor] = selected.length > 0 ? total / selected.length : 0;
  }
  return factors;
}

function introductionGate(parties, initiative, consents, consentPolicy) {
  const requiredLevel = typeof initiative?.required_level === "string"
    ? initiative.required_level
    : null;
  const authorizedLevels = new Set(
    Array.isArray(initiative?.pre_authorized_levels)
      ? initiative.pre_authorized_levels.filter((level) => typeof level === "string")
      : [],
  );
  const approvedValues = new Set(
    Array.isArray(consentPolicy?.approved_values) ? consentPolicy.approved_values : [],
  );
  const vetoValues = new Set(
    Array.isArray(consentPolicy?.veto_values) ? consentPolicy.veto_values : [],
  );
  const blockers = [];
  const consentValue = (party) => (
    consents && typeof consents === "object" && Object.hasOwn(consents, party)
      ? consents[party]
      : undefined
  );

  if (!requiredLevel || !authorizedLevels.has(requiredLevel)) {
    blockers.push({ kind: "insufficient_initiative", required_level: requiredLevel });
  }

  for (const party of parties) {
    const value = consentValue(party);
    if (vetoValues.has(value)) {
      blockers.push({ kind: "veto", party, value });
    } else if (!approvedValues.has(value)) {
      blockers.push({ kind: "missing_consent", party, value: value ?? null });
    }
  }

  return {
    status: blockers.length === 0 ? "ready" : "blocked",
    required_initiative_level: requiredLevel,
    pre_authorized_levels: [...authorizedLevels],
    initiative_authorized: Boolean(requiredLevel) && authorizedLevels.has(requiredLevel),
    every_party_approved: parties.every((party) => approvedValues.has(consentValue(party))),
    party_gate: parties.map((party) => {
      const value = consentValue(party) ?? null;
      return {
        party,
        consent_value: value,
        approved: approvedValues.has(value),
        vetoed: vetoValues.has(value),
      };
    }),
    blockers,
  };
}

function prepareIntroduction(group, selected, req) {
  const introduction = req?.introduction && typeof req.introduction === "object"
    ? req.introduction
    : {};
  const subjectContext = req?.subject_context?.[group.subject] ?? {};
  const candidateReasons = new Map(selected.map((candidate) => [candidate.participant, candidate.why]));
  const whyByPerson = introduction.why_by_person && typeof introduction.why_by_person === "object"
    ? introduction.why_by_person
    : {};
  const whyEachPerson = group.members.map((party) => ({
    party,
    why: typeof whyByPerson[party] === "string"
      ? whyByPerson[party]
      : (candidateReasons.get(party) ?? (party === group.subject ? subjectContext.why ?? null : null)),
  }));
  const consentParties = [...new Set([
    ...group.members,
    ...selected.flatMap((candidate) => candidate.consent_party_refs ?? []),
  ])].sort();
  const sendGate = introductionGate(
    consentParties,
    req?.initiative,
    req?.consents,
    req?.consent_policy,
  );

  return {
    kind: "prepared-multi-party-introduction",
    id: `${group.subject}:${group.members.join("-")}`,
    grouping: group.grouping,
    subject: group.subject,
    parties: group.members,
    consent_parties: consentParties,
    agenda: typeof introduction.agenda === "string" ? introduction.agenda : null,
    why_each_person: whyEachPerson,
    next_step: typeof introduction.next_step === "string" ? introduction.next_step : null,
    send_gate: sendGate,
    send_authorized: sendGate.status === "ready",
  };
}

function candidateAllowedByRoles(candidate, subject, roles, participantRoles) {
  if (!roles) return true;
  const subjectRole = participantRoles[subject];
  const candidateRole = candidate.role ?? participantRoles[candidate.participant];
  const [leftRole, rightRole] = roles.bipartite;
  return (subjectRole === leftRole && candidateRole === rightRole)
    || (subjectRole === rightRole && candidateRole === leftRole);
}

export function selectPairs(req) {
  const candidates = Array.isArray(req?.candidates) ? req.candidates : [];
  const pairing = req?.pairing && typeof req.pairing === "object" ? req.pairing : {};
  const groupSize = configuredGroupSize(pairing);
  const minimumGroupSize = configuredMinimumSize(pairing, groupSize);
  const includeSubject = pairing.include_subject !== false;
  const selectedPerSubject = includeSubject ? groupSize - 1 : groupSize;
  const roles = Array.isArray(pairing?.roles?.bipartite) && pairing.roles.bipartite.length === 2
    ? pairing.roles
    : null;
  const participantRoles = req?.participant_roles ?? {};
  const alreadyMatched = new Set(pairing.exclusion === "none" ? [] : (req?.already_matched ?? []));
  const exclusiveParticipation = pairing.exclusive_participation === true;
  const bySubject = new Map();
  const allParticipants = new Set();
  const rejectedCandidates = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate.subject !== "string" || typeof candidate.participant !== "string") continue;
    const admission = expectedValueAdmission(candidate, req?.expected_value);
    if (!admission.admitted) {
      rejectedCandidates.push({
        subject: candidate.subject,
        participant: candidate.participant,
        scope_key: needleMoverScopeKey(candidate),
        reason: admission.reason,
      });
      continue;
    }
    if (candidate.subject === candidate.participant) continue;
    if (!candidateAllowedByRoles(candidate, candidate.subject, roles, participantRoles)) continue;
    const scopeKey = needleMoverScopeKey(candidate);
    const subjectKey = `${scopeKey}::${candidate.subject}`;
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
    const unique = [];
    const seenParticipants = new Set();
    for (const candidate of shortlist) {
      if (seenParticipants.has(candidate.participant)) continue;
      seenParticipants.add(candidate.participant);
      unique.push(candidate);
    }
    bySubject.set(subjectKey, unique);
  }

  const subjects = [...bySubject.keys()].sort((left, right) => {
    const scoreDelta = bySubject.get(right)[0].expected_value - bySubject.get(left)[0].expected_value;
    return scoreDelta !== 0 ? scoreDelta : left.localeCompare(right);
  });
  const used = new Set();
  const placed = new Set();
  const groups = [];
  const introductions = [];
  let selectedCandidateCount = 0;
  const subjectBlockers = [];

  for (const subjectKey of subjects) {
    const shortlist = bySubject.get(subjectKey);
    const subject = shortlist[0].subject;
    const scopeKey = shortlist[0].scope_key ?? needleMoverScopeKey(shortlist[0]);
    if (includeSubject && exclusiveParticipation && used.has(subject)) continue;
    const available = shortlist.filter((candidate) => {
      if (exclusiveParticipation && used.has(candidate.participant)) return false;
      if (!includeSubject) return true;
      const scopedKey = scopedPairKey(scopeKey, subject, candidate.participant);
      if (scopedKey && alreadyMatched.has(scopedKey)) return false;
      return pairing.allow_unscoped_exclusions === true
        ? !alreadyMatched.has(pairKey(subject, candidate.participant))
        : true;
    });
    const boundary = selectionBoundary(
      available.map((candidate) => candidate.expected_value),
      selectedPerSubject,
      req?.expected_value,
    );
    if (!boundary.distinguishable) {
      subjectBlockers.push({ subject, scope_key: scopeKey, reason: boundary.reason });
      continue;
    }
    const selected = available.slice(0, selectedPerSubject);
    const members = includeSubject
      ? [subject, ...selected.map((candidate) => candidate.participant)]
      : selected.map((candidate) => candidate.participant);
    if (members.length < minimumGroupSize) continue;

    if (exclusiveParticipation) {
      if (includeSubject) used.add(subject);
      for (const candidate of selected) used.add(candidate.participant);
    }
    for (const member of members) placed.add(member);
    selectedCandidateCount += selected.length;
    const weakestCandidateValue = selected.reduce(
      (minimum, candidate) => Math.min(minimum, candidate.expected_value),
      Number.POSITIVE_INFINITY,
    );
    const group = {
      subject,
      scope: selected[0]?.scope ?? null,
      scope_key: scopeKey,
      members: [...members].sort(),
      grouping: groupingType(pairing.grouping, members.length),
      expected_value: weakestCandidateValue,
      score: weakestCandidateValue,
      expected_value_aggregation: "minimum_selected_candidate",
      expected_value_factors: meanFactors(selected),
      expected_value_factor_aggregation: "mean_selected_candidate",
      provenance: "per-candidate expected-value products; group aggregate is the minimum selected candidate",
      selected_shortlist: selected.map((candidate) => ({
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
        .filter((candidate) => candidate.action_ref || candidate.configuration_ref || candidate.configuration != null)
        .map((candidate) => ({
          resource_ref: candidate.resource_ref ?? candidate.participant,
          action_ref: candidate.action_ref ?? null,
          configuration_ref: candidate.configuration_ref ?? null,
          configuration: candidate.configuration ?? null,
        })),
      reasoning_request: {
        stage: "after_shortlist",
        subject,
        scope: selected[0]?.scope ?? null,
        parties: [...members].sort(),
      },
    };
    const introduction = prepareIntroduction(group, selected, req);
    group.introduction = introduction;
    groups.push(group);
    introductions.push(introduction);
  }

  return {
    groups,
    introductions,
    ready_introductions: introductions.filter((record) => record.send_authorized),
    blocked_introductions: introductions.filter((record) => !record.send_authorized),
    unmatched: [...allParticipants].filter((participant) => !placed.has(participant)).sort(),
    unmatched_details: [...rejectedCandidates, ...subjectBlockers].sort((left, right) => (
      `${left.scope_key ?? ""}|${left.subject ?? ""}|${left.participant ?? ""}|${left.reason}`
        .localeCompare(`${right.scope_key ?? ""}|${right.subject ?? ""}|${right.participant ?? ""}|${right.reason}`)
    )),
    instrumentation: {
      subject_count: bySubject.size,
      candidate_count: candidates.length,
      selected_candidate_count: selectedCandidateCount,
      group_count: groups.length,
      all_pairs_evaluation_count: 0,
      expensive_reasoning_requests: groups.length,
      expensive_reasoning_stage: "after_shortlist",
      rejected_candidate_count: rejectedCandidates.length,
      indistinguishable_subject_count: subjectBlockers.filter((entry) => (
        entry.reason === "indistinguishable_expected_value"
      )).length,
      exclusive_participation: exclusiveParticipation,
    },
  };
}

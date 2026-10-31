// tools/decide-with-a-method/read-data/decision-outcome.mjs
//
// How a decision turned out, read from the evidence its record holds: checks (outcome_checks), observations and
// the person's reports. Ported from the old app's src/check-uses.mjs (outcomeIsCurrent, currentDecisionOutcome,
// personReportVerified, decisionStatus, decisionResult); the only change is that who wins when the person and a
// check disagree (`precedence`, read-data/decision-outcome.json) is passed in rather than imported.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Evidence from an earlier decision generation is never the current outcome of a later one.
//   2. A report counts as the person's own only with a signed-in host's basis and source; a label alone is a claim.
//   3. Nothing is rewritten: this is a projection of the record as it is.

export const decisionGeneration = record => record?.decision_generation ?? 1;
const outcomeTime = (entry, kind) => entry.observed_at ?? (kind === 'report' ? entry.reported_at : entry.checked_at);
const milliseconds = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

// Older records did not name their generation. Their own timestamp, and an action's recorded generation when
// available, are enough to keep them historical after a new decision. Undated legacy evidence cannot verify a
// later generation.
export function outcomeIsCurrent(record, entry, kind = 'check') {
  const generation = entry.decision_generation ?? (entry.action_key
    ? record.actions?.find(action => action.key === entry.action_key)?.decision_generation : undefined);
  if (generation !== undefined) return generation === decisionGeneration(record);
  const observed = milliseconds(outcomeTime(entry, kind));
  const decided = milliseconds(record.decided_at);
  if (observed !== null && decided !== null) return observed >= decided;
  return decisionGeneration(record) === 1;
}

// A person report can contradict a verified result; it cannot promote itself into independent verification.
export const personReportVerified = report => Boolean(report?.answered_by === 'person' && ['signed_in_person_screen', 'kept_person_message'].includes(report.person_source?.basis)
  && typeof report.person_source?.source_ref === 'string' && report.person_source.source_ref.trim().length > 0);

// The one current assessment. "checked" and "reported" stay distinct. The revision orders simultaneous evidence; a
// tie favours failure over success. With precedence.person_confirmed_wins the person's confirmed value stays current
// until they change or retract it, and the AI's inference is returned beside it.
export function currentDecisionOutcome(record, precedence) {
  record ??= {};
  const candidates = [];
  for (const [field, kind, by] of [['outcome_checks', 'check', 'checked'], ['observations', 'observation', 'checked'], ['reports', 'report', 'reported']]) {
    for (const [index, entry] of (record[field] ?? []).entries()) {
      if (!['met', 'failed', 'unknown'].includes(entry.result) || !outcomeIsCurrent(record, entry, kind)) continue;
      if (['technical_delivery_only', 'reported_execution', 'observation_unavailable'].includes(entry.scope)) continue;
      if (kind === 'report' && entry.answered_by !== undefined && entry.answered_by !== 'person') continue;
      candidates.push({ result: entry.result, at: outcomeTime(entry, kind) ?? null, by,
        source_ref: entry.source_ref ?? null, summary: entry.summary ?? entry.reason ?? null,
        decision_generation: decisionGeneration(record), revision: entry.outcome_revision ?? 0, index, evidence: entry });
    }
  }
  const severity = { met: 0, unknown: 1, failed: 2 };
  const superseded = new Set(candidates.map(item => item.evidence.supersedes).filter(Boolean));
  const current = candidates.filter(item => !superseded.has(item.source_ref));
  current.sort((a, b) => (milliseconds(a.at) ?? -Infinity) - (milliseconds(b.at) ?? -Infinity)
    || a.revision - b.revision || severity[a.result] - severity[b.result] || a.index - b.index);
  const latest = current.at(-1) ?? null;
  if (!latest) return null;
  const confirmed = current.filter(item => item.by === 'reported' && personReportVerified(item.evidence)).at(-1) ?? null;
  const inferred = current.filter(item => item.by === 'checked').at(-1) ?? null;
  const chosen = precedence.person_confirmed_wins === true && confirmed ? confirmed : latest;
  const inference = inferred && inferred !== chosen ? { result: inferred.result, at: inferred.at, source_ref: inferred.source_ref, summary: inferred.summary } : null;
  return inference ? { ...chosen, inference } : chosen;
}

// Preserves other reasons a case is open for correction (a rejected action or an explicit disagreement).
export function decisionStatus(record, precedence) {
  record ??= {};
  if (!record.decision || ['invalid_source', 'ended', 'needs_decision'].includes(record.status)) return record.status;
  const outcome = currentDecisionOutcome(record, precedence);
  if (outcome?.result === 'failed') return 'correction_needed';
  if (outcome?.result === 'unknown' || outcome?.by === 'reported' || !outcome) {
    return record.status === 'correction_needed' ? 'correction_needed' : 'needs_outcome';
  }
  return record.status;
}

// The current settled outcome, or null while unknown.
export function decisionResult(record, precedence) {
  const outcome = currentDecisionOutcome(record, precedence);
  if (outcome?.result === 'met' && outcome.by === 'reported' && !personReportVerified(outcome.evidence)) return null;
  return outcome && outcome.result !== 'unknown' ? { result: outcome.result, at: outcome.at, by: outcome.by } : null;
}

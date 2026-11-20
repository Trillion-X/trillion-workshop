// tools/opponent-game-plan/read-data/scouting.mjs
//
// What a person has gathered on an opponent (or on themself), read from records and joined into one profile.
//   subject             { kind, subjectId, subjectKind, label, payload: { isSelf?, ...facts } }
//   evidence            { kind, evidenceKind: "player-report", evidenceId, subject: { id }, source: { sourceId, confidence?,
//                         visibility }, payload: { visibility, styleLabels, strengths, weaknesses, strategiesWorked,
//                         strategiesFailed, notes?, confidence? } }
//   profile-projection  { kind, profileId, subject: { id }, payload: { strongest?, weakest?, style?, ratings: { name: 0-100 },
//                         ...any other facts } }
//   result              { kind, resultKind: "match-plan", planId, selfPlayerId, opponentPlayerId, strategies: [{ strategyId,
//                         name, tactics: [{ tacticId, label }] }] } and
//                       { kind, resultKind: "tactic-outcome", resultId, selfPlayerId, opponentPlayerId,
//                         payload: { planId?, strategyId?, tacticId?, outcome: worked | failed | mixed, notes?, matchRef? } }
//   evidence-confidence-policy  { kind, policyId, minimumConfidence, missingConfidenceIsUsable }
// Nothing here names a sport: what a rating, a style or a fact is called is the person's own words in their records.

import { randomUUID } from 'node:crypto';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const payloadOf = row => (isRecord(row) ? (row.payload ?? row.value ?? row) : row);
const field = (value, name) => (isRecord(value) && typeof value[name] === 'string' ? value[name] : '');
const unique = values => [...new Set(values.filter(Boolean))];
const listOf = value => (Array.isArray(value) ? value : []);

export function readScoutingState(rows, filters = {}) {
  const values = Array.isArray(rows) ? rows.map(payloadOf) : [];
  const kindIs = (value, kind) => field(value, 'kind') === kind;
  return {
    subjects: values.filter(value => kindIs(value, 'subject') && (!filters.subject_kind || field(value, 'subjectKind') === filters.subject_kind)),
    reports: values.filter(value => kindIs(value, 'evidence') && field(value, 'evidenceKind') === 'player-report'),
    profiles: values.filter(value => kindIs(value, 'profile-projection') && (!filters.profile_kind || field(value, 'projectionKind') === filters.profile_kind)),
    plans: values.filter(value => kindIs(value, 'result') && field(value, 'resultKind') === 'match-plan'),
    tacticResults: values.filter(value => kindIs(value, 'result') && field(value, 'resultKind') === 'tactic-outcome'),
    policy: values.find(value => kindIs(value, 'evidence-confidence-policy')) ?? null,
  };
}

// Ratings are whole or fractional numbers from 0 to 100; anything else a record holds is left out, never guessed. A
// later profile's rating of the same name replaces an earlier one.
function ratingsFrom(profiles) {
  const ratings = {};
  for (const profile of profiles) {
    for (const [name, value] of Object.entries(profile.payload?.ratings ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) ratings[name] = value;
    }
  }
  return ratings;
}

function tacticOutcomeSummaries(plans, results) {
  return results.map(result => {
    const plan = result.payload.planId ? plans.find(candidate => candidate.planId === result.payload.planId) : undefined;
    const strategy = plan?.strategies.find(candidate => candidate.strategyId === result.payload.strategyId);
    const tactic = strategy?.tactics.find(candidate => candidate.tacticId === result.payload.tacticId);
    return {
      resultId: result.resultId,
      outcome: result.payload.outcome,
      planId: result.payload.planId,
      strategyId: result.payload.strategyId,
      strategyName: strategy?.name,
      tacticId: result.payload.tacticId,
      tacticLabel: tactic?.label,
      notes: result.payload.notes,
      matchRef: result.payload.matchRef,
    };
  });
}

const outcomeLabels = (outcomes, target) => outcomes
  .filter(outcome => outcome.outcome === target)
  .map(outcome => outcome.tacticLabel ?? outcome.notes ?? '');

// The one place a profile is made from its parts: the facts reports and profiles state, joined without repeats, and the
// outcomes of tactics tried. A view made from only some of a subject's reports (the usable ones) comes from here too.
export function profileView({ player, reports, profiles, plans, tacticResults }) {
  const outcomes = tacticOutcomeSummaries(plans, tacticResults);
  const fromReports = name => reports.flatMap(report => listOf(report.payload[name]));
  return {
    player,
    reports,
    publicReports: reports.filter(report => report.payload.visibility === 'public'),
    privateReports: reports.filter(report => report.payload.visibility !== 'public'),
    profiles,
    plans,
    tacticResults,
    tacticOutcomes: outcomes,
    strengths: unique(fromReports('strengths').concat(profiles.map(profile => profile.payload.strongest ?? ''))),
    weaknesses: unique(fromReports('weaknesses').concat(profiles.map(profile => profile.payload.weakest ?? ''))),
    strategiesWorked: unique(fromReports('strategiesWorked').concat(outcomeLabels(outcomes, 'worked'))),
    strategiesFailed: unique(fromReports('strategiesFailed').concat(outcomeLabels(outcomes, 'failed'))),
    styleLabels: unique(fromReports('styleLabels').concat(profiles.map(profile => profile.payload.style ?? ''))),
    ratings: ratingsFrom(profiles),
  };
}

export function profileForSubject(state, subjectId) {
  const involves = result => result.opponentPlayerId === subjectId || result.selfPlayerId === subjectId;
  return profileView({
    player: state.subjects.find(subject => subject.subjectId === subjectId),
    reports: state.reports.filter(report => report.subject.id === subjectId),
    profiles: state.profiles.filter(profile => profile.subject.id === subjectId),
    plans: state.plans.filter(involves),
    tacticResults: state.tacticResults.filter(involves),
  });
}

// One row per subject that is not the person themself: who it is, how many reports and profiles are on file, and how
// many tactics worked and failed against them.
export function searchRows(state) {
  return state.subjects
    .filter(subject => !subject.payload?.isSelf)
    .map(subject => {
      const profile = profileForSubject(state, subject.subjectId);
      return {
        subjectId: subject.subjectId,
        name: subject.label,
        facts: subject.payload ?? {},
        styleLabels: profile.styleLabels,
        reportCount: profile.reports.length,
        profileCount: profile.profiles.length,
        workedCount: profile.tacticResults.filter(result => result.payload.outcome === 'worked').length,
        failedCount: profile.tacticResults.filter(result => result.payload.outcome === 'failed').length,
      };
    });
}

// Which reports may be used. The policy is the person's: a report whose confidence (its source's, else its own) is at
// least minimumConfidence is usable; one with no confidence is usable only if missingConfidenceIsUsable. With no policy
// nothing is usable: every report waits for review.
export function splitEvidenceByConfidence(reports, policy) {
  if (!policy) return { usable: [], needsReview: reports };
  const usable = [];
  const needsReview = [];
  for (const report of reports) {
    const confidence = report.source?.confidence ?? report.payload.confidence;
    const ok = typeof confidence === 'number' ? confidence >= policy.minimumConfidence : policy.missingConfidenceIsUsable;
    (ok ? usable : needsReview).push(report);
  }
  return { usable, needsReview };
}

export function assertPolicy(policy) {
  if (policy === null || policy === undefined) return null;
  if (!isRecord(policy) || typeof policy.minimumConfidence !== 'number' || typeof policy.missingConfidenceIsUsable !== 'boolean') {
    throw new Error('A confidence policy is { minimumConfidence: a number, missingConfidenceIsUsable: true or false }.');
  }
  return policy;
}

// A plan has the number of strategies and tactics the person asked for, and no other shape.
export function assertPlanShape(plan, shape) {
  if (!Array.isArray(plan?.strategies) || plan.strategies.length !== shape.strategies) {
    throw new Error(`A plan must contain exactly ${shape.strategies} strategies.`);
  }
  for (const strategy of plan.strategies) {
    if (!Array.isArray(strategy?.tactics) || strategy.tactics.length !== shape.tactics_per_strategy) {
      throw new Error(`Each strategy must contain exactly ${shape.tactics_per_strategy} tactics.`);
    }
  }
  return plan;
}

export function assertShape(shape) {
  for (const name of ['strategies', 'tactics_per_strategy']) {
    if (!Number.isInteger(shape?.[name]) || shape[name] < 1) throw new Error('plan_shape must be { strategies: a whole number, tactics_per_strategy: a whole number }.');
  }
  return shape;
}

// ---------------------------------------------------------------------------------------------------------------
// The context a plan is asked for from: only what the usable evidence says, one line per fact.

function flatten(value, prefix, lines) {
  if (Array.isArray(value)) {
    if (value.length > 0) lines.push(`${prefix}: ${value.join(', ')}`);
  } else if (isRecord(value)) {
    for (const [key, inner] of Object.entries(value)) flatten(inner, `${prefix} ${key}`, lines);
  } else if (value !== undefined && value !== null && String(value).trim() !== '') {
    lines.push(`${prefix}: ${String(value).trim()}`);
  }
}

function profileLines(label, view) {
  const lines = [view.player?.label ? `${label}: ${view.player.label}` : label];
  const facts = Object.entries(view.player?.payload ?? {}).filter(([key]) => key !== 'isSelf');
  for (const [key, value] of facts) flatten(value, key, lines);
  const profile = view.profiles[0]?.payload ?? {};
  for (const [key, value] of Object.entries(profile)) if (!['strongest', 'weakest', 'style', 'ratings'].includes(key)) flatten(value, key, lines);
  flatten(view.styleLabels, 'style', lines);
  flatten(view.strengths, 'strongest', lines);
  flatten(view.weaknesses, 'weakest', lines);
  flatten(view.strategiesWorked, 'strategies that worked', lines);
  flatten(view.strategiesFailed, 'strategies that did not work', lines);
  for (const [name, value] of Object.entries(view.ratings)) lines.push(`${name}: ${value}/100`);
  return lines;
}

export function buildPlanPrompt(selfView, opponentView, shape) {
  return [
    `Create exactly ${shape.strategies} strategies with exactly ${shape.tactics_per_strategy} tactics each.`,
    'Use only the evidence listed below. Do not invent facts about either side.',
    '',
    ...profileLines('Self', selfView),
    '',
    ...profileLines('Opponent', opponentView),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The records the person's scouting writes: a subject, a report of evidence, a profile projection, a tactic result.
// Each builder returns the record for the caller to write; none keeps anything. Text is trimmed and empty text is left
// out. The outcomes a tactic can have are the three the readers count: worked, failed, mixed.

export const TACTIC_OUTCOMES = ['worked', 'failed', 'mixed'];

export function timeOf(now) {
  const when = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(when.getTime())) throw new Error('now must be an ISO time such as 2026-01-01T09:00:00Z.');
  return when.toISOString();
}

const textOf = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const textListOf = values => [...new Set(listOf(values).map(textOf).filter(Boolean))];
const newId = prefix => `${prefix}:${randomUUID()}`;

function requireText(input, names) {
  for (const name of names) if (!textOf(input[name])) throw new Error(`${name} is required.`);
}

// Ratings are whole or fractional numbers from 0 to 100; null and missing are left out. Anything else is refused on write
// (the reader leaves it out, never guesses it).
export function ratingsOf(values) {
  if (values === undefined || values === null) return {};
  if (!isRecord(values)) throw new Error('ratings must be { name: a number from 0 to 100 }.');
  const ratings = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${name} rating must be between 0 and 100.`);
    ratings[name] = value;
  }
  return ratings;
}

// A subject: someone in the scouting, the person themself or an opponent. Written again, it replaces the one before.
export function subjectRecord({ subject_id, subject_label, subject_kind = 'player', is_self, facts = {}, now }) {
  requireText({ subject_id, subject_label }, ['subject_id', 'subject_label']);
  if (!isRecord(facts)) throw new Error('facts must be a record of the subject facts.');
  return {
    kind: 'subject',
    subjectId: subject_id,
    subjectKind: subject_kind,
    label: subject_label.trim(),
    payload: { ...facts, ...(is_self === true ? { isSelf: true } : {}) },
    createdAt: timeOf(now),
  };
}

// A report of evidence about a subject. Private unless the person says public; its confidence is kept on the source and
// the payload, where the policy reads it.
export function reportRecord({ report_id, subject_id, subject_label, subject_kind = 'player', author_id, visibility = 'private',
  style_labels, strengths, weaknesses, strategies_worked, strategies_failed, notes, confidence, now }) {
  requireText({ subject_id, author_id }, ['subject_id', 'author_id']);
  if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence))) throw new Error('confidence must be a number.');
  const evidenceId = report_id ?? newId('evidence');
  return {
    kind: 'evidence',
    evidenceId,
    subject: { id: subject_id, kind: subject_kind, label: textOf(subject_label) },
    evidenceKind: 'player-report',
    source: { sourceId: author_id, visibility, confidence },
    payload: {
      authorId: author_id,
      visibility,
      styleLabels: textListOf(style_labels),
      strengths: textListOf(strengths),
      weaknesses: textListOf(weaknesses),
      strategiesWorked: textListOf(strategies_worked),
      strategiesFailed: textListOf(strategies_failed),
      notes: textOf(notes),
      confidence,
    },
    createdAt: timeOf(now),
  };
}

// A profile projection: facts about a subject from one source (court-zone notes, shot ratings, anything the person names).
// Strings are trimmed, empty facts are left out, and ratings are checked by ratingsOf.
export function profileRecord({ profile_id, subject_id, subject_kind = 'player', profile_kind, source, payload = {}, now }) {
  requireText({ subject_id, profile_kind }, ['subject_id', 'profile_kind']);
  if (!isRecord(source) || !textOf(source.sourceId)) throw new Error('source needs a sourceId.');
  if (!isRecord(payload)) throw new Error('payload must be a record of the profile facts.');
  const facts = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'ratings' || value === undefined || value === null) continue;
    const kept = typeof value === 'string' ? textOf(value) : value;
    if (kept !== undefined) facts[key] = kept;
  }
  return {
    kind: 'profile-projection',
    profileId: profile_id ?? newId('profile-projection'),
    subject: { id: subject_id, kind: subject_kind },
    projectionKind: profile_kind,
    source,
    sourceRefs: [source.sourceId],
    payload: { ...facts, ratings: ratingsOf(payload.ratings) },
    createdAt: timeOf(now),
  };
}

// A tactic tried in a match: its outcome, and the plan, strategy and tactic it came from when given.
export function tacticResultRecord({ result_id, self_id, opponent_id, plan_id, strategy_id, tactic_id, outcome, notes, match_ref, now }) {
  requireText({ self_id, opponent_id }, ['self_id', 'opponent_id']);
  if (!TACTIC_OUTCOMES.includes(outcome)) throw new Error('outcome must be worked, failed or mixed.');
  const refs = [plan_id, strategy_id, tactic_id, match_ref].map(textOf).filter(Boolean);
  return {
    kind: 'result',
    resultKind: 'tactic-outcome',
    resultId: result_id ?? newId('result'),
    subject: { id: opponent_id, kind: 'player' },
    selfPlayerId: self_id,
    opponentPlayerId: opponent_id,
    sourceRefs: refs,
    payload: {
      planId: textOf(plan_id),
      strategyId: textOf(strategy_id),
      tacticId: textOf(tactic_id),
      outcome,
      notes: textOf(notes),
      matchRef: textOf(match_ref),
    },
    createdAt: timeOf(now),
  };
}

// The latest match plan between a person and an opponent (the one the tactics are marked on), or null.
export function latestPlanFor(rows, selfId, opponentId) {
  const { plans } = readScoutingState(rows);
  return plans
    .filter(plan => plan.selfPlayerId === selfId && plan.opponentPlayerId === opponentId)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null;
}

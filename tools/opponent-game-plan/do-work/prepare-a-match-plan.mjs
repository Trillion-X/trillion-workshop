// tools/opponent-game-plan/do-work/prepare-a-match-plan.mjs
//
// The command of tool:prepare-a-match-plan. One JSON request on standard input, { result } out. `operation` is one of:
//   context      { rows, self_id, opponent_id, requester_id, plan_shape: { strategies, tactics_per_strategy },
//                  confidence_policy?, request_id?, now?, subject_kind?, profile_kind? }
//                -> { request_record }: a plan-request holding promptText (what the evidence says of both sides, one line per
//                fact, and how many strategies and tactics are asked for), the ids of the public, private and
//                to-be-reviewed reports and of the profiles and tactic results behind it. Only reports the confidence policy
//                allows are in the text; with no policy none is. Missing facts are left out, never written as "unknown".
//   record-plan  { plan_id, request_id, self_id, opponent_id, strategies, plan_shape, evidence_refs?, now? }
//                -> { plan_record }: the match-plan result once its shape is the one asked for
// The plan itself is written by the AI that reads promptText; this command only prepares what it reads and checks what it
// wrote, and calls no model.
import { randomUUID } from 'node:crypto';
import { runAsMain } from '../read-data/run-as-main.mjs';
import {
  assertPlanShape, assertPolicy, assertShape, buildPlanPrompt, profileForSubject, profileView, readScoutingState,
  splitEvidenceByConfidence,
} from '../read-data/scouting.mjs';

function timeOf(now) {
  const when = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(when.getTime())) throw new Error('now must be an ISO time such as 2026-01-01T09:00:00Z.');
  return when.toISOString();
}

function context(input) {
  const shape = assertShape(input.plan_shape);
  for (const name of ['self_id', 'opponent_id', 'requester_id']) if (!input[name]) throw new Error(`${name} is required.`);
  const state = readScoutingState(input.rows, input);
  const self = profileForSubject(state, input.self_id);
  const opponent = profileForSubject(state, input.opponent_id);
  const split = splitEvidenceByConfidence(self.reports.concat(opponent.reports), assertPolicy(input.confidence_policy) ?? state.policy);
  const usable = new Set(split.usable.map(report => report.evidenceId));
  const onlyUsable = view => profileView({ ...view, reports: view.reports.filter(report => usable.has(report.evidenceId)) });
  const requestId = input.request_id ?? `plan-request:${randomUUID()}`;
  return {
    request_record: {
      kind: 'plan-request',
      requestId,
      requestKind: 'match-plan',
      requesterId: input.requester_id,
      selfPlayerId: input.self_id,
      opponentPlayerId: input.opponent_id,
      publicEvidenceRefs: split.usable.filter(report => report.payload.visibility === 'public').map(report => report.evidenceId),
      privateEvidenceRefs: split.usable.filter(report => report.payload.visibility !== 'public').map(report => report.evidenceId),
      reviewEvidenceRefs: split.needsReview.map(report => report.evidenceId),
      profileRefs: self.profiles.concat(opponent.profiles).map(profile => profile.profileId),
      resultRefs: [...new Set(self.tacticResults.concat(opponent.tacticResults).map(result => result.resultId))],
      promptText: buildPlanPrompt(onlyUsable(self), onlyUsable(opponent), shape),
      createdAt: timeOf(input.now),
    },
  };
}

function recordPlan(input) {
  const shape = assertShape(input.plan_shape);
  for (const name of ['plan_id', 'request_id', 'self_id', 'opponent_id']) if (!input[name]) throw new Error(`${name} is required.`);
  assertPlanShape(input, shape);
  for (const strategy of input.strategies) {
    if (!strategy.strategyId || !strategy.name) throw new Error('Every strategy needs a strategyId and a name.');
    for (const tactic of strategy.tactics) if (!tactic.tacticId || !tactic.label) throw new Error('Every tactic needs a tacticId and a label.');
  }
  return {
    plan_record: {
      kind: 'result',
      resultKind: 'match-plan',
      resultId: input.plan_id,
      planId: input.plan_id,
      requestId: input.request_id,
      selfPlayerId: input.self_id,
      opponentPlayerId: input.opponent_id,
      strategies: input.strategies,
      evidenceRefs: input.evidence_refs ?? [],
      createdAt: timeOf(input.now),
    },
  };
}

export function prepareAMatchPlan(input) {
  switch (input?.operation) {
    case 'context':
      if (!Array.isArray(input.rows)) throw new Error('rows must be a list of records.');
      return context(input);
    case 'record-plan': return recordPlan(input);
    default: throw new Error('operation must be context or record-plan.');
  }
}

await runAsMain(import.meta.url, prepareAMatchPlan);

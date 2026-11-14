import type {
  CourtZoneProfile,
  EvidenceConfidencePolicy,
  MatchStrategyPlan,
  OpponentProfileView,
  OpponentGamePlanState,
  OpponentSearchRow,
  ShotRatings,
  TacticOutcomeSummary,
  TennisPlayerIdentity,
  TennisPlayerReport,
  TacticResult,
} from './opponent-game-plan-types.ts';
import { SHOT_RATING_KEYS as RATING_KEYS } from './opponent-game-plan-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadFromRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return row.payload ?? row.value ?? row;
}

function kind(value: unknown): string {
  return isRecord(value) && typeof value.kind === 'string' ? value.kind : '';
}

function evidenceKind(value: unknown): string {
  return isRecord(value) && typeof value.evidenceKind === 'string' ? value.evidenceKind : '';
}

function projectionKind(value: unknown): string {
  return isRecord(value) && typeof value.projectionKind === 'string' ? value.projectionKind : '';
}

function requestKind(value: unknown): string {
  return isRecord(value) && typeof value.requestKind === 'string' ? value.requestKind : '';
}

function resultKind(value: unknown): string {
  return isRecord(value) && typeof value.resultKind === 'string' ? value.resultKind : '';
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function ratingsFromProfiles(profiles: readonly CourtZoneProfile[]): ShotRatings {
  const ratings: ShotRatings = {};
  for (const profile of profiles) {
    for (const key of RATING_KEYS) {
      const value = profile.payload.shotRatings[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) {
        ratings[key] = value;
      }
    }
  }
  return ratings;
}

function tacticOutcomeSummaries(
  plans: readonly MatchStrategyPlan[],
  results: readonly TacticResult[],
): TacticOutcomeSummary[] {
  return results.map((result) => {
    const plan = result.payload.planId ? plans.find((candidate) => candidate.planId === result.payload.planId) : undefined;
    const strategy = plan?.strategies.find((candidate) => candidate.strategyId === result.payload.strategyId);
    const tactic = strategy?.tactics.find((candidate) => candidate.tacticId === result.payload.tacticId);
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

function outcomeLabels(outcomes: readonly TacticOutcomeSummary[], target: 'worked' | 'failed'): string[] {
  return outcomes
    .filter((outcome) => outcome.outcome === target)
    .map((outcome) => outcome.tacticLabel ?? outcome.notes ?? '')
    .filter(Boolean);
}

export function readOpponentGamePlanState(rows: unknown): OpponentGamePlanState {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return {
    players: values.filter((value): value is TennisPlayerIdentity => (
      kind(value) === 'subject'
      && isRecord(value)
      && value.subjectKind === 'tennis-player'
    )),
    reports: values.filter((value): value is TennisPlayerReport => kind(value) === 'evidence' && evidenceKind(value) === 'player-report'),
    profiles: values.filter((value): value is CourtZoneProfile => (
      kind(value) === 'profile-projection'
      && projectionKind(value) === 'court-zone-profile'
    )),
    requests: values.filter((value): value is OpponentGamePlanState['requests'][number] => (
      kind(value) === 'plan-request'
      && requestKind(value) === 'match-plan'
    )),
    plans: values.filter((value): value is MatchStrategyPlan => kind(value) === 'result' && resultKind(value) === 'match-plan'),
    tacticResults: values.filter((value): value is TacticResult => kind(value) === 'result' && resultKind(value) === 'tactic-outcome'),
  };
}

export function readEvidenceConfidencePolicy(rows: unknown): EvidenceConfidencePolicy | null {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return values.find((value): value is EvidenceConfidencePolicy => kind(value) === 'evidence-confidence-policy') ?? null;
}

export function splitEvidenceByConfidence(
  reports: TennisPlayerReport[],
  policy: EvidenceConfidencePolicy | null,
): { usable: TennisPlayerReport[]; needsReview: TennisPlayerReport[] } {
  if (!policy) {
    return { usable: [], needsReview: reports };
  }

  const usable: TennisPlayerReport[] = [];
  const needsReview: TennisPlayerReport[] = [];
  for (const report of reports) {
    const confidence = report.source.confidence ?? report.payload.confidence;
    if (typeof confidence !== 'number') {
      (policy.missingConfidenceIsUsable ? usable : needsReview).push(report);
    } else if (confidence >= policy.minimumConfidence) {
      usable.push(report);
    } else {
      needsReview.push(report);
    }
  }
  return { usable, needsReview };
}

export function profileForPlayer(state: OpponentGamePlanState, playerId: string): OpponentProfileView {
  const reports = state.reports.filter((report) => report.subject.id === playerId);
  const publicReports = reports.filter((report) => report.payload.visibility === 'public');
  const privateReports = reports.filter((report) => report.payload.visibility !== 'public');
  const profiles = state.profiles.filter((profile) => profile.subject.id === playerId);
  const tacticResults = state.tacticResults.filter((result) => result.opponentPlayerId === playerId || result.selfPlayerId === playerId);
  const plans = state.plans.filter((plan) => plan.opponentPlayerId === playerId || plan.selfPlayerId === playerId);
  const tacticOutcomes = tacticOutcomeSummaries(plans, tacticResults);
  return {
    player: state.players.find((player) => player.subjectId === playerId),
    reports,
    publicReports,
    privateReports,
    profiles,
    plans,
    tacticResults,
    tacticOutcomes,
    strengths: unique(reports.flatMap((report) => report.payload.strengths).concat(profiles.map((profile) => profile.payload.strongestShot ?? ''))),
    weaknesses: unique(reports.flatMap((report) => report.payload.weaknesses).concat(profiles.map((profile) => profile.payload.weakestShot ?? ''))),
    strategiesWorked: unique(reports.flatMap((report) => report.payload.strategiesWorked).concat(outcomeLabels(tacticOutcomes, 'worked'))),
    strategiesFailed: unique(reports.flatMap((report) => report.payload.strategiesFailed).concat(outcomeLabels(tacticOutcomes, 'failed'))),
    styleLabels: unique(reports.flatMap((report) => report.payload.styleLabels).concat(profiles.map((profile) => profile.payload.playingStyle ?? ''))) as OpponentProfileView['styleLabels'],
    shotRatings: ratingsFromProfiles(profiles),
  };
}

export function opponentSearchRows(state: OpponentGamePlanState): OpponentSearchRow[] {
  return state.players
    .filter((player) => !player.payload.isSelf)
    .map((player) => {
      const profile = profileForPlayer(state, player.subjectId);
      return {
        playerId: player.subjectId,
        name: player.label,
        hand: player.payload.hand,
        styleLabels: profile.styleLabels,
        reportCount: profile.reports.length,
        profileCount: profile.profiles.length,
        workedCount: profile.tacticResults.filter((result) => result.payload.outcome === 'worked').length,
        failedCount: profile.tacticResults.filter((result) => result.payload.outcome === 'failed').length,
      };
    });
}

export function latestPlanForMatch(
  state: OpponentGamePlanState,
  selfPlayerId: string,
  opponentPlayerId: string,
): MatchStrategyPlan | undefined {
  return state.plans
    .filter((plan) => plan.selfPlayerId === selfPlayerId && plan.opponentPlayerId === opponentPlayerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function assertMatchPlanShape(plan: MatchStrategyPlan): MatchStrategyPlan {
  if (plan.strategies.length !== 2) {
    throw new Error('Match plan must contain exactly 2 strategies');
  }
  for (const strategy of plan.strategies) {
    if (strategy.tactics.length !== 3) {
      throw new Error('Each match plan strategy must contain exactly 3 tactics');
    }
  }
  return plan;
}

export function knownShotRatings(profile: CourtZoneProfile): ShotRatings {
  return ratingsFromProfiles([profile]);
}

export type ShotRatingKeyList = typeof RATING_KEYS;

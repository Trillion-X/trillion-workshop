import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  EvidenceConfidencePolicy,
  MatchPlanStrategy,
  MatchPlanTactic,
  MatchPlanRequest,
  MatchStrategyPlan,
  OpponentProfileView,
  ShotRatings,
  TennisPlayerReport,
} from '../read-data/opponent-game-plan-types.ts';
import { SHOT_RATING_KEYS } from '../read-data/opponent-game-plan-types.ts';
import {
  assertMatchPlanShape,
  splitEvidenceByConfidence,
} from '../read-data/read-opponent-game-plan.ts';

export const REQUEST_MATCH_PLAN_ACTION = 'action:opponent-game-plan.request-plan';

export type RequestMatchPlanDraft = {
  requestId?: string;
  requesterId: string;
  selfPlayerId: string;
  opponentPlayerId: string;
  selfProfile: OpponentProfileView;
  opponentProfile: OpponentProfileView;
  evidenceConfidencePolicy?: EvidenceConfidencePolicy | null;
  now?: Date;
};

export type RequestMatchPlanInput = {
  request_id: string;
  request_record: MatchPlanRequest;
};

export type MatchPlanRecordDraft = {
  planId: string;
  requestId: string;
  selfPlayerId: string;
  opponentPlayerId: string;
  strategies: [MatchPlanStrategy, MatchPlanStrategy];
  evidenceRefs?: string[];
  now?: Date;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function ratingLines(ratings: ShotRatings): string[] {
  return SHOT_RATING_KEYS
    .filter((key) => typeof ratings[key] === 'number')
    .map((key) => `${key}: ${ratings[key]}/100`);
}

function pushLine(lines: string[], label: string, value: string | undefined): void {
  const cleanValue = value?.trim();
  if (cleanValue) lines.push(`${label}: ${cleanValue}`);
}

function pushList(lines: string[], label: string, values: readonly string[]): void {
  if (values.length > 0) lines.push(`${label}: ${values.join(', ')}`);
}

function profileLines(label: string, view: OpponentProfileView): string[] {
  const courtProfile = view.profiles[0];
  const lines = [view.player?.label ? `${label}: ${view.player.label}` : label];
  pushLine(lines, 'hand', view.player?.payload.hand ?? courtProfile?.payload.hand);
  pushList(lines, 'style', view.styleLabels);
  pushList(lines, 'strongest', view.strengths);
  pushList(lines, 'weakest', view.weaknesses);
  pushList(lines, 'strategies that worked', view.strategiesWorked);
  pushList(lines, 'strategies that did not work', view.strategiesFailed);
  if (courtProfile?.payload.winners?.from || courtProfile?.payload.winners?.to) {
    lines.push(`winner zones: ${[courtProfile.payload.winners.from, courtProfile.payload.winners.to].filter(Boolean).join(' to ')}`);
  }
  pushLine(lines, 'winner rally context', courtProfile?.payload.winners?.rallyContext);
  pushLine(lines, 'error zone', courtProfile?.payload.errors?.from);
  pushLine(lines, 'error rally context', courtProfile?.payload.errors?.rallyContext);
  if (courtProfile?.payload.quadrantMeaning) {
    for (const [zone, meaning] of Object.entries(courtProfile.payload.quadrantMeaning)) {
      pushLine(lines, `zone ${zone}`, meaning);
    }
  }
  lines.push(...ratingLines(view.shotRatings));
  return lines;
}

export function buildMatchPlanPrompt(selfProfile: OpponentProfileView, opponentProfile: OpponentProfileView): string {
  return [
    'Create exactly 2 match strategies with exactly 3 tactics each.',
    'Use only the evidence listed below. Do not invent player truth.',
    '',
    ...profileLines('Self player', selfProfile),
    '',
    ...profileLines('Opponent', opponentProfile),
  ].join('\n');
}

function profileWithReports(view: OpponentProfileView, reports: TennisPlayerReport[]): OpponentProfileView {
  return {
    ...view,
    reports,
    publicReports: reports.filter((report) => report.payload.visibility === 'public'),
    privateReports: reports.filter((report) => report.payload.visibility !== 'public'),
    strengths: Array.from(new Set(reports.flatMap((report) => report.payload.strengths).concat(view.profiles.map((profile) => profile.payload.strongestShot ?? '')).filter(Boolean))),
    weaknesses: Array.from(new Set(reports.flatMap((report) => report.payload.weaknesses).concat(view.profiles.map((profile) => profile.payload.weakestShot ?? '')).filter(Boolean))),
    strategiesWorked: Array.from(new Set(reports.flatMap((report) => report.payload.strategiesWorked).concat(view.tacticOutcomes.filter((outcome) => outcome.outcome === 'worked').map((outcome) => outcome.tacticLabel ?? outcome.notes ?? '')).filter(Boolean))),
    strategiesFailed: Array.from(new Set(reports.flatMap((report) => report.payload.strategiesFailed).concat(view.tacticOutcomes.filter((outcome) => outcome.outcome === 'failed').map((outcome) => outcome.tacticLabel ?? outcome.notes ?? '')).filter(Boolean))),
    styleLabels: Array.from(new Set(reports.flatMap((report) => report.payload.styleLabels).concat(view.profiles.map((profile) => profile.payload.playingStyle ?? '')).filter(Boolean))) as OpponentProfileView['styleLabels'],
  };
}

export function buildRequestMatchPlanInput(draft: RequestMatchPlanDraft): RequestMatchPlanInput {
  const requestId = draft.requestId ?? generatedId('plan-request');
  const reports = draft.selfProfile.reports.concat(draft.opponentProfile.reports);
  const split = splitEvidenceByConfidence(reports, draft.evidenceConfidencePolicy ?? null);
  const usableReportIds = new Set(split.usable.map((report) => report.evidenceId));
  const usableSelfProfile = profileWithReports(
    draft.selfProfile,
    draft.selfProfile.reports.filter((report) => usableReportIds.has(report.evidenceId)),
  );
  const usableOpponentProfile = profileWithReports(
    draft.opponentProfile,
    draft.opponentProfile.reports.filter((report) => usableReportIds.has(report.evidenceId)),
  );
  const profiles = draft.selfProfile.profiles.concat(draft.opponentProfile.profiles);
  const resultRefs = draft.selfProfile.tacticResults.concat(draft.opponentProfile.tacticResults).map((result) => result.resultId);
  return {
    request_id: requestId,
    request_record: {
      kind: 'plan-request',
      requestId,
      requestKind: 'match-plan',
      requesterId: draft.requesterId,
      selfPlayerId: draft.selfPlayerId,
      opponentPlayerId: draft.opponentPlayerId,
      publicEvidenceRefs: split.usable.filter((report) => report.payload.visibility === 'public').map((report) => report.evidenceId),
      privateEvidenceRefs: split.usable.filter((report) => report.payload.visibility !== 'public').map((report) => report.evidenceId),
      reviewEvidenceRefs: split.needsReview.map((report) => report.evidenceId),
      profileRefs: profiles.map((profile) => profile.profileId),
      resultRefs: Array.from(new Set(resultRefs)),
      promptText: buildMatchPlanPrompt(usableSelfProfile, usableOpponentProfile),
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function buildMatchPlanRecord(draft: MatchPlanRecordDraft): MatchStrategyPlan {
  return assertMatchPlanShape({
    kind: 'result',
    resultKind: 'match-plan',
    resultId: draft.planId,
    planId: draft.planId,
    requestId: draft.requestId,
    selfPlayerId: draft.selfPlayerId,
    opponentPlayerId: draft.opponentPlayerId,
    strategies: draft.strategies,
    evidenceRefs: draft.evidenceRefs ?? [],
    createdAt: (draft.now ?? new Date()).toISOString(),
  });
}

export function tactic(tacticId: string, label: string, reason?: string): MatchPlanTactic {
  return { tacticId, label, reason };
}

export function requestMatchPlan(input: RequestMatchPlanInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: REQUEST_MATCH_PLAN_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}

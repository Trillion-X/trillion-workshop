import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  DecisionEvidence,
  DecisionPrompt,
} from '@/packages/practice-decision-loop/read-data/practice-decision-loop-types';
import type {
  TacticsBracketMatch,
  TacticsDivision,
  TacticsProfileLink,
  TacticsScenario,
  TacticsSeason,
  TacticsSeasonCoachReview,
  TacticsSeasonInvite,
  TacticsConfig,
} from '../read-data/tactics-practice-types';

export const OPEN_SEASON_TOURNAMENT_ACTION = 'action:tactics-practice.open-season';

type RecordWrite = {
  address: string;
  path: string[];
  payload: unknown;
};

export type OpenSeasonTournamentDraft = {
  seasonId: string;
  label: string;
  weekCount: number;
  invites: Array<{ inviteId: string; playerRef: string; state: TacticsSeasonInvite['state'] }>;
  divisions: Array<{ divisionId: string; label: string; playerRefs: string[] }>;
  bracketMatches: Array<{ matchId: string; round: string; playerRefs: string[]; winnerRef?: string }>;
  weeklyScenarios: TacticsScenario[];
  weeklyEvidence: DecisionEvidence[];
  weeklyPrompts: DecisionPrompt[];
  coachReviews?: Array<{
    coachReviewId: string;
    resultRef?: string;
    promptRefs: string[];
    title: string;
    points: string[];
    nextPromptRefs: string[];
  }>;
  profileLinks: TacticsProfileLink[];
  championRef?: string;
  createdAt: string;
};

export type OpenSeasonTournamentInput = {
  season_id: string;
  config_record: TacticsConfig;
  season_record: TacticsSeason;
  invite_records: TacticsSeasonInvite[];
  division_records: TacticsDivision[];
  bracket_records: TacticsBracketMatch[];
  scenario_records: TacticsScenario[];
  evidence_records: DecisionEvidence[];
  prompt_records: DecisionPrompt[];
  coach_review_records: TacticsSeasonCoachReview[];
  profile_records: TacticsProfileLink[];
  record_writes: RecordWrite[];
};

export function buildOpenSeasonTournamentInput(draft: OpenSeasonTournamentDraft): OpenSeasonTournamentInput {
  const input: OpenSeasonTournamentInput = {
    season_id: draft.seasonId,
    config_record: {
      kind: 'tactics-config',
      configId: draft.seasonId,
      configKind: 'season-tactics-tournament',
      label: draft.label,
      scenarioRefs: draft.weeklyScenarios.map((scenario) => scenario.scenarioId),
      contestRefs: [],
      accessRef: `tactics-season-access:${draft.seasonId}`,
      ratingSystemRef: 'tactical-rating',
      createdAt: draft.createdAt,
    },
    season_record: {
      kind: 'tactics-season',
      seasonId: draft.seasonId,
      label: draft.label,
      inviteOnly: true,
      weekCount: draft.weekCount,
      divisionRefs: draft.divisions.map((division) => division.divisionId),
      bracketRefs: draft.bracketMatches.map((match) => match.matchId),
      weeklyScenarioRefs: draft.weeklyScenarios.map((scenario) => scenario.scenarioId),
      inviteRefs: draft.invites.map((invite) => invite.inviteId),
      championRef: draft.championRef,
      createdAt: draft.createdAt,
    },
    invite_records: draft.invites.map((invite) => ({
      kind: 'tactics-season-invite',
      inviteId: invite.inviteId,
      seasonId: draft.seasonId,
      playerRef: invite.playerRef,
      state: invite.state,
      createdAt: draft.createdAt,
    })),
    division_records: draft.divisions.map((division) => ({
      kind: 'tactics-division',
      divisionId: division.divisionId,
      seasonId: draft.seasonId,
      label: division.label,
      playerRefs: division.playerRefs,
    })),
    bracket_records: draft.bracketMatches.map((match) => ({
      kind: 'tactics-bracket-match',
      matchId: match.matchId,
      seasonId: draft.seasonId,
      round: match.round,
      playerRefs: match.playerRefs,
      winnerRef: match.winnerRef,
    })),
    scenario_records: draft.weeklyScenarios,
    evidence_records: draft.weeklyEvidence,
    prompt_records: draft.weeklyPrompts,
    coach_review_records: (draft.coachReviews ?? draft.weeklyScenarios.map((scenario) => ({
      coachReviewId: `tactics-season-coach-review:${scenario.scenarioId}`,
      promptRefs: [scenario.promptRef],
      title: `${scenario.title} coach review`,
      points: [],
      nextPromptRefs: [],
    }))).map((coachReview) => ({
      kind: 'tactics-season-coach-review',
      coachReviewId: coachReview.coachReviewId,
      seasonId: draft.seasonId,
      resultRef: coachReview.resultRef,
      promptRefs: coachReview.promptRefs,
      title: coachReview.title,
      points: coachReview.points,
      nextPromptRefs: coachReview.nextPromptRefs,
      createdAt: draft.createdAt,
    })),
    profile_records: draft.profileLinks,
    record_writes: [],
  };
  input.record_writes = [
    {
      address: `package::tactics-practice::config::${draft.seasonId}`,
      path: ['current-item', 'published-record'],
      payload: input.config_record,
    },
    {
      address: `package::tactics-practice::season::${draft.seasonId}`,
      path: ['current-item', 'published-record'],
      payload: input.season_record,
    },
    ...input.invite_records.map((record) => ({
      address: `package::tactics-practice::season-invite::${record.inviteId}`,
      path: ['current-item', 'published-record'],
      payload: record,
    })),
    ...input.division_records.map((record) => ({
      address: `package::tactics-practice::division::${record.divisionId}`,
      path: ['current-item', 'published-record'],
      payload: record,
    })),
    ...input.bracket_records.map((record) => ({
      address: `package::tactics-practice::bracket-match::${record.matchId}`,
      path: ['current-item', 'published-record'],
      payload: record,
    })),
    ...input.scenario_records.map((record) => ({
      address: `package::tactics-practice::scenario::${record.scenarioId}`,
      path: ['current-item', 'published-record'],
      payload: record,
    })),
    ...input.evidence_records.map((record) => ({
      address: `package::practice-decision-loop::evidence::${record.evidenceId}`,
      path: ['current-item', 'published-record'],
      payload: record,
    })),
    ...input.prompt_records.map((record) => ({
      address: `package::practice-decision-loop::prompt::${record.promptId}`,
      path: ['current-item', 'published-record'],
      payload: record,
    })),
    ...input.coach_review_records.map((record) => ({
      address: `package::tactics-practice::season-coach-review::${record.coachReviewId}`,
      path: ['current-item', 'published-record'],
      payload: record,
    })),
    ...input.profile_records.map((record) => ({
      address: `package::tactics-practice::profile::${record.profileId}`,
      path: ['current-item', 'published-record'],
      payload: record,
    })),
  ];
  return input;
}

export function openSeasonTournament(input: OpenSeasonTournamentInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: OPEN_SEASON_TOURNAMENT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}

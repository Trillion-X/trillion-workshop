import type {
  DecisionEvidence,
  DecisionPrompt,
} from '@/packages/practice-decision-loop/read-data/practice-decision-loop-types';
import type {
  TacticsBracketMatch,
  TacticsDivision,
  TacticsProfileLink,
  TacticsPeerVote,
  TacticsScenario,
  TacticsSeason,
  TacticsSeasonCoachReview,
  TacticsSeasonInvite,
  TacticsSeasonResult,
  TacticalRatingEffect,
  TacticsConfig,
  TacticsConfigKind,
  TacticsContest,
  TacticsContestView,
  TacticsPracticeHome,
  TacticsPracticeState,
  TacticsSeasonTournamentView,
} from './tactics-practice-types';

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

export function readTacticsPracticeState(rows: unknown): TacticsPracticeState {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return {
    configs: values.filter((value): value is TacticsConfig => kind(value) === 'tactics-config'),
    contests: values.filter((value): value is TacticsContest => kind(value) === 'tactics-contest'),
    scenarios: values.filter((value): value is TacticsScenario => kind(value) === 'tactical-scenario'),
    votes: values.filter((value): value is TacticsPeerVote => kind(value) === 'tactics-peer-vote'),
    ratingEffects: values.filter((value): value is TacticalRatingEffect => kind(value) === 'tactical-rating-effect'),
    seasonInvites: values.filter((value): value is TacticsSeasonInvite => kind(value) === 'tactics-season-invite'),
    seasons: values.filter((value): value is TacticsSeason => kind(value) === 'tactics-season'),
    divisions: values.filter((value): value is TacticsDivision => kind(value) === 'tactics-division'),
    brackets: values.filter((value): value is TacticsBracketMatch => kind(value) === 'tactics-bracket-match'),
    seasonResults: values.filter((value): value is TacticsSeasonResult => kind(value) === 'tactics-season-result'),
    seasonCoachReviews: values.filter((value): value is TacticsSeasonCoachReview => kind(value) === 'tactics-season-coach-review'),
    profiles: values.filter((value): value is TacticsProfileLink => kind(value) === 'tactics-profile-link'),
    genericEvidence: values.filter((value): value is DecisionEvidence => kind(value) === 'decision-evidence'),
    genericPrompts: values.filter((value): value is DecisionPrompt => kind(value) === 'decision-prompt'),
  };
}

export function tacticsTacticsPracticeHome(state: TacticsPracticeState): TacticsPracticeHome {
  return {
    dailyContest: state.configs.find((config) => config.configKind === 'daily-tactics-contest'),
    oneOnOneContest: state.configs.find((config) => config.configKind === 'one-on-one-tactics-contest'),
    seasonTournament: state.configs.find((config) => config.configKind === 'season-tactics-tournament'),
    activeSeason: state.seasons[0],
    scenarioCount: state.scenarios.length,
    voteCount: state.votes.length,
    ratingEffectCount: state.ratingEffects.length,
  };
}

function contestView(
  state: TacticsPracticeState,
  configKind: Exclude<TacticsConfigKind, 'season-tactics-tournament'>,
): TacticsContestView | undefined {
  const config = state.configs.find((candidate) => candidate.configKind === configKind);
  if (!config) return undefined;
  const contestRefs = new Set(config.contestRefs);
  const scenarioRefs = new Set(config.scenarioRefs);
  const scenarios = state.scenarios.filter((scenario) => scenarioRefs.has(scenario.scenarioId));
  const scenarioPromptRefs = scenarios.map((scenario) => scenario.promptRef);
  const contest = state.contests.find((candidate) => contestRefs.has(candidate.contestId));
  const promptRefs = new Set([...(contest?.promptRefs ?? []), ...scenarioPromptRefs]);
  const prompts = state.genericPrompts.filter((prompt) => promptRefs.has(prompt.promptId));
  return {
    config,
    contest,
    scenarios,
    prompts,
    votes: state.votes.filter((vote) => promptRefs.has(vote.promptId)),
    ratingEffects: state.ratingEffects.filter((effect) => promptRefs.has(effect.promptId)),
  };
}

export function dailyTacticsContestView(
  state: TacticsPracticeState,
): TacticsContestView | undefined {
  return contestView(state, 'daily-tactics-contest');
}

export function oneOnOneTacticsContestView(
  state: TacticsPracticeState,
): TacticsContestView | undefined {
  return contestView(state, 'one-on-one-tactics-contest');
}

export function seasonTournamentView(
  state: TacticsPracticeState,
): TacticsSeasonTournamentView | undefined {
  const season = state.seasons[0];
  if (!season) return undefined;
  const config = state.configs.find((candidate) => candidate.configKind === 'season-tactics-tournament');
  const inviteRefs = new Set(season.inviteRefs);
  const divisionRefs = new Set(season.divisionRefs);
  const bracketRefs = new Set(season.bracketRefs);
  const weeklyScenarioRefs = new Set(season.weeklyScenarioRefs);
  const weeklyScenarios = state.scenarios.filter((scenario) => weeklyScenarioRefs.has(scenario.scenarioId));
  const promptRefs = new Set(weeklyScenarios.map((scenario) => scenario.promptRef));
  const weeklyPrompts = state.genericPrompts.filter((prompt) => promptRefs.has(prompt.promptId));
  const evidenceRefs = new Set(weeklyPrompts.flatMap((prompt) => prompt.evidenceRefs));
  const results = state.seasonResults.filter((result) => result.seasonId === season.seasonId);
  return {
    config,
    season,
    invites: state.seasonInvites.filter((invite) => inviteRefs.has(invite.inviteId)),
    divisions: state.divisions.filter((division) => divisionRefs.has(division.divisionId)),
    brackets: state.brackets.filter((bracket) => bracketRefs.has(bracket.matchId)),
    weeklyScenarios,
    weeklyPrompts,
    weeklyEvidence: state.genericEvidence.filter((evidence) => evidenceRefs.has(evidence.evidenceId)),
    results,
    championResult: results.find((result) => result.resultKind === 'champion'),
    coachReviews: state.seasonCoachReviews.filter((coachReview) => coachReview.seasonId === season.seasonId),
    profiles: state.profiles.filter((profile) => profile.seasonId === season.seasonId || profile.promptRefs.some((promptRef) => promptRefs.has(promptRef))),
  };
}

export function assertTacticsConfigUsesGenericPrompt(
  config: TacticsConfig,
  state: TacticsPracticeState,
): TacticsConfig {
  const scenarioRefs = new Set(config.scenarioRefs);
  const scenarios = state.scenarios.filter((scenario) => scenarioRefs.has(scenario.scenarioId));
  const promptRefs = new Set(scenarios.map((scenario) => scenario.promptRef));
  if (promptRefs.size === 0) {
    throw new Error(`${config.configId} has no generic prompt link`);
  }
  const promptExists = state.genericPrompts.some((prompt) => promptRefs.has(prompt.promptId));
  if (!promptExists) {
    throw new Error(`${config.configId} points to missing generic prompt`);
  }
  return config;
}

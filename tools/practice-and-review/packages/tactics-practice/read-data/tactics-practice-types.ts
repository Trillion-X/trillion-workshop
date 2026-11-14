import type {
  DecisionEvidence,
  DecisionPrompt,
} from '@/packages/practice-decision-loop/read-data/practice-decision-loop-types';

export type TacticsConfigKind =
  | 'daily-tactics-contest'
  | 'one-on-one-tactics-contest'
  | 'season-tactics-tournament';

export type CourtZone = 'A' | 'B' | 'C' | 'D';

export type TacticsScenario = {
  kind: 'tactical-scenario';
  scenarioId: string;
  title: string;
  situation: string;
  courtZones: CourtZone[];
  evidenceRefs: string[];
  promptRef: string;
  createdAt: string;
};

export type TacticsConfig = {
  kind: 'tactics-config';
  configId: string;
  configKind: TacticsConfigKind;
  label: string;
  scenarioRefs: string[];
  contestRefs: string[];
  accessRef?: string;
  ratingSystemRef?: string;
  createdAt: string;
};

export type TacticsContest = {
  kind: 'tactics-contest';
  contestId: string;
  configKind: Exclude<TacticsConfigKind, 'season-tactics-tournament'>;
  label: string;
  promptRefs: string[];
  participantRefs: string[];
  startsAt: string;
  closesAt?: string;
  resultRef?: string;
  createdAt: string;
};

export type TacticsPeerVote = {
  kind: 'tactics-peer-vote';
  voteId: string;
  promptId: string;
  responseId: string;
  voterId: string;
  vote: 'stronger' | 'weaker' | 'same' | 'unsafe';
  createdAt: string;
};

export type TacticalRatingEffect = {
  kind: 'tactical-rating-effect';
  effectId: string;
  playerId: string;
  promptId: string;
  responseId: string;
  delta: number;
  reason: string;
  createdAt: string;
};

export type TacticsSeasonInvite = {
  kind: 'tactics-season-invite';
  inviteId: string;
  seasonId: string;
  playerRef: string;
  state: 'invited' | 'accepted' | 'declined';
  createdAt: string;
};

export type TacticsSeason = {
  kind: 'tactics-season';
  seasonId: string;
  label: string;
  inviteOnly: boolean;
  weekCount: number;
  divisionRefs: string[];
  bracketRefs: string[];
  weeklyScenarioRefs: string[];
  inviteRefs: string[];
  championRef?: string;
  createdAt: string;
};

export type TacticsDivision = {
  kind: 'tactics-division';
  divisionId: string;
  seasonId: string;
  label: string;
  playerRefs: string[];
};

export type TacticsBracketMatch = {
  kind: 'tactics-bracket-match';
  matchId: string;
  seasonId: string;
  round: string;
  playerRefs: string[];
  winnerRef?: string;
};

export type TacticsSeasonResult = {
  kind: 'tactics-season-result';
  resultId: string;
  seasonId: string;
  resultKind: 'weekly-scenario' | 'division' | 'playoff' | 'champion';
  promptRef?: string;
  bracketRef?: string;
  playerRef: string;
  score: number;
  evidenceRefs: string[];
  createdAt: string;
};

export type TacticsSeasonCoachReview = {
  kind: 'tactics-season-coach-review';
  coachReviewId: string;
  seasonId: string;
  resultRef?: string;
  promptRefs: string[];
  title: string;
  points: string[];
  nextPromptRefs: string[];
  createdAt: string;
};

export type TacticsProfileLink = {
  kind: 'tactics-profile-link';
  profileId: string;
  subjectRef: string;
  seasonId?: string;
  promptRefs: string[];
  evidenceRefs: string[];
};

export type TacticsPracticeState = {
  configs: TacticsConfig[];
  contests: TacticsContest[];
  scenarios: TacticsScenario[];
  votes: TacticsPeerVote[];
  ratingEffects: TacticalRatingEffect[];
  seasonInvites: TacticsSeasonInvite[];
  seasons: TacticsSeason[];
  divisions: TacticsDivision[];
  brackets: TacticsBracketMatch[];
  seasonResults: TacticsSeasonResult[];
  seasonCoachReviews: TacticsSeasonCoachReview[];
  profiles: TacticsProfileLink[];
  genericEvidence: DecisionEvidence[];
  genericPrompts: DecisionPrompt[];
};

export type TacticsPracticeHome = {
  dailyContest?: TacticsConfig;
  oneOnOneContest?: TacticsConfig;
  seasonTournament?: TacticsConfig;
  activeSeason?: TacticsSeason;
  scenarioCount: number;
  voteCount: number;
  ratingEffectCount: number;
};

export type TacticsContestView = {
  config: TacticsConfig;
  contest?: TacticsContest;
  scenarios: TacticsScenario[];
  prompts: DecisionPrompt[];
  votes: TacticsPeerVote[];
  ratingEffects: TacticalRatingEffect[];
};

export type TacticsSeasonTournamentView = {
  config?: TacticsConfig;
  season: TacticsSeason;
  invites: TacticsSeasonInvite[];
  divisions: TacticsDivision[];
  brackets: TacticsBracketMatch[];
  weeklyScenarios: TacticsScenario[];
  weeklyPrompts: DecisionPrompt[];
  weeklyEvidence: DecisionEvidence[];
  results: TacticsSeasonResult[];
  championResult?: TacticsSeasonResult;
  coachReviews: TacticsSeasonCoachReview[];
  profiles: TacticsProfileLink[];
};

export type TennisHand = 'right' | 'left' | 'unknown';

export type TennisPlayerStyle =
  | 'serve-and-volley'
  | 'baseliner'
  | 'grinder'
  | 'all-court'
  | 'counterpuncher'
  | 'attacker';

export type CourtZone = 'A' | 'B' | 'C' | 'D';

export type ShotRatingKey =
  | 'first-serve'
  | 'second-serve'
  | 'forehand-return'
  | 'backhand-return'
  | 'forehand'
  | 'backhand'
  | 'slice'
  | 'volley'
  | 'dropshot'
  | 'spin'
  | 'power'
  | 'speed'
  | 'endurance';

export const SHOT_RATING_KEYS: readonly ShotRatingKey[] = [
  'first-serve',
  'second-serve',
  'forehand-return',
  'backhand-return',
  'forehand',
  'backhand',
  'slice',
  'volley',
  'dropshot',
  'spin',
  'power',
  'speed',
  'endurance',
];

export type ShotRatings = Partial<Record<ShotRatingKey, number>>;

export type ScoutingVisibility = 'public' | 'private' | 'coach';

export type ScoutingSource = {
  sourceId: string;
  label?: string;
  confidence?: number;
  visibility: ScoutingVisibility;
};

export type EvidenceConfidencePolicy = {
  kind: 'evidence-confidence-policy';
  policyId: string;
  minimumConfidence: number;
  missingConfidenceIsUsable: boolean;
};

export type SubjectRef = {
  id: string;
  kind: string;
  label?: string;
};

export type TennisPlayerPayload = {
  hand?: TennisHand;
  isSelf?: boolean;
};

export type TennisPlayerIdentity = {
  kind: 'subject';
  subjectId: string;
  subjectKind: 'tennis-player';
  label: string;
  payload: TennisPlayerPayload;
  createdAt: string;
};

export type TennisPlayerReportPayload = {
  authorId: string;
  visibility: ScoutingVisibility;
  styleLabels: TennisPlayerStyle[];
  strengths: string[];
  weaknesses: string[];
  strategiesWorked: string[];
  strategiesFailed: string[];
  notes?: string;
  confidence?: number;
};

export type TennisPlayerReport = {
  kind: 'evidence';
  evidenceId: string;
  subject: SubjectRef;
  evidenceKind: 'player-report';
  source: ScoutingSource;
  payload: TennisPlayerReportPayload;
  createdAt: string;
};

export type CourtZoneProfilePayload = {
  hand?: TennisHand;
  quadrantMeaning?: Partial<Record<CourtZone, string>>;
  strongestShot?: string;
  weakestShot?: string;
  playingStyle?: TennisPlayerStyle;
  winners?: {
    from?: CourtZone;
    to?: CourtZone;
    rallyContext?: string;
  };
  errors?: {
    from?: CourtZone;
    rallyContext?: string;
  };
  shotRatings: ShotRatings;
};

export type CourtZoneProfile = {
  kind: 'profile-projection';
  profileId: string;
  subject: SubjectRef;
  projectionKind: 'court-zone-profile';
  source: ScoutingSource;
  sourceRefs: string[];
  payload: CourtZoneProfilePayload;
  createdAt: string;
};

export type MatchPlanRequest = {
  kind: 'plan-request';
  requestId: string;
  requestKind: 'match-plan';
  requesterId: string;
  selfPlayerId: string;
  opponentPlayerId: string;
  publicEvidenceRefs: string[];
  privateEvidenceRefs: string[];
  reviewEvidenceRefs?: string[];
  profileRefs: string[];
  resultRefs: string[];
  promptText: string;
  createdAt: string;
};

export type MatchPlanTactic = {
  tacticId: string;
  label: string;
  reason?: string;
};

export type MatchPlanStrategy = {
  strategyId: string;
  name: string;
  tactics: [MatchPlanTactic, MatchPlanTactic, MatchPlanTactic];
};

export type MatchStrategyPlan = {
  kind: 'result';
  resultKind: 'match-plan';
  resultId: string;
  planId: string;
  requestId: string;
  selfPlayerId: string;
  opponentPlayerId: string;
  strategies: [MatchPlanStrategy, MatchPlanStrategy];
  evidenceRefs: string[];
  createdAt: string;
};

export type TacticResultOutcome = 'worked' | 'failed' | 'mixed';

export type TacticResultPayload = {
  planId?: string;
  strategyId?: string;
  tacticId?: string;
  outcome: TacticResultOutcome;
  notes?: string;
  matchRef?: string;
};

export type TacticResult = {
  kind: 'result';
  resultKind: 'tactic-outcome';
  resultId: string;
  subject: SubjectRef;
  selfPlayerId: string;
  opponentPlayerId: string;
  sourceRefs: string[];
  payload: TacticResultPayload;
  createdAt: string;
};

export type OpponentGamePlanRecord =
  | TennisPlayerIdentity
  | TennisPlayerReport
  | CourtZoneProfile
  | EvidenceConfidencePolicy
  | MatchPlanRequest
  | MatchStrategyPlan
  | TacticResult;

export type OpponentGamePlanState = {
  players: TennisPlayerIdentity[];
  reports: TennisPlayerReport[];
  profiles: CourtZoneProfile[];
  requests: MatchPlanRequest[];
  plans: MatchStrategyPlan[];
  tacticResults: TacticResult[];
};

export type OpponentSearchRow = {
  playerId: string;
  name: string;
  hand?: TennisHand;
  styleLabels: TennisPlayerStyle[];
  reportCount: number;
  profileCount: number;
  workedCount: number;
  failedCount: number;
};

export type TacticOutcomeSummary = {
  resultId: string;
  outcome: TacticResultOutcome;
  planId?: string;
  strategyId?: string;
  strategyName?: string;
  tacticId?: string;
  tacticLabel?: string;
  notes?: string;
  matchRef?: string;
};

export type OpponentProfileView = {
  player?: TennisPlayerIdentity;
  reports: TennisPlayerReport[];
  publicReports: TennisPlayerReport[];
  privateReports: TennisPlayerReport[];
  profiles: CourtZoneProfile[];
  plans: MatchStrategyPlan[];
  tacticResults: TacticResult[];
  tacticOutcomes: TacticOutcomeSummary[];
  strengths: string[];
  weaknesses: string[];
  strategiesWorked: string[];
  strategiesFailed: string[];
  styleLabels: TennisPlayerStyle[];
  shotRatings: ShotRatings;
};

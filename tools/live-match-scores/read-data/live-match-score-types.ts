export type LiveMatchFormat = 'singles' | 'doubles';
export type LiveMatchStatus = 'live' | 'complete';
export type LiveScoreSide = 'team-a' | 'team-b';
export type LiveScoreEventKind = 'start' | 'score' | 'finish';
export type LiveScoreLocalState = 'confirmed' | 'pending-offline' | 'reconciled';

export type LiveMatchTeam = {
  teamId: LiveScoreSide;
  label: string;
  players: string[];
};

export type LiveMatchScoringModel = {
  scoreUnit: 'game' | 'point';
  setsToWin: number;
  gamesToWinSet: number;
  tiebreakAt: number;
  pointsToWinTiebreak: number;
  winBy: number;
  /** A labeled point ladder (e.g. ["0","15","30","40"]). When present, the score
   *  displays these labels instead of raw counts; when absent, raw counts show
   *  (e.g. pickleball). This is the DATA that replaces the `sport === 'tennis'`
   *  display branch — a scoring-rule carries its own display vocabulary. */
  pointLabels?: string[];
  /** An advantage label (e.g. "AD"). When present, a deuce/advantage zone applies
   *  at the final ladder label; when absent, sudden death at the final label
   *  (e.g. padel golden point). Replaces the hardcoded tennis 40-40/AD logic. */
  advantageLabel?: string;
};

export type LiveMatchShare = {
  shareId: string;
  publicPath: string;
  enabled: boolean;
};

export type LiveMatchRecord = {
  kind: 'live-match';
  matchId: string;
  scoringRuleRef: string;
  matchFormat: LiveMatchFormat;
  teams: [LiveMatchTeam, LiveMatchTeam];
  scoringModel: LiveMatchScoringModel;
  status: LiveMatchStatus;
  share: LiveMatchShare;
  createdBy?: string;
  createdAt: string;
};

export type LiveScorePayload = {
  teamScores: Record<LiveScoreSide, number>;
  setNumber: number;
  pointScores?: Record<LiveScoreSide, number>;
  gameScores?: Record<LiveScoreSide, number>;
  setScores?: Record<LiveScoreSide, number>;
  displayScores?: Record<LiveScoreSide, string>;
  serverTeamId?: LiveScoreSide;
  scoringPhase?: string;
  winnerTeamId?: LiveScoreSide;
};

export type LiveScoreEventRecord = {
  kind: 'live-score-event';
  eventId: string;
  matchId: string;
  sequence: number;
  actorId?: string;
  eventKind: LiveScoreEventKind;
  score: LiveScorePayload;
  localState: LiveScoreLocalState;
  createdAt: string;
};

export type LiveMatchContextRecord = {
  kind: 'live-match-context-link';
  contextId: string;
  matchId: string;
  tournamentId?: string;
  scheduleRowId?: string;
  bracketMatchId?: string;
  standingId?: string;
  leaderboardId?: string;
  createdAt: string;
};

export type LiveMatchBoardScheduleRow = {
  kind: 'live-match-board-schedule-row';
  scheduleRowId: string;
  matchId: string;
  startsAt: string;
  courtLabel?: string;
  roundLabel?: string;
  status: 'scheduled' | 'live' | 'complete';
};

export type LiveMatchBoardBracketRow = {
  kind: 'live-match-board-bracket-row';
  bracketMatchId: string;
  matchId: string;
  bracketLabel?: string;
  roundLabel: string;
  positionLabel?: string;
  winnerTeamId?: LiveScoreSide;
  nextMatchId?: string;
};

export type LiveMatchBoardStandingRow = {
  kind: 'live-match-board-standing-row';
  standingId: string;
  matchId: string;
  teamId: LiveScoreSide;
  teamLabel: string;
  divisionLabel?: string;
  rank: number;
  wins: number;
  losses: number;
  points?: number;
};

export type LiveMatchBoardLeaderboardRow = {
  kind: 'live-match-board-leaderboard-row';
  leaderboardId: string;
  matchId: string;
  subjectId: string;
  label: string;
  rank: number;
  score: number;
  movement?: 'up' | 'down' | 'same';
};

export type LiveMatchScoreRecord =
  | LiveMatchRecord
  | LiveScoreEventRecord
  | LiveMatchContextRecord
  | LiveMatchBoardScheduleRow
  | LiveMatchBoardBracketRow
  | LiveMatchBoardStandingRow
  | LiveMatchBoardLeaderboardRow;

export type LiveMatchScoreState = {
  matches: LiveMatchRecord[];
  events: LiveScoreEventRecord[];
  contexts: LiveMatchContextRecord[];
  scheduleRows: LiveMatchBoardScheduleRow[];
  bracketRows: LiveMatchBoardBracketRow[];
  standingRows: LiveMatchBoardStandingRow[];
  leaderboardRows: LiveMatchBoardLeaderboardRow[];
};

export type LiveMatchSpectatorView = {
  matchId: string;
  scoringRuleRef: string;
  matchFormat: LiveMatchFormat;
  teamLabels: [string, string];
  players: [string[], string[]];
  score: LiveScorePayload;
  status: LiveMatchStatus;
  publicPath: string;
  eventCount: number;
};

export type LiveMatchScoreView = {
  match: LiveMatchRecord;
  latestEvent?: LiveScoreEventRecord;
  score: LiveScorePayload;
  eventCount: number;
  context?: LiveMatchContextRecord;
  spectator: LiveMatchSpectatorView;
};

export type LiveMatchBoardRow = {
  matchId: string;
  label: string;
  scoringRuleRef: string;
  status: LiveMatchStatus;
  scoreLine: string;
  publicPath: string;
  tournamentId?: string;
  scheduleRowId?: string;
  bracketMatchId?: string;
  standingId?: string;
  leaderboardId?: string;
  schedule?: LiveMatchBoardScheduleRow;
  bracket?: LiveMatchBoardBracketRow;
  standings: LiveMatchBoardStandingRow[];
  leaderboard: LiveMatchBoardLeaderboardRow[];
};

export type LiveMatchBoardProjection = {
  rows: LiveMatchBoardRow[];
  schedule: LiveMatchBoardScheduleRow[];
  brackets: LiveMatchBoardBracketRow[];
  standings: LiveMatchBoardStandingRow[];
  leaderboard: LiveMatchBoardLeaderboardRow[];
};

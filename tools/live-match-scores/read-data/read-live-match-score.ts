import type {
  LiveMatchBoardBracketRow,
  LiveMatchBoardLeaderboardRow,
  LiveMatchBoardProjection,
  LiveMatchBoardRow,
  LiveMatchBoardScheduleRow,
  LiveMatchBoardStandingRow,
  LiveMatchContextRecord,
  LiveMatchRecord,
  LiveMatchScoreState,
  LiveMatchScoreView,
  LiveMatchSpectatorView,
  LiveScoreEventRecord,
  LiveScorePayload,
  LiveScoreSide,
} from './live-match-score-types.ts';
import { applyScoringRuleDisplay } from './scoring-rules.ts';

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

const EMPTY_SCORE: LiveScorePayload = {
  setNumber: 1,
  teamScores: {
    'team-a': 0,
    'team-b': 0,
  },
};

const SIDES: [LiveScoreSide, LiveScoreSide] = ['team-a', 'team-b'];

function eventsForMatch(state: LiveMatchScoreState, matchId: string): LiveScoreEventRecord[] {
  return state.events
    .filter((event) => event.matchId === matchId)
    .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt));
}

function eventStateRank(event: LiveScoreEventRecord): number {
  if (event.localState === 'reconciled') return 3;
  if (event.localState === 'confirmed') return 2;
  return 1;
}

function chooseEventForSequence(
  current: LiveScoreEventRecord | undefined,
  candidate: LiveScoreEventRecord,
): LiveScoreEventRecord {
  if (!current) return candidate;
  const rank = eventStateRank(candidate) - eventStateRank(current);
  if (rank > 0) return candidate;
  if (rank < 0) return current;
  return candidate.createdAt >= current.createdAt ? candidate : current;
}

function replayedEventsForMatch(state: LiveMatchScoreState, matchId: string): LiveScoreEventRecord[] {
  const bySequence = new Map<number, LiveScoreEventRecord>();
  for (const event of eventsForMatch(state, matchId)) {
    bySequence.set(event.sequence, chooseEventForSequence(bySequence.get(event.sequence), event));
  }
  return Array.from(bySequence.values()).sort(
    (a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt),
  );
}

function publicEventsForMatch(state: LiveMatchScoreState, matchId: string): LiveScoreEventRecord[] {
  return replayedEventsForMatch(state, matchId).filter((event) => event.localState !== 'pending-offline');
}

function latestEvent(events: readonly LiveScoreEventRecord[]): LiveScoreEventRecord | undefined {
  return events[events.length - 1];
}

export function previousScoreForMatch(state: LiveMatchScoreState, matchId: string): LiveScorePayload | undefined {
  const events = replayedEventsForMatch(state, matchId);
  return events[events.length - 2]?.score;
}

function otherSide(side: LiveScoreSide): LiveScoreSide {
  return side === 'team-a' ? 'team-b' : 'team-a';
}

function scorePair(source: Record<LiveScoreSide, number> | undefined): Record<LiveScoreSide, number> {
  return {
    'team-a': source?.['team-a'] ?? 0,
    'team-b': source?.['team-b'] ?? 0,
  };
}

function isWon(a: number, b: number, target: number, winBy: number): boolean {
  return a >= target && a - b >= winBy;
}

/** Normalize + display a score from the match's RULE MODEL (DATA), never a sport
 *  literal. The old `tennisPointLabels` + `match.sport === 'tennis'` phase/display
 *  branches are dissolved into `applyScoringRuleDisplay` (scoring-rules.ts): the
 *  rule's `pointLabels`/`advantageLabel`/`tiebreakAt` DATA drive phase + display,
 *  so tennis, pickleball, padel, and any future rule score with zero code (L030/
 *  L090). The scoring math (sets/games/tiebreak) already reads `match.scoringModel`
 *  generically — only the sport-literal phase/display branch was the violation. */
function normalizeScore(match: LiveMatchRecord, score: LiveScorePayload): LiveScorePayload {
  return applyScoringRuleDisplay(match.scoringModel, score);
}

function scoreWithSetWinner(match: LiveMatchRecord, score: LiveScorePayload, side: LiveScoreSide): LiveScorePayload {
  const setScores = scorePair(score.setScores);
  const nextSetScores = { ...setScores, [side]: setScores[side] + 1 };
  const winnerTeamId = nextSetScores[side] >= match.scoringModel.setsToWin ? side : undefined;
  return normalizeScore(match, {
    ...score,
    teamScores: { 'team-a': 0, 'team-b': 0 },
    pointScores: { 'team-a': 0, 'team-b': 0 },
    gameScores: { 'team-a': 0, 'team-b': 0 },
    setScores: nextSetScores,
    setNumber: score.setNumber + (winnerTeamId ? 0 : 1),
    scoringPhase: winnerTeamId ? 'complete' : 'standard',
    winnerTeamId,
  });
}

function scoreWithGameWinner(match: LiveMatchRecord, score: LiveScorePayload, side: LiveScoreSide): LiveScorePayload {
  const gameScores = scorePair(score.gameScores ?? score.teamScores);
  const nextGameScores = { ...gameScores, [side]: gameScores[side] + 1 };
  const opponent = otherSide(side);
  const setWon =
    isWon(nextGameScores[side], nextGameScores[opponent], match.scoringModel.gamesToWinSet, match.scoringModel.winBy)
    || (
      match.scoringModel.tiebreakAt > 0
      && nextGameScores[side] === match.scoringModel.tiebreakAt + 1
      && nextGameScores[opponent] === match.scoringModel.tiebreakAt
    );

  if (setWon) {
    return scoreWithSetWinner(match, {
      ...score,
      teamScores: nextGameScores,
      gameScores: nextGameScores,
      pointScores: { 'team-a': 0, 'team-b': 0 },
    }, side);
  }

  return normalizeScore(match, {
    ...score,
    teamScores: nextGameScores,
    gameScores: nextGameScores,
    pointScores: { 'team-a': 0, 'team-b': 0 },
  });
}

/** Score one point inside a LABELED-LADDER game (a rule whose model carries
 *  `pointLabels`, e.g. tennis/padel). The game-win constants are read from the
 *  rule MODEL (DATA), never hardcoded for "tennis": a game is won by reaching the
 *  final ladder rung (`pointLabels.length`, default 4) with the rule's game lead —
 *  win-by-2 (advantage) when the rule declares an `advantageLabel`, else win-by-1
 *  (golden point, e.g. padel). So a golden-point rule scores correctly from a DATA
 *  row with zero code (L090) — the old hardcoded `isWon(...,4,2)` was the buried
 *  tennis assumption that SCR01 dissolves alongside the sport enum. */
function scoreLabeledPoint(match: LiveMatchRecord, score: LiveScorePayload, side: LiveScoreSide): LiveScorePayload {
  if (score.winnerTeamId) return normalizeScore(match, score);
  const normalized = normalizeScore(match, score);
  const points = scorePair(normalized.pointScores);
  const games = scorePair(normalized.gameScores ?? normalized.teamScores);
  const opponent = otherSide(side);
  const inTiebreak =
    match.scoringModel.tiebreakAt > 0
    && games['team-a'] >= match.scoringModel.tiebreakAt
    && games['team-b'] >= match.scoringModel.tiebreakAt;
  const nextPoints = { ...points, [side]: points[side] + 1 };
  // Game-win thresholds from the rule model, not a tennis literal.
  const gamePointsToWin = match.scoringModel.pointLabels?.length ?? 4;
  const gameWinBy = match.scoringModel.advantageLabel ? 2 : 1;

  if (inTiebreak) {
    if (isWon(nextPoints[side], nextPoints[opponent], match.scoringModel.pointsToWinTiebreak, match.scoringModel.winBy)) {
      return scoreWithGameWinner(match, {
        ...normalized,
        pointScores: nextPoints,
        scoringPhase: 'tiebreak',
      }, side);
    }
    return normalizeScore(match, {
      ...normalized,
      pointScores: nextPoints,
      scoringPhase: 'tiebreak',
    });
  }

  if (isWon(nextPoints[side], nextPoints[opponent], gamePointsToWin, gameWinBy)) {
    return scoreWithGameWinner(match, {
      ...normalized,
      pointScores: nextPoints,
      scoringPhase: 'standard',
    }, side);
  }
  return normalizeScore(match, {
    ...normalized,
    pointScores: nextPoints,
    scoringPhase: 'standard',
  });
}

function scorePointUnit(match: LiveMatchRecord, score: LiveScorePayload, side: LiveScoreSide): LiveScorePayload {
  if (score.winnerTeamId) return normalizeScore(match, score);
  const normalized = normalizeScore(match, score);
  const nextScores = { ...normalized.teamScores, [side]: normalized.teamScores[side] + 1 };
  const opponent = otherSide(side);
  const winnerTeamId = isWon(nextScores[side], nextScores[opponent], match.scoringModel.gamesToWinSet, match.scoringModel.winBy) ? side : undefined;
  const previousSets = scorePair(normalized.setScores);
  return normalizeScore(match, {
    ...normalized,
    teamScores: nextScores,
    gameScores: nextScores,
    setScores: winnerTeamId ? { ...previousSets, [side]: previousSets[side] + 1 } : previousSets,
    scoringPhase: winnerTeamId ? 'complete' : 'standard',
    winnerTeamId,
  });
}

function statusForMatch(match: LiveMatchRecord, events: readonly LiveScoreEventRecord[]) {
  return latestEvent(events)?.score.winnerTeamId ? 'complete' : match.status;
}

function fallbackStandingRows(view: LiveMatchScoreView, context: LiveMatchContextRecord | undefined): LiveMatchBoardStandingRow[] {
  const winner = view.score.winnerTeamId;
  if (!winner) return [];
  return SIDES.map((side, index) => {
    const won = side === winner;
    return {
      kind: 'live-match-board-standing-row',
      standingId: `${context?.standingId ?? view.match.matchId}:${side}`,
      matchId: view.match.matchId,
      teamId: side,
      teamLabel: view.match.teams[index].label,
      divisionLabel: context?.tournamentId,
      rank: won ? 1 : 2,
      wins: won ? 1 : 0,
      losses: won ? 0 : 1,
      points: won ? 3 : 0,
    };
  });
}

function fallbackLeaderboardRows(view: LiveMatchScoreView, context: LiveMatchContextRecord | undefined): LiveMatchBoardLeaderboardRow[] {
  const winner = view.score.winnerTeamId;
  if (!winner) return [];
  return SIDES.map((side, index) => {
    const won = side === winner;
    return {
      kind: 'live-match-board-leaderboard-row',
      leaderboardId: `${context?.leaderboardId ?? view.match.matchId}:${side}`,
      matchId: view.match.matchId,
      subjectId: view.match.teams[index].teamId,
      label: view.match.teams[index].label,
      rank: won ? 1 : 2,
      score: won ? 1 : 0,
      movement: 'same',
    };
  });
}

function contextForMatch(state: LiveMatchScoreState, matchId: string): LiveMatchContextRecord | undefined {
  return state.contexts
    .filter((context) => context.matchId === matchId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function readLiveMatchScoreState(rows: unknown): LiveMatchScoreState {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return {
    matches: values.filter((value): value is LiveMatchRecord => kind(value) === 'live-match'),
    events: values.filter((value): value is LiveScoreEventRecord => kind(value) === 'live-score-event'),
    contexts: values.filter((value): value is LiveMatchContextRecord => kind(value) === 'live-match-context-link'),
    scheduleRows: values.filter((value): value is LiveMatchBoardScheduleRow => kind(value) === 'live-match-board-schedule-row'),
    bracketRows: values.filter((value): value is LiveMatchBoardBracketRow => kind(value) === 'live-match-board-bracket-row'),
    standingRows: values.filter((value): value is LiveMatchBoardStandingRow => kind(value) === 'live-match-board-standing-row'),
    leaderboardRows: values.filter((value): value is LiveMatchBoardLeaderboardRow => kind(value) === 'live-match-board-leaderboard-row'),
  };
}

export function spectatorViewForMatch(
  match: LiveMatchRecord,
  events: readonly LiveScoreEventRecord[],
): LiveMatchSpectatorView {
  const latest = latestEvent(events);
  const score = normalizeScore(match, latest?.score ?? EMPTY_SCORE);
  return {
    matchId: match.matchId,
    scoringRuleRef: match.scoringRuleRef,
    matchFormat: match.matchFormat,
    teamLabels: [match.teams[0].label, match.teams[1].label],
    players: [match.teams[0].players, match.teams[1].players],
    score,
    status: statusForMatch(match, events),
    publicPath: match.share.publicPath,
    eventCount: events.length,
  };
}

export function liveMatchScoreView(state: LiveMatchScoreState, matchId: string): LiveMatchScoreView | undefined {
  const match = state.matches.find((candidate) => candidate.matchId === matchId);
  if (!match) return undefined;
  const events = replayedEventsForMatch(state, matchId);
  const publicEvents = publicEventsForMatch(state, matchId);
  const latest = latestEvent(events);
  const score = normalizeScore(match, latest?.score ?? EMPTY_SCORE);
  return {
    match,
    latestEvent: latest,
    score,
    eventCount: events.length,
    context: contextForMatch(state, matchId),
    spectator: spectatorViewForMatch(match, publicEvents),
  };
}

export function liveMatchScoreViews(state: LiveMatchScoreState): LiveMatchScoreView[] {
  return state.matches
    .map((match) => liveMatchScoreView(state, match.matchId))
    .filter((view): view is LiveMatchScoreView => Boolean(view))
    .sort((a, b) => b.match.createdAt.localeCompare(a.match.createdAt));
}

export function liveMatchBoardRows(state: LiveMatchScoreState): LiveMatchBoardRow[] {
  return liveMatchScoreViews(state).map((view) => {
    const [teamA, teamB] = view.spectator.teamLabels;
    const boardScores = view.spectator.score.gameScores ?? view.spectator.score.teamScores;
    const scoreA = boardScores['team-a'];
    const scoreB = boardScores['team-b'];
    const schedule = state.scheduleRows.find((row) => row.matchId === view.match.matchId || row.scheduleRowId === view.context?.scheduleRowId);
    const bracket = state.bracketRows.find((row) => row.matchId === view.match.matchId || row.bracketMatchId === view.context?.bracketMatchId);
    const explicitStandings = state.standingRows
      .filter((row) => row.matchId === view.match.matchId || row.standingId === view.context?.standingId)
      .sort((a, b) => a.rank - b.rank || a.teamLabel.localeCompare(b.teamLabel));
    const explicitLeaderboard = state.leaderboardRows
      .filter((row) => row.matchId === view.match.matchId || row.leaderboardId === view.context?.leaderboardId)
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
    const standings = explicitStandings.length > 0 ? explicitStandings : fallbackStandingRows(view, view.context);
    const leaderboard = explicitLeaderboard.length > 0 ? explicitLeaderboard : fallbackLeaderboardRows(view, view.context);
    return {
      matchId: view.match.matchId,
      label: `${teamA} vs ${teamB}`,
      scoringRuleRef: view.match.scoringRuleRef,
      status: view.spectator.status,
      scoreLine: `${scoreA}-${scoreB}`,
      publicPath: view.match.share.publicPath,
      tournamentId: view.context?.tournamentId,
      scheduleRowId: view.context?.scheduleRowId,
      bracketMatchId: view.context?.bracketMatchId,
      standingId: view.context?.standingId,
      leaderboardId: view.context?.leaderboardId,
      schedule,
      bracket,
      standings,
      leaderboard,
    };
  });
}

export function liveMatchBoardProjection(state: LiveMatchScoreState): LiveMatchBoardProjection {
  const rows = liveMatchBoardRows(state);
  return {
    rows,
    schedule: [...state.scheduleRows].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    brackets: [...state.bracketRows].sort((a, b) => a.roundLabel.localeCompare(b.roundLabel) || (a.positionLabel ?? '').localeCompare(b.positionLabel ?? '')),
    standings: rows.flatMap((row) => row.standings).sort((a, b) => a.rank - b.rank || a.teamLabel.localeCompare(b.teamLabel)),
    leaderboard: rows.flatMap((row) => row.leaderboard).sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)),
  };
}

export function nextSequenceForMatch(state: LiveMatchScoreState, matchId: string): number {
  const latest = latestEvent(eventsForMatch(state, matchId));
  return latest ? latest.sequence + 1 : 1;
}

export function scoreWithDelta(score: LiveScorePayload, side: 'team-a' | 'team-b', delta: number): LiveScorePayload {
  const next = Math.max(0, score.teamScores[side] + delta);
  const teamScores = {
    ...score.teamScores,
    [side]: next,
  };
  return {
    ...score,
    teamScores,
    gameScores: score.gameScores ? { ...score.gameScores, [side]: next } : score.gameScores,
    displayScores: score.displayScores ? { ...score.displayScores, [side]: String(next) } : score.displayScores,
  };
}

export function scorePointForSide(match: LiveMatchRecord, score: LiveScorePayload, side: LiveScoreSide): LiveScorePayload {
  return match.scoringModel.scoreUnit === 'game'
    ? scoreLabeledPoint(match, score, side)
    : scorePointUnit(match, score, side);
}

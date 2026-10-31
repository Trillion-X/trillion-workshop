// tools/live-match-scores/read-data/match-replay.mjs
//
// A match is an append-only log: the match record, then score events ({ kind: "live-score-event", matchId, sequence,
// score, localState, createdAt }). Every view is replayed from that log.
//   * Two events with the same sequence (a tap made offline and its confirmation) keep one, chosen by state:
//     reconciled, then confirmed, then pending-offline; the same state keeps the later createdAt.
//   * The scorer sees every replayed event; a spectator sees none that is still pending-offline.
//   * The board lists each match with its score line, its linked schedule, bracket, standing and leaderboard rows; a
//     finished match with no standing or leaderboard row of its own gets a one-match row for each side.
import { applyScoringRuleDisplay } from './scoring-rules.mjs';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const payloadOf = row => (isRecord(row) ? (row.payload ?? row.value ?? row) : row);
const kindOf = value => (isRecord(value) && typeof value.kind === 'string' ? value.kind : '');
const SIDES = ['team-a', 'team-b'];
const EMPTY_SCORE = { setNumber: 1, teamScores: { 'team-a': 0, 'team-b': 0 } };

const inOrder = (a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt);
const stateRank = event => (event.localState === 'reconciled' ? 3 : event.localState === 'confirmed' ? 2 : 1);

function chooseForSequence(current, candidate) {
  if (!current) return candidate;
  const rank = stateRank(candidate) - stateRank(current);
  if (rank !== 0) return rank > 0 ? candidate : current;
  return candidate.createdAt >= current.createdAt ? candidate : current;
}

function replayedEvents(state, matchId) {
  const bySequence = new Map();
  for (const event of state.events.filter(item => item.matchId === matchId).sort(inOrder)) {
    bySequence.set(event.sequence, chooseForSequence(bySequence.get(event.sequence), event));
  }
  return [...bySequence.values()].sort(inOrder);
}

const publicEvents = (state, matchId) => replayedEvents(state, matchId).filter(event => event.localState !== 'pending-offline');
const latest = events => events[events.length - 1];

export function readMatchState(rows) {
  const values = Array.isArray(rows) ? rows.map(payloadOf) : [];
  const of = kind => values.filter(value => kindOf(value) === kind);
  return {
    matches: of('live-match'),
    events: of('live-score-event'),
    contexts: of('live-match-context-link'),
    scheduleRows: of('live-match-board-schedule-row'),
    bracketRows: of('live-match-board-bracket-row'),
    standingRows: of('live-match-board-standing-row'),
    leaderboardRows: of('live-match-board-leaderboard-row'),
  };
}

// The score before the latest replayed event, or undefined when there is none: what an undo returns to.
export function previousScoreForMatch(state, matchId) {
  return replayedEvents(state, matchId).at(-2)?.score;
}

// The next sequence number: one past the highest event of this match, 1 for a match with none.
export function nextSequenceForMatch(state, matchId) {
  const events = state.events.filter(event => event.matchId === matchId).sort(inOrder);
  return events.length ? latest(events).sequence + 1 : 1;
}

function spectatorView(match, events) {
  const score = applyScoringRuleDisplay(match.scoringModel, latest(events)?.score ?? EMPTY_SCORE);
  return {
    matchId: match.matchId,
    scoringRuleRef: match.scoringRuleRef,
    matchFormat: match.matchFormat,
    teamLabels: [match.teams[0].label, match.teams[1].label],
    players: [match.teams[0].players, match.teams[1].players],
    score,
    status: latest(events)?.score.winnerTeamId ? 'complete' : match.status,
    publicPath: match.share.publicPath,
    eventCount: events.length,
  };
}

export function matchView(state, matchId) {
  const match = state.matches.find(item => item.matchId === matchId);
  if (!match) return undefined;
  const events = replayedEvents(state, matchId);
  const latestEvent = latest(events);
  const context = state.contexts.filter(item => item.matchId === matchId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    match,
    latestEvent,
    score: applyScoringRuleDisplay(match.scoringModel, latestEvent?.score ?? EMPTY_SCORE),
    eventCount: events.length,
    context,
    spectator: spectatorView(match, publicEvents(state, matchId)),
  };
}

export function matchViews(state) {
  return state.matches
    .map(match => matchView(state, match.matchId))
    .sort((a, b) => b.match.createdAt.localeCompare(a.match.createdAt));
}

const byRankThen = label => (a, b) => a.rank - b.rank || a[label].localeCompare(b[label]);

function fallbackStandingRows(view) {
  const winner = view.score.winnerTeamId;
  if (!winner) return [];
  return SIDES.map((side, index) => {
    const won = side === winner;
    return {
      kind: 'live-match-board-standing-row',
      standingId: `${view.context?.standingId ?? view.match.matchId}:${side}`,
      matchId: view.match.matchId,
      teamId: side,
      teamLabel: view.match.teams[index].label,
      divisionLabel: view.context?.tournamentId,
      rank: won ? 1 : 2,
      wins: won ? 1 : 0,
      losses: won ? 0 : 1,
      points: won ? 3 : 0,
    };
  });
}

function fallbackLeaderboardRows(view) {
  const winner = view.score.winnerTeamId;
  if (!winner) return [];
  return SIDES.map((side, index) => {
    const won = side === winner;
    return {
      kind: 'live-match-board-leaderboard-row',
      leaderboardId: `${view.context?.leaderboardId ?? view.match.matchId}:${side}`,
      matchId: view.match.matchId,
      subjectId: view.match.teams[index].teamId,
      label: view.match.teams[index].label,
      rank: won ? 1 : 2,
      score: won ? 1 : 0,
      movement: 'same',
    };
  });
}

export function boardRows(state) {
  return matchViews(state).map(view => {
    const { matchId } = view.match;
    const [teamA, teamB] = view.spectator.teamLabels;
    const scores = view.spectator.score.gameScores ?? view.spectator.score.teamScores;
    const own = (row, linkKey, contextKey) => row.matchId === matchId || (view.context?.[contextKey] !== undefined && row[linkKey] === view.context[contextKey]);
    const explicitStandings = state.standingRows.filter(row => own(row, 'standingId', 'standingId')).sort(byRankThen('teamLabel'));
    const explicitLeaderboard = state.leaderboardRows.filter(row => own(row, 'leaderboardId', 'leaderboardId')).sort(byRankThen('label'));
    return {
      matchId,
      label: `${teamA} vs ${teamB}`,
      scoringRuleRef: view.match.scoringRuleRef,
      status: view.spectator.status,
      scoreLine: `${scores['team-a']}-${scores['team-b']}`,
      publicPath: view.match.share.publicPath,
      tournamentId: view.context?.tournamentId,
      scheduleRowId: view.context?.scheduleRowId,
      bracketMatchId: view.context?.bracketMatchId,
      standingId: view.context?.standingId,
      leaderboardId: view.context?.leaderboardId,
      schedule: state.scheduleRows.find(row => own(row, 'scheduleRowId', 'scheduleRowId')),
      bracket: state.bracketRows.find(row => own(row, 'bracketMatchId', 'bracketMatchId')),
      standings: explicitStandings.length ? explicitStandings : fallbackStandingRows(view),
      leaderboard: explicitLeaderboard.length ? explicitLeaderboard : fallbackLeaderboardRows(view),
    };
  });
}

export function boardProjection(state) {
  const rows = boardRows(state);
  return {
    rows,
    schedule: [...state.scheduleRows].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    brackets: [...state.bracketRows].sort((a, b) => a.roundLabel.localeCompare(b.roundLabel) || (a.positionLabel ?? '').localeCompare(b.positionLabel ?? '')),
    standings: rows.flatMap(row => row.standings).sort(byRankThen('teamLabel')),
    leaderboard: rows.flatMap(row => row.leaderboard).sort(byRankThen('label')),
  };
}

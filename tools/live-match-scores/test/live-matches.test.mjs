// A match from its first point to its last: starting a match from a rule row, advancing it point by point through games,
// tiebreaks, sets and the end, undoing, replaying an append-only log (offline taps, spectators), and the board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAMatch } from '../do-work/score-a-match.mjs';
import { readLiveMatches } from '../do-work/read-live-matches.mjs';
import { initialScorePayload, scorePointForSide } from '../read-data/match-scoring.mjs';

const NOW = '2026-01-01T09:00:00.000Z';
const at = minute => `2026-01-01T09:${String(minute).padStart(2, '0')}:00.000Z`;

const startDoubles = (extra = {}) => scoreAMatch({
  operation: 'start-match',
  match_id: 'live-match:1',
  share_id: 'live-match-share:1',
  event_id: 'live-score-event:0',
  scoring_rule_ref: 'scoring-rule:tennis-standard',
  match_format: 'doubles',
  team_a_players: ['Alder', 'Birch'],
  team_b_players: ['Cedar', 'Dove'],
  created_by: 'user:1',
  now: NOW,
  ...extra,
});

test('a match starts from a rule row with the players\' names as its teams and a share path', () => {
  const { match_record: match, initial_event_record: first } = startDoubles();
  assert.equal(match.teams[0].label, 'Alder / Birch');
  assert.equal(match.share.publicPath, '/live/live-match%3A1');
  assert.equal(match.scoringModel.scoreUnit, 'game');
  assert.equal(match.scoringModel.gamesToWinSet, 6);
  assert.deepEqual(first.score.teamScores, { 'team-a': 0, 'team-b': 0 });
  assert.equal(first.sequence, 0);
  const pickle = scoreAMatch({ operation: 'start-match', scoring_rule_ref: 'scoring-rule:pickleball-11', match_format: 'singles', team_a_players: ['Alder'], team_b_players: ['Birch'], now: NOW });
  assert.equal(pickle.match_record.scoringModel.scoreUnit, 'point');
  assert.equal(pickle.match_record.scoringModel.winBy, 2);
  assert.match(pickle.match_record.matchId, /^live-match:/);
});

test('a roster that does not fit, and a rule nobody wrote, are refused', () => {
  assert.throws(() => scoreAMatch({ operation: 'start-match', scoring_rule_ref: 'scoring-rule:pickleball-11', match_format: 'doubles', team_a_players: ['Only one'], team_b_players: ['Two', 'Players'] }), /Doubles needs two players/);
  assert.throws(() => scoreAMatch({ operation: 'start-match', scoring_rule_ref: 'scoring-rule:croquet', match_format: 'singles', team_a_players: ['A'], team_b_players: ['B'] }), /No scoring rule "scoring-rule:croquet"/);
});

test('rules the caller gives replace the bundled ones', () => {
  const custom = { kind: 'scoring-rule', ruleId: 'scoring-rule:house', label: 'House', scoringModel: { scoreUnit: 'point', setsToWin: 1, gamesToWinSet: 21, tiebreakAt: 0, pointsToWinTiebreak: 0, winBy: 2 } };
  const { match_record: match } = scoreAMatch({ operation: 'start-match', scoring_rules: [custom], scoring_rule_ref: 'scoring-rule:house', match_format: 'singles', team_a_players: ['A'], team_b_players: ['B'], now: NOW });
  assert.equal(match.scoringModel.gamesToWinSet, 21);
  assert.throws(() => scoreAMatch({ operation: 'start-match', scoring_rules: [custom], scoring_rule_ref: 'scoring-rule:tennis-standard', match_format: 'singles', team_a_players: ['A'], team_b_players: ['B'] }), /No scoring rule/);
});

// Play points through the command: each event is appended to the rows, as the caller would write it.
function play(rows, sides, startMinute = 1) {
  let log = [...rows];
  let last;
  sides.forEach((side, index) => {
    last = scoreAMatch({ operation: 'score-point', rows: log, match_id: 'live-match:1', side, actor_id: 'user:1', event_id: `live-score-event:${startMinute + index}`, now: at(startMinute + index) });
    log = [...log, last.event_record];
  });
  return { log, last };
}

test('tennis points run through a game, a tiebreak, a set and the end of the match', () => {
  const { match_record: match, initial_event_record: first } = startDoubles({ scoring_model: { setsToWin: 1 } });
  const one = play([match, first], ['team-a']);
  assert.deepEqual(one.last.score.displayScores, { 'team-a': '15', 'team-b': '0' });
  assert.equal(one.last.event_record.sequence, 1);
  const done = play(one.log, Array(23).fill('team-a'), 2);
  assert.deepEqual(done.last.score.gameScores, { 'team-a': 0, 'team-b': 0 });
  assert.deepEqual(done.last.score.setScores, { 'team-a': 1, 'team-b': 0 });
  assert.equal(done.last.score.winnerTeamId, 'team-a');
  assert.equal(done.last.score.scoringPhase, 'complete');
  assert.throws(() => scoreAMatch({ operation: 'score-point', rows: done.log, match_id: 'live-match:1', side: 'team-b' }), /already won by team-a/);
});

test('deuce needs two clear points with an advantage rule, and the games reach a tiebreak at 6-6', () => {
  const { match_record: match, initial_event_record: first } = startDoubles();
  const toDeuce = play([match, first], ['team-a', 'team-b', 'team-a', 'team-b', 'team-a', 'team-b']);
  assert.deepEqual(toDeuce.last.score.displayScores, { 'team-a': '40', 'team-b': '40' });
  const advantage = play(toDeuce.log, ['team-a'], 7);
  assert.deepEqual(advantage.last.score.displayScores, { 'team-a': 'AD', 'team-b': '40' });
  assert.equal(advantage.last.score.gameScores['team-a'], 0);
  const won = play(advantage.log, ['team-a'], 8);
  assert.deepEqual(won.last.score.gameScores, { 'team-a': 1, 'team-b': 0 });
  // six games each by hand-built scores, then the next points are tiebreak points counted to 7
  const sixAll = { ...initialScorePayload(), teamScores: { 'team-a': 6, 'team-b': 6 }, gameScores: { 'team-a': 6, 'team-b': 6 } };
  let score = scorePointForSide(match, sixAll, 'team-a');
  assert.equal(score.scoringPhase, 'tiebreak');
  assert.deepEqual(score.displayScores, { 'team-a': '1', 'team-b': '0' });
  for (let i = 0; i < 6; i++) score = scorePointForSide(match, score, 'team-a');
  assert.deepEqual(score.gameScores, { 'team-a': 0, 'team-b': 0 });
  assert.deepEqual(score.setScores, { 'team-a': 1, 'team-b': 0 });
  assert.equal(score.setNumber, 2);
});

test('pickleball points win the match at the target by two and feed the board', () => {
  const start = scoreAMatch({ operation: 'start-match', match_id: 'live-match:p', event_id: 'e:0', scoring_rule_ref: 'scoring-rule:pickleball-11', match_format: 'doubles', team_a_players: ['Alder', 'Birch'], team_b_players: ['Cedar', 'Dove'], scoring_model: { gamesToWinSet: 3 }, now: NOW });
  let log = [start.match_record, start.initial_event_record];
  let last;
  for (let i = 0; i < 3; i++) {
    last = scoreAMatch({ operation: 'score-point', rows: log, match_id: 'live-match:p', side: 'team-b', event_id: `e:${i + 1}`, now: at(i + 1) });
    log = [...log, last.event_record];
  }
  assert.deepEqual(last.score.teamScores, { 'team-a': 0, 'team-b': 3 });
  assert.deepEqual(last.score.setScores, { 'team-a': 0, 'team-b': 1 });
  assert.equal(last.score.winnerTeamId, 'team-b');
  const read = readLiveMatches({ rows: log });
  assert.equal(read.matches[0].spectator.status, 'complete');
  assert.deepEqual(read.board.standings.map(row => [row.teamLabel, row.rank, row.wins, row.losses, row.points]), [['Cedar / Dove', 1, 1, 0, 3], ['Alder / Birch', 2, 0, 1, 0]]);
  assert.deepEqual(read.board.leaderboard.map(row => [row.label, row.rank, row.score]), [['Cedar / Dove', 1, 1], ['Alder / Birch', 2, 0]]);
});

test('a golden-point rule gives the game to the next point at deuce, from its row alone', () => {
  const start = scoreAMatch({ operation: 'start-match', match_id: 'live-match:g', event_id: 'e:0', scoring_rule_ref: 'scoring-rule:padel-golden-point', match_format: 'doubles', team_a_players: ['A', 'B'], team_b_players: ['C', 'D'], scoring_model: { setsToWin: 1, gamesToWinSet: 1 }, now: NOW });
  let score = start.initial_event_record.score;
  for (let i = 0; i < 3; i++) { score = scorePointForSide(start.match_record, score, 'team-a'); score = scorePointForSide(start.match_record, score, 'team-b'); }
  assert.deepEqual(score.displayScores, { 'team-a': '40', 'team-b': '40' });
  assert.equal(score.winnerTeamId, undefined);
  score = scorePointForSide(start.match_record, score, 'team-a');
  assert.equal(score.winnerTeamId, 'team-a');
  assert.equal(score.scoringPhase, 'complete');
});

// A log with one confirmed tap, a context link and the board's own rows.
function seedRows() {
  const { match_record: match, initial_event_record: first } = startDoubles();
  const tap = scoreAMatch({ operation: 'record-score', rows: [match, first], match_id: 'live-match:1', actor_id: 'user:1', event_id: 'live-score-event:1', score: { setNumber: 1, teamScores: { 'team-a': 2, 'team-b': 1 } }, now: at(1) });
  const link = scoreAMatch({ operation: 'link-context', context_id: 'live-match-context:1', match_id: 'live-match:1', tournament_id: 'tournament:spring', schedule_row_id: 'schedule:1', bracket_match_id: 'bracket:semi', standing_id: 'standing:a', leaderboard_id: 'leaderboard:club', now: NOW });
  return [
    { payload: match }, { payload: first }, { payload: tap.event_record }, { payload: link.context_record },
    { payload: { kind: 'live-match-board-schedule-row', scheduleRowId: 'schedule:1', matchId: 'live-match:1', startsAt: NOW, courtLabel: 'Court 1', roundLabel: 'Semifinal', status: 'live' } },
    { payload: { kind: 'live-match-board-bracket-row', bracketMatchId: 'bracket:semi', matchId: 'live-match:1', bracketLabel: 'Spring Draw', roundLabel: 'Semifinal', positionLabel: 'Top half', nextMatchId: 'bracket:final' } },
    { payload: { kind: 'live-match-board-standing-row', standingId: 'standing:a', matchId: 'live-match:1', teamId: 'team-a', teamLabel: 'Alder / Birch', rank: 1, wins: 3, losses: 0, points: 9 } },
    { payload: { kind: 'live-match-board-standing-row', standingId: 'standing:a', matchId: 'live-match:1', teamId: 'team-b', teamLabel: 'Cedar / Dove', rank: 2, wins: 2, losses: 1, points: 6 } },
    { payload: { kind: 'live-match-board-leaderboard-row', leaderboardId: 'leaderboard:club', matchId: 'live-match:1', subjectId: 'player:alder', label: 'Alder', rank: 1, score: 1200, movement: 'same' } },
  ];
}

test('an append-only log replays into the scorer, spectator and board views', () => {
  const read = readLiveMatches({ rows: seedRows(), match_id: 'live-match:1' });
  const view = read.match;
  assert.deepEqual(view.score.teamScores, { 'team-a': 2, 'team-b': 1 });
  assert.equal(view.spectator.publicPath, '/live/live-match%3A1');
  assert.equal(view.spectator.eventCount, 2);
  assert.equal('actorId' in view.spectator, false);
  assert.equal(read.next_sequence, 2);
  const [row] = read.board.rows;
  assert.equal(row.label, 'Alder / Birch vs Cedar / Dove');
  assert.equal(row.scoreLine, '2-1');
  assert.equal(row.schedule.courtLabel, 'Court 1');
  assert.equal(row.bracket.nextMatchId, 'bracket:final');
  assert.deepEqual(row.standings.map(item => [item.teamLabel, item.rank, item.wins]), [['Alder / Birch', 1, 3], ['Cedar / Dove', 2, 2]]);
  assert.deepEqual(row.leaderboard.map(item => [item.label, item.score]), [['Alder', 1200]]);
});

test('offline taps count for the scorer, not for spectators, and the same sequence keeps the best-confirmed one', () => {
  const rows = seedRows();
  const pending = { payload: { kind: 'live-score-event', eventId: 'live-score-event:pending', matchId: 'live-match:1', sequence: 2, eventKind: 'score', score: { setNumber: 1, teamScores: { 'team-a': 3, 'team-b': 1 } }, localState: 'pending-offline', createdAt: at(2) } };
  const seen = readLiveMatches({ rows: [...rows, pending], match_id: 'live-match:1' });
  assert.deepEqual(seen.match.score.teamScores, { 'team-a': 3, 'team-b': 1 });
  assert.deepEqual(seen.match.spectator.score.teamScores, { 'team-a': 2, 'team-b': 1 });
  assert.equal(seen.board.rows[0].scoreLine, '2-1');
  const reconciled = { payload: { ...pending.payload, eventId: 'live-score-event:reconciled', localState: 'reconciled', score: { setNumber: 1, teamScores: { 'team-a': 4, 'team-b': 1 } }, createdAt: at(3) } };
  const after = readLiveMatches({ rows: [...rows, pending, reconciled], match_id: 'live-match:1' });
  assert.deepEqual(after.match.score.teamScores, { 'team-a': 4, 'team-b': 1 });
  assert.equal(after.match.eventCount, 3);
  assert.deepEqual(after.match.spectator.score.teamScores, { 'team-a': 4, 'team-b': 1 });
  assert.equal(after.match.spectator.eventCount, 3);
});

test('undo writes the score before the latest event as a new event; with nothing to undo it says so', () => {
  const { match_record: match, initial_event_record: first } = startDoubles();
  const one = play([match, first], ['team-a', 'team-a']);
  const undone = scoreAMatch({ operation: 'undo-point', rows: one.log, match_id: 'live-match:1', event_id: 'e:undo', now: at(9) });
  assert.equal(undone.event_record.sequence, 3);
  assert.deepEqual(undone.score.displayScores, { 'team-a': '15', 'team-b': '0' });
  assert.throws(() => scoreAMatch({ operation: 'undo-point', rows: [match], match_id: 'live-match:1' }), /No saved point to undo/);
});

test('scores that are not whole numbers, a missing match and an unknown operation are refused', () => {
  const { match_record: match, initial_event_record: first } = startDoubles();
  const rows = [match, first];
  assert.throws(() => scoreAMatch({ operation: 'record-score', rows, match_id: 'live-match:1', score: { setNumber: 1, teamScores: { 'team-a': -1, 'team-b': 0 } } }), /whole numbers/);
  assert.throws(() => scoreAMatch({ operation: 'record-score', rows, match_id: 'live-match:1', score: { teamScores: { 'team-a': 1, 'team-b': 0 } } }), /setNumber/);
  assert.throws(() => scoreAMatch({ operation: 'score-point', rows, match_id: 'live-match:none', side: 'team-a' }), /No live match/);
  assert.throws(() => scoreAMatch({ operation: 'score-point', rows, match_id: 'live-match:1', side: 'left' }), /team-a or team-b/);
  assert.throws(() => scoreAMatch({ operation: 'score-point', rows, match_id: 'live-match:1', side: 'team-a', local_state: 'maybe' }), /local_state/);
  assert.throws(() => scoreAMatch({ operation: 'dance' }), /operation must be/);
  assert.throws(() => scoreAMatch({ operation: 'start-match', scoring_rule_ref: 'scoring-rule:pickleball-11', match_format: 'singles', team_a_players: ['A'], team_b_players: ['B'], now: 'not a time' }), /ISO time/);
  assert.throws(() => readLiveMatches({}), /rows must be a list/);
});

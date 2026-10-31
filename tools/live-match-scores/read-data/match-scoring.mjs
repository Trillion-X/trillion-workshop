// tools/live-match-scores/read-data/match-scoring.mjs
//
// How one point moves a match, from the match's own scoringModel (never from a sport's name):
//   scoreUnit "game": a labelled-ladder game (tennis, padel). A game is won by reaching pointLabels.length points with a
//     lead of 2 when the rule has an advantageLabel, else 1 (golden point). At tiebreakAt games each, points count to
//     pointsToWinTiebreak by winBy. A game won moves the game score; games to gamesToWinSet (by winBy, or the one-game
//     tiebreak win) win the set; setsToWin sets win the match.
//   scoreUnit "point": rally scoring (pickleball). Points count to gamesToWinSet by winBy; that wins the set and the match.
import { applyScoringRuleDisplay, findScoringRule, pair } from './scoring-rules.mjs';

const ZERO = () => ({ 'team-a': 0, 'team-b': 0 });
const otherSide = side => (side === 'team-a' ? 'team-b' : 'team-a');
const isWon = (a, b, target, winBy) => a >= target && a - b >= winBy;
const normalize = (match, score) => applyScoringRuleDisplay(match.scoringModel, score);

export function initialScorePayload() {
  return {
    setNumber: 1,
    teamScores: ZERO(),
    pointScores: ZERO(),
    gameScores: ZERO(),
    setScores: ZERO(),
    displayScores: { 'team-a': '0', 'team-b': '0' },
    scoringPhase: 'standard',
  };
}

function scoreWithSetWinner(match, score, side) {
  const setScores = pair(score.setScores);
  const nextSetScores = { ...setScores, [side]: setScores[side] + 1 };
  const winnerTeamId = nextSetScores[side] >= match.scoringModel.setsToWin ? side : undefined;
  return normalize(match, {
    ...score,
    teamScores: ZERO(),
    pointScores: ZERO(),
    gameScores: ZERO(),
    setScores: nextSetScores,
    setNumber: score.setNumber + (winnerTeamId ? 0 : 1),
    scoringPhase: winnerTeamId ? 'complete' : 'standard',
    winnerTeamId,
  });
}

function scoreWithGameWinner(match, score, side) {
  const model = match.scoringModel;
  const gameScores = pair(score.gameScores ?? score.teamScores);
  const nextGameScores = { ...gameScores, [side]: gameScores[side] + 1 };
  const opponent = otherSide(side);
  const setWon = isWon(nextGameScores[side], nextGameScores[opponent], model.gamesToWinSet, model.winBy)
    || (model.tiebreakAt > 0 && nextGameScores[side] === model.tiebreakAt + 1 && nextGameScores[opponent] === model.tiebreakAt);
  const afterGame = { ...score, teamScores: nextGameScores, gameScores: nextGameScores, pointScores: ZERO() };
  return setWon ? scoreWithSetWinner(match, afterGame, side) : normalize(match, afterGame);
}

// One point inside a labelled-ladder game; every constant is read from the model.
function scoreLabeledPoint(match, score, side) {
  const model = match.scoringModel;
  const normalized = normalize(match, score);
  const points = pair(normalized.pointScores);
  const games = pair(normalized.gameScores ?? normalized.teamScores);
  const opponent = otherSide(side);
  const inTiebreak = model.tiebreakAt > 0 && games['team-a'] >= model.tiebreakAt && games['team-b'] >= model.tiebreakAt;
  const nextPoints = { ...points, [side]: points[side] + 1 };
  const gamePointsToWin = model.pointLabels?.length ?? 4;
  const gameWinBy = model.advantageLabel ? 2 : 1;
  const phase = inTiebreak ? 'tiebreak' : 'standard';
  const target = inTiebreak ? model.pointsToWinTiebreak : gamePointsToWin;
  const winBy = inTiebreak ? model.winBy : gameWinBy;
  const moved = { ...normalized, pointScores: nextPoints, scoringPhase: phase };
  return isWon(nextPoints[side], nextPoints[opponent], target, winBy)
    ? scoreWithGameWinner(match, moved, side)
    : normalize(match, moved);
}

function scorePointUnit(match, score, side) {
  const normalized = normalize(match, score);
  const nextScores = { ...normalized.teamScores, [side]: normalized.teamScores[side] + 1 };
  const winnerTeamId = isWon(nextScores[side], nextScores[otherSide(side)], match.scoringModel.gamesToWinSet, match.scoringModel.winBy) ? side : undefined;
  const previousSets = pair(normalized.setScores);
  return normalize(match, {
    ...normalized,
    teamScores: nextScores,
    gameScores: nextScores,
    setScores: winnerTeamId ? { ...previousSets, [side]: previousSets[side] + 1 } : previousSets,
    scoringPhase: winnerTeamId ? 'complete' : 'standard',
    winnerTeamId,
  });
}

// The score after `side` wins one point. A match already won refuses: a point after the end is a mistake to correct.
export function scorePointForSide(match, score, side) {
  if (!['team-a', 'team-b'].includes(side)) throw new Error('side must be team-a or team-b.');
  if (score.winnerTeamId) throw new Error(`The match is already won by ${score.winnerTeamId}; undo the last point to correct it.`);
  return match.scoringModel.scoreUnit === 'game' ? scoreLabeledPoint(match, score, side) : scorePointUnit(match, score, side);
}

// Scores are whole numbers at or above 0.
export function assertScore(score) {
  for (const group of [score.teamScores, score.pointScores, score.gameScores, score.setScores]) {
    for (const value of Object.values(group ?? {})) {
      if (!Number.isInteger(value) || value < 0) throw new Error('Scores must be whole numbers at or above 0.');
    }
  }
}

const clean = players => (players ?? []).map(player => String(player).trim()).filter(Boolean);

// A new match record from a rule row: the roster check, the teams' labels (the players' names unless given), and the
// rule's model with any overrides on top.
export function buildMatchRecord(draft, rules) {
  const rule = findScoringRule(rules, draft.scoring_rule_ref);
  if (!rule) throw new Error(`No scoring rule ${JSON.stringify(draft.scoring_rule_ref)}; the rules given are ${rules.map(item => item.ruleId).join(', ') || 'none'}.`);
  if (!['singles', 'doubles'].includes(draft.match_format)) throw new Error('match_format must be singles or doubles.');
  const required = draft.match_format === 'doubles' ? 2 : 1;
  const a = clean(draft.team_a_players);
  const b = clean(draft.team_b_players);
  if (a.length < required || b.length < required) {
    throw new Error(draft.match_format === 'doubles' ? 'Doubles needs two players on each side.' : 'Singles needs one player on each side.');
  }
  const team = (teamId, players, label, fallback) => ({ teamId, label: label?.trim() || players.join(' / ') || fallback, players });
  const matchId = draft.match_id;
  return {
    kind: 'live-match',
    matchId,
    scoringRuleRef: rule.ruleId,
    matchFormat: draft.match_format,
    teams: [team('team-a', a, draft.team_a_label, 'Team A'), team('team-b', b, draft.team_b_label, 'Team B')],
    scoringModel: { ...rule.scoringModel, ...draft.scoring_model },
    status: 'live',
    share: { shareId: draft.share_id, publicPath: `${draft.share_path_prefix}${encodeURIComponent(matchId)}`, enabled: true },
    createdBy: draft.created_by,
    createdAt: draft.created_at,
  };
}

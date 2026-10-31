// tools/live-match-scores/read-data/scoring-rules.mjs
//
// A game's scoring is DATA: a scoring-rule record { kind: "scoring-rule", ruleId, label, scoringModel }. A match points
// at one by ruleId, so tennis, pickleball, padel, table tennis or a house rule are each one row and none is a branch in
// code. The model carries the win structure (scoreUnit, setsToWin, gamesToWinSet, tiebreakAt, pointsToWinTiebreak,
// winBy) and the display: `pointLabels` (a labelled ladder such as 0/15/30/40; absent means raw counts) and
// `advantageLabel` (a deuce zone at the last label; absent means the next point there wins, a golden point).
//
// Sides are always "team-a" and "team-b". A score payload is
// { setNumber, teamScores, pointScores, gameScores, setScores, displayScores, scoringPhase, winnerTeamId? }.
import rules from './scoring-rules.json' with { type: 'json' };

export const SIDES = ['team-a', 'team-b'];

export const bundledScoringRules = rules.rules;

export function pair(value) {
  return { 'team-a': Number(value?.['team-a'] ?? 0), 'team-b': Number(value?.['team-b'] ?? 0) };
}

// The scoring phase, read from the rule's model: tiebreak applies when the rule declares one (tiebreakAt > 0) and both
// sides have reached it. An explicit phase wins when given.
export function resolveScoringPhase(model, gameScores, explicitPhase) {
  if (explicitPhase) return explicitPhase;
  const games = pair(gameScores);
  if (model.tiebreakAt > 0 && games['team-a'] >= model.tiebreakAt && games['team-b'] >= model.tiebreakAt) return 'tiebreak';
  return 'standard';
}

// Display scores from the model's data. A labelled ladder shows its labels, with a deuce/advantage zone when
// `advantageLabel` is set; with no labels the raw team counts show. Tiebreak and complete phases show raw counts.
export function resolveDisplayScores(model, pointScores, teamScores, phase) {
  const points = pair(pointScores);
  const teams = pair(teamScores);
  const labels = model.pointLabels;
  const hasLabels = Array.isArray(labels) && labels.length > 0;
  if (!hasLabels || phase === 'tiebreak' || phase === 'complete') {
    const source = hasLabels ? points : teams;
    return { 'team-a': String(source['team-a']), 'team-b': String(source['team-b']) };
  }
  const last = labels.length - 1;
  const a = points['team-a'];
  const b = points['team-b'];
  if (model.advantageLabel && a >= last && b >= last) {
    if (a === b) return { 'team-a': labels[last], 'team-b': labels[last] };
    return {
      'team-a': a > b ? model.advantageLabel : labels[last],
      'team-b': b > a ? model.advantageLabel : labels[last],
    };
  }
  return { 'team-a': labels[Math.min(a, last)] ?? String(a), 'team-b': labels[Math.min(b, last)] ?? String(b) };
}

// A raw score payload with its phase and display filled in from the rule's model.
export function applyScoringRuleDisplay(model, score) {
  const teamScores = pair(score.teamScores);
  const gameScores = pair(score.gameScores ?? teamScores);
  const pointScores = pair(score.pointScores);
  const setScores = pair(score.setScores);
  const scoringPhase = resolveScoringPhase(model, gameScores, score.scoringPhase);
  return {
    ...score,
    setNumber: score.setNumber || 1,
    teamScores,
    pointScores,
    gameScores,
    setScores,
    displayScores: resolveDisplayScores(model, pointScores, teamScores, scoringPhase),
    scoringPhase,
  };
}

// The rule with this id among the rules given, or null.
export function findScoringRule(rules, ruleId) {
  return rules.find(rule => rule.ruleId === ruleId) ?? null;
}

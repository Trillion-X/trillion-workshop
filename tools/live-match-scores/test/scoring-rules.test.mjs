// The scoring rules as data: the tennis rule's display matches the labelled-ladder logic it came from for every score,
// a rule with no labels shows raw counts, the tiebreak is read from the rule, and a rule nobody wrote code for scores
// and shows from its row alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bundledScoringRules, findScoringRule, resolveDisplayScores, resolveScoringPhase,
} from '../read-data/scoring-rules.mjs';

const rule = id => findScoringRule(bundledScoringRules, id);
const TENNIS = rule('scoring-rule:tennis-standard');
const PICKLEBALL = rule('scoring-rule:pickleball-11');
const PADEL = rule('scoring-rule:padel-golden-point');

// The labelled-ladder display written out longhand, as the oracle for the rule-driven one.
function ladderOracle(points, phase) {
  if (phase === 'tiebreak' || phase === 'complete') return { 'team-a': String(points['team-a']), 'team-b': String(points['team-b']) };
  const a = points['team-a'];
  const b = points['team-b'];
  if (a >= 3 && b >= 3) {
    if (a === b) return { 'team-a': '40', 'team-b': '40' };
    return { 'team-a': a > b ? 'AD' : '40', 'team-b': b > a ? 'AD' : '40' };
  }
  const labels = ['0', '15', '30', '40'];
  return { 'team-a': labels[Math.min(a, 3)], 'team-b': labels[Math.min(b, 3)] };
}

test('the tennis rule shows every score as the longhand ladder does, in every phase', () => {
  for (let a = 0; a <= 6; a++) {
    for (let b = 0; b <= 6; b++) {
      const points = { 'team-a': a, 'team-b': b };
      for (const phase of ['standard', 'tiebreak', 'complete']) {
        assert.deepEqual(resolveDisplayScores(TENNIS.scoringModel, points, points, phase), ladderOracle(points, phase), `${a}-${b} ${phase}`);
      }
    }
  }
});

test('a rule with no labelled ladder shows the raw team counts', () => {
  const display = resolveDisplayScores(PICKLEBALL.scoringModel, { 'team-a': 0, 'team-b': 0 }, { 'team-a': 9, 'team-b': 7 }, 'standard');
  assert.deepEqual(display, { 'team-a': '9', 'team-b': '7' });
});

test('the tiebreak phase comes from the rule, never from a game\'s name', () => {
  assert.equal(resolveScoringPhase(TENNIS.scoringModel, { 'team-a': 6, 'team-b': 6 }), 'tiebreak');
  assert.equal(resolveScoringPhase(TENNIS.scoringModel, { 'team-a': 6, 'team-b': 5 }), 'standard');
  assert.equal(resolveScoringPhase(PICKLEBALL.scoringModel, { 'team-a': 11, 'team-b': 11 }), 'standard');
  assert.equal(resolveScoringPhase(TENNIS.scoringModel, { 'team-a': 0, 'team-b': 0 }, 'complete'), 'complete');
});

test('a golden-point rule has no advantage: past the last label both sides show it', () => {
  const at = (a, b) => resolveDisplayScores(PADEL.scoringModel, { 'team-a': a, 'team-b': b }, { 'team-a': a, 'team-b': b }, 'standard');
  assert.deepEqual(at(3, 3), { 'team-a': '40', 'team-b': '40' });
  assert.deepEqual(at(4, 3), { 'team-a': '40', 'team-b': '40' });
});

test('a rule nobody wrote code for shows its own labels and advantage word', () => {
  const invented = { scoringModel: { scoreUnit: 'point', setsToWin: 1, gamesToWinSet: 5, tiebreakAt: 0, pointsToWinTiebreak: 0, winBy: 1, pointLabels: ['love', 'one', 'two', 'three'], advantageLabel: 'plus' } };
  const at = (a, b) => resolveDisplayScores(invented.scoringModel, { 'team-a': a, 'team-b': b }, { 'team-a': a, 'team-b': b }, 'standard');
  assert.deepEqual(at(1, 2), { 'team-a': 'one', 'team-b': 'two' });
  assert.equal(at(4, 3)['team-a'], 'plus');
});

test('a rule is found by its id, and an id nobody wrote is not found', () => {
  assert.equal(findScoringRule(bundledScoringRules, 'scoring-rule:pickleball-11'), PICKLEBALL);
  assert.equal(findScoringRule(bundledScoringRules, 'scoring-rule:nope'), null);
  assert.equal(findScoringRule(bundledScoringRules, undefined), null);
});

// The pick split, the result, the personal history and the command over standard input, on made-up matches and pickers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tallyMatchPicks } from '../do-work/tally-match-picks.mjs';
import { matchPickPersonalHistory, matchPickViews, readPicksState } from '../read-data/match-picks.mjs';

const at = minute => `2026-01-01T09:${String(minute).padStart(2, '0')}:00.000Z`;
const pick = (pickId, pickerId, choiceId, minute, matchId = 'match:1') => ({ payload: { kind: 'match-pick', pickId, matchId, pickerId, choiceId, createdAt: at(minute) } });
const match = (matchId, label, startsAt) => ({ payload: { kind: 'pick-match', matchId, label, startsAt, status: 'open', choices: [{ choiceId: 'alder', label: 'Alder' }, { choiceId: 'birch', label: 'Birch' }] } });
const result = (resultId, matchId, winningChoiceId, summary, minute) => ({ payload: { kind: 'match-pick-result', resultId, matchId, winningChoiceId, summary, resolvedAt: at(minute) } });

const seeded = () => [match('match:1', 'Alder vs Birch', at(30)), pick('p1', 'user:1', 'alder', 1), pick('p2', 'user:2', 'birch', 2), pick('p3', 'user:3', 'birch', 3)];

test('the community split gives each choice its count and whole percent, and the picker\'s own choice', () => {
  const [view] = matchPickViews(readPicksState(seeded()), 'user:1');
  assert.equal(view.totalPicks, 3);
  const by = id => view.choices.find(choice => choice.choiceId === id);
  assert.equal(by('alder').percentPicked, 33);
  assert.equal(by('birch').percentPicked, 67);
  assert.equal(by('birch').pickCount, 2);
  assert.equal(view.userPick.choiceId, 'alder');
  assert.equal(by('alder').selectedByUser, true);
  assert.equal(by('birch').selectedByUser, false);
});

test('a match nobody picked splits at zero, and a picker not named has no own pick', () => {
  const [view] = matchPickViews(readPicksState([match('match:1', 'Alder vs Birch')]));
  assert.equal(view.totalPicks, 0);
  assert.deepEqual(view.choices.map(choice => choice.percentPicked), [0, 0]);
  assert.equal(view.userPick, undefined);
});

test('a resolved match shows its winner, and the history marks a pick right or wrong', () => {
  const state = readPicksState([...seeded(), result('r1', 'match:1', 'birch', 'Birch won.', 40)]);
  const [view] = matchPickViews(state, 'user:1');
  assert.equal(view.result.winningChoiceId, 'birch');
  assert.equal(view.choices.find(choice => choice.choiceId === 'birch').winner, true);
  assert.deepEqual(matchPickPersonalHistory(state, 'user:1').map(({ matchLabel, choiceLabel, correct, resultSummary }) => ({ matchLabel, choiceLabel, correct, resultSummary })),
    [{ matchLabel: 'Alder vs Birch', choiceLabel: 'Alder', correct: false, resultSummary: 'Birch won.' }]);
  assert.equal(matchPickPersonalHistory(state, 'user:2')[0].correct, true);
});

test('the latest result record counts, and an unresolved pick has no right or wrong yet', () => {
  const state = readPicksState([...seeded(), result('r1', 'match:1', 'alder', 'First call.', 40), result('r2', 'match:1', 'birch', 'Corrected.', 50)]);
  assert.equal(matchPickViews(state)[0].result.summary, 'Corrected.');
  assert.equal(matchPickPersonalHistory(readPicksState(seeded()), 'user:1')[0].correct, undefined);
});

test('a picker who changes their pick counts once, for the latest pick, and the first pick is marked superseded', () => {
  const state = readPicksState([...seeded(), pick('p4', 'user:1', 'birch', 10)]);
  const [view] = matchPickViews(state, 'user:1');
  assert.equal(view.totalPicks, 3);
  assert.equal(view.choices.find(choice => choice.choiceId === 'birch').pickCount, 3);
  assert.equal(view.userPick.choiceId, 'birch');
  assert.deepEqual(matchPickPersonalHistory(state, 'user:1').map(entry => [entry.pick.pickId, entry.superseded]), [['p4', false], ['p1', true]]);
});

test('matches come in start order, then by label; a pick for a match with no record shows its id', () => {
  const state = readPicksState([match('m:b', 'Birch vs Cedar', at(20)), match('m:a', 'Alder vs Dove', at(10)), match('m:c', 'Cedar vs Dove', at(10)), pick('p', 'user:1', 'x', 1, 'm:gone')]);
  assert.deepEqual(matchPickViews(state).map(view => view.match.matchId), ['m:a', 'm:c', 'm:b']);
  assert.equal(matchPickPersonalHistory(state, 'user:1')[0].matchLabel, 'm:gone');
  assert.equal(matchPickPersonalHistory(state, 'user:1')[0].choiceLabel, 'x');
});

test('rows may be the records themselves, and rows of other kinds are ignored', () => {
  const bare = seeded().map(row => row.payload);
  assert.equal(matchPickViews(readPicksState([...bare, { payload: { kind: 'something-else' } }, null, 'text']))[0].totalPicks, 3);
});

test('the command answers with the split and, for a picker, the history', () => {
  const answer = tallyMatchPicks({ rows: seeded(), picker_id: 'user:2' });
  assert.equal(answer.matches[0].userPick.choiceId, 'birch');
  assert.equal(answer.history.length, 1);
  assert.equal('history' in tallyMatchPicks({ rows: seeded() }), false);
  assert.throws(() => tallyMatchPicks({}), /rows must be a list/);
});

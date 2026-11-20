// The records a free pick is made of (read-data/pick-records.mjs): built and trimmed, refused when a field is missing,
// held to the person's banned wording, and read back by the tally that reads them. Made-up names and terms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { prepareMatchPickRecord } from '../do-work/prepare-match-pick-record.mjs';
import { readPicksState, matchPickViews } from '../read-data/match-picks.mjs';

const NOW = '2026-06-20T12:00:00.000Z';
const prompt = { what: 'prompt', matchId: 'pick-match:1', label: ' Alder vs Birch ', startsAt: '2026-06-20T14:00:00.000Z', choices: [{ choiceId: ' c:alder ', label: ' Alder ' }, { choiceId: 'c:birch', label: 'Birch' }], now: NOW };

test('a prompt is trimmed, open, and keeps the id given; without one it gets a new id', () => {
  const made = prepareMatchPickRecord(prompt);
  assert.equal(made.id, 'pick-match:1');
  assert.deepEqual(made.record, { kind: 'pick-match', matchId: 'pick-match:1', label: 'Alder vs Birch', startsAt: '2026-06-20T14:00:00.000Z', choices: [{ choiceId: 'c:alder', label: 'Alder' }, { choiceId: 'c:birch', label: 'Birch' }], status: 'open' });
  const first = prepareMatchPickRecord({ ...prompt, matchId: undefined });
  const second = prepareMatchPickRecord({ ...prompt, matchId: undefined });
  assert.match(first.id, /^pick-match:[0-9a-f-]{36}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.record.matchId, first.id);
});

test('a prompt needs a label, two choices, each with an id and a label, and no choice id twice', () => {
  assert.throws(() => prepareMatchPickRecord({ ...prompt, label: '  ' }), /needs label/);
  assert.throws(() => prepareMatchPickRecord({ ...prompt, choices: [prompt.choices[0]] }), /at least two choices/);
  assert.throws(() => prepareMatchPickRecord({ ...prompt, choices: [{ choiceId: 'a', label: 'A' }, { choiceId: '', label: 'B' }] }), /choices\[1\] needs choiceId/);
  assert.throws(() => prepareMatchPickRecord({ ...prompt, choices: [{ choiceId: 'a', label: 'A' }, { choiceId: 'b', label: ' ' }] }), /choices\[1\] needs label/);
  assert.throws(() => prepareMatchPickRecord({ ...prompt, choices: [{ choiceId: 'a', label: 'A' }, { choiceId: 'a', label: 'B' }] }), /given twice/);
});

test('a pick and a result carry the ids and the time, and refuse what is missing', () => {
  const pick = prepareMatchPickRecord({ what: 'pick', pickId: 'match-pick:1', matchId: ' m:1 ', pickerId: ' user:1 ', choiceId: ' c:alder ', now: NOW });
  assert.deepEqual(pick.record, { kind: 'match-pick', pickId: 'match-pick:1', matchId: 'm:1', pickerId: 'user:1', choiceId: 'c:alder', createdAt: NOW });
  const result = prepareMatchPickRecord({ what: 'result', resultId: 'r:1', matchId: 'm:1', winningChoiceId: 'c:alder', summary: '  Alder won in two sets.  ', now: NOW });
  assert.deepEqual(result.record, { kind: 'match-pick-result', resultId: 'r:1', matchId: 'm:1', winningChoiceId: 'c:alder', summary: 'Alder won in two sets.', resolvedAt: NOW });
  assert.throws(() => prepareMatchPickRecord({ what: 'pick', matchId: '', pickerId: 'u', choiceId: 'c' }), /needs matchId/);
  assert.throws(() => prepareMatchPickRecord({ what: 'pick', matchId: 'm', pickerId: 'u' }), /needs choiceId/);
  assert.throws(() => prepareMatchPickRecord({ what: 'result', matchId: 'm', winningChoiceId: 'c', summary: '' }), /needs summary/);
  assert.throws(() => prepareMatchPickRecord({ what: 'result', matchId: 'm', summary: 's' }), /needs winningChoiceId/);
});

test('the person\'s banned wording is refused in a prompt label, a choice label and a result summary, not in a pick', () => {
  assert.throws(() => prepareMatchPickRecord({ ...prompt, label: 'Best ZORP today', banned_terms: ['zorp'] }), /label cannot contain "zorp"/);
  assert.throws(() => prepareMatchPickRecord({ ...prompt, choices: [{ choiceId: 'a', label: 'Big  prize' }, { choiceId: 'b', label: 'B' }], banned_terms: ['big prize'] }), /choices\[0\]\.label cannot contain/);
  assert.throws(() => prepareMatchPickRecord({ what: 'result', matchId: 'm', winningChoiceId: 'c', summary: 'A zorp cleared', banned_terms: ['zorp'] }), /summary cannot contain/);
  assert.equal(prepareMatchPickRecord({ what: 'pick', matchId: 'm', pickerId: 'u', choiceId: 'zorp', banned_terms: ['zorp'], now: NOW }).record.choiceId, 'zorp');
  assert.equal(prepareMatchPickRecord({ ...prompt, banned_terms: [] }).id, 'pick-match:1', 'an empty list passes everything');
  assert.throws(() => prepareMatchPickRecord({ ...prompt, banned_terms: 'zorp' }), /banned_terms must be a list/);
});

test('what and now are refused when they are not usable', () => {
  assert.throws(() => prepareMatchPickRecord({ what: 'wager' }), /what must be one of prompt, pick, result/);
  assert.throws(() => prepareMatchPickRecord(null), /must be an object/);
  assert.throws(() => prepareMatchPickRecord({ ...prompt, now: 'soon' }), /now must be a time/);
});

test('records built here are the records the tally reads', () => {
  const rows = [
    prepareMatchPickRecord(prompt).record,
    ...['user:1', 'user:2', 'user:3'].map((pickerId, index) => prepareMatchPickRecord({ what: 'pick', matchId: 'pick-match:1', pickerId, choiceId: index === 0 ? 'c:alder' : 'c:birch', now: NOW }).record),
    prepareMatchPickRecord({ what: 'result', matchId: 'pick-match:1', winningChoiceId: 'c:birch', summary: 'Birch won.', now: NOW }).record,
  ];
  const [view] = matchPickViews(readPicksState(rows), 'user:1');
  assert.equal(view.totalPicks, 3);
  assert.deepEqual(view.choices.map(choice => [choice.choiceId, choice.percentPicked, choice.winner]), [['c:alder', 33, false], ['c:birch', 67, true]]);
  assert.equal(view.userPick.choiceId, 'c:alder');
});

test('the command reads one JSON request and prints one JSON line, and refuses in one line with a non-zero exit', async () => {
  const run = input => new Promise(resolve => {
    const child = execFile('node', ['do-work/prepare-match-pick-record.mjs'], { cwd: new URL('..', import.meta.url).pathname }, (error, stdout) => resolve({ error, line: JSON.parse(stdout.trim().split('\n').at(-1)) }));
    child.stdin.end(JSON.stringify(input));
  });
  const ok = await run({ what: 'pick', pickId: 'p1', matchId: 'm', pickerId: 'u', choiceId: 'c', now: NOW });
  assert.equal(ok.error, null);
  assert.equal(ok.line.result.record.createdAt, NOW);
  const refused = await run({ what: 'pick', matchId: 'm' });
  assert.notEqual(refused.error.code, 0);
  assert.match(refused.line.error, /needs pickerId/);
});

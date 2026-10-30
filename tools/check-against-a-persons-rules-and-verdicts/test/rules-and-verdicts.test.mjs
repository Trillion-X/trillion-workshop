// tools/check-against-a-persons-rules-and-verdicts: a person's exact stand decides first, their stated rows fail and their
// inferred rows only hold, nothing passes on silence, model rows never pass without a calibrated answer the caller gives,
// a row's held_when only holds, and labelled examples come from the person's stands. Every rule, line and stand here is
// made up for the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactRef } from '../../where-a-person-stands/do-work/artifact-ref.mjs';
import { CheckRefusal, check, compileVerdictRules, examplesFromStands, governing, linesOf, statusOf, verdictFindings } from '../do-work/rules-and-verdicts.mjs';

const FOLD = { lowercase: true, collapse_space: true, strip_trailing: '[.!?]+' };
const ref = text => artifactRef({ text }, FOLD);
const stand = (kind, text, stance, at, why = `about ${text}`) => ({ kind, artifact: ref(text), text, stance, why, at });
const PARTLY_PLUM = stand('title', 'Plum notes', 'partly', '2026-01-03T00:00:00Z', 'the plum part is fine');
const STANDS = [
  stand('title', 'Start here', 'agree', '2026-01-02T00:00:00Z'),
  stand('title', 'Zorblax for everyone', 'disagree', '2026-01-02T00:00:00Z', 'zorblax is not a word I use'),
  PARTLY_PLUM,
  stand('voice', 'calm voice', 'agree', '2026-01-02T00:00:00Z'),
  stand('voice', 'loud voice', 'disagree', '2026-01-02T00:00:00Z', 'too loud'),
  { kind: 'title', artifact: artifactRef({ contains: 'quiet part' }, FOLD), contains: 'quiet part', stance: 'disagree', why: 'not the quiet part', at: '2026-01-02T00:00:00Z' },
];
const DOC = {
  fold: FOLD,
  stage: { default: 'final' },
  stance_rule: 'their-stance',
  novel: { rule: 'novel', says: 'Nothing of theirs judges this.' },
  agree_clears: { rules: ['no-sparkle'] },
  rows: [
    { id: 'no-zorblax', kinds: ['title'], words: ['zorblax'], says: 'Never zorblax.', because: [ref('Zorblax for everyone')] },
    { id: 'maybe-long', kinds: ['title'], pattern: '\\w+ \\w+ \\w+ \\w+ \\w+', at_most: 'uncertain', says: 'Maybe too long.' },
    { id: 'has-a-verb', kinds: ['title'], words: ['start', 'zorblax', 'plum', 'find', 'sparkle', 'quiet'], required: true, at_most: 'uncertain', says: 'A title starts from an action.' },
    { id: 'plum-basis', kinds: ['title'], words: ['plum'], says: 'Plum only with care.', because: [ref('Plum notes')] },
    { id: 'gone-basis', kinds: ['title'], words: ['grape'], says: 'Grape is out.', because: [`1f:${'c'.repeat(64)}`] },
    { id: 'few-asks', kinds: ['plan'], path: 'steps.*.kind', where: 'ask', count_at_most: 1, when: { path: 'shape', where: 'quiz' }, says: 'One ask per quiz.' },
    { id: 'take-voice', kinds: ['take'], part: { path: 'voice', kind: 'voice' }, says: 'A take is judged by its voice.' },
    { id: 'reads-well', kinds: ['title'], ask: { question: 'Does it read well?', options: ['yes', 'no'], fail: 'no', calibration: { status: 'unseparable' } }, at_most: 'uncertain', says: 'May not read well.' },
  ],
};
const compiled = compileVerdictRules(DOC);
const GENERIC = [
  { id: 'no-sparkle', words: ['sparkle'], says: 'No sparkle.' },
  { id: 'no-hedge', words: ['maybe'], says: 'No hedging.', held_when: { path: 'origin', where: 'said-aloud' } },
];
const one = (unit, options = {}) => check([unit], options.rules ?? GENERIC, { stands: STANDS, verdictRules: compiled, ...options }).results[0];
const rules = result => [...result.breaks, ...result.uncertain].map(finding => finding.rule).sort();

test('their exact disagree fails the thing and quotes their words', () => {
  const result = one({ text: 'zorblax for everyone.', kind: 'title' });
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.breaks.map(finding => finding.rule), ['their-stance']);
  assert.match(result.breaks[0].says, /They disagreed: "zorblax is not a word I use"/);
});

test('partly holds at review and fails at final', () => {
  assert.equal(verdictFindings({ text: 'Plum notes', kind: 'title' }, { compiled, stands: STANDS, stage: 'review' }).findings[0].outcome, 'uncertain');
  assert.equal(verdictFindings({ text: 'Plum notes', kind: 'title' }, { compiled, stands: STANDS, stage: 'final' }).findings[0].outcome, 'fail');
  assert.equal(compiled.doc.stage.default, 'final');
});

test('their agree decides the thing and clears the generic rules their DATA names; a reworded thing is checked in full', () => {
  const agreed = one({ text: 'Start here', kind: 'title' });
  assert.equal(agreed.verdict, 'pass');
  const sparkle = stand('title', 'Start sparkle', 'agree', '2026-01-02T00:00:00Z');
  assert.equal(check([{ text: 'Start sparkle', kind: 'title' }], GENERIC, { stands: [sparkle], verdictRules: compiled }).results[0].verdict, 'pass');
  const reworded = one({ text: 'Start sparkle now', kind: 'title' });
  assert.ok(reworded.breaks.some(finding => finding.rule === 'no-sparkle'), 'similarity decides nothing');
});

test('a row newer than their agree still applies; an older one does not', () => {
  const newer = compileVerdictRules({ ...DOC, rows: [...DOC.rows, { id: 'no-here', kinds: ['title'], words: ['here'], says: 'Not here.', at: '2026-02-01T00:00:00Z' }] });
  assert.ok(verdictFindings({ text: 'Start here', kind: 'title' }, { compiled: newer, stands: STANDS }).findings.some(finding => finding.rule === 'no-here'));
  const older = compileVerdictRules({ ...DOC, rows: [...DOC.rows, { id: 'no-here', kinds: ['title'], words: ['here'], says: 'Not here.', at: '2025-12-01T00:00:00Z' }] });
  assert.equal(verdictFindings({ text: 'Start here', kind: 'title' }, { compiled: older, stands: STANDS }).decided, 'pass');
});

test('a stated row fails, an inferred row only holds, and an inferred required row that finds nothing holds at review and fails at final', () => {
  const found = verdictFindings({ text: 'Find zorblax in the old box today', kind: 'title' }, { compiled, stands: STANDS, stage: 'review' }).findings;
  assert.deepEqual(found.map(finding => [finding.rule, finding.outcome]).sort(), [['maybe-long', 'uncertain'], ['no-zorblax', 'fail']]);
  const silent = text => verdictFindings({ text, kind: 'title' }, { compiled, stands: STANDS, stage: 'review' }).findings.find(finding => finding.rule === 'has-a-verb');
  assert.equal(silent('An old box').outcome, 'uncertain');
  assert.equal(verdictFindings({ text: 'An old box', kind: 'title' }, { compiled, stands: STANDS, stage: 'final' }).findings.find(finding => finding.rule === 'has-a-verb').outcome, 'fail');
});

test('a row takes its strength from the newest stand it names, and holds once every stand it names is gone', () => {
  const plum = verdictFindings({ text: 'Find plum jam', kind: 'title' }, { compiled, stands: STANDS, stage: 'review' }).findings.find(finding => finding.rule === 'plum-basis');
  assert.equal(plum.outcome, 'uncertain');
  assert.match(plum.says, /They partly agreed: "the plum part is fine"/);
  const grape = verdictFindings({ text: 'Find grape jam', kind: 'title' }, { compiled, stands: STANDS }).findings.find(finding => finding.rule === 'gone-basis');
  assert.equal(grape.outcome, 'uncertain');
  assert.match(grape.says, /Basis gone/);
});

test('a stand on a part decides every thing holding that part; an exact stand wins over it', () => {
  assert.equal(governing(STANDS, { text: 'Find the quiet part fast', kind: 'title' }, compiled).contains, 'quiet part');
  assert.equal(one({ text: 'Find the quiet part fast', kind: 'title' }).verdict, 'fail');
  const exact = [...STANDS, stand('title', 'Find the quiet part fast', 'agree', '2026-01-01T00:00:00Z')];
  assert.equal(governing(exact, { text: 'Find the quiet part fast', kind: 'title' }, compiled).stance, 'agree');
});

test('a stand taken back is no stand, and the newest stand on a thing governs', () => {
  const taken = [stand('title', 'Start here', null, '2026-01-05T00:00:00Z')];
  assert.equal(governing(taken, { text: 'Start here', kind: 'title' }, compiled), null);
  const changed = [stand('title', 'Start here', 'disagree', '2026-01-01T00:00:00Z'), stand('title', 'Start here', 'agree', '2026-01-04T00:00:00Z')];
  assert.equal(governing(changed, { text: 'start here!', kind: 'title' }, compiled).stance, 'agree');
});

test('a part row gives a take the stand on its voice, and a voice never judged waits for them', () => {
  const take = voice => verdictFindings({ text: JSON.stringify({ voice }), view: { voice }, kind: 'take' }, { compiled, stands: STANDS, stage: 'review' }).findings;
  assert.deepEqual(take('calm voice'), []);
  assert.deepEqual(take('loud voice').map(finding => finding.outcome), ['fail']);
  assert.match(take('new voice')[0].says, /They have not judged this voice/);
  assert.equal(take('new voice')[0].outcome, 'uncertain');
});

test('a plan row applies by a value the plan holds, and nothing else judges the JSON', () => {
  const plan = (shape, asks) => ({ shape, steps: Array.from({ length: asks }, () => ({ kind: 'ask' })) });
  const quiz = one({ text: '', view: plan('quiz', 3), kind: 'plan' });
  assert.equal(quiz.verdict, 'fail');
  assert.deepEqual(quiz.breaks.map(finding => finding.rule), ['few-asks']);
  assert.deepEqual(quiz.applicable_rule_ids, ['few-asks']);
  assert.equal(one({ text: '', view: plan('quiz', 1), kind: 'plan' }).verdict, 'pass');
  const story = one({ text: '', view: plan('story', 3), kind: 'plan' }, { stage: 'review' });
  assert.deepEqual(rules(story), ['no-applicable-rule', 'novel']);
});

test('a thing nothing of theirs judges is novel: held at review, failed at final, though generic rules ran on it', () => {
  const review = one({ text: 'Sparkle', kind: 'caption' }, { stage: 'review' });
  assert.deepEqual(rules(review), ['no-sparkle', 'novel']);
  assert.equal(one({ text: 'Quiet hills', kind: 'caption' }, { stage: 'review' }).verdict, 'uncertain');
  assert.equal(one({ text: 'Quiet hills', kind: 'caption' }, { stage: 'final' }).verdict, 'fail');
});

test('a unit no rule applies to is unqualified, never passed', () => {
  const result = check([{ text: 'Quiet hills', kind: 'caption' }], [{ id: 'titles-only', kinds: ['title'], words: ['x'], says: 'x' }]).results[0];
  assert.equal(result.qualification, 'unqualified');
  assert.equal(result.verdict, 'uncertain');
  assert.equal(statusOf([result]), 'unqualified');
});

test('a held_when row only holds on units whose facts it names, and such a unit is advisory', () => {
  const said = check([{ text: 'Maybe later', kind: 'line', facts: { origin: 'said-aloud' } }], GENERIC).results[0];
  assert.equal(said.verdict, 'uncertain');
  assert.equal(said.advisory, true);
  assert.match(said.uncertain[0].says, /Held, not failed/);
  const added = check([{ text: 'Maybe later', kind: 'line', facts: { origin: 'typed' } }], GENERIC).results[0];
  assert.equal(added.verdict, 'fail');
  assert.equal(check([{ text: 'Maybe later', kind: 'line' }], GENERIC).results[0].verdict, 'fail');
});

const ASK = (calibration, extra = {}) => ({ id: 'sounds-off', kinds: ['line'], ask: { question: 'Does it sound off?', options: ['yes', 'no'], fail: 'yes', calibration, ...extra }, says: 'Sounds off.' });

test('a model row asks one question per sentence with an id, and an unanswered question never passes', () => {
  const rows = [ASK({ status: 'usable', t_pass: 0.3, t_fail: 0.7 }), { id: 'any', words: ['zzz'], says: 'z' }];
  const { results, questions } = check([{ text: 'One thing. Two things!', kind: 'line', context: { before: 'a' } }], rows);
  assert.deepEqual(questions.map(question => [question.id, question.text]), [['0:sounds-off:0', 'One thing.'], ['0:sounds-off:1', 'Two things!']]);
  assert.deepEqual(questions[0].context, { before: 'a' });
  assert.equal(results[0].verdict, 'uncertain');
  assert.equal(results[0].uncertain[0].why, 'no model answer');
  const answered = p => check([{ text: 'One thing. Two things!', kind: 'line' }], rows, { answers: { '0:sounds-off:0': { yes: 0.1 }, '0:sounds-off:1': { yes: p } } }).results[0];
  assert.equal(answered(0.9).verdict, 'fail');
  assert.equal(answered(0.5).verdict, 'uncertain');
  assert.equal(answered(0.1).verdict, 'pass');
  assert.equal(answered(1.5).verdict, 'uncertain', 'a probability out of range is unknown, never a pass');
});

test('a model row that is not usable, or has bad bounds, never passes; a capped row never fails and cannot qualify alone', () => {
  const answers = { '0:sounds-off:0': { yes: 0.99 } };
  assert.equal(check([{ text: 'One thing.', kind: 'line' }], [ASK({ status: 'unseparable' }), { id: 'any', words: ['zzz'], says: 'z' }], { answers }).results[0].uncertain[0].qualified, false);
  assert.match(check([{ text: 'One thing.', kind: 'line' }], [ASK({ status: 'usable', t_pass: 0.8, t_fail: 0.2 })], { answers }).results[0].uncertain[0].why, /bounds/);
  const capped = check([{ text: 'One thing.', kind: 'line' }], [ASK({ status: 'usable', t_pass: 0.3, t_fail: 0.7 }, { at_most: 'uncertain' })], { answers }).results[0];
  assert.equal(capped.verdict, 'uncertain');
  assert.deepEqual(rules(capped), ['sounds-off', 'uncertain-only-rows-cannot-qualify']);
});

test('a reading row of theirs is not asked until its calibration is usable, and holds the thing meanwhile', () => {
  const { results, questions } = check([{ text: 'Find old maps', kind: 'title' }], GENERIC, { verdictRules: compiled, stands: STANDS, stage: 'review' });
  assert.deepEqual(questions, []);
  const held = results[0].uncertain.find(finding => finding.rule === 'reads-well');
  assert.equal(held.qualified, false);
  const usable = compileVerdictRules({ ...DOC, rows: DOC.rows.map(row => (row.id === 'reads-well' ? { ...row, ask: { ...row.ask, calibration: { status: 'usable', t_pass: 0.3, t_fail: 0.7 } } } : row)) });
  assert.deepEqual(check([{ text: 'Find old maps', kind: 'title' }], GENERIC, { verdictRules: usable, stands: STANDS }).questions.map(question => question.rule), ['reads-well']);
  assert.deepEqual(check([{ text: 'Start here', kind: 'title' }], GENERIC, { verdictRules: usable, stands: STANDS }).questions, [], 'their exact stand decides it');
});

test('findings the caller already has count, and a unit needing context review never fails on a word finding', () => {
  const also = check([{ text: 'Quiet hills', kind: 'line', also_found: [{ rule: 'read-first', outcome: 'fail', found: 'hills', says: 'Say what hills.' }] }], GENERIC).results[0];
  assert.equal(also.verdict, 'fail');
  const context = check([{ text: 'Sparkle', kind: 'line', context_requires_review: true }], GENERIC).results[0];
  assert.equal(context.verdict, 'uncertain');
  assert.equal(context.qualification, 'context-unqualified');
  assert.deepEqual(rules(context), ['context-policy-unqualified', 'no-sparkle']);
});

test('the lines say each unit that did not pass and each finding', () => {
  const lines = linesOf(check([{ text: 'Sparkle', kind: 'line', where: 'a.txt:1' }, { text: 'Quiet', kind: 'line' }], GENERIC).results);
  assert.equal(lines[0], '2 units: 1 fail, 0 uncertain, 1 pass');
  assert.equal(lines[1], 'FAIL [line] a.txt:1');
  assert.equal(lines[2], '  no-sparkle: "Sparkle". No sparkle.');
});

test('a request it cannot check is refused with what to send', () => {
  assert.throws(() => check([{ text: 'x', kind: 'line' }], []), CheckRefusal);
  assert.throws(() => check([], GENERIC), CheckRefusal);
  assert.throws(() => check([{ text: ' ', kind: 'line' }], GENERIC), CheckRefusal);
  assert.throws(() => check([{ text: 'x', kind: 'line' }], GENERIC, { stage: 'draft' }), /review or final/);
  assert.throws(() => compileVerdictRules({ rows: [] }), /Missing: fold, stage.default, stance_rule, novel.rule, novel.says, agree_clears.rules/);
});

test('their stands become labelled examples for the reading rows: agreed things good, a rejected pair bad for its row', () => {
  const withPairs = compileVerdictRules({ ...DOC, rows: DOC.rows.map(row => (row.id === 'reads-well' ? { ...row, pairs: [{ rejected: ref('Zorblax for everyone') }] } : row)) });
  const { items, rows: reading } = examplesFromStands(withPairs, STANDS);
  assert.deepEqual(reading, ['reads-well']);
  assert.deepEqual(items.map(item => [item.text, item.good, item.bad_for]).sort(), [['Start here', true, []], ['Zorblax for everyone', false, ['reads-well']]]);
  const missing = compileVerdictRules({ ...DOC, rows: DOC.rows.map(row => (row.id === 'reads-well' ? { ...row, pairs: [{ rejected: `1f:${'d'.repeat(64)}` }] } : row)) });
  assert.throws(() => examplesFromStands(missing, STANDS), CheckRefusal);
});

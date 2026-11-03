// tools/check-against-a-persons-rules-and-verdicts: only the person's own agree on one exact line waives the one rule it
// names; a model row's adapter, model and examples travel with its questions; and a unit's words are the person's own only
// when every word is literally in a span they said. Every rule, line, stand and span here is made up for the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactRef } from '../../where-a-person-stands/do-work/artifact-ref.mjs';
import { check, compileVerdictRules, governing, linesOf, waivers } from '../do-work/rules-and-verdicts.mjs';

const FOLD = { lowercase: true, quotes: [['‘’', "'"]], collapse_space: true, strip_trailing: '[.!?]+' };
const RULES = [
  { id: 'no-not-quite', words: ['not quite'], says: 'No "not quite" openers.' },
  { id: 'no-zorblax', words: ['zorblax'], says: 'No zorblax.' },
];
const unit = (text, kind = 'narrator') => ({ text, kind, where: 'test' });
const run = (text, stands) => check([unit(text)], RULES, { stands }).results[0];

test('the person\'s agree on one exact line, naming one rule, waives that rule there and is listed as waived', () => {
  const ruling = { text: 'Not quite.', stance: 'agree', by: 'person', rule: 'no-not-quite' };
  assert.equal(run('Not quite.', []).verdict, 'fail');
  const waived = run('Not quite.', [ruling]);
  assert.equal(waived.verdict, 'pass');
  assert.deepEqual(waived.waived.map(finding => finding.rule), ['no-not-quite']);
  assert.equal(run('  Not quite.  ', [{ ...ruling, by: undefined }]).verdict, 'pass');
  const lines = linesOf([waived]);
  assert.match(lines[1], /^WAIVED \[narrator\] test$/);
  assert.match(lines[2], /no-not-quite: the person agreed to this exact line/);
  assert.equal(waivers([ruling]).size, 1);
});

test('nothing else waives: another line however close, a stand by someone else, disagree, no rule, another rule', () => {
  const ruling = { text: 'Not quite.', stance: 'agree', by: 'person', rule: 'no-not-quite' };
  for (const other of ['Not quite right.', 'Not quite!', 'Not quite, but zorblax.']) {
    assert.equal(run(other, [ruling]).verdict, run(other, []).verdict, other);
    assert.deepEqual(run(other, [ruling]).waived, [], other);
  }
  for (const weak of [{ ...ruling, by: 'helper' }, { ...ruling, stance: 'disagree' }, { ...ruling, rule: undefined }, { ...ruling, rule: 'no-zorblax' }]) {
    assert.equal(run('Not quite.', [weak]).verdict, 'fail', JSON.stringify(weak));
  }
  // a stand that names a rule is never the person's verdict on the whole thing
  const compiled = compileVerdictRules({ rows: [], fold: FOLD, stage: { default: 'final' }, stance_rule: 'their-stance',
    novel: { rule: 'novel', says: 'Nothing of theirs judges this.' }, agree_clears: { rules: [] } });
  const ruleStand = { ...ruling, kind: 'narrator', artifact: artifactRef({ text: 'Not quite.' }, FOLD), stance: 'disagree' };
  assert.equal(governing([ruleStand], unit('Not quite.'), compiled), null);
});

test('a model row\'s adapter, model and examples go with each question, and its finding names the adapter', () => {
  const adapter = { blake3: 'made-up-adapter-id', name: 'made-up adapter' };
  const row = { id: 'reads-well', says: 'May not read well.', ask: { question: 'Does it read well?', options: ['yes', 'no'], fail: 'no',
    adapter, model: 'made-up-small-model', examples: [{ text: 'A good line.', good: true }], calibration: { status: 'usable', t_pass: 0.3, t_fail: 0.6 } } };
  const first = check([{ ...unit('A plum line. Another plum line.'), context: { before: 'Earlier words.' } }], [row]);
  assert.equal(first.questions.length, 2);
  for (const question of first.questions) {
    assert.deepEqual([question.adapter, question.model, question.examples, question.context],
      [adapter, 'made-up-small-model', [{ text: 'A good line.', good: true }], { before: 'Earlier words.' }]);
  }
  const answers = Object.fromEntries(first.questions.map(question => [question.id, { yes: 0.1, no: 0.9 }]));
  const [result] = check([unit('A plum line. Another plum line.')], [row], { answers }).results;
  assert.equal(result.verdict, 'fail');
  assert.equal(result.breaks[0].adapter, 'made-up-adapter-id');
  const plain = { ...row, ask: { ...row.ask, adapter: undefined, model: undefined, examples: undefined } };
  const [question] = check([unit('A plum line.')], [plain]).questions;
  assert.deepEqual(['adapter', 'model', 'examples'].filter(key => key in question), []);
});

// The person's own words: spans from a recording, as the caller reads them. literalPieces is pin-files-by-content's.
const origins = await import('../do-work/spoken-origins.mjs').catch(error => ({ missing: error.message }));
const skip = origins.missing ? `needs tools/pin-files-by-content/do-work/verify-source-spans.mjs (literalPieces): ${origins.missing}` : false;
const SPANS = [{ clip: 'K0042', from: 1, to: 5, text: "so then you can zorblax those notes later. and that's my guess" }];
const HOLDS = [{ id: 'no-zorblax', words: ['zorblax'], says: 'No zorblax.', held_when: { path: 'origin', where: 'own-words' } },
  { id: 'capital-after-stop', check: 'capital-after-stop', says: 'A capital after a full stop.' }];

test('words literally in a span the person said are their own, with the span; an added or changed word is not', { skip }, () => {
  const [own, mixed, capital, quote, swapped] = origins.withSpokenOrigins([unit('you can zorblax those notes later.'),
    unit('you can zorblax those notes later [today].'), unit('You can zorblax those notes later.'), unit('And that’s my guess.'),
    unit('You can use those notes later.'), ], SPANS, { fold: FOLD });
  assert.deepEqual([own.facts.origin, own.facts.span], ['own-words', { clip: 'K0042', from: 1, to: 5 }]);
  assert.deepEqual([mixed, capital, quote, swapped].map(one => one.facts.origin), ['added-words', 'own-words', 'own-words', 'added-words']);
  const view = { view: { a: 1 }, kind: 'plan' };
  assert.equal(origins.withSpokenOrigins([view], SPANS, { fold: FOLD })[0], view);
});

test('a row for added words holds on the person\'s own words and is advisory there; mechanical rows still fail', { skip }, () => {
  const [own, mechanical, added] = origins.withSpokenOrigins([unit('you can zorblax those notes later.'),
    unit('you can zorblax those notes later. and then we go'), unit('We zorblax your notes.')],
  [{ ...SPANS[0], text: `${SPANS[0].text} and then we go` }], { fold: FOLD });
  const { results } = check([own, mechanical, added], HOLDS);
  assert.deepEqual(results[0].breaks, []);
  assert.deepEqual([results[0].verdict, results[0].advisory, results[0].uncertain[0].rule], ['uncertain', true, 'no-zorblax']);
  assert.deepEqual(results[1].breaks.map(finding => finding.rule), ['capital-after-stop']);
  assert.deepEqual(results[2].breaks.map(finding => finding.rule), ['no-zorblax']);
});

test('recorded words whose speaker no one checked are judged as added words, never softened', { skip }, () => {
  const spans = [{ clip: 'K9999', from: null, to: null, speaker_verified: false, text: 'we zorblax your notes' },
    { clip: 'K0001', from: 0, to: 1, text: 'nothing alike' }];
  const [line] = origins.withSpokenOrigins([unit('We zorblax your notes.')], spans, { fold: FOLD });
  assert.deepEqual([line.facts.origin, line.facts.span.clip], ['unverified-speaker', 'K9999']);
  const [result] = check([line], HOLDS).results;
  assert.deepEqual(result.breaks.map(finding => finding.rule), ['no-zorblax']);
});

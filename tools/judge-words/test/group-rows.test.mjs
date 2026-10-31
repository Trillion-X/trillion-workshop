// tools/judge-words: rows that select named groups of markers across a whole piece (a framework's parts, the feelings
// a script carries, cues it is spoken with), with the share found, groups found together in one line, a marker said
// again later, and one word said three times. Carried from bitfield-packages
// packages/content-gate/__tests__/owner-framework-gates.test.ts (its framework, emotion, retention, voice and humour
// gates); their rule sets were a person's own, so test/fixtures/made-up-rule-sets.json holds made-up ones of the same shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { judge, makeJudge } from '../do-work/judge-words.mjs';

const SETS = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/made-up-rule-sets.json'), 'utf8'));
const lines = (...texts) => texts.map((text, index) => ({ text, kind: 'line', path: ['lines', index] }));
const run = (set, items) => judge({ ...SETS[set], items });
const uncapped = answer => answer.findings.filter(finding => finding.at_most === undefined);

test('framework: all three parts with two together in one line scores high', () => {
  const answer = run('framework', lines(
    'The soil holds the roots. The water feeds them. The light wakes them.',
    'These three work together: the gardener grows, the painter finds colour, and the sun and rain meet.',
  ));
  assert.ok(answer.score > 50, String(answer.score));
  assert.equal(answer.findings.every(finding => finding.rule !== 'core-parts'), true);
});

test('framework: a part missing fails, and the finding names it', () => {
  const answer = run('framework', lines('The soil holds the roots. The water feeds them.'));
  assert.equal(answer.passed, false);
  const missing = answer.findings.find(finding => finding.rule === 'core-parts' && finding.test === 'percent_found_at_least');
  assert.deepEqual(missing.missing, ['Light']);
  assert.match(answer.lines.join('\n'), /66\.7% found, at least 100% needed; not found: Light/);
});

test('framework: four of five roles is 80%, which holds that row', () => {
  const answer = run('framework', lines('The gardener grows. The painter finds colour. The sailor sets out on a voyage. The baker makes bread.'));
  assert.equal(answer.findings.some(finding => finding.rule === 'roles'), false);
  assert.ok(answer.score >= 40, String(answer.score));
});

test('feeling: a script open about what went wrong scores above 60; one with no marker fails', () => {
  const open = run('feeling', lines(
    'I failed for years at this. My mistake taught me everything. It was real and honest.',
    'I remember when I was new, just like you. That is why it matters.',
  ));
  assert.ok(open.score > 60, String(open.score));
  assert.equal(uncapped(open).length, 0);
  assert.equal(run('feeling', lines('This is a neutral statement with nothing in it.')).passed, false);
});

test('remembering: a key word said again two lines later counts; said in the next line only, it does not', () => {
  const spaced = run('remembering', lines(
    'The garden starts with what you have.',
    'Many give up in the middle. Watch how others keep going.',
    'Real growth comes when you keep at the garden.',
    'How would you start yours? What did you discover?',
  ));
  assert.equal(spaced.findings.some(finding => finding.rule === 'said-again'), false);
  assert.ok(spaced.score >= 40, String(spaced.score));
  const adjacent = makeJudge([SETS.remembering.rules[0]])(lines('The garden.', 'The garden again.', 'Nothing else.'));
  assert.deepEqual(adjacent.map(finding => finding.missing), [['key']]);
  const partial = run('remembering', lines('The story starts with a struggle. Then comes what we learn.'));
  assert.equal(typeof partial.score, 'number');
});

test('voice: a word said three times and marked pauses pass; with no word said three times the uncapped row fails', () => {
  const marked = run('voice', lines(
    'Patience. [PAUSE] Patience is everything. [PAUSE] Patience, patience, patience.',
    'When you practise patience, all of it shifts. This is [LOUD]VITAL[/LOUD].',
  ));
  assert.equal(uncapped(marked).length, 0);
  assert.ok(marked.score >= SETS.voice.min_score, String(marked.score));
  const flat = run('voice', lines('No key phrase is repeated three times in this content.'));
  assert.equal(flat.passed, false);
  assert.ok(flat.findings.some(finding => finding.rule === 'said-three-times'));
  assert.match(flat.lines.find(line => line.includes('said')), /at least 3 needed/);
});

test('humour: a slip, a twist, laughing at yourself and talking to the viewer pass; flat words still get an answer', () => {
  const warm = run('humour', lines(
    'So I tried this myself. [SLIP] Honestly, I was terrible at it at first. But you know what? I kept going.',
    "Look, I'm not the best at explaining this, but here is the twist: the slip is the lesson.",
  ));
  assert.deepEqual([warm.status, warm.findings.length], ['passed', 0]);
  const flat = run('humour', lines('This is a formal, impersonal statement without any marker.'));
  assert.equal(typeof flat.score, 'number');
});

test('a whole script is judged by every set at once, and none scores 0', () => {
  const script = lines(
    'I failed for years with this. My mind said one thing, the roots of it said another. [PAUSE] Listen to that.',
    'The gardener in me wanted more. The painter in me wanted colour. But the sailor said: wait. What if growth, growth, growth is not the point?',
    'The light shows what the water cannot. The soil holds it all. [SLIP] I got this wrong five times before it worked.',
    'Honestly, I still struggle. But the journey changed me, like you. What would you discover in the garden if you stopped?',
  );
  for (const set of Object.keys(SETS).filter(name => name !== 'what_this_is')) {
    const answer = run(set, script);
    assert.ok(answer.score > 30, `${set} ${answer.score}`);
  }
});

test('group rows are refused when compiled wrong: no markers, a share test without groups, apart or together without across', () => {
  assert.throws(() => makeJudge([{ id: 'g', groups: [{ id: 'a' }] }]), /needs words or patterns/);
  assert.throws(() => makeJudge([{ id: 'g', groups: [{ words: ['a'] }] }]), /an id each/);
  assert.throws(() => makeJudge([{ id: 'g', pattern: 'a', percent_found_at_least: 50 }]), /needs groups/);
  assert.throws(() => makeJudge([{ id: 'g', groups: [{ id: 'a', words: ['a'] }], together_at_least: 2 }]), /across/);
  assert.throws(() => makeJudge([{ id: 'g', groups: [{ id: 'a', words: ['a'], apart_at_least: 2 }] }]), /across/);
  assert.throws(() => makeJudge([{ id: 'g', groups: [{ id: 'a', words: ['a'], weight: -1 }] }]), /weight/);
});

test('a group row judged per line flags each group a line holds, and weights shape the share', () => {
  const each = makeJudge([{ id: 'g', says: 'x', groups: [{ id: 'a', words: ['alpha'] }, { id: 'b', patterns: ['\\bbeta\\b'] }] }]);
  assert.deepEqual(each(lines('alpha and beta', 'beta only')).map(finding => [finding.path, finding.found]),
    [['lines.0', 'a'], ['lines.0', 'b'], ['lines.1', 'b']]);
  const weighted = { id: 'w', says: 'x', across: true, percent_found_at_least: 100,
    groups: [{ id: 'heavy', words: ['heavy'], weight: 3 }, { id: 'light', words: ['light'] }] };
  assert.equal(judge({ rules: [weighted], items: lines('only heavy here') }).score, 75);
});

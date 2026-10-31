// tools/judge-words: a whole sales page and a whole video script judged by a person's rows, with every finding placed
// at its block and offset. Carried from bitfield-packages packages/content-gate/__tests__/ethos-page-copy-gate.test.ts
// and ethos-video-script-gate.test.ts; those ran a person's real page and a real ad transcript, so
// test/fixtures/made-up-page-and-script.json holds a made-up page and script with the same counts and gaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { judge, makeJudge } from '../do-work/judge-words.mjs';

const { page, script } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/made-up-page-and-script.json'), 'utf8'));
const blocks = list => list.map((block, index) => ({ text: block.text, kind: block.kind, path: ['blocks', index], value: block }));
const run = (set, list) => judge({ rules: set.rules, items: blocks(list), ...(set.min_score !== undefined ? { min_score: set.min_score } : {}) });
const uncapped = answer => answer.findings.filter(finding => finding.at_most === undefined);
const of = (answer, rule) => answer.findings.filter(finding => finding.rule === rule);
const cleaned = page.blocks.map(block => ({ ...block, text: block.text.replace(/—/g, ' - ') }));

test('the page fails on its long dashes: six uncapped findings, each at its block and offset, each saying what to write instead', () => {
  const answer = run(page, page.blocks);
  assert.equal(answer.passed, false);
  const dashes = of(answer, 'no-long-dash');
  assert.equal(dashes.length, 6);
  for (const finding of dashes) {
    assert.equal(finding.at_most, undefined);
    assert.match(finding.path, /^blocks\.\d+$/);
    assert.equal(typeof finding.offset, 'number');
    assert.equal(page.blocks[Number(finding.path.split('.')[1])].text.slice(finding.offset, finding.offset + 1), '—');
    assert.equal(finding.found, '—');
    assert.equal(finding.suggest, '" - "');
  }
});

test('with the dashes replaced the page holds: no uncapped finding, and the dash row finds nothing', () => {
  const answer = run(page, cleaned);
  assert.equal(answer.status, 'held');
  assert.equal(uncapped(answer).length, 0);
  assert.equal(of(answer, 'no-long-dash').length, 0);
});

test('hedges and weak intensifiers are capped findings: found, never failing', () => {
  const answer = run(page, page.blocks);
  assert.deepEqual([of(answer, 'no-hedge-hoping').length, of(answer, 'no-weak-very').length], [3, 4]);
  assert.equal(of(answer, 'no-hedge-hoping')[0].at_most, 'warn');
  const hedgesOnly = run(page, [{ kind: 'paragraph', text: "you're hoping it works. hoping your teacher knows. hoping the advice is good." }]);
  assert.equal(hedgesOnly.status, 'held');
  assert.equal(of(hedgesOnly, 'no-hedge-hoping').length, 3);
});

test('a blank block is no item, an item without a kind is of no kind, and a request with no words is no input', () => {
  const answer = judge({ rules: page.rules, items: [{ text: 'hello', kind: 'paragraph' }, { text: '' }, { text: '   ' }] });
  assert.equal(answer.coverage.items, 1);
  assert.equal(judge({ rules: page.rules, items: [{ text: 'some words' }] }).findings.every(finding => !('kind' in finding)), true);
  assert.equal(judge({ rules: page.rules, items: [] }).status, 'no-input');
  assert.equal(run(page, page.blocks).coverage.items, page.blocks.length - 1);   // the empty paragraph is not judged
});

test('the script fails honestly: it names exactly the two missing parts, its order holds, and it has no long dash', () => {
  const answer = run(script, script.blocks);
  assert.equal(answer.passed, false);
  assert.deepEqual(of(answer, 'script-parts').map(finding => finding.found), ['quote', 'ask']);
  assert.equal(of(answer, 'script-order').length, 0);
  assert.equal(of(answer, 'no-long-dash').length, 0);
});

test('the script with a quote and an ask added in order passes', () => {
  const completed = [...script.blocks, { kind: 'quote', text: 'A learner who had never touched clay threw a bowl in one afternoon.' },
    { kind: 'ask', text: 'Book the weekend from the link and bring old clothes.' }];
  const answer = run(script, completed);
  assert.deepEqual([answer.status, uncapped(answer).length], ['passed', 0]);
});

test('an ask before the hook fails on order even with every part there', () => {
  const scrambled = [{ kind: 'ask', text: 'Book now.' }, ...script.blocks, { kind: 'quote', text: 'One afternoon, one bowl.' }];
  const answer = run(script, scrambled);
  assert.equal(answer.passed, false);
  assert.equal(of(answer, 'script-order').length, 1);
});

test('every row of both rule sets compiles: each is DATA over the one judge', () => {
  assert.doesNotThrow(() => makeJudge([...page.rules, ...script.rules]));
});

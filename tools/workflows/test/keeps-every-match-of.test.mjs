// Tests for the keeps-every-match-of check kind (recipe-check-kinds.json): every piece the patterns match in the text a
// step was handed is still in its answer. Run on the Workshop runner; the text, patterns and answers are made up.
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkProblems, checkSteps } from '../read-data/check-bindings.mjs';
import { runWorkflow } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';

const rule = {
  kind: 'keeps-every-match-of', says: 'Every page mark, link and number is kept',
  path: [['this', 'pages'], ['this', 'caption']], of: [['input', 'piece', 'pages'], ['input', 'piece', 'caption']],
  patterns: ['PAGE \\d+', 'https?://\\S+', '\\d+(?:[.,]\\d+)*%?'],
};
const piece = { pages: 'PAGE 1\nWe grew 42% in 2025.\nPAGE 2\nSee https://example.org/a', caption: '3 tips' };

function run(answer, rules = [rule]) {
  const judged = checkSteps('rewrite', rules);
  const steps = [{ id: 'rewrite', kind: 'ask', config: { name: 'anyone', input: { do: 'Rewrite.' } } }, ...judged.steps, { id: 'after', kind: 'ask', config: { name: 'anyone', input: { do: 'Then this.' } } }];
  const id = 'workflow:sample-keeps';
  return runWorkflow({ definitions: [{ id, name: id, kind: 'workflow', is_active: true, version: 1, steps, edges: [...judged.edges, judged.onwards('after')] }], workflow_id: id, input: { piece }, answers: { rewrite: answer }, partition: 'person' });
}

test('a rule naming its patterns is valid; one without patterns is refused', () => {
  const schemas = { input: { type: 'object', properties: { piece: { type: 'object', properties: { pages: { type: 'string' }, caption: { type: 'string' } } } } } };
  assert.deepEqual(checkProblems([rule], 'anyone', 'rewrite', [], undefined, null), []);
  assert.equal(checkProblems([{ ...rule, patterns: [] }], 'anyone', 'rewrite', [], undefined, null).length, 1);
  assert.equal(checkProblems([{ ...rule, patterns: [''] }], 'anyone', 'rewrite', [], undefined, schemas).length, 1);
});

test('reworded, reordered and spread across fields, every match is kept and the run goes on', async () => {
  const ran = await run({ pages: 'PAGE 1\nIn 2025 we grew 42%.\nPAGE 2\nRead https://example.org/a', caption: 'Three tips (3)' });
  assert.deepEqual(ran.waiting.map(item => item.step_id), ['after']);
});

test('a dropped number, link or page mark fails the run, naming the pieces lost', async () => {
  const number = await run({ pages: 'PAGE 1\nWe grew a lot in 2025.\nPAGE 2\nSee https://example.org/a', caption: '3 tips' });
  assert.equal(number.status, 'failed');
  assert.match(String(number.error_message), /Every page mark, link and number is kept \("42%"\)/);
  const marks = await run({ pages: 'We grew 42% in 2025. See https://example.org/b', caption: '3 tips' });
  assert.match(String(marks.error_message), /"PAGE 1"/);
  assert.match(String(marks.error_message), /"https:\/\/example.org\/a"/);
});

test('matching is exact: a changed case or a moved digit is a lost piece', async () => {
  const lowered = await run({ pages: 'page 1\nWe grew 42% in 2025.\nPAGE 2\nSee https://example.org/a', caption: '3 tips' });
  assert.match(String(lowered.error_message), /"PAGE 1"/);
  const moved = await run({ pages: 'PAGE 1\nWe grew 24% in 2025.\nPAGE 2\nSee https://example.org/a', caption: '3 tips' });
  assert.match(String(moved.error_message), /"42%"/);
});

test('a pattern with a group keeps only the group, and text with no matches holds', async () => {
  const grouped = { ...rule, patterns: ['PAGE (\\d+)'] };
  const ran = await run({ pages: 'Page 1, page 2', caption: '' }, [grouped]);
  assert.deepEqual(ran.waiting.map(item => item.step_id), ['after'], 'the digits 1 and 2 are kept even though the mark words changed');
  const none = await run({ pages: 'anything', caption: '' }, [{ ...rule, patterns: ['NOTHING-HERE-\\d+'] }]);
  assert.deepEqual(none.waiting.map(item => item.step_id), ['after']);
});

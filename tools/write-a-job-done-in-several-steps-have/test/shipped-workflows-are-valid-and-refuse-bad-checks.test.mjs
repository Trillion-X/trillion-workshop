// tools/write-a-job-done-in-several-steps-have: every shipped workflow row is a valid recipe, and a recipe whose check
// rules are malformed is refused in plain words. Ported from the older version's test/workflows.test.mjs ("the shipped
// L078 workflow is a valid recipe") and its checkProblems (src/workflows.mjs.held:93-116, at b6ae0ebf81).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { recipeProblems } from '../read-data/workflows.mjs';

const SHIPPED = fileURLToPath(new URL('../../workflows/recipes/workflows.json', import.meta.url));

// Every object in the shipped file that is a workflow row: an `id` of "workflow:..." with steps or a definition.
function workflowRows(value, found = []) {
  if (Array.isArray(value)) value.forEach(item => workflowRows(item, found));
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && value.id.startsWith('workflow:') && (value.steps || value.definition)) found.push(value);
    else Object.values(value).forEach(item => workflowRows(item, found));
  }
  return found;
}

test('every shipped workflow row is a valid recipe', () => {
  const rows = workflowRows(JSON.parse(readFileSync(SHIPPED, 'utf8')));
  assert.ok(rows.length > 100, `expected the shipped workflows, found ${rows.length}`);
  for (const row of rows) assert.deepEqual(recipeProblems(row), [], row.id);
});

// One recipe whose second step carries the given check rules; the first step has none, so only the second step's
// rules are judged. Each refusal names the step and the rule.
const withChecks = checks => ({
  id: 'workflow:check-rules-probe',
  job: 'probe the check rules',
  steps: [
    { id: 'a', do: 'write it', submit: { type: 'object' } },
    { id: 'b', do: 'judge it', submit: { type: 'object' }, checks },
  ],
});

test('a check rule with an unknown kind, or no words in plain English, is refused by name', () => {
  assert.deepEqual(recipeProblems(withChecks([{ kind: 'nope', says: 'x', path: ['this'] }])).length, 1);
  assert.match(recipeProblems(withChecks([{ kind: 'nope', says: 'x', path: ['this'] }]))[0], /steps\[1\]\.checks\[0\]\.kind must be one of: subset-of, covers/);
  assert.deepEqual(recipeProblems(withChecks([{ kind: 'subset-of', path: ['this'], of: [['this', 'k']] }])), ['steps[1].checks[0].says must say, in plain words, what the check asks for.']);
});

test('a check rule whose path, lookup or words are malformed is refused, as the older check step refused it', () => {
  const refused = (rule, pattern) => {
    const problems = recipeProblems(withChecks([rule]));
    assert.ok(problems.some(line => pattern.test(line)), `${JSON.stringify(rule)} should be refused: ${problems.join(' | ')}`);
  };
  refused({ kind: 'exists', says: 's', path: ['foo', 'x'], catalog: 'workflow' }, /path must be a list of keys starting with "this", "input", "steps"/);
  refused({ kind: 'exists', says: 's', path: ['steps', 'b', 'x'], catalog: 'workflow' }, /path reads step "b", which is not an earlier step/);
  refused({ kind: 'exists', says: 's', path: ['this'], catalog: 'planet' }, /catalog must be one of: workflow, tool, list-row, record/);
  refused({ kind: 'subset-of', says: 's', path: ['this'] }, /of is required/);
  refused({ kind: 'excludes-words', says: 's', path: ['this'], words: [] }, /words must list the words to keep out/);
  refused({ kind: 'distinct-at-least', says: 's', path: ['this'], count: 0 }, /count must be a whole number above 0/);
  refused({ kind: 'mentioned-in', says: 's', path: ['this'] }, /in is required/);
  refused({ kind: 'covers', says: 's', of: [['this']] }, /path is required/);
});

test('a well-formed check rule passes', () => {
  assert.deepEqual(recipeProblems(withChecks([{ kind: 'covers', says: 'covers the list', path: ['this'], of: [['this', 'q']] }])), []);
});

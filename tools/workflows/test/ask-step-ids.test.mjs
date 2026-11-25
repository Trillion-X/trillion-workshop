// tools/workflows: an ask step whose context.step_id is not its own id, or that two ask steps share, is refused at write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { askStepIdProblems } from '../read-data/ask-step-ids.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';
import { recipeProblems as writtenProblems } from '../../write-a-job-done-in-several-steps-have/read-data/workflows.mjs';

const ask = (id, step_id) => ({ id, kind: 'ask', config: { name: 'anyone', context: step_id === undefined ? {} : { step_id }, input: { do: 'x', submit: { type: 'object' } } } });
// The put-a-sites-commit-live recipe as written Nov 24 2026 at 9:31 PM CST: two new asks copied from prove with its step_id.
const copied = { id: 'workflow:put-live', steps: [ask('apply', 'apply'), ask('prove', 'prove'), ask('picture-before', 'prove'), ask('compare', 'prove')],
  edges: [{ from: 'apply', to: 'prove', kind: 'always' }, { from: 'prove', to: 'picture-before', kind: 'always' }, { from: 'picture-before', to: 'compare', kind: 'always' }] };

test('asks copied from another step with its step_id are each refused, and the shared id is named once', () => {
  const problems = askStepIdProblems(copied);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^definition\.steps\.picture-before\.config\.context\.step_id is "prove", not the step's own id "picture-before"/);
  assert.match(problems[1], /^definition\.steps\.compare\.config\.context\.step_id is "prove"/);
  assert.match(problems[2], /the ask steps "prove", "picture-before", "compare" share the context\.step_id "prove"/);
});

test('asks with their own step_id, or none, pass; a non-ask step is not looked at', () => {
  assert.deepEqual(askStepIdProblems({ steps: [ask('a', 'a'), ask('b'), { id: 'c', kind: 'action', config: { context: { step_id: 'a' } } }] }), []);
  assert.deepEqual(askStepIdProblems({}), []);
});

test('both recipe validators refuse the copied definition with the same words', () => {
  const words = askStepIdProblems(copied);
  const recipe = { id: copied.id, job: 'Put a site\'s commit live', definition: copied };
  for (const problems of [recipeProblems(recipe), writtenProblems(recipe)]) for (const word of words) assert.ok(problems.includes(word), word);
});

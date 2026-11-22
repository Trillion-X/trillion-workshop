// tools/workflows: a step that calls tool:run-sql-in-my-database names its connection, credential_name or database, or the recipe is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeProblems } from '../read-data/recipe-problems.mjs';

const RUN_SQL = 'tool:run-sql-in-my-database';
const recipe = steps => ({ kind: 'workflow-recipe', id: 'workflow:fixture', job: 'Get the fixture done.', steps });
const definitionRecipe = steps => ({ kind: 'workflow-recipe', id: 'workflow:fixture', job: 'Get the fixture done.', definition: { steps, edges: [] } });
const runStep = input => ({ id: 'count', title: 'count', do: 'Count the rows.', submit: { type: 'object' }, run_tool: { tool_id: RUN_SQL, input } });
const askStep = input => ({ id: 'count', kind: 'ask', config: { name: RUN_SQL, input } });
const bound = { $kind: 'binding', select: { from: 'input', path: 'credential_name' } };

test('a run-sql step names its connection by credential_name or database, as text or a binding, in both step shapes', () => {
  for (const input of [{ sql: 'SELECT 1', credential_name: 'own-rows-postgres-connection' }, { sql: 'SELECT 1', database: 'shop_for_who_runs_it' }, { sql: 'SELECT 1', credential_name: bound }]) {
    assert.deepEqual(recipeProblems(recipe([runStep(input)])), [], JSON.stringify(input));
    assert.deepEqual(recipeProblems(definitionRecipe([askStep(input)])), [], JSON.stringify(input));
  }
});

test('a run-sql step with no credential_name or database is named in the problems, in both step shapes', () => {
  for (const input of [{ sql: 'SELECT 1' }, { sql: 'SELECT 1', credential_name: null }, { sql: 'SELECT 1', database: '' }]) {
    assert.ok(recipeProblems(recipe([runStep(input)])).some(problem => /^steps\[0\]\.run_tool\.input names no connection/.test(problem)), JSON.stringify(input));
    assert.ok(recipeProblems(definitionRecipe([askStep(input)])).some(problem => /^definition\.steps\[0\]\.config\.input names no connection/.test(problem)), JSON.stringify(input));
  }
  const noInput = { id: 'count', title: 'count', do: 'Count the rows.', submit: { type: 'object' }, run_tool: { tool_id: RUN_SQL } };
  assert.ok(recipeProblems(recipe([noInput])).some(problem => /names no connection/.test(problem)), 'a run with no input');
});

test('the rule is for run-sql only: another tool with no connection is not named', () => {
  const other = { id: 'count', title: 'count', do: 'Count the rows.', submit: { type: 'object' }, run_tool: { tool_id: 'tool:some-other-tool', input: { sql: 'SELECT 1' } } };
  assert.deepEqual(recipeProblems(recipe([other])), []);
});

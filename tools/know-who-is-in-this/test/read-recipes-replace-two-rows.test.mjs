// tools/know-who-is-in-this: the people list and the where-someone-appeared read were rows that reached records through the
// records door (retired). Their jobs are now workflow:list-the-people-my-prints-can-name and workflow:find-where-someone-appeared,
// run by the person's AI against their own store. This checks both recipes and kits are valid and that no row here names a
// records method.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recipeProblems } from '../../workflows/read-data/recipe-problems.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const WORKFLOWS = '../../workflows/';
const RECIPES = ['list-the-people-my-prints-can-name', 'find-where-someone-appeared'];

for (const name of RECIPES) {
  test(`the ${name} recipe passes the recipe validator and its kit names only that recipe`, () => {
    const recipe = read(`${WORKFLOWS}recipes/${name}.json`).records[0].payload;
    assert.deepEqual(recipeProblems(recipe), []);
    const kit = read(`${WORKFLOWS}kits/${name}.json`);
    assert.deepEqual(kit.workflows, [recipe.id]);
    assert.equal(recipe.steps.find(step => step.id === 'prove').checks.length > 0, true, 'the prove step checks the example answers');
  });
}

test('no row of this folder names a records method', () => {
  const rows = read('../what-this-tool-does-and-how-to-run-it.json');
  assert.doesNotMatch(JSON.stringify(rows), /records:(read|write|list|search)\b/);
});

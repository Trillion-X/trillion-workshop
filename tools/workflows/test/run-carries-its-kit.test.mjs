// tools/workflows: every started run carries its recipe's kit (start-a-recipe-run.mjs kitFor), so no workflow runs without
// one: the shipped kit file, else the kit on the person's own recipe row, else a kit drafted from the recipe's own steps,
// marked draft with what it still owes. A recipe is never refused for lacking a kit. The own-row recipe here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { kitProblems } from '../read-data/kit-problems.mjs';
import { publicRecipe } from '../read-data/public-recipes.mjs';
import { recipeFromRows } from '../read-data/recipe-rows.mjs';
import { kitFor } from '../read-data/start-a-recipe-run.mjs';

const madeUp = {
  kind: 'workflow-recipe', id: 'workflow:made-up-bake', label: 'Made-up bake', job: 'Bake one loaf from a starter.',
  input_schema: { type: 'object', properties: {} },
  steps: [
    { id: 'feed', title: 'Feed the starter', do: 'Feed the starter and wait until it doubles.', submit: { type: 'object' }, done_when: 'The starter has doubled.' },
    { id: 'bake', title: 'Bake the loaf', do: 'Shape, proof and bake the loaf.', submit: { type: 'object' }, done_when: 'The loaf is baked.' },
  ],
};

test('a shipped recipe\'s run carries the kit the Workshop ships beside it, and that kit passes', () => {
  const recipe = publicRecipe('workflow:storyboard-a-launch-video');
  const { from, kit } = kitFor(recipe);
  assert.equal(from, 'shipped');
  assert.deepEqual(kitProblems(kit, { recipe }), []);
});

test('the person\'s own recipe row carries its kit field into the run', () => {
  const kit = { start_here: 'Say to your AI: "Run workflow:made-up-bake with my starter."', lists: [], no_lists_because: 'It keeps nothing but the loaf.', workflows: ['workflow:made-up-bake'], tools: ['tool:start-a-recipe-run'], instructions: ['1.', '2.', '3.'], worked_examples: [] };
  const row = { value: { recipe: 'workflow:made-up-bake', title: 'Made-up bake', job: 'Bake one loaf.', kit: JSON.stringify(kit) } };
  const steps = madeUp.steps.map((step, position) => ({ value: { step: step.id, title: step.title, do: step.do, submit: JSON.stringify(step.submit), position } }));
  const recipe = recipeFromRows(row, steps);
  assert.deepEqual(recipe.kit, kit);
  assert.deepEqual(kitFor(recipe), { from: 'own-row', kit });
});

test('a recipe with no kit anywhere still runs, carrying a kit drafted from its own steps and what it owes', () => {
  const { from, kit } = kitFor(madeUp);
  assert.equal(from, 'drafted');
  assert.equal(kit.draft, true);
  assert.ok(kit.instructions.some(line => line.includes('Feed the starter')), kit.instructions.join('\n'));
  assert.ok(Array.isArray(kit.owes) && kit.owes.length > 0, 'a drafted kit says what it still lacks');
});

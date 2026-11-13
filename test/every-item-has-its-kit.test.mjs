// Every Workshop item ships with its kit (L082, tools/workflows/kit-template.json): its lists with example rows, its
// workflows, tools and instructions, worked examples naming the MCP call, workflow and step, and a pour into a list the
// person already keeps. An item with no kit is refused unless test/items-without-a-kit.json names it from before kits,
// and that list may only shrink. .githooks/pre-commit and pre-push run the same gate (test-helpers/every-item-kit.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OWED_FILE, items, kitGateProblems } from '../test-helpers/every-item-kit.mjs';

const owed = JSON.parse(readFileSync(OWED_FILE, 'utf8'));

test('every item ships its kit, or shipped before kits and is named as owing one', () => {
  assert.deepEqual(kitGateProblems({ owed }), []);
});

test('an item that is not named as owing a kit and has none is refused', () => {
  const [first] = owed.workflows;
  const problems = kitGateProblems({ owed: { ...owed, workflows: owed.workflows.filter(id => id !== first) } });
  assert.deepEqual(problems, [`${first} ships with no kit: add one (tools/workflows/kit-template.json shows every part).`]);
});

test('the list of items owing a kit only shrinks: an id with a kit, or gone, must come out', () => {
  const problems = kitGateProblems({ owed: { ...owed, workflows: [...owed.workflows, 'workflow:quintillion', 'workflow:not-here'] } });
  assert.deepEqual(problems, [
    'test/items-without-a-kit.json names workflow:quintillion, which now has its kit: take it out.',
    'test/items-without-a-kit.json names workflow:not-here, which is not a workflow here: take it out.',
  ]);
});

test('the three proof workflows and the pour tool carry whole kits', () => {
  const withKits = new Map(items().filter(item => item.problems !== null).map(item => [item.id, item.problems]));
  for (const id of ['workflow:turn-what-you-said-into-content', 'workflow:answer-comments-and-messages', 'workflow:quintillion', 'tool:pour-example-rows-into-my-list']) {
    assert.deepEqual(withKits.get(id), [], `${id} has a whole kit`);
  }
});

test('every workflow kit\'s pour example pours its example rows through the pour tool', async () => {
  const { pour } = await import('../tools/pour-example-rows-into-my-list/do-work/pour.mjs');
  const recipes = JSON.parse(readFileSync(new URL('../tools/workflows/recipes/workflows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  for (const recipe of recipes.filter(item => item.kit?.pour)) {
    const { example, least_coverage } = recipe.kit.pour;
    const answer = pour({ kit_list: recipe.kit.lists.find(list => list.list === example.kit_list), into: example.into, field_map: example.field_map, least_coverage });
    assert.equal(answer.poured, true, `${recipe.id}: ${answer.says}`);
    assert.ok(answer.coverage >= least_coverage, `${recipe.id} covers ${answer.coverage}`);
  }
});

test('the commit and push hooks run the gate', () => {
  for (const hook of ['pre-commit', 'pre-push']) {
    assert.match(readFileSync(new URL(`../.githooks/${hook}`, import.meta.url), 'utf8'), /test-helpers\/every-item-kit\.mjs/, hook);
  }
});

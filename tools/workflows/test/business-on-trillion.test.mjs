// tools/workflows: the business-setup meta-workflow (rows read from the published recipes)
// tools/workflows: the business-setup meta-workflow (workflow:set-up-a-business-on-trillion) and its stage recipes.
// Every stage passes the strict step anatomy; every stage the parent starts exists; every workflow id a step names is
// shipped here or already in the public recipes; the parent's tool list is the set of tool ids the stages name; and no
// step uses a phrase that leaves a choice open or names a private identifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recipeProblems, CHECK_VOCABULARY } from '../read-data/recipe-problems.mjs';

// The banana-level anatomy every step must carry (L082): the text fields, the references, a position, the submit
// object, and a good_answer with a Passes and a Fails example. Written out here so the test does not depend on a
// validator option that is not yet committed.
const TEXT_FIELDS = ['when', 'do', 'done_when', 'if_missing', 'why'];
const anatomyProblems = (step, name) => {
  const problems = [];
  for (const field of TEXT_FIELDS) if (typeof step[field] !== 'string' || step[field].trim() === '') problems.push(`${name}.${field}`);
  for (const field of ['came_from', 'part_of']) if (!Array.isArray(step[field]) || step[field].length === 0) problems.push(`${name}.${field}`);
  if (step.submit?.type !== 'object') problems.push(`${name}.submit`);
  if (!/Passes:[\s\S]*\bFails:[\s\S]*\S/.test(step.good_answer ?? '')) problems.push(`${name}.good_answer`);
  return problems;
};

const BUNDLE = [
  'workflow:set-up-business-accounts-and-connections',
  'workflow:answer-comments-and-messages',
  'workflow:build-the-landing-page',
  'workflow:legal-pages-and-support',
  'workflow:make-short-videos-from-footage',
  'workflow:manage-member-billing',
  'workflow:measure-the-funnel-and-set-a-baseline',
  'workflow:onboard-new-buyers-in-five-days',
  'workflow:post-on-social-channels-on-a-schedule',
  'workflow:prove-the-launch-on-the-real-url',
  'workflow:publish-articles-and-newsletter-on-a-cadence',
  'workflow:recover-failed-payments-and-win-back',
  'workflow:retention-and-referral',
  'workflow:run-a-community',
  'workflow:run-a-course-from-list-rows',
  'workflow:set-up-a-business-on-trillion',
  'workflow:set-up-brand-and-branded-emails',
  'workflow:take-payments-with-stripe',
];
const published = JSON.parse(readFileSync(new URL('../recipes/workflows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const recipes = published.filter(recipe => BUNDLE.includes(recipe.id));
const parent = recipes.find(recipe => recipe.id === 'workflow:set-up-a-business-on-trillion');
const shipped = new Set(published.map(recipe => recipe.id));
const TOOL = /tool:[a-z0-9][a-z0-9_.:-]*[a-z0-9]/g;
const WORKFLOW = /workflow:[a-z0-9][a-z0-9-]*[a-z0-9]/g;

test('the meta-workflow and its stages are shipped', () => {
  assert.ok(parent, 'parent recipe present');
  assert.equal(recipes.length, 18);
});

for (const recipe of recipes) {
  test(`${recipe.id} passes the recipe validator and the step anatomy with zero problems`, () => {
    assert.deepEqual(recipeProblems(recipe, CHECK_VOCABULARY), []);
    assert.deepEqual(recipe.steps.flatMap(step => anatomyProblems(step, `${recipe.id}:${step.id}`)), []);
  });
}

test('every stage the parent starts is a business-on-trillion recipe, or a live shipped recipe run by reference', () => {
  const started = parent.steps.filter(step => step.run_tool?.tool_id === 'tool:start-a-recipe-run').map(step => step.run_tool.input.row);
  assert.ok(started.length >= 20, `parent starts ${started.length} stages`);
  const own = new Set(recipes.map(recipe => recipe.id));
  for (const row of started) assert.ok(own.has(row) || shipped.has(row), `${row} is neither shipped here nor in workflows.json`);
});

test('every workflow id a step names is a shipped recipe or a business-on-trillion recipe', () => {
  const own = new Set(recipes.map(recipe => recipe.id));
  for (const recipe of recipes) {
    for (const match of JSON.stringify(recipe.steps).matchAll(WORKFLOW)) {
      const id = match[0];
      if (id === recipe.id) continue;
      assert.ok(own.has(id) || shipped.has(id), `${recipe.id} names ${id}, which is not a known workflow`);
    }
  }
});

test('the parent tool list is exactly the tool ids every business-on-trillion step names (its own list excepted)', () => {
  const named = new Set();
  for (const recipe of recipes) for (const step of recipe.steps) {
    if (step.id === 'check-tools-live') continue;
    for (const match of JSON.stringify(step).matchAll(TOOL)) named.add(match[0].slice('tool:'.length));
  }
  const listText = parent.steps.find(step => step.id === 'check-tools-live').do;
  const listed = listText.slice(listText.indexOf('this list: ') + 'this list: '.length, listText.indexOf('. An answer'));
  assert.deepEqual(listed.split(', ').sort(), [...named].sort());
});

test('no step leaves a choice open or names a private identifier', () => {
  const banned = /use judgement|use judgment|as appropriate|the appropriate place|if needed|etc\.|\/Users\/|ethos/i;
  for (const recipe of recipes) for (const step of recipe.steps) {
    assert.doesNotMatch(JSON.stringify(step), banned, `${recipe.id} ${step.id}`);
  }
});

test('every stage writes its own checklist row, and the parent makes the checklist those rows belong to', () => {
  for (const recipe of recipes.filter(item => item.id !== parent.id)) {
    const last = recipe.steps[recipe.steps.length - 1];
    assert.equal(last.id, 'record-the-stage', recipe.id);
    assert.match(last.do, /record:setup-stage:/, recipe.id);
  }
  assert.match(parent.steps.find(step => step.id === 'make-the-checklist').do, /list:business-setup-checklist/);
});

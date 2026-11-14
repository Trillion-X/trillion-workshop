// Every workflow is a candidate branch: tool:choose-the-workflows-that-fire reads every workflow the person has and every
// recipe the Workshop installs, and the formulas engine chooses by the conditions each carries on its own row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';
import { startARecipeRun } from '../read-data/start-a-recipe-run.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';

const installed = JSON.parse(readFileSync(new URL('../recipes/workflows.json', import.meta.url), 'utf8')).records.map(({ payload }) => payload);

// A records door over rows kept in memory: { id, type, value }.
function doorOver(rows) {
  const kept = new Map(rows.map(row => [row.id, row]));
  return {
    read: async (type, id) => (kept.get(id)?.type === type ? kept.get(id).value : null),
    list: async function* ({ type, prefix = '' }) { for (const row of kept.values()) if (row.type === type && row.id.startsWith(prefix)) yield row; },
    write: async records => { for (const record of records) kept.set(record.id, record); },
    kept,
  };
}

const kinds = values => ({ fields: [{ id: 'kinds', kind: 'tags', path: ['kinds'] }], tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'kinds', operator: 'has_any_of', params: { values } }] } });
const condition = (label, values, extra = {}) => ({ label, condition: kinds(values), made_by: 'the person', state: 'On', ...extra });
const ownRow = (slug, value, type = 'record:workflow-recipe') => ({ id: `record:workflow-recipe:${slug}`, type, value: { recipe: `workflow:${slug}`, ...value } });

test('on a blank account the installed workflows choose by their own conditions, and every installed workflow is a candidate', async () => {
  const answer = await chooseTheWorkflowsThatFire({ parts: [{ words: 'Most teams skip the plan.', kinds: ['claim'], subjects: ['planning'] }] }, { door: doorOver([]) });
  assert.equal(answer.workflows, installed.length);
  assert.equal(answer.own, 0);
  assert.ok(answer.chosen.some(item => item.workflow === 'workflow:research-what-everyone-says' && item.part === 0 && item.from === 'catalog'));
  const conditioned = new Set(installed.filter(recipe => recipe.fires_when).map(recipe => recipe.id));
  assert.equal(answer.unconditioned.length, installed.length - conditioned.size);
  assert.deepEqual(answer.unfinished, []);
});

test('a workflow added to the person\'s list is chosen at once, with no list of branches edited', async () => {
  const added = ownRow('research-to-plan', { title: 'Research to plan', job: 'Turn research findings into a facts-first plan.', fires_when: JSON.stringify([condition('a research finding arrives', ['finding'])]) });
  const door = doorOver([added]);
  const parts = [{ words: 'A finding: most small teams never write their plan down.', kinds: ['finding'] }, { words: 'Buy milk.', kinds: ['errand'] }];
  const before = await chooseTheWorkflowsThatFire({ parts }, { door: doorOver([]) });
  assert.ok(!before.chosen.some(item => item.workflow === 'workflow:research-to-plan'));
  const after = await chooseTheWorkflowsThatFire({ parts }, { door });
  assert.deepEqual(after.chosen.filter(item => item.workflow === 'workflow:research-to-plan'), [
    { workflow: 'workflow:research-to-plan', label: 'Research to plan', part: 0, condition: 'a research finding arrives', made_by: 'the person', from: 'own' },
  ]);
  assert.ok(after.unmatched_parts.includes(1), 'a part no condition keeps is named');
  assert.equal(after.workflows, before.workflows + 1);
});

test('rows kept under the older row type are read too, and the person\'s own conditions win over the installed ones', async () => {
  const id = 'workflow:research-what-everyone-says';
  const mine = ownRow('research-what-everyone-says', { fires_when: JSON.stringify([condition('only when I ask for research', ['research-request'])]) }, 'workflow-recipe');
  const answer = await chooseTheWorkflowsThatFire({ parts: [{ words: 'x', kinds: ['claim'] }, { words: 'y', kinds: ['research-request'] }] }, { door: doorOver([mine]) });
  assert.deepEqual(answer.chosen.filter(item => item.workflow === id).map(item => [item.part, item.from]), [[1, 'own']]);
});

test('a row of the person\'s with only {recipe, fires_when} adds conditions to an installed workflow, whose installed steps still run', async () => {
  const id = 'workflow:first-win';
  const door = doorOver([ownRow('first-win', { fires_when: JSON.stringify([condition('a trial starts', ['trial-started'])]) })]);
  const answer = await chooseTheWorkflowsThatFire({ parts: [{ words: 'x', kinds: ['trial-started'] }] }, { door });
  assert.ok(answer.chosen.some(item => item.workflow === id && item.from === 'own'));
  const started = await startARecipeRun({ input: { row: id }, task: { request_key: 'k1' } }, { door });
  assert.equal(started.status, 'written');
  assert.deepEqual(door.kept.get(started.job).value.job, installed.find(recipe => recipe.id === id).steps);
});

test('an Off condition chooses nothing, an unfinished one is named, and a workflow with neither is unconditioned', async () => {
  const unfinished = { label: 'broken', condition: { fields: [{ id: 'kinds', kind: 'tags', path: ['kinds'] }], tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'nope', operator: 'has_any_of', params: { values: ['x'] } }] } }, made_by: 'the person', state: 'On' };
  const door = doorOver([
    ownRow('off-one', { title: 'Off', fires_when: JSON.stringify([condition('retired', ['x'], { state: 'Off' })]) }),
    ownRow('broken-one', { title: 'Broken', fires_when: JSON.stringify([unfinished]) }),
    ownRow('bare-one', { title: 'Bare' }),
  ]);
  const answer = await chooseTheWorkflowsThatFire({ parts: [{ words: 'x', kinds: ['x'] }] }, { door });
  assert.ok(!answer.chosen.some(item => ['workflow:off-one', 'workflow:broken-one'].includes(item.workflow)));
  assert.deepEqual(answer.unfinished.map(item => item.workflow), ['workflow:broken-one']);
  assert.ok(answer.unconditioned.some(item => item.workflow === 'workflow:off-one'));
  assert.ok(answer.unconditioned.some(item => item.workflow === 'workflow:bare-one' && item.label === 'Bare'));
});

test('a recipe whose conditions the engine cannot evaluate, or that keep every part, is refused', () => {
  const base = installed.find(recipe => recipe.id === 'workflow:first-win');
  const keepsAll = { label: 'always', condition: { fields: [], tree: { kind: 'group', combinator: 'and', negate: false, rules: [] } }, made_by: 'x', state: 'On' };
  assert.deepEqual(recipeProblems({ ...base, fires_when: [keepsAll] }), ['fires_when[0].condition reads no field, so it would keep every part.']);
  assert.match(recipeProblems({ ...base, fires_when: {} })[0], /must be a list of conditions/);
});

test('parts are required', async () => {
  await assert.rejects(chooseTheWorkflowsThatFire({ parts: [] }, { door: doorOver([]) }), /parts must be a list/);
});

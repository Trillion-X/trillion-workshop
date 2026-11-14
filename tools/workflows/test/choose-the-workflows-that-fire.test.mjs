// Every workflow is a candidate branch: tool:choose-the-workflows-that-fire reads every workflow the person has and every
// recipe the Workshop installs, and the formulas engine chooses by the conditions each carries on its own row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';
import { conditionProblems } from '../read-data/fires-when.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';
import { startARecipeRun } from '../read-data/start-a-recipe-run.mjs';

// Every recipe file the Workshop installs, as the chooser reads them (the first file holding an id wins).
const RECIPES = new URL('../recipes/', import.meta.url);
const installed = [...new Map(readdirSync(RECIPES).filter(name => name.endsWith('.json')).sort()
  .flatMap(name => JSON.parse(readFileSync(new URL(name, RECIPES), 'utf8')).records.map(({ payload }) => payload))
  .reverse().map(recipe => [recipe.id, recipe])).values()];

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
  assert.deepEqual(after.chosen.filter(item => item.workflow === 'workflow:research-to-plan').map(({ workflow, label, part, condition, made_by, from }) => ({ workflow, label, part, condition, made_by, from })), [
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

test('every installed condition is one the engine evaluates; one it cannot, or that keeps every part, is named', () => {
  for (const recipe of installed) assert.deepEqual(conditionProblems(recipe.fires_when, recipe.id), [], `${recipe.id} conditions`);
  const keepsAll = { label: 'always', condition: { fields: [], tree: { kind: 'group', combinator: 'and', negate: false, rules: [] } }, made_by: 'x', state: 'On' };
  assert.deepEqual(conditionProblems([keepsAll]), ['fires_when[0].condition reads no field, so it would keep every part.']);
  assert.match(conditionProblems({})[0], /must be a list of conditions/);
  const base = installed.find(recipe => recipe.id === 'workflow:first-win');
  assert.deepEqual(recipeProblems({ ...base, fires_when: [keepsAll] }), ['fires_when[0].condition reads no field, so it would keep every part.'], 'the validator refuses it too');
});

test('matches are ranked by how rare the tags they met are, times the condition\'s measured weight', async () => {
  const both = (slug, values, extra) => ownRow(slug, { title: slug, fires_when: JSON.stringify([condition(slug, values, extra)]) });
  // common-tag is held by four workflows, rare-tag by three; c meets the part on both, d and e on rare-tag alone.
  const door = doorOver([both('a', ['common-tag']), both('b', ['common-tag']), both('f', ['common-tag']), both('c', ['common-tag', 'rare-tag']), both('d', ['rare-tag'], { weight: 0.5 }), both('e', ['rare-tag'])]);
  const answer = await chooseTheWorkflowsThatFire({ parts: [{ words: 'x', kinds: ['common-tag', 'rare-tag'] }] }, { door });
  const mine = answer.chosen.filter(item => ['a', 'b', 'c', 'd', 'e', 'f'].includes(item.workflow.replace('workflow:', '')));
  const score = id => mine.find(item => item.workflow === `workflow:${id}`).score;
  assert.ok(score('c') > score('e') && score('e') > score('a'), 'two tags met beat one, and the rarer tag beats the commoner');
  assert.ok(Math.abs(score('d') - score('e') / 2) < 1e-5, 'half the measured weight, half the score');
  assert.equal(score('a'), score('b'));
  const three = await chooseTheWorkflowsThatFire({ parts: [{ words: 'x', kinds: ['common-tag', 'rare-tag'] }, { words: 'y', kinds: ['common-tag'] }, { words: 'z', kinds: [] }] }, { door });
  const broad = three.broad.map(entry => entry.workflow);
  assert.ok(broad.includes('workflow:a') && !broad.includes('workflow:e'), 'a condition keeping 2 of 3 parts is broad, one keeping 1 of 3 is not');
  assert.equal(mine.find(item => item.workflow === 'workflow:c').matched.length, 2);
  const ranks = answer.chosen.filter(item => item.part === 0).map(item => item.rank);
  assert.deepEqual(ranks, ranks.map((_, at) => at + 1), 'ranks run 1, 2, 3 within a part, best first');
});

test('parts are required', async () => {
  await assert.rejects(chooseTheWorkflowsThatFire({ parts: [] }, { door: doorOver([]) }), /parts must be a list/);
});

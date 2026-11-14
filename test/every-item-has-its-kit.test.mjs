// Every Workshop item ships with its kit (L082, tools/workflows/kit-template.json): its lists with example rows, its
// workflows, tools and instructions, worked examples naming the MCP call, workflow and step, and a pour into a list the
// person already keeps. The kit is one file beside the item (<item folder>/kits/<id without its prefix>.json). An item
// with no kit is refused unless test/items-without-a-kit.json names it from before kits, and that list may only shrink.
// The same gate (test-helpers/every-item-kit.mjs, `npm run check-kits`) runs at every push to this repository, because tests
// are off in publication: the push gate push-time-workshop-every-item-ships-its-kit.py in the orchestration repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { OWED_FILE, items, kitFileOf, kitGateProblems, touchedIds } from '../test-helpers/every-item-kit.mjs';
import { HOST_TOOLS } from '../tools/workflows/read-data/recipe-problems.mjs';
import { KIT_TEMPLATE, kitBundleInput } from '../tools/workflows/read-data/kit-problems.mjs';

const owed = JSON.parse(readFileSync(OWED_FILE, 'utf8'));
const withKits = () => items().filter(item => item.problems !== null);

test('every item ships its kit, or shipped before kits and is named as owing one', () => {
  assert.deepEqual(kitGateProblems({ owed }), []);
});

test('the allowance list is dated', () => {
  assert.match(owed.dated, /^\d{4}-\d{2}-\d{2}$/);
});

test('an item that is not named as owing a kit and has none is refused, and told where its kit goes', () => {
  const [first] = owed.workflows;
  const problems = kitGateProblems({ owed: { ...owed, workflows: owed.workflows.filter(id => id !== first) } });
  assert.deepEqual(problems, [`${first} ships with no kit: add ${kitFileOf('workflows', first).replace(/^.*\/tools\//, 'tools/')} (tools/workflows/kit-template.json shows every part).`]);
});

test('the list of items owing a kit only shrinks: an id with a kit, or gone, must come out', () => {
  const problems = kitGateProblems({ owed: { ...owed, workflows: [...owed.workflows, 'workflow:quintillion', 'workflow:not-here'] } });
  assert.deepEqual(problems, [
    'test/items-without-a-kit.json names workflow:quintillion, which now has its kit: take it out.',
    'test/items-without-a-kit.json names workflow:not-here, which is not a workflow here: take it out.',
  ]);
});

test('an id added to the allowance list since the list a commit or push is compared with is refused', () => {
  const [first, second] = owed.tools;
  const before = { ...owed, tools: owed.tools.filter(id => id !== second) };
  assert.deepEqual(kitGateProblems({ owed, before }), [`test/items-without-a-kit.json gained ${second}: the list only shrinks, so give ${second} its kit instead.`]);
  assert.ok(first);
});

test('a kit that leaves out a workflow its item runs is refused by name', () => {
  const [recipeItem] = withKits().filter(entry => entry.id === 'workflow:quintillion');
  assert.deepEqual(recipeItem.problems, []);
  const kit = JSON.parse(readFileSync(recipeItem.file, 'utf8'));
  assert.ok(kit.workflows.includes('workflow:grow-the-one-tree'), 'the kit names the workflow its steps run');
});

test('the kits that exist are whole: the pour tool and the first workflows carry them', () => {
  const byId = new Map(withKits().map(item => [item.id, item.problems]));
  for (const id of ['workflow:turn-what-you-said-into-content', 'workflow:answer-comments-and-messages', 'workflow:quintillion', 'tool:pour-example-rows-into-my-list']) {
    assert.deepEqual(byId.get(id), [], `${id} has a whole kit`);
  }
});

test('every kit file belongs to a workflow here: none is left beside a workflow that is gone', () => {
  const known = new Set(items().map(item => item.file));
  const folder = new URL('../tools/workflows/kits/', import.meta.url);
  for (const name of readdirSync(folder).filter(entry => entry.endsWith('.json'))) {
    assert.ok(known.has(new URL(name, folder).pathname), `tools/workflows/kits/${name} belongs to a workflow here`);
  }
});

test('every kit pours its example rows through the pour tool', async () => {
  const { pour } = await import('../tools/pour-example-rows-into-my-list/do-work/pour.mjs');
  for (const item of withKits()) {
    const kit = JSON.parse(readFileSync(item.file, 'utf8'));
    if (!kit.pour) continue;
    const { example, least_coverage } = kit.pour;
    const answer = pour({ kit_list: kit.lists.find(list => list.list === example.kit_list), into: example.into, field_map: example.field_map, least_coverage });
    assert.equal(answer.poured, true, `${item.id}: ${answer.says}`);
    assert.ok(answer.coverage >= least_coverage, `${item.id} covers ${answer.coverage}`);
  }
});

test('every kit installs as one marketplace set of items that are all here (the host\'s own tools too)', () => {
  const all = new Set([...items().map(item => item.id), ...HOST_TOOLS]);
  for (const item of withKits()) {
    const set = kitBundleInput(JSON.parse(readFileSync(item.file, 'utf8')), { id: item.id, title: item.id });
    for (const { kind, id } of set.components) assert.ok(all.has(`${kind}:${id}`), `${item.id}: the set names ${kind}:${id}, which is here`);
  }
});

test('when changed items are refused, an item still on the list that a change touches is refused until it has its kit', () => {
  const folderOf = id => items().find(item => item.id === id).file.replace(/^.*\/tools\/([^/]+)\/kits\/.*$/, '$1');
  const [tool] = owed.tools;
  const touched = touchedIds({ changed: [`tools/${folderOf(tool)}/do-work/anything.mjs`] });
  assert.ok(touched.has(tool), 'a file in the tool folder touches the tool');
  assert.equal(touchedIds({ changed: [`tools/${folderOf(tool)}/kits/${tool.slice(5)}.json`] }).has(tool), false, 'a kit file is not a change to the item');
  const rules = { ...KIT_TEMPLATE.rules, refuse_changed_items: true };
  assert.deepEqual(kitGateProblems({ owed, touched, rules }).map(line => line.split(' ')[0]), [...touched].filter(id => owed.tools.includes(id) || owed.workflows.includes(id)));
  assert.deepEqual(kitGateProblems({ owed, touched, rules: { ...rules, refuse_changed_items: false } }), []);
});

test('a workflow whose recipe differs from the one before is touched, an unchanged one is not', () => {
  const now = JSON.parse(readFileSync(new URL('../tools/workflows/recipes/workflows.json', import.meta.url), 'utf8'));
  const [first, ...rest] = now.records;
  const before = { records: [{ payload: { ...first.payload, job: `${first.payload.job} (earlier)` } }, ...rest] };
  const touched = touchedIds({ beforeRecipes: before });
  assert.deepEqual([...touched].filter(id => id.startsWith('workflow:')), [first.payload.id]);
});

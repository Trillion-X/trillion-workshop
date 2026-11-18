// tools/write-a-job-done-in-several-steps-have: a person's workflow runs on the workflow engine (the built wasm) through
// the older version's definitionOf, in one call, with nothing stored. The recipe rows are made up, in the shape a person's
// lists keep them (nested values as JSON text).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runAsTheTool, runAWorkflow, runWorkflow } from '../read-data/run-a-workflow.mjs';
import { kitProblems } from '../../workflows/read-data/kit-problems.mjs';

const json = value => JSON.stringify(value);
const row = {
  id: 'record:workflow-recipe:made-up-bake',
  type: 'record:workflow-recipe',
  value: { recipe: 'workflow:made-up-bake', title: 'Bake a loaf', job: 'Bake one loaf from a recipe card.' },
};
const steps = [
  { id: 'record:workflow-step:made-up-bake--bake', type: 'record:workflow-step', value: { recipe: '["made-up-bake"]', step: 'bake', title: 'Bake', position: 1, do: 'Bake the loaf.', submit: json({ type: 'object' }) } },
  {
    id: 'record:workflow-step:made-up-bake--pick', type: 'record:workflow-step',
    value: {
      recipe: '["made-up-bake"]', step: 'pick', title: 'Pick flours', position: 0, do: 'Pick the flours the card names.',
      submit: json({ type: 'object', properties: { flours: { type: 'array' } } }),
      checks: json([{ kind: 'subset-of', says: 'Only flours the card names', path: ['this', 'flours', '*'], of: ['input', 'allowed'] }]),
    },
  },
];
const input = { allowed: ['rye', 'wheat'] };

test('(a) a recipe row and its step rows run on the engine to paused at the first ask', async () => {
  const { definition, run } = await runAWorkflow({ row, steps, input });
  assert.deepEqual(definition.steps.map(step => `${step.kind} ${step.id}`), ['ask pick', 'return pick#checks', 'return pick#wrong', 'fail pick#refused', 'ask bake']);
  assert.equal(run.status, 'paused');
  assert.deepEqual(run.waiting.map(wait => wait.step_id), ['pick']);
  assert.equal(run.waiting[0].input.do, 'Pick the flours the card names.');
});

test('(b) with an answer for every step, the run completes', async () => {
  const { run } = await runAWorkflow({ row, steps, input, answers: { pick: { flours: ['rye'] }, bake: { done: true } } });
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.waiting, []);
  assert.deepEqual(run.execution_context.steps.bake.output, { done: true });
});

test('(c) a subset-of check fails a bad answer on the engine, naming the value', async () => {
  const { run } = await runAWorkflow({ row, steps, input, answers: { pick: { flours: ['rye', 'sawdust'] }, bake: { done: true } } });
  assert.equal(run.status, 'failed');
  assert.match(run.error_message, /Only flours the card names \("sawdust"\)/);
});

test('(d) a row holding its own definition runs as that definition', async () => {
  const definition = {
    id: 'workflow:made-up-hand-off', name: 'Hand off', kind: 'workflow', is_active: true, version: 1,
    steps: [
      { id: 'draft', kind: 'ask', config: { name: 'agent:made-up-writer', input: { topic: 'rye' }, context: { step_id: 'draft' } } },
      { id: 'proof', kind: 'ask', config: { name: 'ai', input: {}, context: { step_id: 'proof' } } },
    ],
    edges: [{ from: 'draft', to: 'proof', kind: 'always' }],
  };
  const own = { id: 'record:workflow-recipe:made-up-hand-off', value: { recipe: 'workflow:made-up-hand-off', title: 'Hand off', definition: json(definition) } };
  const first = await runAWorkflow({ row: own, steps: [] });
  assert.deepEqual(first.definition, definition);
  assert.deepEqual(first.run.waiting, [{ step_id: 'draft', asks: 'agent:made-up-writer', input: { topic: 'rye' } }]);
  const done = await runAWorkflow({ row: own, steps: [], answers: { draft: { text: 'Rye keeps.' }, proof: { ok: true } } });
  assert.equal(done.run.status, 'completed');
});

const toolRow = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;

test('the tool row runs its sample runs through runAsTheTool, as definitions and as a recipe', async () => {
  assert.equal(toolRow.id, 'tool:run-workflow-definition');
  assert.equal(toolRow.invoke.argv.at(-1), 'runAsTheTool');
  assert.ok(toolRow.invoke.argv.includes('/opt/records-door/do-work/run-an-export.mjs'), 'it runs through run-an-export, which hands the run its door');
  for (const sample of toolRow.verify) {
    const result = await runAsTheTool({ run: sample.input }, {});
    assert.equal(result.status, 'paused');
    assert.equal(result.waiting[0].step_id, sample.contains);
  }
  await assert.rejects(runWorkflow({ definitions: [{}], workflow_id: 'x', recipe: { id: 'workflow:x' } }), /not both/);
});

test('the tool row packs every file its module imports', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const packed = toolRow.invoke.files.package_files.filter(item => item.package).map(item => item.paths.map(path => `${item.package}/${path}`)).flat();
  const isPacked = file => packed.some(path => file === path || file.startsWith(`${path}/`));
  const seen = new Set();
  const walk = file => {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(isPacked(relative(root, file)), `${relative(root, file)} is imported and not packed`);
    if (!/\.(m?js|ts)$/.test(file) || statSync(file).isDirectory()) return;
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:import|export)[^'"`;]*?from\s*['"]([^'"]+)['"]|new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g)) {
      const said = match[1] ?? match[2];
      const path = said.startsWith('trillion-workshop/tools/') ? resolve(root, said.slice('trillion-workshop/tools/'.length))
        : said.startsWith('.') ? resolve(dirname(file), said) : null;
      if (path && existsSync(path)) walk(path);
    }
  };
  // Every module the command names, where the row packs it, and what each imports.
  const placed = toolRow.invoke.files.package_files.filter(item => item.package && item.at);
  const modules = toolRow.invoke.argv.flatMap(word => {
    const item = placed.find(item => typeof word === 'string' && word.startsWith(`${item.at}/`));
    return item ? [resolve(root, item.package, word.slice(item.at.length + 1))] : [];
  });
  assert.equal(modules.length, 2, 'the command names its runner and the module it runs');
  modules.forEach(walk);
  assert.ok(seen.size > 2);
});

test('the tool\'s kit is whole', () => {
  const kit = JSON.parse(readFileSync(new URL('../kits/run-workflow-definition.json', import.meta.url), 'utf8'));
  assert.deepEqual(kitProblems(kit, { tool: toolRow }), []);
});

test('a parallel loop asks every lane before it pauses, so every lane is waiting at once', async () => {
  const lanes = 30;
  const definitions = [
    { id: 'workflow:made-up-fan', name: 'Fan', kind: 'workflow', is_active: true, version: 1,
      steps: [{ id: 'lanes', kind: 'loop', config: { source: Array.from({ length: lanes }, (_, index) => index), item_var: 'lane', definition_id: 'workflow:made-up-lane', parallel: true, max_concurrency: lanes } }] },
    { id: 'workflow:made-up-lane', name: 'Lane', kind: 'workflow', is_active: true, version: 1,
      steps: [{ id: 'work', kind: 'ask', config: { name: 'agent:', input: {}, context: {} } }] },
  ];
  const run = await runWorkflow({ definitions, workflow_id: 'workflow:made-up-fan' });
  assert.equal(run.status, 'paused');
  assert.equal(run.waiting.length, lanes);
});

// A listed workflow row runs as this tool (source:workflow-recipes invoke_with): the engine hands the row's id as `row`
// beside the wake's input. Every shipped wake must start its run on the engine at the step its start_at names.
test('(w) every shipped workflow wake runs on the engine from its row id and starts at the step its start_at names, with its kit', async () => {
  const { publicRecipes } = await import('../../workflows/read-data/public-recipes.mjs');
  const woken = publicRecipes().flatMap(recipe => (recipe.wakes ?? []).map(wake => ({ recipe, wake })));
  assert.ok(woken.length >= 14, `expected the shipped wakes, found ${woken.length}`);
  for (const { recipe, wake } of woken) {
    const run = await runWorkflow({ row: recipe.id, ...wake.input });
    assert.notEqual(run.status, 'failed', `${recipe.id} ${wake.id}: ${run.error_message}`);
    if (recipe.definition) continue;
    const first = wake.input.start_at ?? recipe.steps[0].id;
    assert.equal(run.definition.steps[0].id, first, `${recipe.id} ${wake.id}`);
    assert.ok(run.kit && typeof run.kit === 'object', `${recipe.id} carries a kit`);
  }
});

test('(x) a start_at that names no step is refused, and fields of its own are refused unless the row is named by id', async () => {
  const { publicRecipes } = await import('../../workflows/read-data/public-recipes.mjs');
  const shipped = publicRecipes().find(recipe => recipe.steps?.length);
  await assert.rejects(runWorkflow({ row: shipped.id, start_at: 'made-up-step' }), /start_at names "made-up-step", which is not a step/);
  await assert.rejects(runWorkflow({ recipe: shipped, start_at: 'x' }), /Only a listed workflow row's run takes fields of its own/);
});

// A woken run's input holds the fact that woke it: the engine hands the task's cause.detail ({kind, from, event_id,
// payload, coalesced, last?}) as woken_by, and a direct call has none.
test('(y) a woken run is given the fact that woke it as input.fact, and folded facts as folded and last', async () => {
  assert.deepEqual(toolRow.invoke.stdin, { run: { fill: { from: 'input' } }, woken_by: { fill: { from: 'task', field: 'cause.detail' } } });
  const bind = path => ({ $kind: 'binding', select: { from: 'input', path } });
  const definition = {
    id: 'workflow:made-up-echo', name: 'Echo', kind: 'workflow', is_active: true, version: 1, edges: [],
    steps: [{ id: 'see', kind: 'ask', config: { name: 'person', input: { position: bind('fact.position'), folded: bind('folded'), last: bind('last.position') }, context: { step_id: 'see' } } }],
  };
  const recipe = { id: 'workflow:made-up-echo', label: 'Echo', definition };
  const detail = { kind: 'row-changes', from: 'run', event_id: 'd:7:3', payload: { kind: 'row-changes', table_name: 'post', op: 'INSERT', position: '3' }, coalesced: 0 };
  const woken = await runAsTheTool({ run: { recipe }, woken_by: detail });
  assert.equal(woken.status, 'paused');
  assert.equal(woken.waiting[0].input.position, '3');
  const folded = await runAsTheTool({ run: { recipe, input: { keep: 1 } }, woken_by: { ...detail, coalesced: 2, last: { event_id: 'd:7:5', payload: { position: '5' } } } });
  assert.deepEqual([folded.waiting[0].input.position, folded.waiting[0].input.folded, folded.waiting[0].input.last], ['3', 2, '5']);
  const direct = await runAsTheTool({ run: { recipe } });
  assert.equal(direct.waiting?.[0]?.input?.position ?? null, null);
});

// A tool ask runs through the run's door in the same call; an answer given wins; a tool the run may not start waits.
test('(z) a tool ask runs through the door, keyed by step and what it asks; other asks wait; a refused tool waits with why', async () => {
  const bind = path => ({ $kind: 'binding', select: { from: 'input', path } });
  const definition = {
    id: 'workflow:made-up-two-tools', name: 'Two tools', kind: 'workflow', is_active: true, version: 1,
    steps: [
      { id: 'count', kind: 'ask', config: { name: 'tool:made-up-count', input: { words: bind('words') }, context: { step_id: 'count' } } },
      { id: 'judge', kind: 'ask', config: { name: 'ai', input: {}, context: { step_id: 'judge' } } },
    ],
    edges: [{ from: 'count', to: 'judge', kind: 'always' }],
  };
  const calls = [];
  const door = { async run(tool, input, { key }) { calls.push({ tool, input, key }); return { count: input.words.length }; } };
  const ran = await runAsTheTool({ run: { definitions: [definition], workflow_id: definition.id, input: { words: ['a', 'b'] } } }, { door });
  assert.equal(ran.status, 'paused');
  assert.deepEqual(ran.waiting.map(item => item.step_id), ['judge']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { words: ['a', 'b'] });
  assert.match(calls[0].key, /^count:[0-9a-f]{64}$/);
  const again = await runAsTheTool({ run: { definitions: [definition], workflow_id: definition.id, input: { words: ['a', 'b'] } } }, { door });
  assert.equal(calls[1].key, calls[0].key, 'the same ask is the same key, so the engine runs it once');
  await runAsTheTool({ run: { definitions: [definition], workflow_id: definition.id, input: { words: ['a', 'b'] }, answers: { count: { count: 9 } } } }, { door });
  assert.equal(calls.length, 2, 'an answer given for the step wins over running the tool');
  const refusing = { async run() { throw Object.assign(new Error('This run may not start tool:made-up-count.'), { code: 'rpc_error', outcome: 'unknown' }); } };
  const held = await runAsTheTool({ run: { definitions: [definition], workflow_id: definition.id, input: { words: [] } } }, { door: refusing });
  assert.deepEqual(held.waiting.map(item => [item.step_id, item.why]), [['count', 'This run may not start tool:made-up-count.']]);
  const failing = { async run() { throw Object.assign(new Error('tool:made-up-count did not finish: boom'), { code: 'tool_run_failed', outcome: 'committed' }); } };
  const failed = await runAsTheTool({ run: { definitions: [definition], workflow_id: definition.id, input: { words: [] } } }, { door: failing });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error_message, /Step 'count' failed: .*did not finish: boom/);
  assert.ok(again);
});

test('a recipe holding its own definition keeps the definitions it uses, so its loops and actions find them', async () => {
  const child = { id: 'workflow:made-up-child', name: 'Child', kind: 'workflow', is_active: true, version: 1, edges: [],
    steps: [{ id: 'say', kind: 'ask', config: { name: 'person', input: {}, context: { step_id: 'say' } } }] };
  const { definitionOf } = await import('../read-data/workflows.mjs');
  const made = definitionOf({ id: 'workflow:made-up-parent', label: 'Parent', definition: { id: 'workflow:made-up-parent', version: 1, steps: [], edges: [], uses: [child] } });
  assert.deepEqual(made.uses, [child]);
});

test('a recipe holding its own definition starts at its first step, the one its wake names; another step is refused', async () => {
  const recipe = { kind: 'workflow-recipe', id: 'workflow:made-up-graph', label: 'made up', definition: { steps: [
    { id: 'first', kind: 'ask', config: { name: 'ai', input: { do: 'one', submit: { type: 'object' } } } },
    { id: 'second', kind: 'ask', config: { name: 'ai', input: { do: 'two', submit: { type: 'object' } } } }],
    edges: [{ from: 'first', to: 'second', kind: 'always' }] } };
  const run = await runWorkflow({ recipe, input: { start_at: 'first' } });
  assert.equal(run.status, 'paused');
  assert.deepEqual(run.waiting.map(item => item.step_id), ['first']);
  await assert.rejects(runWorkflow({ recipe, input: { start_at: 'second' } }), /starts at its first step, "first"/);
});


test('a door ask a step may name (wake:arrive) runs as that door operation; the tool row takes its rights from the workflow row', async () => {
  assert.deepEqual(toolRow.invoke.records, { fd: 3, from_listed_row: true });
  const definition = { id: 'workflow:made-up-teller', name: 'Teller', kind: 'workflow', is_active: true, version: 1, edges: [],
    steps: [{ id: 'tell', kind: 'ask', config: { name: 'wake:arrive', input: { kind: 'made-up', event_id: 'e', payload: {} }, context: { step_id: 'tell' } } }] };
  const calls = [];
  const door = { run() { throw new Error('not a tool'); }, async operation(method, input, { key }) { calls.push([method, input.kind, key.split(':')[0]]); return { kept: true }; } };
  const ran = await runAsTheTool({ run: { definitions: [definition], workflow_id: definition.id } }, { door });
  assert.equal(ran.status, 'completed');
  assert.deepEqual(calls, [['wake:arrive', 'made-up', 'tell']]);
});

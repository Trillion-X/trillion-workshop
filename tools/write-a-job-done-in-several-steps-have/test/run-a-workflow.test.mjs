// tools/write-a-job-done-in-several-steps-have: a person's workflow runs on the workflow engine (the built wasm) through
// the older version's definitionOf, in one call, with nothing stored. The recipe rows are made up, in the shape a person's
// lists keep them (nested values as JSON text).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runAWorkflow, runWorkflow } from '../read-data/run-a-workflow.mjs';
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
  assert.deepEqual(definition.steps.map(step => `${step.kind} ${step.id}`), ['ask pick', 'check pick#checks', 'ask bake']);
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
  assert.match(run.error_message, /Only flours the card names \("sawdust" is not one of them\)/);
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

test('the tool row runs its sample runs through runWorkflow, as definitions and as a recipe', async () => {
  assert.equal(toolRow.id, 'tool:run-workflow-definition');
  assert.equal(toolRow.invoke.argv.at(-1), 'runWorkflow');
  for (const sample of toolRow.verify) {
    const result = await runWorkflow(sample.input, {});
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
  walk(fileURLToPath(new URL('../read-data/run-a-workflow.mjs', import.meta.url)));
  assert.ok(seen.size > 2);
});

test('the tool\'s kit is whole', () => {
  const kit = JSON.parse(readFileSync(new URL('../kits/run-workflow-definition.json', import.meta.url), 'utf8'));
  assert.deepEqual(kitProblems(kit, { tool: toolRow }), []);
});

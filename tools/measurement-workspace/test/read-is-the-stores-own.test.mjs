// tools/measurement-workspace: the three record-list reads were replaced by workflow:read-cost-measurements (the person's own
// store keeps the rows; the screen takes them in as surfaceInput.measurements). The pricing action stays a tool, since it does
// real work. No file in this folder names a records method or the retired records door.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const row = JSON.parse(await read('../what-this-tool-does-and-how-to-run-it.json')).records[0].payload;
const recipe = JSON.parse(await read('../../workflows/recipes/read-cost-measurements.json')).records[0].payload;
const kit = JSON.parse(await read('../../workflows/kits/read-cost-measurements.json'));
const screen = await read('../screen.mjs');
const data = JSON.parse(await read('../DATA.json'));

test('the tool row and its DATA names no records method and no records door', async () => {
  const texts = [JSON.stringify(row), JSON.stringify(data), await read('../what-this-tool-does-and-how-to-run-it.json'), await read('../DATA.json')];
  for (const text of texts) {
    assert.equal(/records:(read|write|list)/.test(text), false);
    assert.equal(text.includes('/records-door'), false);
  }
  assert.deepEqual(Object.keys(row.screen.requests), ['manage-pricing']);
  assert.equal(row.screen.requests['manage-pricing'].resource_operation, 'tools:run');
});

test('the screen reads no store: its rows come in as surfaceInput.measurements and only pricing calls the host', () => {
  assert.equal(/host\.call\(\s*'read-/.test(screen), false);
  assert.equal(/records:(read|write|list)/.test(screen), false);
  assert.ok(screen.includes("host.call('manage-pricing'"));
  assert.ok(screen.includes('surfaceInput?.measurements'));
});

test('workflow:read-cost-measurements is a recipe that reads the three kinds, with its proof steps and no write', () => {
  const payload = recipe;
  assert.equal(payload.id, 'workflow:read-cost-measurements');
  assert.deepEqual(payload.steps.map(step => step.id), ['look', 'render', 'prove', 'keep']);
  const prove = payload.steps.find(step => step.id === 'prove');
  assert.deepEqual(prove.checks.map(check => check.kind), ['covers', 'covers']);
  assert.deepEqual(prove.checks[0].values, [['answered', 'answered', 'answered', 'refused']]);
  assert.ok(prove.do.includes('record:cost-measurement-observation:obs-1'));
  assert.equal(JSON.stringify(payload).includes('records:'), false);
});

test('the kit names only the recipe and the screen tool', () => {
  assert.deepEqual(kit.workflows, ['workflow:read-cost-measurements']);
  assert.deepEqual(kit.tools, ['tool:measurement-workspace']);
  assert.equal(JSON.stringify(kit).includes('records:'), false);
});

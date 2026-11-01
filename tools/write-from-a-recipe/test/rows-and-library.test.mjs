// Every row's own sample, run the way the tool container runs it (the input on standard input, the answer on the last
// line), and the kept recipes and blocks: every recipe composes with synthetic text, every block has a body, and no
// person, brand or private value is in them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BLOCKS, RECIPES } from '../read-data/library.mjs';
import { composeAWritingInstruction } from '../do-work/compose-a-writing-instruction.mjs';
import { listWritingRecipes } from '../do-work/list-writing-recipes.mjs';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const at = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((node, key) => node?.[key], value);

for (const row of rows) {
  test(`${row.id} answers its own sample on the last line`, () => {
    for (const sample of (row.verify ?? []).filter(item => item.kind === 'sample-run')) {
      const ran = spawnSync(process.execPath, row.invoke.argv.slice(1), { cwd: folder, input: JSON.stringify(sample.input), encoding: 'utf8' });
      assert.equal(ran.status, 0, ran.stderr);
      const answer = at(JSON.parse(ran.stdout.trim().split('\n').at(-1)), row.result_selector);
      assert.ok(String(at(answer, sample.output_selector)).includes(sample.contains), JSON.stringify(answer));
    }
  });
}

test('the file checker declares a computer run with only the explicit folder read capability', () => {
  const row = rows.find(candidate => candidate.id === 'tool:check-writing-file');
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['read-a-folder']);
  assert.equal(row.invoke.argv.at(-1).fill.field, 'grants.read-a-folder.folder');
  assert.ok(row.invoke.files.package_files[0].paths.includes('package.json'));
  assert.ok(row.invoke.files.package_files.some(file => file.at === '/opt' && file.package === 'write-from-a-recipe' && file.paths.includes('package.json')), 'shared module imports stay inside the declared run package scope');
  assert.equal(JSON.parse(readFileSync(resolve(folder, 'package.json'), 'utf8')).type, 'module');
  assert.equal(JSON.parse(readFileSync(resolve(folder, 'read-data/write-file-limits.json'), 'utf8')).max_bytes, 8 * 1024 * 1024);
});

test('a refused request answers { error } on the last line and exits 1', () => {
  const ran = spawnSync(process.execPath, ['do-work/compose-a-writing-instruction.mjs'], { cwd: folder, input: '{}', encoding: 'utf8' });
  assert.equal(ran.status, 1);
  assert.match(JSON.parse(ran.stdout.trim().split('\n').at(-1)).error, /Give recipe/);
});

test('every kept recipe composes from synthetic text and its own defaults, with no value left as a slot', () => {
  for (const recipe of RECIPES) {
    const work = Object.fromEntries((recipe.work_item.required ?? []).map(key => [key, key === 'text' ? 'A synthetic note about planting tomatoes.' : 'https://example.com']));
    const composed = composeAWritingInstruction({ recipe_id: recipe.id, work_item: work });
    assert.ok(composed.instruction_text.trim().length > 20, recipe.id);
    assert.doesNotMatch(composed.instruction_text, /\[object Object\]|undefined/, recipe.id);
    if (recipe.work_item.required.includes('text')) assert.ok(composed.instruction_text.includes('planting tomatoes'), recipe.id);
  }
});

test('the list finds recipes and blocks by words and section', () => {
  const all = listWritingRecipes();
  assert.equal(all.recipes.length, RECIPES.length);
  assert.equal(all.blocks.length, BLOCKS.length);
  assert.deepEqual(listWritingRecipes({ words: 'plain language' }).blocks.map(block => block.id), ['ai-instruction-block:plain-language']);
  const section = all.sections[0];
  assert.ok(listWritingRecipes({ section }).recipes.every(recipe => recipe.section === section));
});

test('ids are unique, every block has a body, and the kept DATA names no person or private value', () => {
  assert.equal(new Set(RECIPES.map(recipe => recipe.id)).size, RECIPES.length);
  assert.equal(new Set(BLOCKS.map(block => block.id)).size, BLOCKS.length);
  for (const block of BLOCKS) assert.ok(block.body.trim(), block.id);
  const kept = JSON.stringify([RECIPES, BLOCKS]);
  const removedIds = ['extract-design-taste', 'lead-with-the-result', 'keep-operations-off-sales-pages', 'write-complete-spoken-sentences', 'state-the-positive-thing-directly', 'use-concrete-specifics', 'speak-as-a-person', 'make-the-invitation-specific', 'make-every-line-earn-its-place'];
  for (const privateValue of [/\/Users\//, /@[a-z0-9-]+\.[a-z]{2,}/i, /revision_ref/, ...removedIds.map(id => new RegExp(id))]) assert.doesNotMatch(kept, privateValue);
});

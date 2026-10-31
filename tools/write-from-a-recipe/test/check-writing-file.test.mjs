import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWritingFile } from '../do-work/check-writing-file.mjs';

const command = fileURLToPath(new URL('../do-work/check-writing-file.mjs', import.meta.url));

test('a granted file reaches the ordinary gate and returns only the gate result', () => {
  const folder = mkdtempSync(join(tmpdir(), 'writing-file-'));
  try {
    writeFileSync(join(folder, 'input.json'), JSON.stringify({ recipe: {}, writing: { draft_text: 'Private draft.' }, private_source: 'must not be returned' }));
    const result = checkWritingFile({ file: 'input.json' }, { folder, maxBytes: 4096 });
    assert.deepEqual(result, { passed: true, delivery: null });
    assert.equal(JSON.stringify(result).includes('must not be returned'), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('caller recipe override is applied before the shared gate runs', () => {
  const folder = mkdtempSync(join(tmpdir(), 'writing-file-'));
  try {
    writeFileSync(join(folder, 'input.json'), JSON.stringify({ recipe: {}, writing: { draft_text: 'Private draft.' } }));
    assert.throws(() => checkWritingFile({ file: 'input.json', recipe_id: 'missing-recipe' }, { folder }), /No writing recipe is named missing-recipe/);
    assert.deepEqual(checkWritingFile({ file: 'input.json', recipe: {} }, { folder }), { passed: true, delivery: null });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the command reports a malformed file with a code, never its source excerpt', () => {
  const folder = mkdtempSync(join(tmpdir(), 'writing-file-'));
  const privateText = 'private source excerpt that must not leak';
  try {
    writeFileSync(join(folder, 'bad.json'), privateText);
    const ran = spawnSync(process.execPath, [command, folder], { input: JSON.stringify({ file: 'bad.json' }), encoding: 'utf8' });
    assert.equal(ran.status, 1);
    assert.deepEqual(JSON.parse(ran.stdout.trim()), { error: 'writing_file_invalid_utf8_json' });
    assert.equal(ran.stdout.includes(privateText), false);
    assert.equal(ran.stderr.includes(privateText), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('outside links, traversal, oversized and malformed inputs cannot reach the gate', () => {
  const folder = mkdtempSync(join(tmpdir(), 'writing-file-'));
  const outside = mkdtempSync(join(tmpdir(), 'writing-outside-'));
  try {
    writeFileSync(join(outside, 'source.json'), '{}');
    symlinkSync(join(outside, 'source.json'), join(folder, 'link.json'));
    assert.throws(() => checkWritingFile({ file: 'link.json' }, { folder, maxBytes: 20 }), /outside_granted_folder/);
    assert.throws(() => checkWritingFile({ file: '../' + outside.split('/').at(-1) + '/source.json' }, { folder, maxBytes: 20 }), /outside_granted_folder/);
    assert.throws(() => checkWritingFile({ file: join(outside, 'source.json') }, { folder, maxBytes: 20 }), /relative_path/);
    writeFileSync(join(folder, 'large.json'), 'x'.repeat(21));
    assert.throws(() => checkWritingFile({ file: 'large.json' }, { folder, maxBytes: 20 }), /over_byte_bound/);
    writeFileSync(join(folder, 'bad.json'), 'private source is not JSON');
    assert.throws(() => checkWritingFile({ file: 'bad.json' }, { folder, maxBytes: 100 }), error => {
      assert.equal(error.code, 'writing_file_invalid_utf8_json');
      assert.equal(error.message.includes('private source'), false);
      return true;
    });
  } finally { rmSync(folder, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

// The row runs as the container runs it: its command with its sample input on standard input, from a folder holding only
// the files the row packs, and the answer must hold the sample's text and the output schema's required keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import rows from '../tool-rows.json' with { type: 'json' };

const tool = fileURLToPath(new URL('..', import.meta.url));
const descriptors = rows.records.map(record => record.payload);

// "$.a.b[0]" read from an object.
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean)
  .reduce((at, key) => at?.[key], value);

async function packed(row) {
  const folder = await mkdtemp(join(tmpdir(), 'match-picks-row-'));
  for (const path of row.invoke.files.package_files.paths) await cp(join(tool, path), join(folder, path), { recursive: true });
  return folder;
}

const runWith = (row, folder, input) => new Promise(resolve => {
  const child = execFile(row.invoke.argv[0], row.invoke.argv.slice(1), { cwd: folder }, (error, stdout) => resolve({ error, stdout: stdout.trim() }));
  child.stdin.end(JSON.stringify(input));
});

for (const row of descriptors) {
  test(`${row.id} runs from the files it packs and its sample holds`, async () => {
    const folder = await packed(row);
    for (const sample of row.verify) {
      const { error, stdout } = await runWith(row, folder, sample.input);
      assert.equal(error, null);
      const result = select(JSON.parse(stdout), row.result_selector);
      assert.ok(String(select(result, sample.output_selector)).includes(sample.contains), `${row.id}: ${sample.output_selector} holds ${sample.contains}`);
      for (const key of row.output_schema.required) assert.ok(key in result, `${row.id}: the answer has ${key}`);
    }
  });

  test(`${row.id} refuses an empty request in one JSON line and a non-zero exit`, async () => {
    const { error, stdout } = await runWith(row, await packed(row), {});
    assert.notEqual(error.code, 0);
    assert.match(JSON.parse(stdout).error, /must be a list/);
  });
}

test('every row packs the files its command needs and offers no network', () => {
  for (const row of descriptors) {
    assert.equal(row.invoke.internet, false, row.id);
    assert.ok(row.invoke.files.package_files.paths.includes('read-data'), `${row.id} packs read-data`);
    assert.match(row.maker, /^maker:match-picks$/);
  }
});

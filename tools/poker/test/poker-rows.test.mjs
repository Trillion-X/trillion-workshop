// The rows run as the container runs them: each row's command with its sample input on standard input, from a folder
// holding only the files the row packs, and the answer must hold the sample's text and the output schema's required keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import rows from '../tool-rows.json' with { type: 'json' };

const run = promisify(execFile);
const tool = fileURLToPath(new URL('..', import.meta.url));
const descriptors = rows.records.map(record => record.payload);

// "$.a.b[0]" read from an object.
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean)
  .reduce((at, key) => at?.[key], value);

async function packed(row) {
  const folder = await mkdtemp(join(tmpdir(), 'poker-row-'));
  for (const path of row.invoke.files.package_files.paths) await cp(join(tool, path), join(folder, path), { recursive: true });
  return folder;
}

for (const row of descriptors) {
  test(`${row.id} runs from the files it packs and its sample holds`, async () => {
    const folder = await packed(row);
    for (const sample of row.verify) {
      const child = run(row.invoke.argv[0], row.invoke.argv.slice(1), { cwd: folder });
      child.child.stdin.end(JSON.stringify(sample.input));
      const answer = JSON.parse((await child).stdout.trim());
      const result = select(answer, row.result_selector);
      assert.ok(String(select(result, sample.output_selector)).includes(sample.contains), `${row.id}: ${sample.output_selector} holds ${sample.contains}`);
      for (const key of row.output_schema.required) assert.ok(key in result, `${row.id}: the answer has ${key}`);
    }
  });
}

test('every row packs the files its command needs and offers no network', () => {
  for (const row of descriptors) {
    assert.equal(row.invoke.internet, false, row.id);
    assert.ok(row.invoke.files.package_files.paths.includes('read-data'), `${row.id} packs read-data`);
    assert.match(row.maker, /^maker:poker$/);
  }
});

// tools/write-public-share-files/test/records-are-given.test.mjs
//
// The folder holds no records method: its row names none, and its code reads no store. The records a run needs are the
// ones the caller hands in as input.records (the caller reads its own store), so this test fails if a records method
// or a store read comes back into the row or the shell.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROW = new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url);
const SHELL = new URL('../do-work/write-share-files.mjs', import.meta.url);

test('the tool row names no records method and holds no stored records', async () => {
  const text = await readFile(ROW, 'utf8');
  assert.doesNotMatch(text, /records:(list|read|write)/);
  const row = JSON.parse(text).records[0].payload;
  assert.deepEqual(row.stored.map(entry => entry.operations ?? []).flat().filter(op => op.startsWith('records:')), []);
  assert.equal(row.input_schema.properties.records.type, 'array');
  assert.deepEqual(row.input_schema.required, ['origin', 'row_kind', 'records']);
  assert.equal(row.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs', 'the row runs the plain function runner');
  assert.equal(row.invoke.files.package_files.some(entry => entry.package === 'records-door'), false, 'the records door is not mounted');
  assert.equal(row.uses_tools.includes('trillion-workshop/records-door'), false);
});

test('the shell reads no store: it holds no door and calls no records method', async () => {
  const code = await readFile(SHELL, 'utf8');
  assert.doesNotMatch(code, /\bdoor\b|values-door|records-door/);
  assert.doesNotMatch(code, /records:(list|read|write)/);
});

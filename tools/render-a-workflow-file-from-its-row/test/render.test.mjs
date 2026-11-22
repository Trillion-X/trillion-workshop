// tools/render-a-workflow-file-from-its-row: the file is made from a row, carries the row's kept_at, and a stale or
// colon-named file is refused. Uses a stub row, never a live database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileFromRow, checkFile, fileNameOf } from '../read-data/render.mjs';

const stub = JSON.parse(readFileSync(new URL('./fixtures/stub-row.json', import.meta.url), 'utf8'));

test('a file is made from its row, stamped with the row kept_at, and its wake keeps only the start step', () => {
  const file = fileFromRow(stub);
  const payload = file.records[0].payload;
  assert.equal(payload.source_kept_at, stub.kept_at);
  assert.deepEqual(payload.definition, stub.definition);
  assert.deepEqual(payload.wakes[0].input, { start_at: 'keep' });
  assert.equal(payload.fires_when, undefined);
});

test('the file name is the id without workflow: and holds no colon', () => {
  assert.equal(fileNameOf('workflow:stub-keep-a-note'), 'stub-keep-a-note.json');
  assert.throws(() => fileNameOf('stub-keep-a-note'), /starts with workflow:/);
  assert.throws(() => fileNameOf('workflow:keep:a-note'), /holds no colon/);
});

test('a row without job, produces or input schema is refused, not rendered', () => {
  assert.throws(() => fileFromRow({ ...stub, job: '' }), /job is empty/);
  assert.throws(() => fileFromRow({ ...stub, produces: null }), /produces is empty/);
  assert.throws(() => fileFromRow({ ...stub, input_schema: null }), /input_schema is empty/);
});

test('a file stamped with an older kept_at than its row is refused as stale', () => {
  const file = fileFromRow(stub);
  assert.deepEqual(checkFile(file, stub), []);
  const newer = { ...stub, kept_at: '2026-11-21 22:30:00+00' };
  assert.match(checkFile(file, newer).join('\n'), /stale: file is stamped/);
});

test('a colon in the file name is refused', () => {
  const file = fileFromRow(stub);
  assert.match(checkFile(file, stub, 'workflow:stub-keep-a-note.json').join('\n'), /holds a colon/);
});

test('an ask that waits on anyone or ai is a hand ask and is refused', () => {
  const withHand = { ...stub, definition: { ...stub.definition, steps: [{ id: 'keep', kind: 'ask', config: { name: 'anyone' } }] } };
  assert.match(checkFile(fileFromRow(withHand), withHand).join('\n'), /hand ask: keep/);
});

test('a vault name written into a wake input is refused', () => {
  const withVault = { ...stub, wakes: [{ ...stub.wakes[0], input: { start_at: 'keep', store: { credential_name: 'some-login' } } }] };
  const file = fileFromRow({ ...withVault, wakes: [{ ...stub.wakes[0] }] });
  file.records[0].payload.wakes[0].input.store = { credential_name: 'some-login' };
  assert.match(checkFile(file, withVault).join('\n'), /vault name in wake on-note input\.store\.credential_name/);
});

test('a render that drops a payload key, a definition key or a step the origin file has is refused', () => {
  const file = fileFromRow(stub);
  const origin = structuredClone(file);
  origin.records[0].payload.definition.steps.push({ id: 'kept-step', kind: 'return', config: {} });
  origin.records[0].payload.rights = { wake: 'arrive' };
  const problems = checkFile(file, stub, fileNameOf(stub.recipe), origin).join('\n');
  assert.match(problems, /lost against origin file: rights, step kept-step/);
  assert.deepEqual(checkFile(file, stub, fileNameOf(stub.recipe), file), []);
});

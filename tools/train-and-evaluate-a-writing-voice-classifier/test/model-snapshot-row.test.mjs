import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const byId = id => rows.find(row => row.id === id);
const mount = {
  items: { fill: { from: 'input', field: 'model_files' } },
  at: '/opt/train-and-evaluate-a-writing-voice-classifier/model-snapshot',
  max_files: 64,
  max_bytes: 8589934592,
};

test('training and scoring mount only the supplied file snapshot and receive exact identity read rights', () => {
  for (const id of ['tool:train-a-writing-voice-adapter', 'tool:score-writing-with-a-voice-adapter']) {
    const row = byId(id);
    assert.ok(row.input_schema.required.includes('model_files'), id);
    assert.deepEqual(row.invoke.files.account_files, mount, id);
    assert.ok(row.invoke.records.rights.some(right => right.files === '/'
      && right.id.fill?.from === 'task' && right.id.fill?.field === 'account_input_file_identities'
      && right.operations.length === 1 && right.operations[0] === 'read_file'), id);
  }
});

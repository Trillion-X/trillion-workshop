// The four rows of tools/drive-the-screen: computer rows run by tools/records-door's run-an-export.mjs, each naming a
// named export of read-data/drive-the-screen.mjs, and a refusal answered with what the caller owes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as module from '../read-data/drive-the-screen.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);

test('each row runs on the person\'s computer as a named export, with only the capabilities its tool uses', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:look-at-the-screen', 'tool:find-on-the-screen', 'tool:drive-the-screen', 'tool:screen-actions']);
  const wanted = { 'tool:look-at-the-screen': ['read-the-screen-text', 'see-the-screen'], 'tool:find-on-the-screen': ['read-the-screen-text', 'see-the-screen'],
    'tool:drive-the-screen': ['read-the-screen-text', 'see-the-screen', 'drive-the-screen'], 'tool:screen-actions': [] };
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.invoke.capabilities, wanted[row.id]);
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.equal(row.needs.network_egress, false);
    assert.equal(row.result_selector, '$.result');
    const [node, runner, file, name] = row.invoke.argv;
    assert.equal(node, 'node');
    assert.equal(runner, '/opt/records-door/do-work/run-an-export.mjs');
    assert.equal(file, '/opt/drive-the-screen/read-data/drive-the-screen.mjs');
    assert.equal(typeof module[name], 'function', `${row.id} names the export ${name}`);
    assert.ok(row.invoke.files.package_files.some(spec => spec.package === 'look-at-screen'), 'the capture step is tools/look-at-screen\'s');
  }
});

test('the actions row lists the DATA action set, and a refusal is the answer with its reaction, never a bare error', async () => {
  const listed = await module.actions({});
  assert.ok(listed.actions.some(row => row.id === 'press'));
  assert.deepEqual(await module.look('not an object'), { error: module.hostWords.not_an_object });
  const refused = await module.look({ consent: true });
  assert.match(refused.error, /never carried by a call/);
  assert.equal(refused.retry, false);
  assert.equal(typeof refused.reaction, 'string');
});

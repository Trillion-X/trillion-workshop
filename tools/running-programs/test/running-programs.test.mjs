import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listRunningPrograms, readPrograms } from '../read-data/running-programs.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);

// A pretend reader: three programs, one of another user's with no memory readable.
const programs = [
  { pid: 11, name: 'sample-editor', footprint_bytes: 300, resident_bytes: 400 },
  { pid: 12, name: 'Sample Helper', footprint_bytes: 900, resident_bytes: 950 },
  { pid: 13, name: 'system-service', footprint_bytes: null, resident_bytes: null },
];
const reader = answer => ({ exec: async () => ({ ok: true, stdout: `noise\n${JSON.stringify(answer)}\n` }) });

test('the row runs on the person\'s computer with only read-processes, and changes nothing', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:list-running-programs']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.invoke.capabilities, ['read-processes']);
    assert.equal(row.invoke.records, undefined, 'no door: it reads only the Mac');
    assert.notEqual(row.invoke.internet, true);
    assert.equal(row.result_selector, '$.result');
  }
});

test('lists the largest memory first, an unreadable program last, and says when the list was cut', async () => {
  const all = await listRunningPrograms({}, {}, reader({ listed: true, programs }));
  assert.deepEqual(all.programs.map(program => program.pid), [12, 11, 13]);
  assert.equal(all.complete, true);
  const cut = await listRunningPrograms({ most: 1 }, {}, reader({ listed: true, programs }));
  assert.deepEqual([cut.total, cut.programs.length, cut.complete], [3, 1, false]);
});

test('names only the programs whose name has the words asked, in any case', async () => {
  const found = await listRunningPrograms({ name: 'SAMPLE' }, {}, reader({ listed: true, programs }));
  assert.deepEqual(found.programs.map(program => program.name), ['Sample Helper', 'sample-editor']);
});

test('refuses a bad bound and says what to grant when the reader could not list', async () => {
  await assert.rejects(listRunningPrograms({ most: 0 }, {}, reader({ listed: true, programs })), /Ask for 1 to 2000/);
  await assert.rejects(listRunningPrograms({}, {}, reader({ listed: false, programs: [] })), /Grant this tool/);
  await assert.rejects(listRunningPrograms({}, {}, { exec: async () => ({ ok: false, stdout: '' }) }), /Grant this tool/);
});

test('the real reader names this test\'s own process with its memory', { skip: process.platform !== 'darwin' }, async () => {
  const seen = (await readPrograms()).find(program => program.pid === process.pid);
  assert.ok(seen, 'this process is listed');
  assert.ok(seen.footprint_bytes > 0 && seen.resident_bytes > 0, JSON.stringify(seen));
});

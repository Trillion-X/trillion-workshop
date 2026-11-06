import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRunningPrograms, readPrograms, readProcessTable } from '../read-data/running-programs.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);

// A pretend reader: three programs, one of another user's with no memory readable.
const programs = [
  { pid: 11, name: 'sample-editor', footprint_bytes: 300, resident_bytes: 400 },
  { pid: 12, name: 'Sample Helper', footprint_bytes: 900, resident_bytes: 950 },
  { pid: 13, name: 'system-service', footprint_bytes: null, resident_bytes: null },
];
// The osascript reader, chosen because the computer has nothing but its `at`.
const osascriptOnly = [{ reads: 'libproc-through-osascript', at: '/pretend/osascript' }];
const reader = answer => ({ readers: osascriptOnly, has: () => true, exec: async () => ({ ok: true, stdout: `noise\n${JSON.stringify(answer)}\n` }) });

test('the row runs on the person\'s computer with only read-processes, and changes nothing', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:list-running-programs']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.invoke.capabilities, ['read-processes']);
    assert.equal(row.invoke.records, undefined, 'no door: it reads only the computer it runs on');
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
  await assert.rejects(listRunningPrograms({}, {}, { readers: osascriptOnly, has: () => true, exec: async () => ({ ok: false, stdout: '' }) }), /Grant this tool/);
  await assert.rejects(listRunningPrograms({}, {}, { has: () => false }), /Grant this tool/, 'a computer with no reader says what to grant');
});

test('a process table folder is read without starting a program, memory in bytes, a vanished program left out', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'process-table-'));
  const program = (pid, name, status) => { mkdirSync(join(folder, pid)); writeFileSync(join(folder, pid, 'comm'), `${name}\n`); if (status !== null) writeFileSync(join(folder, pid, 'status'), status); };
  program('21', 'sample-editor', 'Name:\tsample-editor\nVmRSS:\t     400 kB\nRssAnon:\t     300 kB\nVmSwap:\t      10 kB\n');
  program('22', 'kernel-helper', 'Name:\tkernel-helper\n');
  program('23', 'not-mine', null);
  mkdirSync(join(folder, '24'));
  mkdirSync(join(folder, 'self'));
  const read = readProcessTable(folder).sort((left, right) => left.pid - right.pid);
  assert.deepEqual(read, [
    { pid: 21, name: 'sample-editor', footprint_bytes: 310 * 1024, resident_bytes: 400 * 1024 },
    { pid: 22, name: 'kernel-helper', footprint_bytes: null, resident_bytes: null },
    { pid: 23, name: 'not-mine', footprint_bytes: null, resident_bytes: null },
  ]);
  const listed = await listRunningPrograms({}, {}, { readers: [{ reads: 'process-table-folder', at: folder }, ...osascriptOnly] });
  assert.deepEqual(listed.programs.map(one => one.pid), [21, 22, 23], 'the first reader the computer has is the one used');
});

test('the real reader this computer has names this test\'s own process with its memory', async t => {
  let all;
  try { all = await readPrograms(); } catch { t.skip('this computer reports no reader running-programs.json names'); return; }
  const seen = all.find(program => program.pid === process.pid);
  assert.ok(seen, 'this process is listed');
  assert.ok(seen.footprint_bytes > 0 && seen.resident_bytes > 0, JSON.stringify(seen));
});

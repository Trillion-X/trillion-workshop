import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
// The osascript reader, chosen because the place has nothing but its `at`.
const osascriptOnly = [{ reads: 'libproc-through-osascript', at: '/pretend/osascript' }];
const reader = answer => ({ readers: osascriptOnly, has: () => true, exec: async () => ({ ok: true, stdout: `noise\n${JSON.stringify(answer)}\n` }) });

test('the rows run on the person\'s computer with only the capabilities each needs: the list reads, the choice reads nothing, only the stop may signal', () => {
  const capabilities = Object.fromEntries(rows.map(row => [row.id, row.invoke.capabilities]));
  assert.deepEqual(capabilities, {
    'tool:list-running-programs': ['read-processes'],
    'tool:choose-programs-left-running': [],
    'tool:stop-programs-left-running': ['read-processes', 'close-apps'],
  });
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
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
  const folder = tempFolder(join(tmpdir(), 'process-table-'));
  const program = (pid, name, status) => { mkdirSync(join(folder, pid)); writeFileSync(join(folder, pid, 'comm'), `${name}\n`); if (status !== null) writeFileSync(join(folder, pid, 'status'), status); };
  program('21', 'sample-editor', 'Name:\tsample-editor\nVmRSS:\t     400 kB\nRssAnon:\t     300 kB\nVmSwap:\t      10 kB\n');
  program('22', 'kernel-helper', 'Name:\tkernel-helper\n');
  program('23', 'not-mine', null);
  mkdirSync(join(folder, '24'));
  mkdirSync(join(folder, 'self'));
  const read = readProcessTable(folder).sort((left, right) => left.pid - right.pid);
  const unknown = { parent_pid: null, session_id: null, started_at_ms: null, cpu_ms: null };
  assert.deepEqual(read, [
    { pid: 21, name: 'sample-editor', footprint_bytes: 310 * 1024, resident_bytes: 400 * 1024, ...unknown },
    { pid: 22, name: 'kernel-helper', footprint_bytes: null, resident_bytes: null, ...unknown },
    { pid: 23, name: 'not-mine', footprint_bytes: null, resident_bytes: null, ...unknown },
  ], 'a program with no stat is listed with its parent, session, start and processor time null, never a guess');
  const listed = await listRunningPrograms({}, {}, { readers: [{ reads: 'process-table-folder', at: folder }, ...osascriptOnly] });
  assert.deepEqual(listed.programs.map(one => one.pid), [21, 22, 23], 'the first reader the computer has is the one used');
});

test('a process table folder gives each program its parent, session, start, processor time and, asked, its command', () => {
  const folder = tempFolder(join(tmpdir(), 'process-table-'));
  writeFileSync(join(folder, 'stat'), 'cpu  1 2 3\nbtime 1700000000\n');
  mkdirSync(join(folder, '31'));
  writeFileSync(join(folder, '31', 'comm'), 'sample loop\n');
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime
  writeFileSync(join(folder, '31', 'stat'), '31 (sample loop) R 1 31 31 0 -1 0 0 0 0 0 600 400 0 0 20 0 1 0 5000 0 0\n');
  writeFileSync(join(folder, '31', 'cmdline'), '/bin/sh\0-c\0while true; do :; done\0');
  const [plain] = readProcessTable(folder);
  assert.deepEqual([plain.parent_pid, plain.session_id, plain.started_at_ms, plain.cpu_ms, plain.command], [1, 31, 1700000050000, 10000, undefined]);
  const [asked] = readProcessTable(folder, { commands: true });
  assert.equal(asked.command, '/bin/sh -c while true; do :; done');
});

test('commands are asked of the osascript reader only when wanted, with the bytes running-programs.json bounds them to', async () => {
  const seen = [];
  const exec = async (_at, args) => { seen.push(args.slice(3)); return { ok: true, stdout: JSON.stringify({ listed: true, programs }) }; };
  await listRunningPrograms({}, {}, { readers: osascriptOnly, has: () => true, exec });
  await listRunningPrograms({ commands: true }, {}, { readers: osascriptOnly, has: () => true, exec });
  assert.deepEqual(seen, [[], ['commands', '4096']]);
  await assert.rejects(listRunningPrograms({ commands: 'yes' }, {}, { readers: osascriptOnly, has: () => true, exec }), /true or false/);
});

test('the real reader this computer has names this test\'s own process with its memory', async t => {
  let all;
  try { all = await readPrograms(); } catch { t.skip('this computer reports no reader running-programs.json names'); return; }
  const seen = all.find(program => program.pid === process.pid);
  assert.ok(seen, 'this process is listed');
  assert.ok(seen.footprint_bytes > 0 && seen.resident_bytes > 0, JSON.stringify(seen));
  assert.equal(seen.parent_pid, process.ppid);
  assert.ok(seen.started_at_ms <= Date.now() && seen.started_at_ms > Date.now() - 3_600_000, JSON.stringify(seen));
  assert.ok(seen.cpu_ms >= 0 && Number.isInteger(seen.session_id), JSON.stringify(seen));
  const [withCommand] = (await readPrograms({ commands: true })).filter(program => program.pid === process.pid);
  assert.ok(withCommand.command.includes('node'), withCommand.command);
});

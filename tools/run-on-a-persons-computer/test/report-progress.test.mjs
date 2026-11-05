// A program's progress file becomes one report per job (computer/report-progress.mjs): its rows say where the files
// are and how to read them, a file is reported only when it changed, a program that died reports failed, and old
// finished work is never announced again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAction, filesOf, reportOf, settingsOf, startReporting } from '../report-progress.mjs';

const row = settingsOf().rows.find(item => item.id === 'drive-keep');
const file = (over = {}) => ({ pid: 4242, drive: '1TB SSD', started_at: '2026-10-01T21:17:40.240Z', state: 'keeping', files_total: 572, files_done: 555, recordings: 14, heard: 12, handed_on: 9, bytes_total: 1000, bytes_done: 400, updated_at: '2026-10-02T00:21:05.341Z', sending: [{ name: '/Recordings/1TB SSD/M4ROOT/CLIP/C9594.MP4', bytes_sent: 50 }], ...over });
const now = Date.parse('2026-10-02T00:22:00Z');

test('a star folder is found and kept as {folder}', () => {
  const found = filesOf('~/a/*/progress.json', '/home/x', folder => (folder === '/home/x/a' ? ['one', '.hidden', 'two'] : []));
  assert.deepEqual(found, [{ path: '/home/x/a/one/progress.json', folder: 'one' }, { path: '/home/x/a/two/progress.json', folder: 'two' }]);
});

test('a drive being kept reads as a running report with its drive, counts and bytes', () => {
  const report = reportOf(row, file(), { folder: 'place-camera-ssd', computer: 'Mac', isAlive: () => true, now });
  assert.equal(report.state, 'running');
  assert.equal(report.kind, 'transfer');
  assert.equal(report.title, 'Keeping 1TB SSD in your files');
  assert.equal(report.body, '555 of 572 files · heard 12 of 14 recordings · 9 sent to your AIs');
  assert.deepEqual(report.progress, { done: 450, total: 1000, unit: 'bytes' }, 'finished files plus what is in flight');
  assert.equal(report.key, 'keep:Mac:place-camera-ssd', 'the key names the drive being kept, never one start of the keeper');
});

test('a program that stopped reports failed, and old ended work is left out', () => {
  assert.equal(reportOf(row, file(), { computer: 'Mac', isAlive: () => false, now }).state, 'failed');
  assert.equal(reportOf(row, file({ state: 'finished' }), { computer: 'Mac', now, settledWithinMs: 30 * 60_000 }).state, 'done');
  assert.equal(reportOf(row, file({ state: 'finished', updated_at: '2026-09-20T00:00:00Z' }), { computer: 'Mac', now, settledWithinMs: 30 * 60_000 }), null);
  assert.equal(reportOf(row, file({ state: 'something-new' }), { computer: 'Mac', now }), null);
});

test('a program started again on the same work keeps one notice and is never told as stopped while its file is fresh', () => {
  const grace = { computer: 'Mac', folder: 'place', now, stoppedAfterMs: 180_000 };
  const first = reportOf(row, file(), { ...grace, isAlive: () => true });
  assert.equal(reportOf(row, file(), { ...grace, isAlive: () => false }), null, 'gone 55 s ago: taken to be starting again, nothing said');
  const next = reportOf(row, file({ pid: 5151, started_at: '2026-10-02T00:21:50.000Z' }), { ...grace, isAlive: () => true });
  assert.equal(next.key, first.key, 'the keeper started again changes the same notice');
  const quiet = reportOf(row, file({ updated_at: '2026-10-02T00:10:00Z' }), { ...grace, isAlive: () => false, settledWithinMs: 30 * 60_000 });
  assert.equal(quiet.state, 'failed', 'gone and quiet past the grace: told as stopped, in the program\'s own words');
  assert.equal(quiet.body, row.stopped_words);
});

test('every row keys its notice by where the work is kept, never by anything one start of the program writes', () => {
  for (const each of settingsOf().rows) {
    const names = [...each.key.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
    assert.ok(names.length && names.every(name => name === 'computer' || name === 'folder'), `${each.id}: ${each.key}`);
  }
});

test('a file is reported only when it changed, and again after the account refused it', async () => {
  const posted = [];
  let take = false;
  let current = file();
  const reporting = startReporting({ settings: { every_seconds: 5, settled_within_minutes: 30, rows: [row] }, timers: false, computer: 'Mac', home: '/h', isAlive: () => true,
    list: () => ['place'], read: () => current, post: async report => { posted.push(report); return take; } });
  await reporting.tick();
  take = true;
  await reporting.tick();
  await reporting.tick();
  assert.equal(posted.length, 2, 'refused once, taken once, then unchanged');
  current = file({ bytes_done: 500 });
  await reporting.tick();
  assert.equal(posted.length, 3);
  assert.equal(posted[2].progress.done, 550);
});

test('running work is reported again after resend_running_seconds even when nothing changed, so it never reads as stopped', async () => {
  const posted = [];
  let clock = 0;
  const reporting = startReporting({ settings: { every_seconds: 5, settled_within_minutes: 30, resend_running_seconds: 60, rows: [row] }, timers: false, computer: 'Mac', home: '/h', isAlive: () => true,
    list: () => ['place'], read: () => file(), post: async report => { posted.push(report); return true; }, clock: () => clock });
  await reporting.tick();
  clock = 30_000;
  await reporting.tick();
  assert.equal(posted.length, 1);
  clock = 61_000;
  await reporting.tick();
  assert.equal(posted.length, 2);
});

test('a report offers the actions its state allows, answered by this computer, and pressing one writes the program\'s control file', async () => {
  const copying = reportOf(row, file(), { computer: 'Mac', agent: 'computer-mac', isAlive: () => true, now });
  assert.deepEqual(copying.actions.map(action => action.id), ['pause', 'stop']);
  assert.equal(copying.answered_by, 'computer-mac');
  const paused = reportOf(row, file({ state: 'paused' }), { computer: 'Mac', agent: 'computer-mac', isAlive: () => true, now });
  assert.deepEqual(paused.actions.map(action => action.id), ['resume', 'stop']);
  assert.match(paused.body, /^Paused/);
  assert.equal(reportOf(row, file(), { computer: 'Mac', isAlive: () => true, now }).actions, undefined, 'no agent, no actions');
  const folder = mkdtempSync(join(tmpdir(), 'report-progress-'));
  const progressPath = join(folder, 'progress.json');
  const pause = row.actions.find(action => action.id === 'pause');
  applyAction(pause, progressPath, new Date('2026-10-02T09:00:00Z'));
  assert.deepEqual(JSON.parse(readFileSync(join(folder, 'control.json'), 'utf8')), { action: 'pause', resume_at: null, by: 'person', set_at: '2026-10-02T09:00:00.000Z' });
  applyAction(row.actions.find(action => action.id === 'resume'), progressPath);
  assert.equal(existsSync(join(folder, 'control.json')), false);
  const written = [];
  const reporting = startReporting({ settings: { every_seconds: 5, settled_within_minutes: 30, rows: [row] }, timers: false, computer: 'Mac', agent: 'computer-mac', home: '/h', isAlive: () => true,
    list: () => ['place'], read: () => file(), post: async () => true, write: (action, path) => { written.push([action.id, path]); return { wrote: action.write.file }; } });
  await reporting.tick();
  const key = 'keep:Mac:place';
  assert.equal(reporting.knows(key), true);
  await reporting.act(key, 'stop');
  assert.deepEqual(written, [['stop', '/h/.trillion/computer-sources/drives/place/progress.json']]);
  await assert.rejects(reporting.act(key, 'format-the-drive'), /No work here offers/);
});

test('a finished drive keeps the name it read while keeping, and says it is in your files', async () => {
  const posted = [];
  let current = file();
  const reporting = startReporting({ settings: { every_seconds: 5, settled_within_minutes: 30, rows: [row] }, timers: false, computer: 'Mac', home: '/h', isAlive: () => true,
    list: () => ['place'], read: () => current, post: async report => { posted.push(report); return true; } });
  await reporting.tick();
  current = file({ state: 'finished', drive: undefined, sending: [], updated_at: new Date().toISOString() });
  await reporting.tick();
  assert.equal(posted.at(-1).state, 'done');
  assert.equal(posted.at(-1).title, '1TB SSD is in your files');
  assert.equal(posted.at(-1).values, undefined, 'what was remembered stays on this computer');
});


test('a report is drawn with the chips its row names, filled from the file, and a chip naming a missing value is left out', () => {
  assert.deepEqual(reportOf(row, file(), { computer: 'Mac', isAlive: () => true, now }).chips, [{ text: '555 of 572 files' }, { text: '12 heard' }, { text: '9 to your AIs' }]);
  assert.deepEqual(reportOf(row, file({ state: 'paused', heard: undefined }), { computer: 'Mac', isAlive: () => true, now }).chips, [{ text: 'Paused', tone: 'attention' }, { text: '555 of 572 files' }]);
  assert.deepEqual(reportOf(row, file({ heard: null }), { computer: 'Mac', isAlive: () => true, now }).chips.map(chip => chip.text), ['555 of 572 files', '9 to your AIs']);
});
